require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const socketIO = require('socket.io');
const path = require('path');
const pkg = require('./package.json');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const {
    initializeDatabase,
    migrateChannelsForEmptyServers,
    ensureChannelSchema,
    ensureE2eeSchema,
    ensureUserProfileSchema,
    ensureUserSecuritySchema,
    ensureServerInviteSchema,
    ensureDmReactionsSchema,
    ensureMessageReplyAndPinsSchema,
    ensureStickerPackSchema,
    FLOR_MAX_STICKER_PACKS_PER_USER,
    FLOR_MAX_STICKERS_PER_PACK,
    migrateChannelHierarchy,
    getChannelTree,
    FLOR_MAX_CHANNEL_PINS,
    FLOR_MAX_DM_PINS,
    userDB,
    messageDB,
    channelDB,
    categoryDB,
    dmDB,
    channelKeyWrapDB,
    fileDB,
    reactionDB,
    dmReactionDB,
    pinDB,
    friendDB,
    serverDB,
    serverBanDB,
    moderationReportDB,
    serverInviteDB,
    stickerPackDB
} = require('./database');

/**
 * HTTPS: либо SSL_KEY_PATH + SSL_CERT_PATH (Let's Encrypt и т.д.),
 * либо USE_HTTPS=true — самоподписанный сертификат (для LAN: FLOR_TLS_SAN=localhost,127.0.0.1,192.168.x.x).
 * Без этого микрофон/WebRTC/E2EE в браузере по http://IP не работают (нужен secure context).
 */
function createHttpServer(app) {
    const keyPath = process.env.SSL_KEY_PATH;
    const certPath = process.env.SSL_CERT_PATH;
    if (keyPath && certPath) {
        if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
            console.error('[HTTPS] Не найдены файлы SSL_KEY_PATH или SSL_CERT_PATH');
            process.exit(1);
        }
        return {
            server: https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app),
            useHttps: true
        };
    }
    if (process.env.USE_HTTPS === '1' || process.env.USE_HTTPS === 'true') {
        const selfsigned = require('selfsigned');
        const sanRaw = process.env.FLOR_TLS_SAN || 'localhost,127.0.0.1';
        const parts = sanRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const altNames = [];
        for (const entry of parts) {
            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(entry)) {
                altNames.push({ type: 7, ip: entry });
            } else {
                altNames.push({ type: 2, value: entry });
            }
        }
        const attrs = [{ name: 'commonName', value: 'flor-messenger' }];
        const pems = selfsigned.generate(attrs, {
            keySize: 2048,
            days: 365,
            algorithm: 'sha256',
            extensions: [
                {
                    name: 'subjectAltName',
                    altNames:
                        altNames.length > 0
                            ? altNames
                            : [
                                  { type: 2, value: 'localhost' },
                                  { type: 7, ip: '127.0.0.1' }
                              ]
                }
            ]
        });
        console.warn(
            '[HTTPS] Самоподписанный сертификат. В браузере примите предупреждение безопасности.\n' +
                '[HTTPS] Для доступа по IP в сети задайте в .env: FLOR_TLS_SAN=localhost,127.0.0.1,ВАШ_LAN_IP'
        );
        return {
            server: https.createServer({ key: pems.private, cert: pems.cert }, app),
            useHttps: true
        };
    }
    return { server: http.createServer(app), useHttps: false };
}

function florOriginFromReq(req) {
    const hdr = String((req && req.headers && req.headers.origin) || '').trim();
    if (/^https?:\/\//i.test(hdr)) return hdr.replace(/\/$/, '');
    const proto = req && req.protocol === 'https' ? 'https' : useHttps ? 'https' : 'http';
    const host = String((req && req.get && req.get('host')) || `127.0.0.1:${PORT}`).trim();
    return `${proto}://${host}`.replace(/\/$/, '');
}

const app = express();
const { server, useHttps } = createHttpServer(app);
const corsOrigin = process.env.CORS_ORIGIN || true;
const io = socketIO(server, {
    cors: {
        origin: corsOrigin === 'true' ? true : corsOrigin,
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 3000;
/** На VPS/PaaS нужен 0.0.0.0, иначе снаружи не достучаться */
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_JWT_SECRET = 'your-secret-key-change-in-production';
let JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
if (JWT_SECRET === DEFAULT_JWT_SECRET) {
    console.warn(
        '[SECURITY] Используется стандартный JWT_SECRET. Задайте уникальный JWT_SECRET в .env для продакшена.'
    );
}
const isElectronRuntime =
    typeof process.versions === 'object' && process.versions !== null && typeof process.versions.electron === 'string';
if (
    process.env.NODE_ENV === 'production' &&
    JWT_SECRET === DEFAULT_JWT_SECRET &&
    !isElectronRuntime
) {
    console.error('[SECURITY] Отказ запуска: в production нужен свой JWT_SECRET в переменных окружения.');
    process.exit(1);
}

const MAX_MESSAGE_LENGTH = 4000;
/** Зашифрованные JSON-пакеты (AES-GCM) могут быть длиннее */
const MAX_E2EE_MESSAGE_LENGTH = 98304;
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CODE_RESEND_MS = 60 * 1000;
const pendingEmailCodes = new Map();
const QR_SESSION_TTL_MS = 3 * 60 * 1000;
const pendingQrSessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of pendingEmailCodes.entries()) {
        if (!entry || now > entry.expiresAt) {
            pendingEmailCodes.delete(k);
        }
    }
}, 60 * 1000);
setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of pendingQrSessions.entries()) {
        if (!entry || now > entry.expiresAt) {
            pendingQrSessions.delete(sid);
        }
    }
}, 30 * 1000);

function createEmailCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function emailCodeKey(email, purpose) {
    return `${String(purpose || '').trim().toLowerCase()}:${String(email || '').trim().toLowerCase()}`;
}

function hashEmailCode(code) {
    return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

function getMailTransporter() {
    const host = String(process.env.SMTP_HOST || '').trim();
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = String(process.env.SMTP_USER || '').trim();
    const pass = String(process.env.SMTP_PASS || '').trim();
    if (!host || !Number.isFinite(port) || !user || !pass) {
        return null;
    }
    return nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
    });
}

async function sendVerificationCodeEmail(email, code) {
    const transporter = getMailTransporter();
    if (!transporter) {
        throw new Error('EMAIL_TRANSPORT_NOT_CONFIGURED');
    }
    const from = String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
    const appName = String(process.env.APP_NAME || 'FLOR MESSENGER').trim();
    const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
            <h2 style="margin:0 0 12px">${appName}</h2>
            <p style="margin:0 0 10px">Код подтверждения:</p>
            <p style="margin:0 0 16px;font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
            <p style="margin:0;color:#555">Код действует 10 минут. Если это были не вы — просто проигнорируйте письмо.</p>
        </div>
    `;
    await transporter.sendMail({
        from,
        to: email,
        subject: `${appName}: код подтверждения`,
        text: `Код подтверждения: ${code}. Код действует 10 минут.`,
        html
    });
}

async function sendLoginAlertEmail(email, username, ipAddr) {
    const transporter = getMailTransporter();
    if (!transporter) return;
    const from = String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
    const appName = String(process.env.APP_NAME || 'FLOR MESSENGER').trim();
    const when = new Date().toLocaleString('ru-RU');
    await transporter.sendMail({
        from,
        to: email,
        subject: `${appName}: вход в аккаунт`,
        text: `Новый вход в аккаунт ${username || ''}\nВремя: ${when}\nIP: ${ipAddr || 'unknown'}`,
        html: `
            <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
                <h2 style="margin:0 0 12px">${appName}</h2>
                <p style="margin:0 0 8px">Выполнен вход в аккаунт <strong>${username || ''}</strong>.</p>
                <p style="margin:0 0 4px">Время: ${when}</p>
                <p style="margin:0 0 12px">IP: ${ipAddr || 'unknown'}</p>
                <p style="margin:0;color:#555">Если это были не вы — срочно смените пароль.</p>
            </div>
        `
    });
}

function verifyStoredEmailCode(email, purpose, code) {
    const key = emailCodeKey(email, purpose);
    const stored = pendingEmailCodes.get(key);
    if (!stored || Date.now() > stored.expiresAt) {
        pendingEmailCodes.delete(key);
        return { ok: false, error: 'Email verification code expired' };
    }
    if (stored.codeHash !== hashEmailCode(code)) {
        return { ok: false, error: 'Invalid email verification code' };
    }
    pendingEmailCodes.delete(key);
    return { ok: true };
}

function createQrSession() {
    const id = crypto.randomBytes(18).toString('base64url');
    const session = {
        id,
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + QR_SESSION_TTL_MS,
        token: null,
        user: null
    };
    pendingQrSessions.set(id, session);
    return session;
}

function sanitizeUserForClient(user) {
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar || user.username.charAt(0).toUpperCase()
    };
}

function sanitizeMessageText(text) {
    if (typeof text !== 'string') return '';
    return text.trim().slice(0, MAX_MESSAGE_LENGTH);
}

function parsePublicE2eePayload(trimmed) {
    try {
        const o = JSON.parse(trimmed);
        if (
            o &&
            Number(o.florE2ee) === 1 &&
            typeof o.iv === 'string' &&
            typeof o.ct === 'string'
        ) {
            return o;
        }
        if (
            o &&
            Number(o.florE2ee) === 2 &&
            typeof o.iv === 'string' &&
            typeof o.ct === 'string' &&
            Array.isArray(o.wraps) &&
            o.wraps.length > 0 &&
            o.wraps.every((w) => typeof w === 'string')
        ) {
            return o;
        }
    } catch (_) {}
    return null;
}

/** Понятный серверу текст: обычный (обрезается) или E2EE-конверт (как есть, лимит выше) */
function normalizeMessageTextInput(raw) {
    if (typeof raw !== 'string') {
        return { ok: false, error: 'Некорректное сообщение' };
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return { ok: false, error: 'Пустое сообщение' };
    }
    const e2ee = parsePublicE2eePayload(trimmed);
    if (e2ee) {
        if (trimmed.length > MAX_E2EE_MESSAGE_LENGTH) {
            return { ok: false, error: 'Слишком длинное зашифрованное сообщение' };
        }
        return { ok: true, text: trimmed, e2ee: true };
    }
    const plain = sanitizeMessageText(raw);
    if (!plain) {
        return { ok: false, error: 'Пустое сообщение' };
    }
    return { ok: true, text: plain, e2ee: false };
}

function florAvatarFromRow(u) {
    if (!u) return '?';
    if (u.avatar && String(u.avatar).trim()) return u.avatar;
    const name = u.username || '';
    return name ? String(name).charAt(0).toUpperCase() : '?';
}

function florChannelRowToBroadcastMessage(row) {
    if (!row) return null;
    const payload = {
        id: row.id,
        senderId: row.user_id,
        author: row.username,
        avatar: florAvatarFromRow(row),
        text: row.content,
        timestamp: row.created_at
    };
    if (row.reply_to_id) {
        payload.replyTo = {
            id: row.reply_to_id,
            author: row.reply_to_username || '',
            text: row.reply_to_content != null ? row.reply_to_content : ''
        };
    }
    return payload;
}

function florDmRowToSocketPayload(row) {
    if (!row) return null;
    const payload = {
        id: row.id,
        senderId: row.sender_id,
        author: row.username,
        avatar: florAvatarFromRow(row),
        text: row.content,
        timestamp: row.created_at,
        read: row.read
    };
    if (row.reply_to_id) {
        payload.replyTo = {
            id: row.reply_to_id,
            author: row.reply_to_username || '',
            text: row.reply_to_content != null ? row.reply_to_content : ''
        };
    }
    return payload;
}

/** Собирает плоский список JWK из массива / вложенных массивов / JSON-строк элементов */
function flattenStoredIdentityJwksPayload(p) {
    const out = [];
    const visit = (v) => {
        if (v == null) return;
        if (Array.isArray(v)) {
            v.forEach(visit);
            return;
        }
        if (typeof v === 'string') {
            try {
                visit(JSON.parse(v));
            } catch (_) {}
            return;
        }
        if (typeof v === 'object' && v.kty === 'EC' && v.x && v.y) {
            const crv = String(v.crv || '').toUpperCase();
            if (crv === 'P-256' || crv === 'PRIME256V1') {
                const j = { ...v, crv: 'P-256' };
                out.push(j);
            }
        }
    };
    visit(p);
    return out;
}

/**
 * Разбор обёртки ключа канала: одна строка florWrap или бандл с разными from (несколько устройств / ретрансляторов).
 * Клиент передаёт fallbackFromUserId из колонки from_user_id для старых записей.
 */
function parseChannelKeyWrapEntries(wrapText, fallbackFromUserId) {
    if (wrapText == null || typeof wrapText !== 'string') return [];
    const t = wrapText.trim();
    if (!t) return [];
    try {
        const o = JSON.parse(t);
        if (o && o.florE2eeChWrapBundle === 1 && Array.isArray(o.items)) {
            return o.items
                .filter((x) => x != null && x.from != null && typeof x.w === 'string')
                .map((x) => ({
                    fromUserId: Number(x.from),
                    wrapStr: String(x.w).trim()
                }))
                .filter((x) => Number.isFinite(x.fromUserId) && x.wrapStr);
        }
        if (o && Number(o.florWrap) === 1 && o.iv && o.ct && fallbackFromUserId != null) {
            const fid = Number(fallbackFromUserId);
            if (Number.isFinite(fid)) return [{ fromUserId: fid, wrapStr: t }];
        }
    } catch (_) {}
    const fid = fallbackFromUserId != null ? Number(fallbackFromUserId) : NaN;
    if (Number.isFinite(fid)) return [{ fromUserId: fid, wrapStr: t }];
    return [];
}

function mergeChannelKeyWrapEntry(existingText, newFromUserId, newWrapStr, existingRowFromUserId) {
    const nf = Number(newFromUserId);
    const nw = typeof newWrapStr === 'string' ? newWrapStr.trim() : '';
    if (!Number.isFinite(nf) || !nw) {
        return existingText != null ? String(existingText) : '';
    }
    const seen = new Set();
    const out = [];
    const push = (from, w) => {
        const ws = typeof w === 'string' ? w.trim() : '';
        if (!Number.isFinite(from) || !ws) return;
        const k = `${from}\0${ws}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ fromUserId: from, wrapStr: ws });
    };
    parseChannelKeyWrapEntries(
        existingText != null ? String(existingText) : '',
        existingRowFromUserId != null ? Number(existingRowFromUserId) : null
    ).forEach((e) => push(e.fromUserId, e.wrapStr));
    push(nf, nw);
    if (out.length === 0) return nw;
    if (out.length === 1) return out[0].wrapStr;
    return JSON.stringify({
        florE2eeChWrapBundle: 1,
        items: out.map((e) => ({ from: e.fromUserId, w: e.wrapStr }))
    });
}

/** Все зарегистрированные публичные ключи устройств (ECDH P-256) */
function mapUserIdentityJwks(row) {
    if (!row || !row.identity_public_jwk) return [];
    try {
        const p = JSON.parse(row.identity_public_jwk);
        const raw = Array.isArray(p) ? p : [p];
        return flattenStoredIdentityJwksPayload(raw);
    } catch (_) {}
    return [];
}

async function assertChannelMember(userId, channelId) {
    const uid = Number(userId);
    const cid = parseInt(channelId, 10);
    if (!Number.isFinite(uid)) return { ok: false, status: 401, error: 'Некорректный пользователь' };
    if (Number.isNaN(cid)) return { ok: false, status: 400, error: 'Некорректный канал' };
    const channel = await channelDB.getById(cid);
    if (!channel) return { ok: false, status: 404, error: 'Канал не найден' };
    if (channel.server_id == null) {
        return { ok: false, status: 500, error: 'Канал не привязан к серверу' };
    }
    const member = await serverDB.isMember(channel.server_id, uid);
    if (!member) return { ok: false, status: 403, error: 'Нет доступа к этому каналу' };
    return { ok: true, channel };
}

