require('dotenv').config();
const express = require('express');
const http = require('http');
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
    friendDB,
    serverDB
} = require('./database');

const app = express();
const server = http.createServer(app);
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

function mapUserIdentityJwk(row) {
    if (!row || !row.identity_public_jwk) return null;
    try {
        return JSON.parse(row.identity_public_jwk);
    } catch (_) {
        return null;
    }
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

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
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
            'text/plain', 'audio/mpeg', 'audio/mp3', 'video/mp4', 'video/webm', 'video/quicktime',
            'application/zip', 'application/x-rar-compressed'
        ];
        
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.pdf', '.doc', '.docx',
                                   '.txt', '.mp3', '.mp4', '.webm', '.mov', '.zip', '.rar'];
        
        const ext = path.extname(file.originalname).toLowerCase();
        
        if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Тип файла не разрешён'), false);
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
        const { avatar } = req.body;
        const userRow = await userDB.findById(req.user.id);
        if (!userRow) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        let nextAvatar;
        if (avatar === undefined || avatar === null) {
            nextAvatar = null;
        } else {
            const t = String(avatar).trim().slice(0, 4);
            nextAvatar = t || null;
        }
        if (nextAvatar === null) {
            await userDB.updateAvatar(req.user.id, null);
        } else {
            await userDB.updateAvatar(req.user.id, nextAvatar);
        }
        const user = await userDB.findById(req.user.id);
        const displayAvatar = user.avatar || user.username.charAt(0).toUpperCase();
        res.json({
            id: user.id,
            username: user.username,
            email: user.email,
            avatar: displayAvatar
        });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ error: 'Не удалось сохранить профиль' });
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
            users.map((u) => ({
                id: u.id,
                username: u.username,
                avatar: u.avatar,
                status: u.status,
                identityPublicJwk: mapUserIdentityJwk(u)
            }))
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

// Get messages by channel (только участники сервера)
app.get('/api/messages/:channelId', authenticateToken, async (req, res) => {
    try {
        const access = await assertChannelMember(req.user.id, req.params.channelId);
        if (!access.ok) {
            return res.status(access.status).json({ error: access.error });
        }
        const cid = parseInt(req.params.channelId, 10);
        const messages = await messageDB.getByChannel(cid);
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
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get messages' });
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
        if (name !== undefined) {
            const t = String(name).trim();
            if (t.length < 2) {
                return res.status(400).json({ error: 'Название не короче 2 символов' });
            }
            patch.name = t;
        }
        if (icon !== undefined) {
            patch.icon = String(icon).trim().slice(0, 16) || srv.icon;
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
        res.json(
            members.map((m) => ({
                id: m.id,
                username: m.username,
                avatar: m.avatar,
                status: m.status,
                identityPublicJwk: mapUserIdentityJwk(m)
            }))
        );
    } catch (error) {
        res.status(500).json({ error: 'Failed to get server members' });
    }
});

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
            await channelKeyWrapDB.upsert(channelId, uid, fromUid, wrap);
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
        });

        io.emit('user-list-update', Array.from(users.values()));
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
                author: sender.username,
                avatar: sender.avatar || sender.username.charAt(0).toUpperCase(),
                text,
                timestamp: new Date()
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
            if (chId == null) return;

            const access = await assertChannelMember(socket.userId, chId);
            if (!access.ok) return;

            await reactionDB.add(emoji, messageId, socket.userId);

            const reactions = await reactionDB.getByMessage(messageId);
            io.to(`server-${access.channel.server_id}`).emit('reaction-update', { messageId, reactions });
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
            if (chId == null) return;

            const access = await assertChannelMember(socket.userId, chId);
            if (!access.ok) return;

            await reactionDB.remove(emoji, messageId, socket.userId);

            const reactions = await reactionDB.getByMessage(messageId);
            io.to(`server-${access.channel.server_id}`).emit('reaction-update', { messageId, reactions });
        } catch (error) {
            console.error('Reaction error:', error);
        }
    });

    // Voice activity detection
    socket.on('voice-activity', (data) => {
        socket.broadcast.emit('user-speaking', {
            userId: socket.userId,
            speaking: data.speaking
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
            socket.join(`voice-${roomKey}`);

            if (!rooms.has(roomKey)) {
                rooms.set(roomKey, new Set());
            }
            rooms.get(roomKey).add(socket.id);

            socket.to(`voice-${roomKey}`).emit('user-joined-voice', {
                userId,
                socketId: socket.id
            });

            const existingUsers = Array.from(rooms.get(roomKey))
                .filter((id) => id !== socket.id)
                .map((id) => users.get(id))
                .filter(Boolean);

            socket.emit('existing-voice-users', existingUsers);
        } catch (e) {
            console.error('join-voice-channel:', e);
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
        socket.leave(`voice-${key}`);

        if (rooms.has(key)) {
            rooms.get(key).delete(socket.id);
            socket.to(`voice-${key}`).emit('user-left-voice', socket.id);
        }
    });

    socket.on('initiate-call', async (data) => {
        try {
            const to = parseInt(data && data.to, 10);
            const type = data && data.type;
            const fromId = socket.userId;

            if (Number.isNaN(to) || to === fromId) return;

            const allowed = await friendDB.checkFriendship(fromId, to);
            if (!allowed) {
                socket.emit('call-rejected', { message: 'Звонки только между друзьями' });
                return;
            }

            const sender = await userDB.findById(fromId);
            if (!sender) return;

            const receiverSocket = Array.from(users.values()).find((u) => u.id === to);
            if (receiverSocket) {
                io.to(receiverSocket.socketId).emit('incoming-call', {
                    from: {
                        id: fromId,
                        username: sender.username,
                        socketId: socket.id,
                        avatar: sender.avatar || sender.username.charAt(0).toUpperCase()
                    },
                    type
                });
            } else {
                socket.emit('call-rejected', { message: 'Пользователь не в сети' });
            }
        } catch (e) {
            console.error('initiate-call:', e);
        }
    });

    socket.on('accept-call', (data) => {
        const { to, from } = data;
        console.log(`Call accepted by ${from.id}, connecting to ${to}`);
        
        // Notify the caller that call was accepted
        io.to(to).emit('call-accepted', {
            from: {
                id: from.id,
                username: from.username,
                socketId: socket.id
            }
        });
    });

    socket.on('reject-call', (data) => {
        const { to } = data;
        console.log(`Call rejected, notifying ${to}`);
        
        // Notify the caller that call was rejected
        io.to(to).emit('call-rejected', {
            from: socket.id,
            message: 'Call was declined'
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
            myServers.forEach((srv) => socket.join(`server-${srv.id}`));
        } catch (e) {
            console.error('resync-server-rooms', e);
        }
    });

    // Handle disconnection
    socket.on('disconnect', async () => {
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
                    members.delete(socket.id);
                    io.to(`voice-${roomName}`).emit('user-left-voice', socket.id);
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
    if (String(err.message || '').includes('разрешён')) {
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
            const local = HOST === '0.0.0.0' ? `http://127.0.0.1:${PORT}` : `http://${HOST}:${PORT}`;
            console.log(`FLOR MESSENGER listening on ${HOST}:${PORT}`);
            console.log(`Open ${local}/ (или /login.html) в браузере`);
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

module.exports = { startFlorServer, app, server, io, PORT };