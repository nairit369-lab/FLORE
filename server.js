require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const socketIO = require('socket.io');
const path = require('path');
const pkg = require('./package.json');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const {
    initializeDatabase,
    migrateChannelsForEmptyServers,
    ensureChannelSchema,
    ensureE2eeSchema,
    ensureUserProfileSchema,
    ensureDmReactionsSchema,
    migrateChannelHierarchy,
    getChannelTree,
    userDB,
    messageDB,
    channelDB,
    categoryDB,
    dmDB,
    channelKeyWrapDB,
    fileDB,
    reactionDB,
    dmReactionDB,
    friendDB,
    serverDB
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

app.get('/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, name: pkg.name, version: pkg.version });
});

app.get('/api/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, version: pkg.version });
});

app.use('/api/', apiLimiter);

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
    const origExt = path.extname(originalname || '').toLowerCase();
    const mimeToExt = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
        'application/pdf': '.pdf',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'text/plain': '.txt',
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
        'video/mp4': '.mp4',
        'video/webm': '.webm',
        'video/quicktime': '.mov',
        'application/zip': '.zip',
        'application/x-rar-compressed': '.rar'
    };
    let ext = mimeToExt[mime];
    if (!ext && origExt && /^\.[a-z0-9]{1,10}$/i.test(origExt)) {
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
        // Allow all common file types
        const allowedMimeTypes = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
            'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain',
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
            'video/mp4',
            'video/webm',
            'video/quicktime',
            'application/zip',
            'application/x-rar-compressed'
        ];

        const allowedExtensions = [
            '.jpg',
            '.jpeg',
            '.png',
            '.gif',
            '.webp',
            '.svg',
            '.pdf',
            '.doc',
            '.docx',
            '.txt',
            '.mp3',
            '.mp4',
            '.webm',
            '.mov',
            '.zip',
            '.rar',
            '.ogg',
            '.opus',
            '.wav',
            '.m4a',
            '.aac'
        ];
        
        const ext = path.extname(file.originalname).toLowerCase();
        
        if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Тип файла не разрешён'), false);
        }
    }
});

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
            return res.status(403).json({ error: 'Invalid token' });
        }
        const uid = Number(decoded && decoded.id);
        if (!Number.isFinite(uid)) {
            return res.status(403).json({ error: 'Invalid token' });
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

// Register
app.post('/api/register', authLimiter, async (req, res) => {
    try {
        let { username, email, password } = req.body;
        username = typeof username === 'string' ? username.trim().slice(0, 32) : '';
        email = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 120) : '';
        password = typeof password === 'string' ? password : '';

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'All fields required' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        const existingUser = await userDB.findByEmail(email);
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await userDB.create(username, email, hashedPassword);
        
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

// Login
app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        
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
        
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        
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
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
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
app.post('/api/upload', authenticateToken, upload.single('file'), async (req, res) => {
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

/** Голосовые и прочие аудио в ЛС (channel_id = NULL) */
app.post('/api/dm/upload', authenticateToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Нет файла' });
        }
        const mt = String(req.file.mimetype || '').toLowerCase();
        if (!mt.startsWith('audio/')) {
            return res.status(400).json({ error: 'Разрешены только аудиофайлы' });
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
        const user = await userDB.findById(req.user.id);
        const savedMessage = await messageDB.create(text, req.user.id, channelId);
        const broadcastMessage = {
            id: savedMessage.id,
            senderId: req.user.id,
            author: user.username,
            avatar: user.avatar || user.username.charAt(0).toUpperCase(),
            text,
            timestamp: new Date().toISOString()
        };
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

            const user = await userDB.findById(socket.userId);
            const cid = parseInt(channelId, 10);
            const savedMessage = await messageDB.create(text, socket.userId, cid);

            const broadcastMessage = {
                id: savedMessage.id,
                senderId: socket.userId,
                author: user.username,
                avatar: user.avatar || user.username.charAt(0).toUpperCase(),
                text,
                timestamp: new Date().toISOString()
            };

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

            const sender = await userDB.findById(socket.userId);

            const savedMessage = await dmDB.create(text, socket.userId, receiverId);

            const messagePayload = {
                id: savedMessage.id,
                senderId: socket.userId,
                author: sender.username,
                avatar: sender.avatar || sender.username.charAt(0).toUpperCase(),
                text,
                timestamp: new Date(),
                read: 0
            };

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
        await ensureDmReactionsSchema();
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