async function assertServerMember(userId, serverId) {
    const sid = parseInt(serverId, 10);
    if (Number.isNaN(sid)) return false;
    return serverDB.isMember(sid, userId);
}

async function assertServerOwner(userId, serverId) {
    const sid = parseInt(serverId, 10);
    if (Number.isNaN(sid)) return null;
    const srv = await serverDB.getById(sid);
    if (!srv) return null;
    if (Number(srv.owner_id) !== Number(userId)) return null;
    return srv;
}

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
}
app.use(
    cors({
        origin: corsOrigin === 'true' ? true : corsOrigin,
        credentials: true
    })
);
app.use(express.json({ limit: '2mb' }));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много попыток. Подождите несколько минут.' }
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
});

/** Лимит запросов к ИИ на пользователя (JWT), чтобы не сжигать квоты и CPU */
const aiUserLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 24,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user && req.user.id != null ? req.user.id : req.ip || '0'),
    message: { error: 'Слишком много запросов к ИИ. Подождите минуту.' }
});

function sanitizeAiMessages(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    let total = 0;
    for (const m of raw.slice(0, 48)) {
        if (!m || typeof m !== 'object') continue;
        let role = String(m.role || 'user').toLowerCase();
        if (!['system', 'user', 'assistant'].includes(role)) role = 'user';
        let content = String(m.content == null ? '' : m.content);
        if (content.length > 32000) content = content.slice(0, 32000) + '…';
        total += content.length;
        if (total > 220000) break;
        out.push({ role, content });
    }
    return out.length ? out : null;
}

async function florProxyOpenAIChat({ baseUrl, apiKey, model, messages, maxTokens }) {
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const r = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: model || 'gpt-4o-mini',
            messages,
            max_tokens: maxTokens
        })
    });
    const text = await r.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = {};
    }
    if (!r.ok) {
        const err =
            (data.error && (data.error.message || data.error)) || text.slice(0, 280) || `HTTP ${r.status}`;
        throw new Error(String(err));
    }
    const out =
        data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof out !== 'string' || !out.trim()) throw new Error('Пустой ответ модели');
    return out.trim();
}

async function florProxyGeminiGenerate({ apiKey, model, messages, maxTokens }) {
    const m = model || 'gemini-1.5-flash';
    let systemText = '';
    const conversation = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            systemText += (systemText ? '\n\n' : '') + msg.content;
            continue;
        }
        const role = msg.role === 'assistant' ? 'model' : 'user';
        conversation.push({ role, parts: [{ text: msg.content }] });
    }
    if (!conversation.length) {
        conversation.push({
            role: 'user',
            parts: [{ text: systemText ? `${systemText}\n\n(выполни инструкции выше)` : 'Ответь кратко.' }]
        });
        systemText = '';
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        m
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
        contents: conversation,
        generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 0.45
        }
    };
    if (systemText) {
        body.systemInstruction = { parts: [{ text: systemText }] };
    }
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await r.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = {};
    }
    if (!r.ok) {
        const err =
            (data.error && (data.error.message || data.error.status)) || text.slice(0, 280) || `HTTP ${r.status}`;
        throw new Error(String(err));
    }
    const parts =
        data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    if (!parts || !parts.length) throw new Error('Пустой ответ Gemini');
    const out = parts.map((p) => p.text || '').join('');
    if (!out.trim()) throw new Error('Пустой ответ модели');
    return out.trim();
}

app.get('/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, name: pkg.name, version: pkg.version });
});

app.get('/api/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, version: pkg.version });
});

app.use('/api/', apiLimiter);

/** Поиск GIF (Giphy). Без GIPHY_API_KEY — встроенный демо-набор. */
function florGiphyImgUrl(obj) {
    if (!obj || typeof obj !== 'object') {
        return '';
    }
    const u = obj.url;
    return typeof u === 'string' && u ? u : '';
}

function florGiphyPickGifUrl(im) {
    if (!im) return '';
    const tryKeys = [
        'downsized_medium',
        'downsized',
        'downsized_small',
        'original',
        'fixed_width',
        'fixed_height',
        'fixed_width_downsampled',
        'fixed_height_downsampled',
        'downsized_large',
        'hd',
        'fixed_width_small',
        'fixed_height_small',
        'preview',
        'preview_gif'
    ];
    for (const k of tryKeys) {
        const s = florGiphyImgUrl(im[k]);
        if (s) return s;
    }
    return '';
}

function florGiphyPickPreviewUrl(im, fallbackUrl) {
    if (!im) return fallbackUrl;
    const tryKeys = [
        'fixed_height_small',
        'fixed_width_small',
        'preview_gif',
        'downsized_still',
        'fixed_height_still',
        'downsized',
        'downsized_small',
        'downsized_medium'
    ];
    for (const k of tryKeys) {
        const s = florGiphyImgUrl(im[k]);
        if (s) return s;
    }
    return fallbackUrl;
}

function florGiphyMapResults(data) {
    const list = data && data.data;
    if (!Array.isArray(list)) return [];
    return list
        .map((d) => {
            const im = d.images || {};
            const url = florGiphyPickGifUrl(im);
            const preview = florGiphyPickPreviewUrl(im, url);
            return { url, preview, title: (d.title && String(d.title).trim()) || '' };
        })
        .filter((x) => x.url);
}

const FLOR_GIF_FALLBACK = [
    { url: 'https://i.giphy.com/3o7abKhOpu0NwenH3O/giphy.gif', preview: 'https://media.giphy.com/media/3o7abKhOpu0NwenH3O/200w.gif' },
    { url: 'https://i.giphy.com/26u4cqiYI30juCOGY/giphy.gif', preview: 'https://media.giphy.com/media/26u4cqiYI30juCOGY/200w.gif' },
    { url: 'https://i.giphy.com/l0MYC0LajboPxCSSY/giphy.gif', preview: 'https://media.giphy.com/media/l0MYC0LajboPxCSSY/200w.gif' },
    { url: 'https://i.giphy.com/xT5LMHxhOfscxPfIfm/giphy.gif', preview: 'https://media.giphy.com/media/xT5LMHxhOfscxPfIfm/200w.gif' },
    { url: 'https://i.giphy.com/3ohzdIuqgS4LZ7Av7y/giphy.gif', preview: 'https://media.giphy.com/media/3ohzdIuqgS4LZ7Av7y/200w.gif' },
    { url: 'https://i.giphy.com/3o6ZtpxWZbqty0A6w8/giphy.gif', preview: 'https://media.giphy.com/media/3o6ZtpxWZbqty0A6w8/200w.gif' },
    { url: 'https://i.giphy.com/d3mlmmM5NRTY1aG0/giphy.gif', preview: 'https://media.giphy.com/media/d3mlmmM5NRTY1aG0/200w.gif' },
    { url: 'https://i.giphy.com/26BRvoyThfJ6qn6wGJ/giphy.gif', preview: 'https://media.giphy.com/media/26BRvoyThfJ6qn6wGJ/200w.gif' },
    { url: 'https://i.giphy.com/3o6gDWuZfxojYfYg7S/giphy.gif', preview: 'https://media.giphy.com/media/3o6gDWuZfxojYfYg7S/200w.gif' },
    { url: 'https://i.giphy.com/l3V0j3ytFyGHqiV3W/giphy.gif', preview: 'https://media.giphy.com/media/l3V0j3ytFyGHqiV3W/200w.gif' },
    { url: 'https://i.giphy.com/5GoVLqeAOo6PK/giphy.gif', preview: 'https://media.giphy.com/media/5GoVLqeAOo6PK/200w.gif' },
    { url: 'https://i.giphy.com/3oz8xZdA5iJqVbN8mQ/giphy.gif', preview: 'https://media.giphy.com/media/3oz8xZdA5iJqVbN8mQ/200w.gif' },
    { url: 'https://i.giphy.com/3o6ZtaO9BZHcOJ3zoQ/giphy.gif', preview: 'https://media.giphy.com/media/3o6ZtaO9BZHcOJ3zoQ/200w.gif' },
    { url: 'https://i.giphy.com/2xPMZqKZrOQeI/giphy.gif', preview: 'https://media.giphy.com/media/2xPMZqKZrOQeI/200w.gif' },
    { url: 'https://i.giphy.com/3ohzdRmVbTjN9YjR8e/giphy.gif', preview: 'https://media.giphy.com/media/3ohzdRmVbTjN9YjR8e/200w.gif' },
    { url: 'https://i.giphy.com/3o6ZtpXBXBMBnQjS9e/giphy.gif', preview: 'https://media.giphy.com/media/3o6ZtpXBXBMBnQjS9e/200w.gif' },
    { url: 'https://i.giphy.com/l3V0A9kQ0h7dH9iEe/giphy.gif', preview: 'https://media.giphy.com/media/l3V0A9kQ0h7dH9iEe/200w.gif' },
    { url: 'https://i.giphy.com/3o7TKSjRrfIPjei7Wo/giphy.gif', preview: 'https://media.giphy.com/media/3o7TKSjRrfIPjei7Wo/200w.gif' },
    { url: 'https://i.giphy.com/3o6ZtehQhVj0kN6C7a/giphy.gif', preview: 'https://media.giphy.com/media/3o6ZtehQhVj0kN6C7a/200w.gif' },
    { url: 'https://i.giphy.com/14udF3QJq1nV0k/giphy.gif', preview: 'https://media.giphy.com/media/14udF3QJq1nV0k/200w.gif' }
];

function florGifFallbackRotate(q) {
    const n = FLOR_GIF_FALLBACK.length;
    let h = 0;
    const s = String(q || 'x');
    for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
    const off = (Math.abs(h) % n) + n;
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(FLOR_GIF_FALLBACK[(off + i) % n]);
    }
    return out;
}

app.get('/api/gifs/search', async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=90');
    const q = String(req.query.q || 'fun')
        .trim()
        .slice(0, 80) || 'fun';
    const limit = Math.min(32, Math.max(6, parseInt(String(req.query.limit || '20'), 10) || 20));
    const key = process.env.GIPHY_API_KEY;
    if (key) {
        try {
            const cyr = /[\u0400-\u04FF]/.test(q);
            const u =
                `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(
                    key
                )}&q=${encodeURIComponent(q)}&limit=${limit}` + (cyr ? '&lang=ru' : '');
            const r = await fetch(u, { headers: { Accept: 'application/json' } });
            if (r.ok) {
                const j = await r.json();
                const results = florGiphyMapResults(j);
                if (results.length) {
                    return res.json({ source: 'giphy', q, results: results.slice(0, limit) });
                }
            }
        } catch (e) {
            console.error('GET /api/gifs/search:', e && e.message);
        }
    }
    return res.json({ source: 'fallback', q, results: florGifFallbackRotate(q).slice(0, limit) });
});

// Create uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}
app.use('/uploads', express.static(uploadsDir));

function multerFilenameFromMime(originalname, mimetype) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const mime = String(mimetype || '')
        .toLowerCase()
        .split(';')[0]
        .trim();
    const safeBase = path.basename(String(originalname || ''));
    let origExt = path.extname(safeBase).toLowerCase();
    if (/\.tar\.gz$/i.test(safeBase)) origExt = '.tar.gz';
    else if (/\.tar\.bz2$/i.test(safeBase)) origExt = '.tar.bz2';
    const mimeToExt = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/pjpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/avif': '.avif',
        'image/bmp': '.bmp',
        'image/x-ms-bmp': '.bmp',
        'image/tiff': '.tiff',
        'image/heic': '.heic',
        'image/heif': '.heif',
        'image/svg+xml': '.svg',
        'application/pdf': '.pdf',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.ms-powerpoint': '.ppt',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
        'application/vnd.oasis.opendocument.text': '.odt',
        'application/vnd.oasis.opendocument.spreadsheet': '.ods',
        'application/vnd.oasis.opendocument.presentation': '.odp',
        'text/plain': '.txt',
        'text/markdown': '.md',
        'text/x-markdown': '.md',
        'application/json': '.json',
        'text/json': '.json',
        'application/rtf': '.rtf',
        'text/rtf': '.rtf',
        'application/xml': '.xml',
        'text/xml': '.xml',
        'audio/mpeg': '.mp3',
        'audio/mp3': '.mp3',
        'audio/webm': '.webm',
        'audio/ogg': '.ogg',
        'audio/opus': '.opus',
        'audio/wav': '.wav',
        'audio/x-wav': '.wav',
        'audio/mp4': '.m4a',
        'audio/x-m4a': '.m4a',
        'audio/aac': '.aac',
        'audio/flac': '.flac',
        'audio/x-flac': '.flac',
        'video/mp4': '.mp4',
        'video/webm': '.webm',
        'video/quicktime': '.mov',
        'video/x-msvideo': '.avi',
        'video/avi': '.avi',
        'video/mpeg': '.mpeg',
        'video/ogg': '.ogg',
        'application/zip': '.zip',
        'application/x-zip-compressed': '.zip',
        'application/x-rar-compressed': '.rar',
        'application/x-7z-compressed': '.7z',
        'application/gzip': '.gz',
        'application/x-gtar': '.tar',
        'application/x-tar': '.tar',
        'text/html': '.html',
        'application/xhtml+xml': '.xhtml',
        'application/x-pdf': '.pdf',
        'text/csv': '.csv',
        'application/vnd.ms-excel': '.xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx'
    };
    let ext = mimeToExt[mime];
    if (!ext && origExt && /^(\.[a-z0-9]{1,10}|\.tar\.gz|\.tar\.bz2)$/i.test(origExt)) {
        ext = origExt;
    }
    if (!ext && origExt && /^\.[a-z0-9]+\.[a-z0-9]+$/i.test(origExt)) {
        ext = origExt;
    }
    if (!ext) ext = '.bin';
    if (ext === '.jpeg') ext = '.jpg';
    return `${uniqueSuffix}${ext}`;
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        cb(null, multerFilenameFromMime(file.originalname, file.mimetype));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const rawMime = String(file.mimetype || '')
            .toLowerCase()
            .split(';')[0]
            .trim();

        const allowedMimeTypes = [
            'image/jpeg',
            'image/jpg',
            'image/pjpeg',
            'image/png',
            'image/gif',
            'image/webp',
            'image/avif',
            'image/bmp',
            'image/x-ms-bmp',
            'image/tiff',
            'image/x-icon',
            'image/vnd.microsoft.icon',
            'image/heic',
            'image/heif',
            'image/svg+xml',
            'application/pdf',
            'application/x-pdf',
            'application/acrobat',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'application/vnd.oasis.opendocument.text',
            'application/vnd.oasis.opendocument.spreadsheet',
            'application/vnd.oasis.opendocument.presentation',
            'text/plain',
            'text/html',
            'application/xhtml+xml',
            'text/csv',
            'text/markdown',
            'text/x-markdown',
            'application/json',
            'text/json',
            'application/rtf',
            'text/rtf',
            'application/xml',
            'text/xml',
            'audio/mpeg',
            'audio/mp3',
            'audio/webm',
            'audio/ogg',
            'audio/opus',
            'audio/wav',
            'audio/x-wav',
            'audio/mp4',
            'audio/x-m4a',
            'audio/aac',
            'audio/flac',
            'audio/x-flac',
            'video/mp4',
            'video/webm',
            'video/quicktime',
            'video/x-msvideo',
            'video/avi',
            'video/mpeg',
            'video/ogg',
            'application/zip',
            'application/x-zip-compressed',
            'application/x-rar-compressed',
            'application/x-7z-compressed',
            'application/gzip',
            'application/x-gtar',
            'application/x-tar'
        ];

        const allowedExtensions = [
            '.jpg',
            '.jpeg',
            '.jfif',
            '.pjpeg',
            '.png',
            '.gif',
            '.webp',
            '.avif',
            '.bmp',
            '.tif',
            '.tiff',
            '.ico',
            '.heic',
            '.heif',
            '.svg',
            '.pdf',
            '.html',
            '.htm',
            '.xhtml',
            '.doc',
            '.docx',
            '.txt',
            '.csv',
            '.xls',
            '.xlsx',
            '.ppt',
            '.pptx',
            '.odt',
            '.ods',
            '.odp',
            '.md',
            '.markdown',
            '.json',
            '.xml',
            '.rtf',
            '.log',
            '.yml',
            '.yaml',
            '.mp3',
            '.mp4',
            '.webm',
            '.mov',
            '.avi',
            '.mkv',
            '.mpeg',
            '.mpg',
            '.wmv',
            '.zip',
            '.rar',
            '.7z',
            '.tar',
            '.gz',
            '.tgz',
            '.ogg',
            '.opus',
            '.wav',
            '.m4a',
            '.aac',
            '.flac'
        ];

        const safeBase = path.basename(String(file.originalname || ''));
        let ext = path.extname(safeBase).toLowerCase();
        /* .tar.gz, .tar.bz2 */
        if (/\.tar\.gz$/i.test(safeBase)) ext = '.tar.gz';
        else if (/\.tar\.bz2$/i.test(safeBase)) ext = '.tar.bz2';

        const allowedCompoundExt = ['.tar.gz', '.tar.bz2'];

        if (
            allowedMimeTypes.includes(rawMime) ||
            allowedExtensions.includes(ext) ||
            allowedCompoundExt.includes(ext)
        ) {
            cb(null, true);
        } else {
            cb(new Error('Тип файла не разрешён'), false);
        }
    }
});

/** Multer отдаёт ошибки фильтра/размера в колбэк — иначе клиент видит пустой ответ */
function uploadSingleMiddleware(fieldName) {
    return (req, res, next) => {
        upload.single(fieldName)(req, res, (err) => {
            if (!err) {
                return next();
            }
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(400).json({ error: 'Файл не больше 10 МБ' });
                }
                return res.status(400).json({ error: err.message || 'Ошибка загрузки' });
            }
            return res.status(400).json({ error: err.message || 'Ошибка загрузки' });
        });
    };
}

const profileImageUpload = multer({
    storage,
    limits: { fileSize: 4 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|png|gif|webp)$/i.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Для аватара и баннера разрешены только JPEG, PNG, GIF, WebP'), false);
        }
    }
});

const stickerPackImageUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const d = path.join(uploadsDir, 'stickers');
            if (!fs.existsSync(d)) {
                fs.mkdirSync(d, { recursive: true });
            }
            cb(null, d);
        },
        filename: (req, file, cb) => {
            cb(null, multerFilenameFromMime(file.originalname, file.mimetype));
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\//i.test(String(file.mimetype || ''))) {
            cb(null, true);
        } else {
            cb(new Error('Для стикера нужен файл изображения'), false);
        }
    }
});

function stickerUploadSingleMiddleware(fieldName) {
    return (req, res, next) => {
        stickerPackImageUpload.single(fieldName)(req, res, (err) => {
            if (!err) {
                return next();
            }
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(400).json({ error: 'Изображение не больше 2 МБ' });
                }
                return res.status(400).json({ error: err.message || 'Ошибка загрузки' });
            }
            return res.status(400).json({ error: err.message || 'Ошибка загрузки' });
        });
    };
}

// Initialize database
initializeDatabase();

// JWT middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access denied' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Сессия истекла', code: 'TOKEN_EXPIRED' });
            }
            return res.status(403).json({ error: 'Недействительный токен', code: 'TOKEN_INVALID' });
        }
        const uid = Number(decoded && decoded.id);
        if (!Number.isFinite(uid)) {
            return res.status(403).json({ error: 'Недействительный токен', code: 'TOKEN_INVALID' });
        }
        req.user = { ...decoded, id: uid };
        next();
    });
}

function normalizeAvatarForStorage(avatar) {
    if (avatar === undefined) return undefined;
    if (avatar === null) return null;
    const s = String(avatar).trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s) || s.startsWith('/uploads/')) return s.slice(0, 512);
    return s.slice(0, 4);
}

// API Routes

app.get('/api/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        requireRegisterEmailCode: String(process.env.FLOR_REQUIRE_REGISTER_EMAIL_CODE || '')
            .toLowerCase() === 'true'
    });
});

// Register
app.post('/api/register', authLimiter, async (req, res) => {
    try {
        let { username, email, password, emailCode } = req.body;
        username = typeof username === 'string' ? username.trim().slice(0, 32) : '';
        email = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 120) : '';
        password = typeof password === 'string' ? password : '';
        emailCode = typeof emailCode === 'string' ? emailCode.trim() : '';

        const requireRegisterCode =
            String(process.env.FLOR_REQUIRE_REGISTER_EMAIL_CODE || '').toLowerCase() === 'true';
        const hasValidSixDigit = /^\d{6}$/.test(emailCode);

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'All fields required' });
        }
        if (emailCode && !hasValidSixDigit) {
            return res.status(400).json({ error: 'Invalid email verification code' });
        }
        if (requireRegisterCode && !hasValidSixDigit) {
            return res.status(400).json({ error: 'Email verification code required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const existingUser = await userDB.findByEmail(email);
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        let emailVerified = false;
        let emailLoginAlerts = false;
        if (hasValidSixDigit) {
            const verifyCode = verifyStoredEmailCode(email, 'register', emailCode);
            if (!verifyCode.ok) {
                return res.status(400).json({ error: verifyCode.error });
            }
            emailVerified = true;
            emailLoginAlerts = true;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await userDB.create(username, email, hashedPassword, {
            emailVerified,
            emailLoginAlerts
        });
        
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: username.charAt(0).toUpperCase()
            }
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/auth/send-email-code', authLimiter, async (req, res) => {
    try {
        const purpose = String((req.body && req.body.purpose) || 'register')
            .trim()
            .toLowerCase();
        const email = String((req.body && req.body.email) || '')
            .trim()
            .toLowerCase();

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        if (purpose !== 'register') {
            return res.status(400).json({ error: 'Unsupported email code purpose' });
        }

        const existingUser = await userDB.findByEmail(email);
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const key = emailCodeKey(email, purpose);
        const prev = pendingEmailCodes.get(key);
        if (prev && Date.now() - prev.lastSentAt < EMAIL_CODE_RESEND_MS) {
            return res
                .status(429)
                .json({ error: 'Please wait before requesting another email code' });
        }

        const code = createEmailCode();
        await sendVerificationCodeEmail(email, code);
        pendingEmailCodes.set(key, {
            codeHash: hashEmailCode(code),
            expiresAt: Date.now() + EMAIL_CODE_TTL_MS,
            lastSentAt: Date.now()
        });

        res.json({ ok: true, expiresInSec: Math.floor(EMAIL_CODE_TTL_MS / 1000) });
    } catch (error) {
        if (error && error.message === 'EMAIL_TRANSPORT_NOT_CONFIGURED') {
            return res.status(500).json({
                error: 'Email transport is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env'
            });
        }
        console.error('send-email-code:', error);
        res.status(500).json({ error: 'Failed to send verification code' });
    }
});

app.post('/api/auth/qr/start', authLimiter, async (req, res) => {
    try {
        const s = createQrSession();
        const approveUrl = `${florOriginFromReq(req)}/login.html?qrSession=${encodeURIComponent(s.id)}`;
        const qrImage = await QRCode.toDataURL(approveUrl, {
            /* H + отступ: устойчивее к сжатию/съёмке с экрана; круглая маска в CSS ломала чтение — не возвращать */
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 320,
            color: { dark: '#0f0a1a', light: '#ffffff' }
        });
        res.json({
            sessionId: s.id,
            qrData: approveUrl,
            qrImage,
            expiresInSec: Math.floor(QR_SESSION_TTL_MS / 1000)
        });
    } catch (e) {
        console.error('qr-start:', e);
        res.status(500).json({ error: 'Failed to create QR session' });
    }
});

app.get('/api/auth/qr/poll/:sessionId', async (req, res) => {
    const sessionId = String(req.params.sessionId || '').trim();
    const s = pendingQrSessions.get(sessionId);
    if (!s || Date.now() > s.expiresAt) {
        pendingQrSessions.delete(sessionId);
        return res.status(404).json({ error: 'QR session expired' });
    }
    if (s.status !== 'approved') {
        return res.json({ status: 'pending' });
    }
    pendingQrSessions.delete(sessionId);
    return res.json({ status: 'approved', token: s.token, user: s.user });
});

app.post('/api/auth/qr/approve', authenticateToken, async (req, res) => {
    try {
        const sessionId = String((req.body && req.body.sessionId) || '').trim();
        const s = pendingQrSessions.get(sessionId);
        if (!s || Date.now() > s.expiresAt) {
            pendingQrSessions.delete(sessionId);
            return res.status(404).json({ error: 'QR session expired' });
        }
        const user = await userDB.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        s.status = 'approved';
        s.token = token;
        s.user = sanitizeUserForClient(user);
        if (Number(user.email_verified) === 1 && Number(user.email_login_alerts) === 1) {
            sendLoginAlertEmail(user.email, user.username, req.ip).catch(() => {});
        }
        res.json({ ok: true });
    } catch (e) {
        console.error('qr-approve:', e);
        res.status(500).json({ error: 'QR approve failed' });
    }
});

// Login
app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const email = String((req.body && req.body.email) || '')
            .trim()
            .toLowerCase();
        const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
        const twoFactorCode = String((req.body && req.body.twoFactorCode) || '').trim();
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        const user = await userDB.findByEmail(email);
        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        if (Number(user.email_verified) === 1) {
            const key = emailCodeKey(email, 'login2fa');
            if (!/^\d{6}$/.test(twoFactorCode)) {
                const prev = pendingEmailCodes.get(key);
                if (!prev || Date.now() - prev.lastSentAt >= EMAIL_CODE_RESEND_MS) {
                    const code = createEmailCode();
                    await sendVerificationCodeEmail(email, code);
                    pendingEmailCodes.set(key, {
                        codeHash: hashEmailCode(code),
                        expiresAt: Date.now() + EMAIL_CODE_TTL_MS,
                        lastSentAt: Date.now()
                    });
                }
                return res.status(401).json({ error: 'Two-factor code required', code: 'TWO_FACTOR_REQUIRED' });
            }
            const verifyCode = verifyStoredEmailCode(email, 'login2fa', twoFactorCode);
            if (!verifyCode.ok) {
                return res.status(400).json({ error: verifyCode.error });
            }
        }
        
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        if (Number(user.email_verified) === 1 && Number(user.email_login_alerts) === 1) {
            sendLoginAlertEmail(user.email, user.username, req.ip).catch(() => {});
        }
        
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar || user.username.charAt(0).toUpperCase()
            }
        });
    } catch (error) {
        if (error && error.message === 'EMAIL_TRANSPORT_NOT_CONFIGURED') {
            return res.status(500).json({
                error: 'Email transport is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env'
            });
        }
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

/** Смена пароля с экрана входа: email + текущий пароль + новый (без JWT) */
app.post('/api/auth/change-password-prelogin', authLimiter, async (req, res) => {
    try {
        const email = String((req.body && req.body.email) || '')
            .trim()
            .toLowerCase();
        const currentPassword =
            typeof (req.body && req.body.currentPassword) === 'string' ? req.body.currentPassword : '';
        const newPassword = typeof (req.body && req.body.newPassword) === 'string' ? req.body.newPassword : '';
        if (!email || !currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Email, current password and new password required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }
        const user = await userDB.findByEmail(email);
        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        const hashed = await bcrypt.hash(newPassword, 10);
        await userDB.updatePassword(user.id, hashed);
        res.json({ ok: true });
    } catch (error) {
        console.error('change-password-prelogin:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

app.post('/api/user/email-alerts/send-code', authenticateToken, authLimiter, async (req, res) => {
    try {
        const user = await userDB.findById(req.user.id);
        if (!user || !user.email) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        const email = String(user.email).trim().toLowerCase();
        const key = emailCodeKey(email, 'alerts');
        const prev = pendingEmailCodes.get(key);
        if (prev && Date.now() - prev.lastSentAt < EMAIL_CODE_RESEND_MS) {
            return res.status(429).json({ error: 'Please wait before requesting another email code' });
        }
        const code = createEmailCode();
        await sendVerificationCodeEmail(email, code);
        pendingEmailCodes.set(key, {
            codeHash: hashEmailCode(code),
            expiresAt: Date.now() + EMAIL_CODE_TTL_MS,
            lastSentAt: Date.now()
        });
        res.json({ ok: true });
    } catch (error) {
        if (error && error.message === 'EMAIL_TRANSPORT_NOT_CONFIGURED') {
            return res.status(500).json({
                error: 'Email transport is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env'
            });
        }
        console.error('email-alerts/send-code:', error);
        res.status(500).json({ error: 'Failed to send verification code' });
    }
});

app.post('/api/user/email-alerts/confirm', authenticateToken, authLimiter, async (req, res) => {
    try {
        const code = String((req.body && req.body.code) || '').trim();
        if (!/^\d{6}$/.test(code)) {
            return res.status(400).json({ error: 'Email verification code required' });
        }
        const user = await userDB.findById(req.user.id);
        if (!user || !user.email) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        const verify = verifyStoredEmailCode(user.email, 'alerts', code);
        if (!verify.ok) {
            return res.status(400).json({ error: verify.error });
        }
        await userDB.updateEmailSecurity(req.user.id, { email_verified: 1, email_login_alerts: 1 });
        res.json({ ok: true });
    } catch (e) {
        console.error('email-alerts/confirm:', e);
        res.status(500).json({ error: 'Failed to enable email alerts' });
    }
});

app.post('/api/reports', authenticateToken, async (req, res) => {
    try {
        const targetType = String((req.body && req.body.targetType) || '').trim().toLowerCase();
        const targetId = parseInt(req.body && req.body.targetId, 10);
        let serverId = parseInt(req.body && req.body.serverId, 10);
        const reason = String((req.body && req.body.reason) || '').trim().slice(0, 120);
        const details = String((req.body && req.body.details) || '').trim().slice(0, 1200);
        if (!['message', 'user', 'server'].includes(targetType)) {
            return res.status(400).json({ error: 'Некорректный тип жалобы' });
        }
        if (!reason) {
            return res.status(400).json({ error: 'Укажите причину жалобы' });
        }
        if ((targetType === 'message' || targetType === 'user') && Number.isNaN(targetId)) {
            return res.status(400).json({ error: 'Некорректная цель жалобы' });
        }
        if (targetType === 'server' && Number.isNaN(serverId)) {
            return res.status(400).json({ error: 'Некорректная группа' });
        }

        if (targetType === 'message') {
            const meta = await messageDB.getMeta(targetId);
            if (!meta) return res.status(404).json({ error: 'Сообщение не найдено' });
            const ch = await channelDB.getById(meta.channel_id);
            if (!ch) return res.status(404).json({ error: 'Канал не найден' });
            serverId = Number(ch.server_id);
            if (!(await assertServerMember(req.user.id, serverId))) {
                return res.status(403).json({ error: 'Нет доступа к этой группе' });
            }
        } else if (targetType === 'user') {
            if (Number.isNaN(serverId)) {
                return res.status(400).json({ error: 'Укажите группу для жалобы на пользователя' });
            }
            if (!(await assertServerMember(req.user.id, serverId))) {
                return res.status(403).json({ error: 'Нет доступа к этой группе' });
            }
        } else {
            if (!(await assertServerMember(req.user.id, serverId))) {
                return res.status(403).json({ error: 'Нет доступа к этой группе' });
            }
        }

        const created = await moderationReportDB.create({
            reporterId: req.user.id,
            serverId,
            targetType,
            targetId: Number.isNaN(targetId) ? null : targetId,
            reason,
            details
        });
        res.status(201).json({ ok: true, id: created.id });
    } catch (e) {
        console.error('POST /api/reports:', e);
        res.status(500).json({ error: 'Не удалось отправить жалобу' });
    }
});

app.get('/api/servers/:serverId/reports', authenticateToken, async (req, res) => {
    try {
        const sid = parseInt(req.params.serverId, 10);
        if (Number.isNaN(sid)) return res.status(400).json({ error: 'Некорректная группа' });
        const srv = await assertServerOwner(req.user.id, sid);
        if (!srv) return res.status(403).json({ error: 'Только владелец может смотреть жалобы' });
        const status = String((req.query && req.query.status) || 'open').trim().toLowerCase();
        const rows = await moderationReportDB.getByServer(sid, status || 'open');
        res.json(rows);
    } catch (e) {
        console.error('GET /api/servers/:serverId/reports:', e);
        res.status(500).json({ error: 'Не удалось загрузить жалобы' });
    }
});

app.patch('/api/reports/:reportId/resolve', authenticateToken, async (req, res) => {
    try {
        const rid = parseInt(req.params.reportId, 10);
        if (Number.isNaN(rid)) return res.status(400).json({ error: 'Некорректная жалоба' });
        const row = await moderationReportDB.findById(rid);
        if (!row) return res.status(404).json({ error: 'Жалоба не найдена' });
        const srv = await assertServerOwner(req.user.id, row.server_id);
        if (!srv) return res.status(403).json({ error: 'Только владелец может закрывать жалобы' });
        await moderationReportDB.resolve(rid, req.user.id);
        res.json({ ok: true });
    } catch (e) {
        console.error('PATCH /api/reports/:reportId/resolve:', e);
        res.status(500).json({ error: 'Не удалось закрыть жалобу' });
    }
});

// Get user profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const user = await userDB.findById(req.user.id);
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get profile' });
    }
});

// Update profile (avatar letter / short label shown in UI)
app.put('/api/user/identity-key', authenticateToken, async (req, res) => {
    try {
        const publicJwk = req.body && req.body.publicJwk;
        if (
            !publicJwk ||
            typeof publicJwk !== 'object' ||
            publicJwk.kty !== 'EC' ||
            publicJwk.crv !== 'P-256' ||
            typeof publicJwk.x !== 'string' ||
            typeof publicJwk.y !== 'string'
        ) {
            return res.status(400).json({ error: 'Нужен публичный ключ ECDH P-256 (JWK)' });
        }
        const changes = await userDB.setIdentityPublicJwk(req.user.id, publicJwk);
        if (!changes.changes) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        res.json({ ok: true });
    } catch (error) {
        console.error('identity-key:', error);
        res.status(500).json({ error: 'Не удалось сохранить ключ' });
    }
});

app.patch('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const { avatar, bio, profile_banner } = req.body || {};
        const userRow = await userDB.findById(req.user.id);
        if (!userRow) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        const patch = {};
        if (avatar !== undefined) {
            patch.avatar = normalizeAvatarForStorage(avatar);
        }
        if (bio !== undefined) {
            const b = bio === null ? null : String(bio).trim().slice(0, 500);
            patch.bio = b || null;
        }
        if (profile_banner !== undefined) {
            const raw = profile_banner === null ? null : String(profile_banner).trim();
            if (raw && !/^https?:\/\//i.test(raw) && !raw.startsWith('/uploads/')) {
                return res.status(400).json({ error: 'Некорректный URL баннера' });
            }
            patch.profile_banner = raw ? raw.slice(0, 512) : null;
        }
        if (Object.keys(patch).length) {
            await userDB.updateProfile(req.user.id, patch);
        }
        const user = await userDB.findById(req.user.id);
        const displayAvatar =
            user.avatar && String(user.avatar).trim()
                ? user.avatar
                : user.username.charAt(0).toUpperCase();
        res.json({
            id: user.id,
            username: user.username,
            email: user.email,
            avatar: displayAvatar,
            bio: user.bio || '',
            profile_banner: user.profile_banner || null
        });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ error: 'Не удалось сохранить профиль' });
    }
});

app.post(
    '/api/user/profile-photo',
    authenticateToken,
    profileImageUpload.single('file'),
    async (req, res) => {
        try {
            const kind = String(
                (req.query && req.query.kind) || (req.body && req.body.kind) || ''
            ).trim();
            if (!req.file) {
                return res.status(400).json({ error: 'Нет файла' });
            }
            if (kind !== 'avatar' && kind !== 'banner') {
                return res.status(400).json({
                    error: 'Укажите kind в адресе: ?kind=avatar или ?kind=banner'
                });
            }
            await fileDB.create(
                req.file.filename,
                req.file.path,
                req.file.mimetype,
                req.file.size,
                req.user.id,
                null
            );
            const url = `/uploads/${req.file.filename}`;
            if (kind === 'avatar') {
                await userDB.updateProfile(req.user.id, { avatar: url });
            } else {
                await userDB.updateProfile(req.user.id, { profile_banner: url });
            }
            const user = await userDB.findById(req.user.id);
            res.json({
                url,
                avatar:
                    user.avatar && String(user.avatar).trim()
                        ? user.avatar
                        : user.username.charAt(0).toUpperCase(),
                profile_banner: user.profile_banner || null
            });
        } catch (error) {
            console.error('profile-photo:', error);
            res.status(500).json({ error: 'Не удалось загрузить файл' });
        }
    }
);

app.delete('/api/messages/:messageId', authenticateToken, async (req, res) => {
    try {
        const messageId = parseInt(req.params.messageId, 10);
        if (Number.isNaN(messageId)) {
            return res.status(400).json({ error: 'Некорректный id' });
        }
        const meta = await messageDB.getMeta(messageId);
        if (!meta) {
            return res.status(404).json({ error: 'Сообщение не найдено' });
        }
        if (Number(meta.user_id) !== Number(req.user.id)) {
            return res.status(403).json({ error: 'Можно удалять только свои сообщения' });
        }
        const access = await assertChannelMember(req.user.id, meta.channel_id);
        if (!access.ok) {
            return res.status(403).json({ error: access.error || 'Нет доступа' });
        }
        const ch = await channelDB.getById(meta.channel_id);
        if (!ch) {
            return res.status(404).json({ error: 'Канал не найден' });
        }
        const result = await messageDB.deleteOwn(messageId, req.user.id);
        if (!result.changes) {
            return res.status(404).json({ error: 'Не удалено' });
        }
        pinDB
            .listChannelPins(meta.channel_id)
            .then((pins) => {
                io.to(`server-${ch.server_id}`).emit('channel-pins-updated', {
                    channelId: meta.channel_id,
                    pins
                });
            })
            .catch(() => {});
        io.to(`server-${ch.server_id}`).emit('message-deleted', {
            channelId: meta.channel_id,
            messageId
        });
        res.json({ ok: true });
    } catch (error) {
        console.error('DELETE message:', error);
        res.status(500).json({ error: 'Не удалось удалить сообщение' });
    }
});

app.delete('/api/messages/:messageId/moderate', authenticateToken, async (req, res) => {
    try {
        const messageId = parseInt(req.params.messageId, 10);
        if (Number.isNaN(messageId)) {
            return res.status(400).json({ error: 'Некорректный id' });
        }
        const meta = await messageDB.getMeta(messageId);
        if (!meta) {
            return res.status(404).json({ error: 'Сообщение не найдено' });
        }
        const ch = await channelDB.getById(meta.channel_id);
        if (!ch || ch.server_id == null) {
            return res.status(404).json({ error: 'Канал не найден' });
        }
        const srv = await assertServerOwner(req.user.id, ch.server_id);
        if (!srv) {
            return res.status(403).json({ error: 'Только владелец группы может удалить чужое сообщение' });
        }
        const result = await messageDB.deleteOwn(messageId, meta.user_id);
        if (!result.changes) {
            return res.status(404).json({ error: 'Не удалено' });
        }
        pinDB
            .listChannelPins(meta.channel_id)
            .then((pins) => {
                io.to(`server-${ch.server_id}`).emit('channel-pins-updated', {
                    channelId: meta.channel_id,
                    pins
                });
            })
            .catch(() => {});
        io.to(`server-${ch.server_id}`).emit('message-deleted', {
            channelId: meta.channel_id,
            messageId
        });
        res.json({ ok: true });
    } catch (error) {
        console.error('DELETE moderated message:', error);
        res.status(500).json({ error: 'Не удалось удалить сообщение' });
    }
});

app.delete('/api/dm-messages/:messageId', authenticateToken, async (req, res) => {
    try {
        const messageId = parseInt(req.params.messageId, 10);
        if (Number.isNaN(messageId)) {
            return res.status(400).json({ error: 'Некорректный id' });
        }
        const dm = await dmDB.getById(messageId);
        if (!dm) {
            return res.status(404).json({ error: 'Сообщение не найдено' });
        }
        if (Number(dm.sender_id) !== Number(req.user.id)) {
            return res.status(403).json({ error: 'Можно удалять только свои сообщения' });
        }
        try {
            await dmDB.deleteReactionsFor(messageId);
        } catch (re) {
            console.warn('dm reactions delete:', re && re.message);
        }
        const result = await dmDB.deleteOwnMessage(messageId, req.user.id);
        if (!result.changes) {
            return res.status(404).json({ error: 'Не удалено' });
        }
        const a = Number(dm.sender_id);
        const b = Number(dm.receiver_id);
        pinDB
            .listDmPinsForPeerPair(a, b)
            .then((pins) => {
                emitFlorDmPinsToUsers(a, b, { pins });
            })
            .catch(() => {});
        emitToUserSockets(dm.sender_id, 'dm-message-deleted', { messageId });
        emitToUserSockets(dm.receiver_id, 'dm-message-deleted', { messageId });
        res.json({ ok: true });
    } catch (error) {
        console.error('DELETE dm message:', error);
        res.status(500).json({ error: 'Не удалось удалить сообщение' });
    }
});

app.get('/api/users/:userId/public', authenticateToken, async (req, res) => {
    try {
        const uid = parseInt(req.params.userId, 10);
        if (Number.isNaN(uid)) {
            return res.status(400).json({ error: 'Некорректный id' });
        }
        if (uid !== req.user.id) {
            const okFriend = await friendDB.checkFriendship(req.user.id, uid);
            if (!okFriend) {
                return res.status(403).json({ error: 'Профиль доступен только друзьям' });
            }
        }
        const u = await userDB.findById(uid);
        if (!u) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        res.json({
            id: u.id,
            username: u.username,
            avatar:
                u.avatar && String(u.avatar).trim() ? u.avatar : u.username.charAt(0).toUpperCase(),
            bio: u.bio || '',
            profile_banner: u.profile_banner || null,
            status: u.status || 'Online'
        });
    } catch (error) {
        console.error('public profile:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/user/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        if (!currentPassword || typeof currentPassword !== 'string') {
            return res.status(400).json({ error: 'Введите текущий пароль' });
        }
        if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
            return res.status(400).json({ error: 'Новый пароль — не менее 6 символов' });
        }
        const row = await userDB.findWithPasswordById(req.user.id);
        if (!row) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        const match = await bcrypt.compare(currentPassword, row.password);
        if (!match) {
            return res.status(400).json({ error: 'Неверный текущий пароль' });
        }
        const hashed = await bcrypt.hash(newPassword, 10);
        await userDB.updatePassword(req.user.id, hashed);
        res.json({ ok: true });
    } catch (error) {
        console.error('change-password:', error);
        res.status(500).json({ error: 'Не удалось сменить пароль' });
    }
});

// Get all users (без email — только для поиска друзей)
app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        const users = await userDB.getAll();
        res.json(
            users.map((u) => {
                const jwks = mapUserIdentityJwks(u);
                return {
                    id: u.id,
                    username: u.username,
                    avatar: u.avatar,
                    status: u.status,
                    identityPublicJwks: jwks,
                    identityPublicJwk: jwks[0] || null
                };
            })
        );
    } catch (error) {
        res.status(500).json({ error: 'Failed to get users' });
    }
});

// File upload
app.post('/api/upload', authenticateToken, uploadSingleMiddleware('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const channelId = parseInt(req.body.channelId, 10);
        if (Number.isNaN(channelId)) {
            return res.status(400).json({ error: 'Некорректный канал' });
        }

        const access = await assertChannelMember(req.user.id, channelId);
        if (!access.ok) {
            return res.status(access.status).json({ error: access.error });
        }

        const fileRecord = await fileDB.create(
            req.file.filename,
            req.file.path,
            req.file.mimetype,
            req.file.size,
            req.user.id,
            channelId
        );
        
        res.json({
            id: fileRecord.id,
            filename: req.file.originalname,
            url: `/uploads/${req.file.filename}`,
            type: req.file.mimetype,
            size: req.file.size
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

/** Вложения в ЛС (channel_id = NULL): те же типы, что и в канале сервера */
app.post('/api/dm/upload', authenticateToken, uploadSingleMiddleware('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Нет файла' });
        }
        const receiverId = parseInt(req.body && req.body.receiverId, 10);
        if (Number.isNaN(receiverId)) {
            return res.status(400).json({ error: 'Некорректный получатель' });
        }
        const friendsOk = await friendDB.checkFriendship(req.user.id, receiverId);
        if (!friendsOk) {
            return res.status(403).json({ error: 'Можно отправлять только друзьям' });
        }
        await fileDB.create(
            req.file.filename,
            req.file.path,
            req.file.mimetype,
            req.file.size,
            req.user.id,
            null
        );
        res.json({
            id: req.file.filename,
            filename: req.file.originalname,
            url: `/uploads/${req.file.filename}`,
            type: req.file.mimetype,
            size: req.file.size
        });
    } catch (error) {
        console.error('DM upload error:', error);
        res.status(500).json({ error: 'Не удалось загрузить' });
    }
});

// Паки стикеров: свои + публичные; файлы в /uploads/stickers/
app.get('/api/sticker-packs', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const packRows = await stickerPackDB.listPacksForUser(userId);
        const packs = [];
        for (const p of packRows) {
            const items = await stickerPackDB.listItems(p.id);
            packs.push({
                id: p.id,
                name: p.name,
                is_public: !!Number(p.is_public),
                owner_id: p.owner_id,
                owner_name: p.owner_name,
                mine: Number(p.owner_id) === Number(userId),
                items: items.map((it) => {
                    const fn = String(it.filename || '').replace(/^\//, '');
                    return {
                        id: it.id,
                        url: fn.startsWith('stickers/') ? `/uploads/${fn}` : `/uploads/stickers/${fn}`
                    };
                })
            });
        }
        res.json({ packs });
    } catch (e) {
        console.error('GET /api/sticker-packs:', e);
        res.status(500).json({ error: 'Ошибка загрузки паков' });
    }
});

app.post('/api/sticker-packs', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const n = await stickerPackDB.countByOwner(userId);
        if (n >= FLOR_MAX_STICKER_PACKS_PER_USER) {
            return res.status(400).json({ error: `Максимум ${FLOR_MAX_STICKER_PACKS_PER_USER} паков` });
        }
        const name = req.body && req.body.name;
        const isPublic = !!(
            req.body &&
            (req.body.is_public === true ||
                req.body.is_public === '1' ||
                req.body.is_public === 1 ||
                req.body.is_public === 'true')
        );
        const row = await stickerPackDB.create(userId, name, isPublic);
        res.json({ pack: { id: row.id, name: row.name, is_public: !!row.is_public, owner_id: row.owner_id } });
    } catch (e) {
        if (e && e.message === 'EMPTY_NAME') {
            return res.status(400).json({ error: 'Введите название пака' });
        }
        console.error('POST /api/sticker-packs:', e);
        res.status(500).json({ error: 'Не удалось создать пак' });
    }
});

app.post(
    '/api/sticker-packs/:packId/stickers',
    authenticateToken,
    stickerUploadSingleMiddleware('file'),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'Нет файла' });
            }
            const packId = parseInt(req.params.packId, 10);
            if (Number.isNaN(packId)) {
                return res.status(400).json({ error: 'Некорректный пак' });
            }
            const pack = await stickerPackDB.getPack(packId);
            if (!pack) {
                return res.status(404).json({ error: 'Пак не найден' });
            }
            if (Number(pack.owner_id) !== Number(req.user.id)) {
                return res.status(403).json({ error: 'Можно добавлять только в свои паки' });
            }
            const cnt = await stickerPackDB.countItemsInPack(packId);
            if (cnt >= FLOR_MAX_STICKERS_PER_PACK) {
                return res.status(400).json({ error: `В паке максимум ${FLOR_MAX_STICKERS_PER_PACK} стикеров` });
            }
            const rel = 'stickers/' + req.file.filename;
            const item = await stickerPackDB.addItem(packId, rel, cnt);
            res.json({
                item: {
                    id: item.id,
                    url: '/uploads/' + rel
                }
            });
        } catch (e) {
            console.error('POST /api/sticker-packs/:id/stickers:', e);
            res.status(500).json({ error: 'Не удалось сохранить стикер' });
        }
    }
);

// Get messages by channel (только участники сервера)
app.get('/api/messages/:channelId', authenticateToken, async (req, res) => {
    try {
        const access = await assertChannelMember(req.user.id, req.params.channelId);
        if (!access.ok) {
            return res.status(access.status).json({ error: access.error });
        }
        const cid = parseInt(req.params.channelId, 10);
        const messages = await messageDB.getByChannel(cid);
        const ids = messages.map((m) => m.id);
        const rmap = await reactionDB.getByMessageIds(ids);
        messages.forEach((m) => {
            m.reactions = rmap[m.id] || [];
        });
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get messages' });
    }
});

app.get('/api/channels/:channelId/pins', authenticateToken, async (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId, 10);
        if (Number.isNaN(channelId)) {
            return res.status(400).json({ error: 'Некорректный канал' });
        }
        const access = await assertChannelMember(req.user.id, channelId);
        if (!access.ok) {
            return res.status(access.status).json({ error: access.error });
        }
        const pins = await pinDB.listChannelPins(channelId);
        res.json({ pins });
    } catch (error) {
        console.error('GET channel pins:', error);
        res.status(500).json({ error: 'Failed to get pins' });
    }
});

app.post('/api/channels/:channelId/pins', authenticateToken, async (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId, 10);
        const messageId = parseInt(req.body && req.body.messageId, 10);
        if (Number.isNaN(channelId) || Number.isNaN(messageId)) {
            return res.status(400).json({ error: 'Некорректные данные' });
        }
        const access = await assertChannelMember(req.user.id, channelId);
        if (!access.ok) {
            return res.status(access.status).json({ error: access.error });
        }
        const meta = await messageDB.getMeta(messageId);
        if (!meta || Number(meta.channel_id) !== channelId) {
            return res.status(404).json({ error: 'Сообщение не найдено в канале' });
        }
        const n = await pinDB.countChannelPins(channelId);
        if (n >= FLOR_MAX_CHANNEL_PINS) {
            return res.status(400).json({ error: `Нельзя закрепить больше ${FLOR_MAX_CHANNEL_PINS} сообщений` });
        }
        try {
            await pinDB.addChannelPin(channelId, messageId, req.user.id);
        } catch (e) {
            if (e && (e.message || '').indexOf('UNIQUE') >= 0) {
                const pins = await pinDB.listChannelPins(channelId);
                return res.json({ ok: true, already: true, pins });
            }
            throw e;
        }
        const pins = await pinDB.listChannelPins(channelId);
        io.to(`server-${access.channel.server_id}`).emit('channel-pins-updated', { channelId, pins });
        res.json({ ok: true, pins });
    } catch (error) {
        console.error('POST channel pin:', error);
        res.status(500).json({ error: 'Не удалось закрепить' });
    }
});

app.delete('/api/channels/:channelId/pins/:messageId', authenticateToken, async (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId, 10);
        const messageId = parseInt(req.params.messageId, 10);
        if (Number.isNaN(channelId) || Number.isNaN(messageId)) {
            return res.status(400).json({ error: 'Некорректные данные' });
        }
        const access = await assertChannelMember(req.user.id, channelId);
        if (!access.ok) {
            return res.status(access.status).json({ error: access.error });
        }
        await pinDB.removeChannelPin(channelId, messageId);
        const pins = await pinDB.listChannelPins(channelId);
        io.to(`server-${access.channel.server_id}`).emit('channel-pins-updated', { channelId, pins });
        res.json({ ok: true, pins });
    } catch (error) {
        console.error('DELETE channel pin:', error);
        res.status(500).json({ error: 'Не удалось убрать закрепление' });
    }
});

app.get('/api/dm/pins', authenticateToken, async (req, res) => {
    try {
        const peerId = parseInt(req.query && req.query.peerId, 10);
        if (Number.isNaN(peerId)) {
            return res.status(400).json({ error: 'Некорректный peerId' });
        }
        if (peerId === req.user.id) {
            return res.status(400).json({ error: 'Некорректный запрос' });
        }
        const allowed = await friendDB.checkFriendship(req.user.id, peerId);
        if (!allowed) {
            return res.status(403).json({ error: 'Нет доступа' });
        }
        const pins = await pinDB.listDmPinsForPeerPair(req.user.id, peerId);
        res.json({ pins });
    } catch (error) {
        console.error('GET dm pins:', error);
        res.status(500).json({ error: 'Failed to get pins' });
    }
});

app.post('/api/dm/pins', authenticateToken, async (req, res) => {
    try {
        const messageId = parseInt(req.body && req.body.messageId, 10);
        const peerId = parseInt(req.body && req.body.peerId, 10);
        if (Number.isNaN(messageId) || Number.isNaN(peerId)) {
            return res.status(400).json({ error: 'Некорректные данные' });
        }
        if (peerId === req.user.id) {
            return res.status(400).json({ error: 'Некорректный запрос' });
        }
        const allowed = await friendDB.checkFriendship(req.user.id, peerId);
        if (!allowed) {
            return res.status(403).json({ error: 'Нет доступа' });
        }
        const dm = await dmDB.getById(messageId);
        if (!dm) {
            return res.status(404).json({ error: 'Сообщение не найдено' });
        }
        const a = Number(req.user.id);
        const b = Number(peerId);
        const ok =
            (Number(dm.sender_id) === a && Number(dm.receiver_id) === b) ||
            (Number(dm.sender_id) === b && Number(dm.receiver_id) === a);
        if (!ok) {
            return res.status(400).json({ error: 'Сообщение не из этого чата' });
        }
        const cur = await pinDB.listDmPinsForPeerPair(a, b);
        if (cur.length >= FLOR_MAX_DM_PINS) {
            return res.status(400).json({ error: `Нельзя закрепить больше ${FLOR_MAX_DM_PINS} сообщений` });
        }
        try {
            await pinDB.addDmPin(messageId, req.user.id);
        } catch (e) {
            if (e && (e.message || '').indexOf('UNIQUE') >= 0) {
                const pins = await pinDB.listDmPinsForPeerPair(a, b);
                return res.json({ ok: true, already: true, pins });
            }
            throw e;
        }
        const pins = await pinDB.listDmPinsForPeerPair(a, b);
        emitFlorDmPinsToUsers(a, b, { peerId, pins });
        res.json({ ok: true, pins });
    } catch (error) {
        console.error('POST dm pin:', error);
        res.status(500).json({ error: 'Не удалось закрепить' });
    }
});

app.delete('/api/dm/pins/:messageId', authenticateToken, async (req, res) => {
    try {
        const messageId = parseInt(req.params.messageId, 10);
        const peerId = parseInt(
            (req.query && req.query.peerId) || (req.body && req.body.peerId),
            10
        );
        if (Number.isNaN(messageId) || Number.isNaN(peerId)) {
            return res.status(400).json({ error: 'Некорректные данные' });
        }
        const allowed = await friendDB.checkFriendship(req.user.id, peerId);
        if (!allowed) {
            return res.status(403).json({ error: 'Нет доступа' });
        }
        const dm = await dmDB.getById(messageId);
        if (dm) {
            const a = Number(req.user.id);
            const b = Number(peerId);
            const ok =
                (Number(dm.sender_id) === a && Number(dm.receiver_id) === b) ||
                (Number(dm.sender_id) === b && Number(dm.receiver_id) === a);
            if (!ok) {
                return res.status(400).json({ error: 'Сообщение не из этого чата' });
            }
        }
        await pinDB.removeDmPin(messageId);
        const a = Number(req.user.id);
        const b = Number(peerId);
        const pins = await pinDB.listDmPinsForPeerPair(a, b);
        emitFlorDmPinsToUsers(a, b, { peerId, pins });
        res.json({ ok: true, pins });
    } catch (error) {
        console.error('DELETE dm pin:', error);
        res.status(500).json({ error: 'Не удалось убрать закрепление' });
    }
});

/** Отправка в канал сервера (надёжнее чистого socket: видно ошибки доступа) */
app.post('/api/messages', authenticateToken, async (req, res) => {
    try {
        const channelId = parseInt(req.body && req.body.channelId, 10);
        const norm = normalizeMessageTextInput(req.body && req.body.text);
        if (Number.isNaN(channelId) || !norm.ok) {
            return res.status(400).json({ error: norm.error || 'Некорректное сообщение' });
        }
        const text = norm.text;
        const access = await assertChannelMember(req.user.id, channelId);
        if (!access.ok) {
            return res.status(access.status).json({ error: access.error });
        }
        let replyToId = null;
        if (req.body && req.body.replyToId != null && req.body.replyToId !== '') {
            const r = parseInt(req.body.replyToId, 10);
            if (!Number.isNaN(r)) {
                const rmeta = await messageDB.getMeta(r);
                if (rmeta && Number(rmeta.channel_id) === channelId) {
                    replyToId = r;
                }
            }
        }
        const saved = await messageDB.create(text, req.user.id, channelId, replyToId);
        const row = await messageDB.getByIdWithReply(saved.id);
        const broadcastMessage = florChannelRowToBroadcastMessage(row);
        io.to(`server-${access.channel.server_id}`).emit('new-message', {
            channelId,
            serverId: access.channel.server_id,
            channelName: access.channel.name,
            message: broadcastMessage
        });
        res.status(201).json({ message: broadcastMessage });
    } catch (error) {
        console.error('POST /api/messages:', error);
        res.status(500).json({ error: 'Не удалось отправить сообщение' });
    }
});

// Get direct messages (только между взаимными друзьями)
app.get('/api/dm/:userId', authenticateToken, async (req, res) => {
    try {
        const other = parseInt(req.params.userId, 10);
        if (Number.isNaN(other)) {
            return res.status(400).json({ error: 'Некорректный пользователь' });
        }
        if (other === req.user.id) {
            return res.status(400).json({ error: 'Нельзя открыть чат с собой' });
        }
        const allowed = await friendDB.checkFriendship(req.user.id, other);
        if (!allowed) {
            return res.status(403).json({ error: 'Личные сообщения доступны только друзьям' });
        }
        const messages = await dmDB.getConversation(req.user.id, other);
        const dmIds = messages.map((m) => m.id);
        const rmap = await dmReactionDB.getByDmMessageIds(dmIds);
        messages.forEach((m) => {
            m.reactions = rmap[m.id] || [];
        });
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get messages' });
    }
});

/** Сводка ЛС: последнее сообщение по каждому диалогу и счётчики непрочитанного (для списка чатов). */
app.get('/api/dm/inbox', authenticateToken, async (req, res) => {
    try {
        const { conversations } = await dmDB.listInboxSummariesForUser(req.user.id);
        res.json({ conversations });
    } catch (error) {
        console.error('GET /api/dm/inbox:', error);
        res.status(500).json({ error: 'Не удалось загрузить список переписок' });
    }
});

/** Пометить все сообщения от partnerId ко мне как прочитанные; собеседник получит socket dm-read-receipt (все вкладки/устройства). */
app.post('/api/dm/read', authenticateToken, async (req, res) => {
    try {
        const partnerId = parseInt(req.body && req.body.partnerId, 10);
        if (Number.isNaN(partnerId)) {
            return res.status(400).json({ error: 'Некорректный собеседник' });
        }
        if (partnerId === req.user.id) {
            return res.status(400).json({ error: 'Некорректный запрос' });
        }
        const allowed = await friendDB.checkFriendship(req.user.id, partnerId);
        if (!allowed) {
            return res.status(403).json({ error: 'Нет доступа' });
        }
        const { ids } = await dmDB.markIncomingReadReturningIds(req.user.id, partnerId);
        if (ids.length) {
            emitToUserSockets(partnerId, 'dm-read-receipt', {
                readerId: req.user.id,
                messageIds: ids
            });
        }
        res.json({ ok: true, messageIds: ids });
    } catch (error) {
        console.error('POST /api/dm/read:', error);
        res.status(500).json({ error: 'Не удалось обновить статус' });
    }
});

/**
 * Прокси к OpenAI-совместимому Chat Completions или Google Gemini (ключ с клиента или из .env).
 * Текст чата уходит на сторонний API — включайте только если доверяете провайдеру.
 */
app.post('/api/ai/complete', authenticateToken, aiUserLimiter, async (req, res) => {
    try {
        const provider = String((req.body && req.body.provider) || '').toLowerCase();
        const messages = sanitizeAiMessages(req.body && req.body.messages);
        if (!messages) {
            return res.status(400).json({ error: 'Передайте messages: [{ role, content }, …]' });
        }
        let maxT = parseInt(req.body && req.body.maxTokens, 10);
        if (!Number.isFinite(maxT)) maxT = 1200;
        maxT = Math.min(Math.max(maxT, 64), 8192);

        const clientKey = typeof req.body.apiKey === 'string' ? req.body.apiKey.trim() : '';

        if (provider === 'openai') {
            const apiKey = clientKey || process.env.OPENAI_API_KEY || process.env.FLOR_OPENAI_API_KEY || '';
            if (!apiKey) {
                return res.status(400).json({
                    error: 'Нужен API-ключ OpenAI: в Настройках → ИИ или переменная OPENAI_API_KEY / FLOR_OPENAI_API_KEY на сервере.'
                });
            }
            const baseRaw = (process.env.FLOR_OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
            const model =
                (typeof req.body.model === 'string' && req.body.model.trim()) ||
                process.env.FLOR_OPENAI_MODEL ||
                'gpt-4o-mini';
            const text = await florProxyOpenAIChat({
                baseUrl: baseRaw,
                apiKey,
                model,
                messages,
                maxTokens: maxT
            });
            return res.json({ text });
        }

        if (provider === 'gemini') {
            const apiKey = clientKey || process.env.GEMINI_API_KEY || process.env.FLOR_GEMINI_API_KEY || '';
            if (!apiKey) {
                return res.status(400).json({
                    error: 'Нужен ключ Google AI (Gemini): в Настройках → ИИ или GEMINI_API_KEY на сервере.'
                });
            }
            const model =
                (typeof req.body.model === 'string' && req.body.model.trim()) ||
                process.env.FLOR_GEMINI_MODEL ||
                'gemini-1.5-flash';
            const text = await florProxyGeminiGenerate({ apiKey, model, messages, maxTokens: maxT });
            return res.json({ text });
        }

        return res.status(400).json({ error: 'provider должен быть openai или gemini' });
    } catch (e) {
        console.error('POST /api/ai/complete:', e && e.message ? e.message : e);
        res.status(502).json({ error: e.message || 'Ошибка провайдера ИИ' });
    }
});

// Server routes
app.post('/api/servers', authenticateToken, async (req, res) => {
    try {
        const { name } = req.body;
        
        if (!name || name.trim().length < 2) {
            return res.status(400).json({ error: 'Server name must be at least 2 characters' });
        }
        
        const ownerId = Number(req.user.id);
        const server = await serverDB.create(name.trim(), ownerId);
        await serverDB.addMember(server.id, ownerId);
        const catText = await categoryDB.create(server.id, 'Текстовые каналы', 0);
        const catVoice = await categoryDB.create(server.id, 'Голосовые каналы', 1);
        await channelDB.create('general', 'text', server.id, catText.id, 0);
        await channelDB.create('random', 'text', server.id, catText.id, 1);
        await channelDB.create('voice-1', 'voice', server.id, catVoice.id, 0);
        await channelDB.create('voice-2', 'voice', server.id, catVoice.id, 1);

        res.json(server);
    } catch (error) {
        console.error('Create server error:', error);
        res.status(500).json({ error: 'Failed to create server' });
    }
});

app.get('/api/servers', authenticateToken, async (req, res) => {
    try {
        const servers = await serverDB.getUserServers(req.user.id);
        res.json(servers);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get servers' });
    }
});

app.get('/api/servers/:serverId/channels', authenticateToken, async (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId, 10);
        if (Number.isNaN(serverId)) {
            return res.status(400).json({ error: 'Некорректный сервер' });
        }
        if (!(await serverDB.isMember(serverId, req.user.id))) {
            return res.status(403).json({ error: 'Нет доступа к серверу' });
        }
        const tree = await getChannelTree(serverId);
        res.json(tree);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get channels' });
    }
});

app.patch('/api/servers/:serverId', authenticateToken, async (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId, 10);
        if (Number.isNaN(serverId)) {
            return res.status(400).json({ error: 'Некорректный сервер' });
        }
        if (!(await serverDB.isMember(serverId, req.user.id))) {
            return res.status(403).json({ error: 'Нет доступа к серверу' });
        }
        const srv = await serverDB.getById(serverId);
        if (!srv || srv.owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Только владелец может менять настройки сервера' });
        }
        const { name, icon } = req.body || {};
        const patch = {};
        if (name !== undefined && name !== null) {
            const t = String(name).trim();
            if (t.length > 0) {
                if (t.length < 2) {
                    return res.status(400).json({ error: 'Название не короче 2 символов' });
                }
                patch.name = t;
            }
        }
        if (icon !== undefined && icon !== null) {
            const ic = String(icon).trim();
            if (ic.length > 0) {
                if (ic.startsWith('/uploads/') || /^https?:\/\//i.test(ic)) {
                    patch.icon = ic.slice(0, 512);
                } else {
                    patch.icon = ic.slice(0, 16);
                }
            }
        }
        if (Object.keys(patch).length === 0) {
            const next = await serverDB.getById(serverId);
            return res.json(next);
        }
        await serverDB.update(serverId, patch);
        const next = await serverDB.getById(serverId);
        res.json(next);
    } catch (error) {
        console.error('PATCH server:', error);
        res.status(500).json({ error: 'Не удалось обновить сервер' });
    }
});

app.get('/api/servers/:serverId/members', authenticateToken, async (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId, 10);
        if (Number.isNaN(serverId)) {
            return res.status(400).json({ error: 'Некорректный сервер' });
        }
        if (!(await serverDB.isMember(serverId, req.user.id))) {
            return res.status(403).json({ error: 'Нет доступа к серверу' });
        }
        const members = await serverDB.getMembers(serverId);
        const srv = await serverDB.getById(serverId);
        res.json(
            members.map((m) => {
                const jwks = mapUserIdentityJwks(m);
                return {
                    id: m.id,
                    username: m.username,
                    avatar: m.avatar,
                    status: m.status,
                    isOwner: srv && Number(srv.owner_id) === Number(m.id),
                    identityPublicJwks: jwks,
                    identityPublicJwk: jwks[0] || null
                };
            })
        );
    } catch (error) {
        res.status(500).json({ error: 'Failed to get server members' });
    }
});

app.delete('/api/servers/:serverId/members/:userId', authenticateToken, async (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId, 10);
        const targetId = parseInt(req.params.userId, 10);
        if (Number.isNaN(serverId) || Number.isNaN(targetId)) {
            return res.status(400).json({ error: 'Некорректный запрос' });
        }
        if (!(await serverDB.isMember(serverId, req.user.id))) {
            return res.status(403).json({ error: 'Нет доступа к серверу' });
        }
        const srv = await serverDB.getById(serverId);
        if (!srv) {
            return res.status(404).json({ error: 'Сервер не найден' });
        }
        const isOwner = Number(srv.owner_id) === Number(req.user.id);
        const isSelf = Number(targetId) === Number(req.user.id);
        if (!isSelf && !isOwner) {
            return res.status(403).json({ error: 'Удалять участников может только владелец' });
        }
        if (Number(targetId) === Number(srv.owner_id)) {
            return res.status(400).json({ error: 'Нельзя удалить владельца группы' });
        }
        const ch = await serverDB.removeMember(serverId, targetId);
        if (!ch.changes) {
            return res.status(404).json({ error: 'Участник не найден' });
        }
        const kicked = Array.from(users.values()).find((u) => u.id === targetId);
        if (kicked) {
            io.to(kicked.socketId).emit('server-membership-update', { serverId, removed: true });
        }
        io.to(`server-${serverId}`).emit('server-membership-update', { serverId });
        res.json({ ok: true });
    } catch (error) {
        console.error('DELETE server member:', error);
        res.status(500).json({ error: 'Не удалось удалить участника' });
    }
});

app.post('/api/servers/:serverId/ban', authenticateToken, async (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId, 10);
        const targetId = parseInt(req.body && req.body.userId, 10);
        const reason = String((req.body && req.body.reason) || '').trim().slice(0, 240);
        if (Number.isNaN(serverId) || Number.isNaN(targetId)) {
            return res.status(400).json({ error: 'Некорректный запрос' });
        }
        const srv = await assertServerOwner(req.user.id, serverId);
        if (!srv) {
            return res.status(403).json({ error: 'Только владелец может блокировать участников' });
        }
        if (Number(targetId) === Number(srv.owner_id)) {
            return res.status(400).json({ error: 'Нельзя заблокировать владельца' });
        }
        await serverBanDB.banUser(serverId, targetId, reason || null, req.user.id);
        await serverDB.removeMember(serverId, targetId);
        for (const u of users.values()) {
            if (Number(u.id) === Number(targetId)) {
                io.to(u.socketId).emit('server-membership-update', { serverId, removed: true });
            }
        }
        io.to(`server-${serverId}`).emit('server-membership-update', { serverId });
        res.json({ ok: true });
    } catch (error) {
        console.error('POST server ban:', error);
        res.status(500).json({ error: 'Не удалось заблокировать пользователя' });
    }
});

app.delete('/api/servers/:serverId/ban/:userId', authenticateToken, async (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId, 10);
        const userId = parseInt(req.params.userId, 10);
        if (Number.isNaN(serverId) || Number.isNaN(userId)) {
            return res.status(400).json({ error: 'Некорректный запрос' });
        }
        const srv = await assertServerOwner(req.user.id, serverId);
        if (!srv) {
            return res.status(403).json({ error: 'Только владелец может снять блокировку' });
        }
        await serverBanDB.unbanUser(serverId, userId);
        res.json({ ok: true });
    } catch (error) {
        console.error('DELETE server ban:', error);
        res.status(500).json({ error: 'Не удалось снять блокировку' });
    }
});

app.post(
    '/api/servers/:serverId/icon',
    authenticateToken,
    profileImageUpload.single('file'),
    async (req, res) => {
        try {
            const serverId = parseInt(req.params.serverId, 10);
            if (Number.isNaN(serverId) || !req.file) {
                return res.status(400).json({ error: 'Некорректный запрос' });
            }
            const srv = await serverDB.getById(serverId);
            if (!srv || Number(srv.owner_id) !== Number(req.user.id)) {
                return res.status(403).json({ error: 'Только владелец может менять иконку' });
            }
            await fileDB.create(
                req.file.filename,
                req.file.path,
                req.file.mimetype,
                req.file.size,
                req.user.id,
                null
            );
            const url = `/uploads/${req.file.filename}`;
            await serverDB.update(serverId, { icon: url });
            const next = await serverDB.getById(serverId);
            io.to(`server-${serverId}`).emit('server-membership-update', { serverId });
            res.json({ url, server: next });
        } catch (error) {
            console.error('server icon:', error);
            res.status(500).json({ error: 'Не удалось загрузить иконку' });
        }
    }
);

app.get('/api/channels/:channelId/e2e-wrap', authenticateToken, async (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId, 10);
        if (Number.isNaN(channelId)) {
            return res.status(400).json({ error: 'Некорректный канал' });
        }
        const access = await assertChannelMember(req.user.id, channelId);
        if (!access.ok) {
            return res.status(access.status).json({ error: access.error });
        }
        const row = await channelKeyWrapDB.getForUser(channelId, req.user.id);
        if (!row) {
            return res.status(404).json({ error: 'Нет обёртки ключа' });
        }
        res.json({ wrap: row.wrap, fromUserId: row.from_user_id });
    } catch (error) {
        console.error('e2e-wrap GET:', error);
        res.status(500).json({ error: 'Ошибка' });
    }
});

app.get('/api/channels/:channelId/e2e-wrap-recipients', authenticateToken, async (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId, 10);
        if (Number.isNaN(channelId)) {
            return res.status(400).json({ error: 'Некорректный канал' });
        }
        const access = await assertChannelMember(req.user.id, channelId);
        if (!access.ok) {
            return res.status(access.status).json({ error: access.error });
        }
        const userIds = await channelKeyWrapDB.listWrappedUserIds(channelId);
        res.json({ userIds });
    } catch (error) {
        console.error('e2e-wrap-recipients:', error);
        res.status(500).json({ error: 'Ошибка' });
    }
});

app.post('/api/channels/:channelId/e2e-wraps', authenticateToken, async (req, res) => {
    try {
        const channelId = parseInt(req.params.channelId, 10);
        const wraps = req.body && req.body.wraps;
        if (Number.isNaN(channelId) || !Array.isArray(wraps) || wraps.length === 0) {
            return res.status(400).json({ error: 'Некорректные данные' });
        }
        const access = await assertChannelMember(req.user.id, channelId);
        if (!access.ok) {
            return res.status(access.status).json({ error: access.error });
        }
        const srvId = access.channel.server_id;
        const fromUid = req.user.id;
        let n = 0;
        for (const w of wraps) {
            const uid = parseInt(w.userId, 10);
            const wrap = typeof w.wrap === 'string' ? w.wrap.trim() : '';
            if (Number.isNaN(uid) || !wrap || wrap.length > 65536) continue;
            if (!(await serverDB.isMember(srvId, uid))) continue;
            const prev = await channelKeyWrapDB.getForUser(channelId, uid);
            const merged = mergeChannelKeyWrapEntry(prev && prev.wrap, fromUid, wrap, prev && prev.from_user_id);
            await channelKeyWrapDB.upsert(channelId, uid, fromUid, merged);
            n += 1;
        }
        res.json({ ok: true, saved: n });
    } catch (error) {
        console.error('e2e-wraps POST:', error);
        res.status(500).json({ error: 'Ошибка сохранения обёрток' });
    }
});

/** Добавить участника по нику (только принятые друзья) */
app.post('/api/servers/:serverId/members', authenticateToken, async (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId, 10);
        if (Number.isNaN(serverId)) {
            return res.status(400).json({ error: 'Некорректный сервер' });
        }
        if (!(await serverDB.isMember(serverId, req.user.id))) {
            return res.status(403).json({ error: 'Нет доступа к серверу' });
        }
        const username = String((req.body && req.body.username) || '').trim();
        if (!username) {
            return res.status(400).json({ error: 'Укажите имя пользователя' });
        }
        const target = await userDB.findByUsername(username);
        if (!target) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        if (target.id === req.user.id) {
            return res.status(400).json({ error: 'Нельзя пригласить себя' });
        }
        const friendsA = await friendDB.checkFriendship(req.user.id, target.id);
        const friendsB = await friendDB.checkFriendship(target.id, req.user.id);
        if (!friendsA && !friendsB) {
            return res.status(403).json({ error: 'В группу можно добавить только друга из списка друзей' });
        }
        const banned = await serverBanDB.isBanned(serverId, target.id);
        if (banned) {
            return res.status(403).json({ error: 'Пользователь заблокирован в этой группе' });
        }
        if (await serverDB.isMember(serverId, target.id)) {
            return res.status(400).json({ error: 'Уже участник группы' });
        }
        await serverDB.addMember(serverId, target.id);
        const invited = Array.from(users.values()).find((u) => u.id === target.id);
        if (invited) {
            io.to(invited.socketId).emit('server-membership-update', { serverId });
        }
        res.json({ ok: true, user: { id: target.id, username: target.username } });
    } catch (error) {
        console.error('POST server member:', error);
        res.status(500).json({ error: 'Не удалось добавить участника' });
    }
});

app.get('/api/servers/:serverId/invites', authenticateToken, async (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId, 10);
        if (Number.isNaN(serverId)) {
            return res.status(400).json({ error: 'Некорректный сервер' });
        }
        if (!(await serverDB.isMember(serverId, req.user.id))) {
            return res.status(403).json({ error: 'Нет доступа к серверу' });
        }
        const srv = await serverDB.getById(serverId);
        if (!srv || srv.owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Только владелец может управлять ссылками' });
        }
        const rows = await serverInviteDB.listByServer(serverId);
        const base = florOriginFromReq(req);
        const out = rows.map((x) => ({
            id: x.id,
            code: x.code,
            url: `${base}/login.html?invite=${encodeURIComponent(x.code)}`,
            revoked: Number(x.revoked) === 1,
            usesCount: Number(x.uses_count) || 0,
            createdAt: x.created_at,
            revokedAt: x.revoked_at,
            lastUsedAt: x.last_used_at,
            createdBy: x.created_by_username || null
        }));
        res.json(out);
    } catch (error) {
        console.error('GET server invites:', error);
        res.status(500).json({ error: 'Не удалось загрузить ссылки' });
    }
});

app.post('/api/servers/:serverId/invites', authenticateToken, async (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId, 10);
        if (Number.isNaN(serverId)) {
            return res.status(400).json({ error: 'Некорректный сервер' });
        }
        if (!(await serverDB.isMember(serverId, req.user.id))) {
            return res.status(403).json({ error: 'Нет доступа к серверу' });
        }
        const srv = await serverDB.getById(serverId);
        if (!srv || srv.owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Только владелец может создавать ссылки' });
        }
        const code = crypto.randomBytes(12).toString('base64url').replace(/[_-]/g, '').slice(0, 16);
        const created = await serverInviteDB.create({ serverId, code, createdBy: req.user.id });
        const base = florOriginFromReq(req);
        res.status(201).json({
            id: created.id,
            code: created.code,
            url: `${base}/login.html?invite=${encodeURIComponent(created.code)}`
        });
    } catch (error) {
        console.error('POST server invite:', error);
        res.status(500).json({ error: 'Не удалось создать ссылку' });
    }
});

app.delete('/api/servers/:serverId/invites/:inviteId', authenticateToken, async (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId, 10);
        const inviteId = parseInt(req.params.inviteId, 10);
        if (Number.isNaN(serverId) || Number.isNaN(inviteId)) {
            return res.status(400).json({ error: 'Некорректные параметры' });
        }
        if (!(await serverDB.isMember(serverId, req.user.id))) {
            return res.status(403).json({ error: 'Нет доступа к серверу' });
        }
        const srv = await serverDB.getById(serverId);
        if (!srv || srv.owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Только владелец может удалять ссылки' });
        }
        const result = await serverInviteDB.revokeById(inviteId, serverId);
        if (!result.changes) {
            return res.status(404).json({ error: 'Ссылка не найдена или уже удалена' });
        }
        res.json({ ok: true });
    } catch (error) {
        console.error('DELETE server invite:', error);
        res.status(500).json({ error: 'Не удалось удалить ссылку' });
    }
});

app.post('/api/invites/:code/join', authenticateToken, async (req, res) => {
    try {
        const code = String(req.params.code || '').trim();
        if (!code || code.length < 6) {
            return res.status(400).json({ error: 'Некорректная ссылка-приглашение' });
        }
        const inv = await serverInviteDB.findByCode(code);
        if (!inv || Number(inv.revoked) === 1) {
            return res.status(404).json({ error: 'Ссылка недействительна' });
        }
        const serverId = Number(inv.server_id);
        if (Number.isNaN(serverId)) {
            return res.status(404).json({ error: 'Ссылка недействительна' });
        }
        const banned = await serverBanDB.isBanned(serverId, req.user.id);
        if (banned) {
            return res.status(403).json({ error: 'Вы заблокированы в этой группе' });
        }
        if (!(await serverDB.isMember(serverId, req.user.id))) {
            await serverDB.addMember(serverId, req.user.id);
            const joinedUser = Array.from(users.values()).find((u) => u.id === req.user.id);
            if (joinedUser) {
                io.to(joinedUser.socketId).emit('server-membership-update', { serverId });
            }
        }
        await serverInviteDB.touchUseByCode(code);
        const server = await serverDB.getById(serverId);
        if (!server) {
            return res.status(404).json({ error: 'Группа не найдена' });
        }
        res.json({ ok: true, server });
    } catch (error) {
        console.error('POST invite join:', error);
        res.status(500).json({ error: 'Не удалось вступить по ссылке' });
    }
});

/** Создать канал (только владелец сервера) */
app.post('/api/servers/:serverId/channels', authenticateToken, async (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId, 10);
        if (Number.isNaN(serverId)) {
            return res.status(400).json({ error: 'Некорректный сервер' });
        }
        if (!(await serverDB.isMember(serverId, req.user.id))) {
            return res.status(403).json({ error: 'Нет доступа к серверу' });
        }
        const srv = await serverDB.getById(serverId);
        if (!srv || srv.owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Только владелец может создавать каналы' });
        }
        const rawName = String((req.body && req.body.name) || '').trim();
        if (rawName.length < 2 || rawName.length > 40) {
            return res.status(400).json({ error: 'Имя канала: от 2 до 40 символов' });
        }
        if (!/^[\w\u0400-\u04FF][\w\u0400-\u04FF\-\s]{1,39}$/i.test(rawName)) {
            return res.status(400).json({ error: 'Допустимы буквы, цифры, пробел и дефис' });
        }
        const name = rawName.replace(/\s+/g, ' ').trim();
        if (await channelDB.nameExistsOnServer(serverId, name)) {
            return res.status(400).json({ error: 'Канал с таким именем уже есть' });
        }
        const type = req.body && req.body.type === 'voice' ? 'voice' : 'text';
        const cats = await categoryDB.listByServer(serverId);
        if (!cats.length) {
            return res.status(500).json({ error: 'Нет категорий на сервере' });
        }
        const textCat = cats.find((c) => /текст/i.test(c.name)) || cats[0];
        const voiceCat = cats.find((c) => /голос/i.test(c.name)) || cats[cats.length - 1];
        const categoryId = type === 'voice' ? voiceCat.id : textCat.id;
        const position = await channelDB.nextPosition(serverId, categoryId);
        const created = await channelDB.create(name, type, serverId, categoryId, position);
        const tree = await getChannelTree(serverId);
        res.status(201).json({ channel: created, tree });
    } catch (error) {
        console.error('POST channel:', error);
        res.status(500).json({ error: 'Не удалось создать канал' });
    }
});

/** Удалить канал (только владелец; нельзя удалить последний текстовый или последний голосовой) */
app.delete('/api/servers/:serverId/channels/:channelId', authenticateToken, async (req, res) => {
    try {
        const serverId = parseInt(req.params.serverId, 10);
        const channelId = parseInt(req.params.channelId, 10);
        if (Number.isNaN(serverId) || Number.isNaN(channelId)) {
            return res.status(400).json({ error: 'Некорректные параметры' });
        }
        if (!(await serverDB.isMember(serverId, req.user.id))) {
            return res.status(403).json({ error: 'Нет доступа к серверу' });
        }
        const srv = await serverDB.getById(serverId);
        if (!srv || srv.owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Только владелец может удалять каналы' });
        }
        const ch = await channelDB.getById(channelId);
        if (!ch || Number(ch.server_id) !== serverId) {
            return res.status(404).json({ error: 'Канал не найден' });
        }
        const t = String(ch.type || '').trim().toLowerCase();
        if (t === 'text') {
            const n = await channelDB.countByServerAndType(serverId, 'text');
            if (n <= 1) {
                return res.status(400).json({ error: 'Нельзя удалить последний текстовый канал' });
            }
        } else if (t === 'voice') {
            const n = await channelDB.countByServerAndType(serverId, 'voice');
            if (n <= 1) {
                return res.status(400).json({ error: 'Нельзя удалить последний голосовой канал' });
            }
        } else {
            return res.status(400).json({ error: 'Неизвестный тип канала' });
        }

        await channelDB.deleteCascade(channelId);
        if (t === 'voice') {
            evictVoiceRoomForDeletedChannel(serverId, channelId);
        }
        const tree = await getChannelTree(serverId);
        io.to(`server-${serverId}`).emit('server-channels-updated', {
            serverId,
            tree,
            deletedChannelId: channelId
        });
        res.json({ ok: true, tree });
    } catch (error) {
        console.error('DELETE channel:', error);
        res.status(500).json({ error: 'Не удалось удалить канал' });
    }
});

app.get('/api/friends', authenticateToken, async (req, res) => {
    try {
        const friends = await friendDB.getFriends(req.user.id);
        res.json(friends);
    } catch (error) {
        console.error('Get friends error:', error);
        res.status(500).json({ error: 'Failed to get friends' });
    }
});

app.get('/api/friends/pending', authenticateToken, async (req, res) => {
    try {
        const requests = await friendDB.getPendingRequests(req.user.id);
        res.json(requests);
    } catch (error) {
        console.error('Get pending requests error:', error);
        res.status(500).json({ error: 'Failed to get pending requests' });
    }
});

// Friend request routes
app.post('/api/friends/request', authenticateToken, async (req, res) => {
    try {
        const friendId = parseInt(req.body.friendId, 10);
        if (Number.isNaN(friendId) || friendId === req.user.id) {
            return res.status(400).json({ error: 'Некорректный запрос' });
        }
        const exists = await userDB.findById(friendId);
        if (!exists) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        const result = await friendDB.sendRequest(req.user.id, friendId);

        if (result.changes > 0) {
            const receiverSocket = Array.from(users.values()).find(u => u.id === friendId);
            if (receiverSocket) {
                io.to(receiverSocket.socketId).emit('new-friend-request');
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Friend request error:', error);
        res.status(500).json({ error: 'Failed to send friend request' });
    }
});

app.post('/api/friends/accept', authenticateToken, async (req, res) => {
    try {
        const friendId = parseInt(req.body.friendId, 10);
        if (Number.isNaN(friendId)) {
            return res.status(400).json({ error: 'Некорректный запрос' });
        }
        await friendDB.acceptRequest(req.user.id, friendId);
        res.sendStatus(200);
    } catch (error) {
        console.error('Accept friend request error:', error);
        res.status(500).json({ error: 'Failed to accept friend request' });
    }
});

app.post('/api/friends/reject', authenticateToken, async (req, res) => {
    try {
        const friendId = parseInt(req.body.friendId, 10);
        if (Number.isNaN(friendId)) {
            return res.status(400).json({ error: 'Некорректный запрос' });
        }
        await friendDB.rejectRequest(req.user.id, friendId);
        res.sendStatus(200);
    } catch (error) {
        console.error('Reject friend request error:', error);
        res.status(500).json({ error: 'Failed to reject friend request' });
    }
});

app.delete('/api/friends/:friendId', authenticateToken, async (req, res) => {
    try {
        const friendId = parseInt(req.params.friendId, 10);
        if (Number.isNaN(friendId)) {
            return res.status(400).json({ error: 'Некорректный запрос' });
        }
        await friendDB.removeFriend(req.user.id, friendId);
        res.sendStatus(200);
    } catch (error) {
        console.error('Remove friend error:', error);
        res.status(500).json({ error: 'Failed to remove friend' });
    }
});

// Store connected users
const users = new Map();

function emitToUserId(userId, event, payload) {
    const uid = Number(userId);
    if (!Number.isFinite(uid)) return;
    for (const u of users.values()) {
        if (Number(u.id) === uid && u.socketId) {
            io.to(u.socketId).emit(event, payload);
        }
    }
}

function emitFlorDmPinsToUsers(userA, userB, payload) {
    emitToUserId(userA, 'dm-pins-updated', payload);
    emitToUserId(userB, 'dm-pins-updated', payload);
}

const rooms = new Map();
/** socketId → голосовое состояние в комнате */
const voiceUserState = new Map();
/** Очередь входящего звонка, если получатель ещё не подключён по сокету (как в мессенджерах) */
const pendingIncomingCalls = new Map();
const PENDING_CALL_TTL_MS = 120000;

function flushPendingIncomingCallForUser(userId, targetSocket) {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || !targetSocket) return;
    const entry = pendingIncomingCalls.get(uid);
    if (!entry) return;
    if (Date.now() - entry.createdAt > PENDING_CALL_TTL_MS) {
        pendingIncomingCalls.delete(uid);
        return;
    }
    pendingIncomingCalls.delete(uid);
    targetSocket.emit('incoming-call', {
        from: entry.payload.from,
        type: entry.payload.type
    });
}

setInterval(() => {
    const now = Date.now();
    for (const [uid, entry] of pendingIncomingCalls.entries()) {
        if (now - entry.createdAt <= PENDING_CALL_TTL_MS) continue;
        pendingIncomingCalls.delete(uid);
        if (entry.callerSocketId) {
            io.to(entry.callerSocketId).emit('call-rejected', {
                message: 'Абонент не в сети',
                code: 'pending-expired'
            });
        }
    }
}, 20000);

function buildVoiceParticipants(roomKey) {
    const set = rooms.get(roomKey);
    if (!set) return [];
    return Array.from(set)
        .map((sid) => {
            const u = users.get(sid);
            if (!u) return null;
            const st = voiceUserState.get(sid) || { micMuted: false, deafened: false };
            return {
                socketId: sid,
                userId: u.id,
                username: u.username,
                avatar: u.avatar,
                micMuted: !!st.micMuted,
                deafened: !!st.deafened
            };
        })
        .filter(Boolean);
}

function emitVoiceRoster(roomKey, alsoNotifySocket = null) {
    const participants = buildVoiceParticipants(roomKey);
    const payload = { roomKey, participants };
    io.to(`voice-${roomKey}`).emit('voice-roster', payload);
    if (alsoNotifySocket) {
        alsoNotifySocket.emit('voice-roster', payload);
    }
    const sidStr = String(roomKey).split(':')[0];
    const serverId = parseInt(sidStr, 10);
    if (Number.isFinite(serverId)) {
        io.to(`server-${serverId}`).emit('voice-channel-roster', payload);
    }
}

/** Только этому клиенту — кто сейчас в голосовых каналах сервера (после join server-${id}). */
function emitVoicePresenceSnapshotToSocket(targetSocket, serverId) {
    const sid = Number(serverId);
    if (!targetSocket || !Number.isFinite(sid)) return;
    for (const [rk, set] of rooms.entries()) {
        if (!String(rk).startsWith(`${sid}:`)) continue;
        if (!set || set.size === 0) continue;
        const participants = buildVoiceParticipants(rk);
        targetSocket.emit('voice-channel-roster', { roomKey: rk, participants });
    }
}

/** После удаления голосового канала — снять сокеты с комнаты и уведомить клиентов */
function evictVoiceRoomForDeletedChannel(serverId, channelId) {
    const roomKey = `${serverId}:${channelId}`;
    if (rooms.has(roomKey)) {
        const set = rooms.get(roomKey);
        Array.from(set).forEach((sid) => {
            voiceUserState.delete(sid);
            const s = io.sockets.sockets.get(sid);
            if (s) {
                try {
                    s.leave(`voice-${roomKey}`);
                } catch (_) {}
                if (s.voiceRoomKey === roomKey) {
                    delete s.voiceRoomKey;
                }
            }
        });
        rooms.delete(roomKey);
    }
    io.to(`server-${serverId}`).emit('voice-channel-roster', { roomKey, participants: [] });
    io.to(`server-${serverId}`).emit('voice-channel-removed', { serverId, channelId });
}

function emitToUserSockets(userId, event, payload) {
    for (const u of users.values()) {
        if (Number(u.id) === Number(userId)) {
            io.to(u.socketId).emit(event, payload);
        }
    }
}

// Socket.IO connection handling
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error('Authentication error'));
    }
    
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error('Authentication error'));
        socket.userId = Number(decoded.id);
        socket.userEmail = decoded.email;
        next();
    });
});

io.on('connection', async (socket) => {
    console.log('User connected:', socket.userId);

    try {
        const user = await userDB.findById(socket.userId);
        if (!user) {
            socket.disconnect();
            return;
        }

        users.set(socket.id, {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            status: user.status,
            socketId: socket.id
        });

        await userDB.updateStatus(socket.userId, 'Online');

        const myServers = await serverDB.getUserServers(socket.userId);
        myServers.forEach((srv) => {
            socket.join(`server-${srv.id}`);
            emitVoicePresenceSnapshotToSocket(socket, srv.id);
        });

        io.emit('user-list-update', Array.from(users.values()));

        flushPendingIncomingCallForUser(socket.userId, socket);
    } catch (error) {
        console.error('Error loading user:', error);
        socket.disconnect();
        return;
    }

    socket.on('send-message', async (messageData) => {
        try {
            const { channelId, message } = messageData;
            const norm = normalizeMessageTextInput(message && message.text);
            if (!norm.ok) return;
            const text = norm.text;

            const access = await assertChannelMember(socket.userId, channelId);
            if (!access.ok) {
                socket.emit('message-send-error', {
                    error: access.error || 'Нет доступа к каналу'
                });
                return;
            }

            const cid = parseInt(channelId, 10);
            let replyToId = null;
            if (message && message.replyToId != null && message.replyToId !== '') {
                const r = parseInt(message.replyToId, 10);
                if (!Number.isNaN(r)) {
                    const rmeta = await messageDB.getMeta(r);
                    if (rmeta && Number(rmeta.channel_id) === cid) {
                        replyToId = r;
                    }
                }
            }
            const savedMessage = await messageDB.create(text, socket.userId, cid, replyToId);
            const row = await messageDB.getByIdWithReply(savedMessage.id);
            const broadcastMessage = florChannelRowToBroadcastMessage(row);

            io.to(`server-${access.channel.server_id}`).emit('new-message', {
                channelId: cid,
                serverId: access.channel.server_id,
                channelName: access.channel.name,
                message: broadcastMessage
            });
        } catch (error) {
            console.error('Message error:', error);
            socket.emit('message-send-error', { error: 'Ошибка сервера при отправке' });
        }
    });

    socket.on('send-dm', async (data) => {
        try {
            const receiverId = parseInt(data.receiverId, 10);
            const norm = normalizeMessageTextInput(data.message && data.message.text);
            if (Number.isNaN(receiverId) || !norm.ok) return;
            const text = norm.text;

            const allowed = await friendDB.checkFriendship(socket.userId, receiverId);
            if (!allowed) return;

            let replyToId = null;
            if (data.message && data.message.replyToId != null && data.message.replyToId !== '') {
                const r = parseInt(data.message.replyToId, 10);
                if (!Number.isNaN(r)) {
                    const parent = await dmDB.getById(r);
                    const a = Number(socket.userId);
                    const b = Number(receiverId);
                    if (
                        parent &&
                        ((Number(parent.sender_id) === a && Number(parent.receiver_id) === b) ||
                            (Number(parent.sender_id) === b && Number(parent.receiver_id) === a))
                    ) {
                        replyToId = r;
                    }
                }
            }

            const savedMessage = await dmDB.create(text, socket.userId, receiverId, replyToId);
            const row = await dmDB.getByIdWithReply(savedMessage.id);
            const messagePayload = florDmRowToSocketPayload(row);
            if (!messagePayload) return;
            messagePayload.read = messagePayload.read != null ? messagePayload.read : 0;

            const receiverSocket = Array.from(users.values()).find((u) => u.id === receiverId);

            if (receiverSocket) {
                io.to(receiverSocket.socketId).emit('new-dm', {
                    senderId: socket.userId,
                    message: messagePayload
                });
            }

            socket.emit('dm-sent', {
                receiverId,
                senderId: socket.userId,
                message: messagePayload
            });
        } catch (error) {
            console.error('DM error:', error);
        }
    });

    socket.on('add-reaction', async (data) => {
        try {
            const messageId = parseInt(data.messageId, 10);
            const emoji = typeof data.emoji === 'string' ? data.emoji.trim().slice(0, 16) : '';
            if (Number.isNaN(messageId) || !emoji) return;

            const chId = await messageDB.getChannelIdForMessage(messageId);
            if (chId != null) {
                const access = await assertChannelMember(socket.userId, chId);
                if (!access.ok) return;

                await reactionDB.add(emoji, messageId, socket.userId);

                const reactions = await reactionDB.getByMessage(messageId);
                io.to(`server-${access.channel.server_id}`).emit('reaction-update', {
                    messageId,
                    reactions,
                    context: 'channel'
                });
                return;
            }

            const dmRow = await dmDB.getById(messageId);
            if (!dmRow) return;
            if (dmRow.sender_id !== socket.userId && dmRow.receiver_id !== socket.userId) return;
            const friendsOk = await friendDB.checkFriendship(dmRow.sender_id, dmRow.receiver_id);
            if (!friendsOk) return;

            await dmReactionDB.add(emoji, messageId, socket.userId);
            const reactions = await dmReactionDB.getByDmMessage(messageId);
            const payload = { messageId, reactions, context: 'dm' };
            emitToUserSockets(dmRow.sender_id, 'reaction-update', payload);
            emitToUserSockets(dmRow.receiver_id, 'reaction-update', payload);
        } catch (error) {
            console.error('Reaction error:', error);
        }
    });

    socket.on('remove-reaction', async (data) => {
        try {
            const messageId = parseInt(data.messageId, 10);
            const emoji = typeof data.emoji === 'string' ? data.emoji.trim().slice(0, 16) : '';
            if (Number.isNaN(messageId) || !emoji) return;

            const chId = await messageDB.getChannelIdForMessage(messageId);
            if (chId != null) {
                const access = await assertChannelMember(socket.userId, chId);
                if (!access.ok) return;

                await reactionDB.remove(emoji, messageId, socket.userId);

                const reactions = await reactionDB.getByMessage(messageId);
                io.to(`server-${access.channel.server_id}`).emit('reaction-update', {
                    messageId,
                    reactions,
                    context: 'channel'
                });
                return;
            }

            const dmRow = await dmDB.getById(messageId);
            if (!dmRow) return;
            if (dmRow.sender_id !== socket.userId && dmRow.receiver_id !== socket.userId) return;
            const friendsOk = await friendDB.checkFriendship(dmRow.sender_id, dmRow.receiver_id);
            if (!friendsOk) return;

            await dmReactionDB.remove(emoji, messageId, socket.userId);
            const reactions = await dmReactionDB.getByDmMessage(messageId);
            const payload = { messageId, reactions, context: 'dm' };
            emitToUserSockets(dmRow.sender_id, 'reaction-update', payload);
            emitToUserSockets(dmRow.receiver_id, 'reaction-update', payload);
        } catch (error) {
            console.error('Reaction error:', error);
        }
    });

    // Voice activity detection
    socket.on('voice-activity', (data) => {
        const rk = socket.voiceRoomKey;
        if (!rk) return;
        socket.to(`voice-${rk}`).emit('user-speaking', {
            socketId: socket.id,
            speaking: !!(data && data.speaking)
        });
    });

    // Join voice channel (комната привязана к серверу и id канала — нет пересечений между группами)
    socket.on('join-voice-channel', async (channelData) => {
        try {
            const serverId = parseInt(channelData && channelData.serverId, 10);
            const channelId = parseInt(channelData && channelData.channelId, 10);
            const userId = socket.userId;
            if (Number.isNaN(serverId) || Number.isNaN(channelId)) return;
            if (!(await serverDB.isMember(serverId, userId))) return;
            const ch = await channelDB.getById(channelId);
            if (!ch || ch.server_id !== serverId || ch.type !== 'voice') return;

            const roomKey = `${serverId}:${channelId}`;
            const prevKey = socket.voiceRoomKey;
            if (prevKey && prevKey !== roomKey) {
                if (rooms.has(prevKey)) {
                    rooms.get(prevKey).delete(socket.id);
                    voiceUserState.delete(socket.id);
                    socket.to(`voice-${prevKey}`).emit('user-left-voice', socket.id);
                    emitVoiceRoster(prevKey, socket);
                    const prevSet = rooms.get(prevKey);
                    if (prevSet && prevSet.size === 0) {
                        rooms.delete(prevKey);
                    }
                }
                socket.leave(`voice-${prevKey}`);
                delete socket.voiceRoomKey;
            }

            socket.join(`voice-${roomKey}`);
            socket.voiceRoomKey = roomKey;

            if (!rooms.has(roomKey)) {
                rooms.set(roomKey, new Set());
            }
            rooms.get(roomKey).add(socket.id);
            if (!voiceUserState.has(socket.id)) {
                voiceUserState.set(socket.id, { micMuted: false, deafened: false });
            }

            const me = users.get(socket.id);
            socket.to(`voice-${roomKey}`).emit('user-joined-voice', {
                userId,
                socketId: socket.id,
                username: me ? me.username : '',
                avatar: me ? me.avatar : null
            });

            const existingUsers = Array.from(rooms.get(roomKey))
                .filter((id) => id !== socket.id)
                .map((id) => users.get(id))
                .filter(Boolean);

            socket.emit('existing-voice-users', existingUsers);
            emitVoiceRoster(roomKey);
        } catch (e) {
            console.error('join-voice-channel:', e);
        }
    });

    socket.on('voice-self-state', (payload) => {
        try {
            const rk = payload && typeof payload.roomKey === 'string' ? payload.roomKey.trim() : '';
            if (!rk || !rooms.has(rk) || !rooms.get(rk).has(socket.id)) return;
            voiceUserState.set(socket.id, {
                micMuted: !!payload.micMuted,
                deafened: !!payload.deafened
            });
            emitVoiceRoster(rk);
        } catch (e) {
            console.error('voice-self-state:', e);
        }
    });

    // WebRTC signaling
    socket.on('offer', (data) => {
        socket.to(data.to).emit('offer', {
            offer: data.offer,
            from: socket.id
        });
    });

    socket.on('answer', (data) => {
        socket.to(data.to).emit('answer', {
            answer: data.answer,
            from: socket.id
        });
    });

    socket.on('ice-candidate', (data) => {
        socket.to(data.to).emit('ice-candidate', {
            candidate: data.candidate,
            from: socket.id
        });
    });

    socket.on('leave-voice-channel', (roomKey) => {
        const key = typeof roomKey === 'string' && roomKey ? roomKey : '';
        if (!key) return;

        if (rooms.has(key)) {
            rooms.get(key).delete(socket.id);
            voiceUserState.delete(socket.id);
            socket.to(`voice-${key}`).emit('user-left-voice', socket.id);
            emitVoiceRoster(key, socket);
            const left = rooms.get(key);
            if (left && left.size === 0) {
                rooms.delete(key);
            }
        }

        socket.leave(`voice-${key}`);
        if (socket.voiceRoomKey === key) {
            delete socket.voiceRoomKey;
        }
    });

    socket.on('initiate-call', async (data) => {
        try {
            const to = parseInt(data && data.to, 10);
            const type = data && data.type;
            const fromId = socket.userId;

            if (Number.isNaN(to) || to === fromId) {
                socket.emit('call-rejected', { message: 'Некорректный вызов' });
                return;
            }

            const allowed = await friendDB.checkFriendship(fromId, to);
            if (!allowed) {
                socket.emit('call-rejected', { message: 'Звонки только между друзьями' });
                return;
            }

            const sender = await userDB.findById(fromId);
            if (!sender) {
                socket.emit('call-rejected', { message: 'Ошибка сервера' });
                return;
            }

            const receiverEntries = [];
            for (const u of users.values()) {
                if (Number(u.id) === Number(to)) receiverEntries.push(u);
            }
            const payload = {
                from: {
                    id: fromId,
                    username: sender.username,
                    socketId: socket.id,
                    avatar: sender.avatar || sender.username.charAt(0).toUpperCase()
                },
                type
            };
            if (receiverEntries.length) {
                receiverEntries.forEach((u) => io.to(u.socketId).emit('incoming-call', payload));
                socket.emit('call-delivered', { ok: true });
            } else {
                pendingIncomingCalls.set(Number(to), {
                    payload,
                    callerSocketId: socket.id,
                    createdAt: Date.now()
                });
                socket.emit('call-queued', {
                    message:
                        'Собеседник сейчас не в приложении. Когда откроет FLOR — увидит входящий звонок (до 2 мин).'
                });
            }
        } catch (e) {
            console.error('initiate-call:', e);
            socket.emit('call-rejected', { message: 'Не удалось установить вызов' });
        }
    });

    socket.on('accept-call', (data) => {
        const { to, from } = data;
        console.log(`Call accepted by ${from.id}, connecting to ${to}`);
        const accepter = users.get(socket.id);
        const avatar =
            accepter?.avatar ||
            (accepter?.username && accepter.username.charAt(0).toUpperCase()) ||
            (from?.username && from.username.charAt(0).toUpperCase()) ||
            '?';

        // Notify the caller that call was accepted
        io.to(to).emit('call-accepted', {
            from: {
                id: from.id,
                username: from.username,
                socketId: socket.id,
                avatar
            }
        });
    });

    socket.on('reject-call', (data) => {
        const { to } = data;
        console.log(`Call rejected, notifying ${to}`);
        
        // Notify the caller that call was rejected
        io.to(to).emit('call-rejected', {
            from: socket.id,
            message: 'Абонент отклонил вызов'
        });
    });
    
    // Video toggle handler
    socket.on('video-toggle', (data) => {
        const { to, enabled } = data;
        if (to) {
            io.to(to).emit('video-toggle', {
                from: socket.id,
                enabled: enabled
            });
        }
    });
    
    // End call
    socket.on('end-call', (data) => {
        const { to } = data;
        if (to) {
            io.to(to).emit('call-ended', { from: socket.id });
        }
    });

    socket.on('resync-server-rooms', async () => {
        try {
            const myServers = await serverDB.getUserServers(socket.userId);
            myServers.forEach((srv) => {
                socket.join(`server-${srv.id}`);
                emitVoicePresenceSnapshotToSocket(socket, srv.id);
            });
        } catch (e) {
            console.error('resync-server-rooms', e);
        }
    });

    // Handle disconnection
    socket.on('disconnect', async () => {
        for (const [uid, entry] of pendingIncomingCalls.entries()) {
            if (entry.callerSocketId === socket.id) {
                pendingIncomingCalls.delete(uid);
            }
        }

        const user = users.get(socket.id);
        
        if (user) {
            console.log(`${user.username} disconnected`);
            
            // Update status in database
            try {
                await userDB.updateStatus(socket.userId, 'Offline');
            } catch (error) {
                console.error('Error updating status:', error);
            }
            
            rooms.forEach((members, roomName) => {
                if (members.has(socket.id)) {
                    io.to(`voice-${roomName}`).emit('user-left-voice', socket.id);
                    members.delete(socket.id);
                    voiceUserState.delete(socket.id);
                    emitVoiceRoster(roomName);
                }
            });
            
            users.delete(socket.id);
            io.emit('user-list-update', Array.from(users.values()));
        }
    });
});

app.get('/', (req, res) => {
    res.redirect(302, '/login.html');
});

app.use(express.static(path.join(__dirname)));

app.use((err, req, res, next) => {
    if (!err) return next();
    const msg = String(err.message || '');
    if (msg.includes('разрешён') || msg.includes('JPEG') || msg.includes('WebP')) {
        return res.status(400).json({ error: err.message });
    }
    console.error(err);
    if (!res.headersSent) {
        return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

let florServerListening = false;

async function startFlorServer() {
    if (florServerListening) {
        return;
    }
    try {
        await ensureChannelSchema();
        await ensureE2eeSchema();
        await ensureUserProfileSchema();
        await ensureUserSecuritySchema();
        await ensureServerInviteSchema();
        await ensureDmReactionsSchema();
        await ensureMessageReplyAndPinsSchema();
        await ensureStickerPackSchema();
        await migrateChannelsForEmptyServers();
        await migrateChannelHierarchy();
    } catch (err) {
        console.error('Ошибка миграций БД:', err);
        throw err;
    }
    await new Promise((resolve, reject) => {
        const onErr = (e) => {
            server.removeListener('error', onErr);
            reject(e);
        };
        server.once('error', onErr);
        server.listen(PORT, HOST, () => {
            server.removeListener('error', onErr);
            florServerListening = true;
            const proto = useHttps ? 'https' : 'http';
            const local = HOST === '0.0.0.0' ? `${proto}://127.0.0.1:${PORT}` : `${proto}://${HOST}:${PORT}`;
            console.log(`FLOR MESSENGER listening on ${HOST}:${PORT} (${proto.toUpperCase()})`);
            console.log(`Open ${local}/login.html в браузере`);
            if (!useHttps) {
                console.warn(
                    '[МОБИЛЬНЫЙ / ДЕМО] Браузер на телефоне не даст микрофон, камеру и WebRTC по http://IP (нужен secure context). ' +
                        'Включите в .env: USE_HTTPS=true и FLOR_TLS_SAN=localhost,127.0.0.1,ВАШ_LAN_IP, перезапустите сервер и откройте https://IP:порт/login.html'
                );
            }
            resolve();
        });
    });
}

if (require.main === module) {
    startFlorServer().catch((err) => {
        console.error('Не удалось запустить сервер:', err);
        process.exit(1);
    });
}

module.exports = { startFlorServer, app, server, io, PORT, useHttps };