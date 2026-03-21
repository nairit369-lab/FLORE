/** Отладочные логи только при sessionStorage.florDebug === '1' */
function florDevLog(...args) {
    try {
        if (sessionStorage.getItem('florDebug') === '1') {
            console.log('[FLOR]', ...args);
        }
    } catch (_) {}
}

// Global state
let currentChannel = 'general';
let channels = { 'general': [], 'random': [] };
let servers = [];
let inCall = false;
let localStream = null;
let screenStream = null;
let peerConnections = {};
let isVideoEnabled = true;
let isAudioEnabled = true;
let isMuted = false;
let isDeafened = false;
let currentUser = null;
let socket = null;
let token = null;
let currentView = 'friends';
let currentServerId = null;
let currentDMUserId = null;
let currentServerChannelMap = {};
let currentServerChannelIdToName = {};
let activeVoiceChannelName = null;
let activeVoiceRoomKey = null;
/** id активного текстового канала (надёжнее, чем только имя) */
let currentTextChannelId = null;
let currentServerRecord = null;
let lastLoadedMessagesForExport = [];
/** userId → JWK публичного ключа (E2EE) */
let florUserKeyCache = new Map();
let micTestStream = null;
let micTestAnalyser = null;
let micTestRaf = null;

const SETTINGS_STORAGE_KEY = 'florMessengerSettings';
const BOOKMARKS_KEY = 'florMessageBookmarks';
const LOGIN_HISTORY_KEY = 'florLoginHistory';
const IDB_NAME = 'florMsgCache_v1';
const IDB_STORE = 'channelMessages';

/** База API (страница с http(s) или из localStorage / fallback для Electron) */
function florOrigin() {
    try {
        const p = window.location.protocol;
        if (p === 'http:' || p === 'https:') {
            return window.location.origin.replace(/\/$/, '');
        }
    } catch (_) {}
    try {
        const s = localStorage.getItem('florServerBase');
        if (s && /^https?:\/\//i.test(String(s).trim())) {
            return String(s).trim().replace(/\/$/, '');
        }
    } catch (_) {}
    return 'http://127.0.0.1:3000';
}

function florApi(path) {
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${florOrigin()}${p}`;
}

/** Микрофон/камера: вне secure context (обычно http:// с чужого IP) getUserMedia недоступен */
function florMediaNeedsSecurePage() {
    try {
        return typeof window !== 'undefined' && window.isSecureContext === false;
    } catch (_) {
        return true;
    }
}

function florMediaAccessHint() {
    if (florMediaNeedsSecurePage()) {
        return (
            'Микрофон и камера в этом браузере недоступны на обычном http:// с IP/доменом (нужен «безопасный» контекст).\n\n' +
            'Варианты:\n' +
            '• Сервер: в .env задайте USE_HTTPS=true и FLOR_TLS_SAN=… (см. .env.example), откройте https://…\n' +
            '• Electron: в .env ELECTRON_INSECURE_ORIGINS=http://ВАШ_IP:порт (через запятую, если несколько)\n' +
            '• Или Nginx + Let’s Encrypt для публичного домена.'
        );
    }
    return (
        'Нет доступа к камере или микрофону.\n\n' +
        'В адресной строке нажмите значок замка → разрешения сайта → микрофон/камера «Разрешить».'
    );
}

function updateFlorMediaHttpsWarningEl() {
    const el = document.getElementById('florMediaHttpsWarning');
    if (!el) return;
    el.style.display = florMediaNeedsSecurePage() ? 'block' : 'none';
}

async function florRefreshUserKeyCache() {
    try {
        const r = await fetch(florApi('/api/users'), { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const users = await r.json();
        florUserKeyCache.clear();
        users.forEach((u) => {
            if (u.identityPublicJwk) florUserKeyCache.set(u.id, u.identityPublicJwk);
        });
    } catch (_) {}
}

async function florFetchMembersForE2ee(serverId) {
    const r = await fetch(florApi(`/api/servers/${serverId}/members`), {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return [];
    return r.json();
}

async function florDecryptChannelMessage(channelId, text) {
    if (!window.florE2ee || !florE2ee.isE2eePayload(text)) return text;
    if (!currentServerRecord) return text;
    try {
        const raw = await florE2ee.ensureChannelKey(
            channelId,
            currentServerRecord.id,
            florApi,
            token,
            currentUser.id,
            florFetchMembersForE2ee
        );
        return await florE2ee.decryptWithChannelKey(raw, text);
    } catch (_) {
        return '🔒 Не удалось расшифровать (нет ключа канала)';
    }
}

function getChannelIdByName(name) {
    const id = currentServerChannelMap[name];
    return id != null ? id : null;
}

function getChannelNameById(id) {
    if (id == null || id === '') return null;
    const n = Number(id);
    if (!Number.isNaN(n) && currentServerChannelIdToName[n] != null) {
        return currentServerChannelIdToName[n];
    }
    return currentServerChannelIdToName[id] ?? null;
}

function flattenChannelTreeToMaps(tree) {
    currentServerChannelMap = {};
    currentServerChannelIdToName = {};
    const blocks = tree.categories || [];
    blocks.forEach((block) => {
        (block.channels || []).forEach((c) => {
            const t = String(c.type == null ? '' : c.type).trim().toLowerCase();
            if (t === 'text') {
                const nid = Number(c.id);
                if (Number.isFinite(nid)) {
                    currentServerChannelMap[c.name] = nid;
                    currentServerChannelIdToName[nid] = c.name;
                }
            }
        });
    });
}

async function fetchServerChannels(serverId) {
    currentServerChannelMap = {};
    currentServerChannelIdToName = {};
    try {
        const response = await fetch(florApi(`/api/servers/${serverId}/channels`), {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (data.categories) {
            flattenChannelTreeToMaps(data);
            return data;
        }
        if (Array.isArray(data)) {
            data.forEach((c) => {
                const t = String(c.type == null ? '' : c.type).trim().toLowerCase();
                if (t === 'text') {
                    const nid = Number(c.id);
                    if (Number.isFinite(nid)) {
                        currentServerChannelMap[c.name] = nid;
                        currentServerChannelIdToName[nid] = c.name;
                    }
                }
            });
            return { categories: [{ id: 0, name: 'Каналы', channels: data }] };
        }
        return data;
    } catch (e) {
        console.error('fetchServerChannels', e);
        return null;
    }
}

const TEXT_CH_SVG =
    '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.87344C10.1845 3 10.4201 3.28107 10.3657 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8734C18.1845 3 18.4201 3.28107 18.3657 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8866C13.5755 21 13.3399 20.7189 13.3943 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41045 9L8.35045 15H14.3504L15.4104 9H9.41045Z"/></svg>';
const VOICE_CH_SVG =
    '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C10.895 2 10 2.895 10 4V12C10 13.105 10.895 14 12 14C13.105 14 14 13.105 14 12V4C14 2.895 13.105 2 12 2ZM19 10V12C19 15.866 15.866 19 12 19C8.134 19 5 15.866 5 12V10H3V12C3 16.418 6.269 20.099 10.5 20.856V24H13.5V20.856C17.731 20.099 21 16.418 21 12V10H19Z"/></svg>';

function renderChannelTree(tree) {
    const root = document.getElementById('channelsTreeRoot');
    if (!root || !tree || !tree.categories) {
        return;
    }
    root.innerHTML = '';
    tree.categories.forEach((cat) => {
        const wrap = document.createElement('div');
        wrap.className = 'channel-category';
        const header = document.createElement('div');
        header.className = 'category-header';
        header.innerHTML = `<span>${escapeHtml(cat.name || 'Категория')}</span>`;
        wrap.appendChild(header);
        (cat.channels || []).forEach((c) => {
            const row = document.createElement('div');
            const isVoice = String(c.type == null ? '' : c.type).trim().toLowerCase() === 'voice';
            row.className = isVoice ? 'channel voice-channel' : 'channel text-channel';
            row.setAttribute('data-channel-id', String(c.id));
            row.setAttribute('data-channel', c.name);
            row.innerHTML = `${isVoice ? VOICE_CH_SVG : TEXT_CH_SVG}<span>${escapeHtml(channelDisplayName(c.name))}</span>`;
            wrap.appendChild(row);
        });
        root.appendChild(wrap);
    });
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
}

function getMessengerSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        const s = raw ? JSON.parse(raw) : {};
        if (s.desktopNotifications === undefined) s.desktopNotifications = true;
        if (s.soundInApp === undefined) s.soundInApp = false;
        if (s.compactMessages === undefined) s.compactMessages = false;
        if (s.theme === undefined) s.theme = 'light';
        if (s.fontScale === undefined) s.fontScale = 100;
        if (s.sidebarWidthPx === undefined) s.sidebarWidthPx = 260;
        if (s.linksOpenNewTab === undefined) s.linksOpenNewTab = true;
        if (s.dndEnabled === undefined) s.dndEnabled = false;
        if (s.dndStart === undefined) s.dndStart = '22:00';
        if (s.dndEnd === undefined) s.dndEnd = '08:00';
        if (s.privacyDmFriendsOnly === undefined) s.privacyDmFriendsOnly = false;
        if (s.privacyGroupInvitesFriends === undefined) s.privacyGroupInvitesFriends = false;
        if (s.privacyHideOnline === undefined) s.privacyHideOnline = false;
        if (s.chatWallpaperPreset === undefined) s.chatWallpaperPreset = '';
        if (s.chatWallpaperUrl === undefined) s.chatWallpaperUrl = '';
        if (s.chatWallpaperBlur === undefined) s.chatWallpaperBlur = 0;
        if (s.displayName === undefined) s.displayName = '';
        if (s.bio === undefined) s.bio = '';
        if (s.audioInputDeviceId === undefined) s.audioInputDeviceId = '';
        if (s.audioOutputDeviceId === undefined) s.audioOutputDeviceId = '';
        if (!s.channelPrefs || typeof s.channelPrefs !== 'object') s.channelPrefs = {};
        return s;
    } catch {
        return {
            desktopNotifications: true,
            soundInApp: false,
            compactMessages: false,
            theme: 'light',
            fontScale: 100,
            sidebarWidthPx: 260,
            linksOpenNewTab: true,
            dndEnabled: false,
            dndStart: '22:00',
            dndEnd: '08:00',
            channelPrefs: {}
        };
    }
}

function minutesSinceMidnight(d) {
    return d.getHours() * 60 + d.getMinutes();
}

function parseTimeHHMM(str) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(str || '');
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

function isDoNotDisturbNow() {
    const s = getMessengerSettings();
    if (!s.dndEnabled) return false;
    const start = parseTimeHHMM(s.dndStart);
    const end = parseTimeHHMM(s.dndEnd);
    if (start == null || end == null) return false;
    const now = minutesSinceMidnight(new Date());
    if (start < end) {
        return now >= start && now < end;
    }
    return now >= start || now < end;
}

function applyFontScale() {
    const n = Number(getMessengerSettings().fontScale) || 100;
    document.documentElement.style.fontSize = `${n / 100 * 16}px`;
}

function applySidebarWidth() {
    const w = Number(getMessengerSettings().sidebarWidthPx) || 260;
    document.documentElement.style.setProperty('--flor-channel-sidebar-width', `${Math.min(360, Math.max(220, w))}px`);
}

function applyChatWallpaper() {
    const chat = document.getElementById('chatView');
    if (!chat) return;
    const s = getMessengerSettings();
    const blur = Math.min(24, Math.max(0, Number(s.chatWallpaperBlur) || 0));
    let url = (s.chatWallpaperUrl && String(s.chatWallpaperUrl).trim()) || '';
    const preset = s.chatWallpaperPreset;
    if (!url && preset === 'purple') {
        url =
            'linear-gradient(135deg, rgba(109,40,217,0.25) 0%, rgba(196,181,253,0.35) 50%, rgba(237,233,254,0.5) 100%)';
    } else if (!url && preset === 'night') {
        url = 'linear-gradient(160deg, #1e1b4b 0%, #312e81 40%, #0f172a 100%)';
    } else if (!url && preset === 'mint') {
        url = 'linear-gradient(135deg, #ecfdf5 0%, #a7f3d0 45%, #d1fae5 100%)';
    }
    chat.style.setProperty('--flor-chat-wallpaper-blur', `${blur}px`);
    if (url && (url.startsWith('linear-gradient') || url.startsWith('radial-gradient'))) {
        chat.style.setProperty('--flor-chat-wallpaper', url);
        chat.classList.add('chat-view-walled');
        chat.style.setProperty('--flor-chat-wallpaper-overlay', preset === 'night' ? '0.55' : '0.72');
    } else if (url) {
        chat.style.setProperty('--flor-chat-wallpaper', `url("${url.replace(/"/g, '\\"')}")`);
        chat.classList.add('chat-view-walled');
        chat.style.setProperty('--flor-chat-wallpaper-overlay', '0.78');
    } else {
        chat.classList.remove('chat-view-walled');
        chat.style.removeProperty('--flor-chat-wallpaper');
    }
}

function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onerror = () => reject(req.error);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(IDB_STORE)) {
                req.result.createObjectStore(IDB_STORE, { keyPath: 'channelId' });
            }
        };
        req.onsuccess = () => resolve(req.result);
    });
}

async function idbPutChannelMessages(channelId, messages) {
    try {
        const db = await idbOpen();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.objectStore(IDB_STORE).put({
                channelId: String(channelId),
                messages,
                updatedAt: Date.now()
            });
        });
        db.close();
    } catch (e) {
        console.warn('IndexedDB put', e);
    }
}

async function idbGetChannelMessages(channelId) {
    try {
        const db = await idbOpen();
        const row = await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const q = tx.objectStore(IDB_STORE).get(String(channelId));
            q.onsuccess = () => resolve(q.result);
            q.onerror = () => reject(q.error);
        });
        db.close();
        return row && row.messages ? row.messages : null;
    } catch (e) {
        return null;
    }
}

function bookmarkContextKey() {
    if (currentView === 'dm' && currentDMUserId) {
        return `dm:${currentDMUserId}`;
    }
    if (currentView === 'server' && currentServerId && currentChannel) {
        return `server:${currentServerId}:ch:${currentChannel}`;
    }
    return 'unknown';
}

function filterChatMessages(query) {
    const q = (query || '').trim().toLowerCase();
    document.querySelectorAll('#messagesContainer .message-group').forEach((el) => {
        const t = (el.textContent || '').toLowerCase();
        if (!q || t.includes(q)) {
            el.classList.remove('message-search-hidden');
        } else {
            el.classList.add('message-search-hidden');
        }
    });
}

function getBookmarks() {
    try {
        const raw = localStorage.getItem(BOOKMARKS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function saveBookmarks(arr) {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(arr.slice(0, 200)));
}

function toggleBookmarkEntry(entry) {
    const list = getBookmarks();
    const i = list.findIndex((x) => x.id === entry.id && x.context === entry.context);
    if (i >= 0) {
        list.splice(i, 1);
        saveBookmarks(list);
        return false;
    }
    list.unshift(entry);
    saveBookmarks(list);
    return true;
}

function linkifyToFragment(text) {
    const frag = document.createDocumentFragment();
    if (text == null || text === '') return frag;
    const str = String(text);
    const openNew = getMessengerSettings().linksOpenNewTab !== false;
    const re = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/gi;
    let last = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
        if (m.index > last) {
            frag.appendChild(document.createTextNode(str.slice(last, m.index)));
        }
        const a = document.createElement('a');
        a.href = m[0];
        a.textContent = m[0];
        if (openNew) {
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
        }
        frag.appendChild(a);
        last = m.index + m[0].length;
    }
    if (last < str.length) {
        frag.appendChild(document.createTextNode(str.slice(last)));
    }
    return frag;
}

function getEffectiveTheme() {
    return getMessengerSettings().theme === 'dark' ? 'dark' : 'light';
}

const THEME_MOON_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const THEME_SUN_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';

function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'dark') {
        root.setAttribute('data-theme', 'dark');
    } else {
        root.removeAttribute('data-theme');
    }
    syncThemeToggleButton(theme);
}

function syncThemeToggleButton(theme) {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    const isDark = theme === 'dark';
    btn.title = isDark ? 'Светлая тема' : 'Тёмная тема';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    btn.innerHTML = isDark ? THEME_SUN_SVG : THEME_MOON_SVG;
}

function initializeThemeToggle() {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
        saveMessengerSettings({ theme: next });
        applyTheme(next);
    });
}

function saveMessengerSettings(patch) {
    const next = { ...getMessengerSettings(), ...patch };
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
}

let florAudioCtx = null;
let florPingAudio = null;
let florPingDataUrlCache = null;

function florEncodeWavMono16(sampleRate, int16Samples) {
    const n = int16Samples.length;
    const dataSize = n * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(buf);
    let p = 0;
    const w4 = (s) => {
        for (let i = 0; i < 4; i++) dv.setUint8(p++, s.charCodeAt(i));
    };
    w4('RIFF');
    dv.setUint32(p, 36 + dataSize, true);
    p += 4;
    w4('WAVE');
    w4('fmt ');
    dv.setUint32(p, 16, true);
    p += 4;
    dv.setUint16(p, 1, true);
    p += 2;
    dv.setUint16(p, 1, true);
    p += 2;
    dv.setUint32(p, sampleRate, true);
    p += 4;
    dv.setUint32(p, sampleRate * 2, true);
    p += 4;
    dv.setUint16(p, 2, true);
    p += 2;
    dv.setUint16(p, 16, true);
    p += 2;
    w4('data');
    dv.setUint32(p, dataSize, true);
    p += 4;
    for (let i = 0; i < n; i++, p += 2) {
        dv.setInt16(p, int16Samples[i], true);
    }
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return `data:audio/wav;base64,${btoa(binary)}`;
}

function florGetPingDataUrl() {
    if (!florPingDataUrlCache) {
        const sr = 22050;
        const n = Math.floor(sr * 0.085);
        const f = 880;
        const out = new Int16Array(n);
        for (let i = 0; i < n; i++) {
            const env = Math.sin((Math.PI * i) / Math.max(1, n - 1));
            out[i] = Math.round(0.2 * 32767 * env * Math.sin((2 * Math.PI * f * i) / sr));
        }
        florPingDataUrlCache = florEncodeWavMono16(sr, out);
    }
    return florPingDataUrlCache;
}

function florTryPlayMediaElement(el) {
    if (!el) return;
    const pr = el.play();
    if (pr && typeof pr.catch === 'function') pr.catch(() => {});
}

/** После первого касания/клавиши: звук уведомлений на http и удалённое аудио WebRTC без «тихого» видео */
function florInitMediaPlaybackUnlock() {
    if (window.florMediaPlaybackUnlockInit) return;
    window.florMediaPlaybackUnlockInit = true;
    const unlock = () => {
        try {
            if (florAudioCtx && florAudioCtx.state === 'suspended') florAudioCtx.resume().catch(() => {});
        } catch (_) {}
        try {
            if (!florPingAudio) {
                florPingAudio = new Audio(florGetPingDataUrl());
                florPingAudio.preload = 'auto';
                florPingAudio.volume = 0.14;
            }
            florPingAudio.volume = 0;
            florPingAudio.play().then(() => {
                florPingAudio.pause();
                florPingAudio.currentTime = 0;
                florPingAudio.volume = 0.14;
            }).catch(() => {
                florPingAudio.volume = 0.14;
            });
        } catch (_) {}
        document
            .querySelectorAll(
                '#remoteParticipants video, #callInterface video:not(#localVideo), #incomingCall video'
            )
            .forEach((v) => florTryPlayMediaElement(v));
    };
    document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    document.addEventListener('keydown', unlock, { capture: true });
}

function playSoftPing() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx && window.isSecureContext) {
            if (!florAudioCtx) florAudioCtx = new Ctx();
            const ctx = florAudioCtx;
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g);
            g.connect(ctx.destination);
            o.frequency.value = 880;
            g.gain.setValueAtTime(0.06, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
            o.start(ctx.currentTime);
            o.stop(ctx.currentTime + 0.14);
            return;
        }
    } catch (_) {}
    try {
        if (florPingAudio) {
            florPingAudio.currentTime = 0;
            florPingAudio.play().catch(() => {});
        }
    } catch (_) {}
}

function applyCompactMessages() {
    document.body.classList.toggle('flor-compact-messages', getMessengerSettings().compactMessages === true);
}

function friendStatusLabel(status) {
    if (status === 'Online') return 'В сети';
    if (status === 'Offline') return 'Не в сети';
    return status || '';
}

function channelDisplayName(channelName) {
    const map = {
        general: 'общий',
        random: 'разное',
        'voice-1': 'Общий голос',
        'voice-2': 'Игры'
    };
    return map[channelName] || channelName;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    applyTheme(getEffectiveTheme());
    applyCompactMessages();
    applyFontScale();
    applySidebarWidth();
    applyChatWallpaper();

    token = localStorage.getItem('token');
    const userStr = localStorage.getItem('currentUser');
    
    if (!token || !userStr) {
        window.location.replace('login.html');
        return;
    }
    
    try {
        currentUser = JSON.parse(userStr);
        initializeApp();
    } catch (e) {
        console.error('Error parsing user data:', e);
        localStorage.removeItem('token');
        localStorage.removeItem('currentUser');
        window.location.replace('login.html');
    }
});

function initializeApp() {
    florInitMediaPlaybackUnlock();
    updateUserInfo();
    initializeFriendsTabs();
    initializeChannels();
    initializeMessageInput();
    initializeUserControls();
    initializeThemeToggle();
    initializeSettingsHub();
    initializeServerHeaderMenu();
    initializeBookmarksPanel();
    initializeChannelSettingsPanel();
    initializeServerSettingsSave();
    initializeServerCreateChannel();
    initializeMembersPanel();
    initializeChatTools();
    initializeHotkeys();
    initializeCallControls();
    initializeServerManagement();
    initializeMobileNav();
    initializeMobileTabbar();
    initializeMobileSwipeNav();
    initializeFileUpload();
    initializeEmojiPicker();
    initializeDraggableCallWindow();
    connectToSocketIO();
    requestNotificationPermission();
    loadUserServers();
    showFriendsView();
    (async () => {
        try {
            await florRefreshUserKeyCache();
            if (window.florE2ee) {
                await window.florE2ee.init(florApi, token, async (userId) => {
                    let k = florUserKeyCache.get(userId);
                    if (k) return k;
                    await florRefreshUserKeyCache();
                    return florUserKeyCache.get(userId) || null;
                });
                if (
                    typeof window.florE2ee.isActive === 'function' &&
                    !window.florE2ee.isActive() &&
                    window.florE2ee.httpsHint
                ) {
                    console.warn('[FLOR]', window.florE2ee.httpsHint);
                }
            }
        } catch (e) {
            console.error('E2EE init:', e);
        }
    })();
}

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function showNotification(title, body) {
    const s = getMessengerSettings();
    if (s.desktopNotifications === false) return;
    if (isDoNotDisturbNow()) return;
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/assets/flor-logo.png' });
    }
}

function updateUserInfo() {
    const userAvatar = document.querySelector('.user-avatar');
    const username = document.querySelector('.username');
    const userStatus = document.querySelector('.user-status');

    if (userAvatar) userAvatar.textContent = currentUser.avatar;
    const disp = getMessengerSettings().displayName;
    if (username) username.textContent = (disp && disp.trim()) || currentUser.username;
    if (userStatus) {
        userStatus.textContent = getMessengerSettings().privacyHideOnline ? 'Невидимка' : 'В сети';
    }
}

function connectToSocketIO() {
    if (typeof io !== 'undefined') {
        socket = io(florOrigin(), { auth: { token: token } });
        
        socket.on('connect', () => {
            florDevLog('Connected to server');
        });

        socket.on('server-membership-update', () => {
            if (socket && socket.connected) {
                socket.emit('resync-server-rooms');
            }
            loadUserServers();
        });
        
       socket.on('connect_error', (error) => {
            console.error('Connection error:', error);
        });

        socket.on('message-send-error', (data) => {
            const msg = (data && data.error) || 'Сообщение не отправлено';
            alert(msg);
        });
        
        socket.on('new-message', async (data) => {
            const channelId = data.channelId;
            const channelName =
                (typeof data.channelName === 'string' && data.channelName.trim()) ||
                getChannelNameById(channelId);
            if (!channelName) return;

            if (
                data.serverId != null &&
                currentServerId != null &&
                Number(data.serverId) !== Number(currentServerId)
            ) {
                return;
            }

            if (!channels[channelName]) {
                channels[channelName] = [];
            }
            channels[channelName].push(data.message);
            
            if (channelName === currentChannel && currentView === 'server') {
                const mid = data.message && data.message.id;
                const box = document.getElementById('messagesContainer');
                if (mid != null && box && box.querySelector(`[data-message-id="${mid}"]`)) {
                    return;
                }
                let msg = data.message;
                if (msg && window.florE2ee && currentServerRecord && data.channelId != null) {
                    const text = await florDecryptChannelMessage(data.channelId, msg.text);
                    msg = { ...msg, text };
                }
                addMessageToUI(msg);
                scrollToBottom();
                if (
                    getMessengerSettings().soundInApp === true &&
                    document.visibilityState === 'visible' &&
                    !isDoNotDisturbNow()
                ) {
                    playSoftPing();
                }
            }
            
            if (document.hidden && getMessengerSettings().desktopNotifications !== false && !isDoNotDisturbNow()) {
                const rawT = data.message.text;
                const preview =
                    window.florE2ee && florE2ee.isE2eePayload(rawT) ? 'зашифрованное сообщение' : rawT;
                showNotification('Новое сообщение', `${data.message.author}: ${preview}`);
            }
        });
        
        socket.on('reaction-update', (data) => {
            updateMessageReactions(data.messageId, data.reactions);
        });

        // WebRTC Signaling
        socket.on('user-joined-voice', (data) => {
            florDevLog('User joined voice:', data);
            createPeerConnection(data.socketId, true);
        });

        socket.on('existing-voice-users', (users) => {
            users.forEach(user => {
                createPeerConnection(user.socketId, false);
            });
        });

        socket.on('user-left-voice', (socketId) => {
            if (peerConnections[socketId]) {
                peerConnections[socketId].close();
                delete peerConnections[socketId];
            }
            const remoteVideo = document.getElementById(`remote-${socketId}`);
            if (remoteVideo) remoteVideo.remove();
        });

        socket.on('offer', async (data) => {
            if (!peerConnections[data.from]) {
                createPeerConnection(data.from, false);
            }
            const pc = peerConnections[data.from];
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('answer', { to: data.from, answer: answer });
        });

        socket.on('answer', async (data) => {
            const pc = peerConnections[data.from];
            if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            }
        });

        socket.on('ice-candidate', async (data) => {
            const pc = peerConnections[data.from];
            if (pc && data.candidate) {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
        });
        
        socket.on('video-toggle', (data) => {
            // Update UI when peer toggles video
            const participantDiv = document.getElementById(`participant-${data.from}`);
            if (participantDiv) {
                if (data.enabled) {
                    participantDiv.style.opacity = '1';
                } else {
                    participantDiv.style.opacity = '0.7';
                }
            }
        });
        socket.on('new-dm', async (data) => {
            if (data.senderId === currentDMUserId) {
                let t = data.message.text;
                if (window.florE2ee) {
                    t = await florE2ee.decryptDmPayload(t, data.senderId);
                }
                addMessageToUI({
                    id: data.message.id,
                    senderId: data.message.senderId,
                    author: data.message.author,
                    avatar: data.message.avatar,
                    text: t,
                    timestamp: data.message.timestamp
                });
                scrollToBottom();
                if (
                    getMessengerSettings().soundInApp === true &&
                    document.visibilityState === 'visible' &&
                    !isDoNotDisturbNow()
                ) {
                    playSoftPing();
                }
            }
        });

        socket.on('dm-sent', async (data) => {
            if (data.receiverId === currentDMUserId) {
                let t = data.message.text;
                if (window.florE2ee) {
                    t = await florE2ee.decryptDmPayload(t, data.receiverId);
                }
                addMessageToUI({
                    id: data.message.id,
                    senderId: data.senderId != null ? data.senderId : currentUser.id,
                    author: currentUser.username,
                    avatar: currentUser.avatar,
                    text: t,
                    timestamp: data.message.timestamp
                });
                scrollToBottom();
            }
        });

        socket.on('new-friend-request', () => {
            loadPendingRequests();
            showNotification('Заявка в друзья', 'Вам пришла новая заявка в друзья.');
        });

        socket.on('incoming-call', (data) => {
            const { from, type } = data;
            if (from) {
                showIncomingCall(from, type);
            }
        });

        socket.on('call-accepted', (data) => {
            florDevLog('Call accepted by:', data.from);
            // When call is accepted, create peer connection
            document.querySelector('.call-channel-name').textContent = `Связь с ${data.from.username}`;
            
            // Create peer connection as initiator
            if (!peerConnections[data.from.socketId]) {
                createPeerConnection(data.from.socketId, true);
            }
        });

        socket.on('call-rejected', (data) => {
            alert('Звонок отклонён');
            // Close call interface
            const callInterface = document.getElementById('callInterface');
            callInterface.classList.add('hidden');
            if (localStream) {
                localStream.getTracks().forEach(track => track.stop());
                localStream = null;
            }
            inCall = false;
        });
        
        socket.on('call-ended', (data) => {
            // Handle when other party ends the call
            if (peerConnections[data.from]) {
                peerConnections[data.from].close();
                delete peerConnections[data.from];
            }
            const remoteVideo = document.getElementById(`remote-${data.from}`);
            if (remoteVideo) remoteVideo.remove();
            
            // If no more connections, end the call
            if (Object.keys(peerConnections).length === 0) {
                leaveVoiceChannel(true);
            }
        });
    }
}

// Initialize friends tabs
function initializeFriendsTabs() {
    const tabs = document.querySelectorAll('.friends-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.getAttribute('data-tab');
            switchFriendsTab(tabName);
        });
    });
    
    const searchBtn = document.getElementById('searchUserBtn');
    if (searchBtn) {
        searchBtn.addEventListener('click', searchUsers);
    }
    
    loadFriends();
}

function switchFriendsTab(tabName) {
    document.querySelectorAll('.friends-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
    
    document.querySelectorAll('.friends-list').forEach(l => l.classList.remove('active-tab'));
    const contentMap = {
        'online': 'friendsOnline',
        'all': 'friendsAll',
        'pending': 'friendsPending',
        'add': 'friendsAdd'
    };
    document.getElementById(contentMap[tabName]).classList.add('active-tab');
    
    if (tabName === 'pending') {
        loadPendingRequests();
    }
}

async function loadFriends() {
    try {
        const response = await fetch(florApi('/api/friends'), {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const friends = await response.json();
        displayFriends(friends);
        populateDMList(friends);
        await florRefreshUserKeyCache();
    } catch (error) {
        console.error('Error loading friends:', error);
    }
}

function displayFriends(friends) {
    const onlineList = document.getElementById('friendsOnline');
    const allList = document.getElementById('friendsAll');
    
    onlineList.innerHTML = '';
    allList.innerHTML = '';
    
    if (friends.length === 0) {
        onlineList.innerHTML = '<div class="friends-empty">Пока нет друзей</div>';
        allList.innerHTML = '<div class="friends-empty">Пока нет друзей</div>';
        return;
    }
    
    const onlineFriends = friends.filter(f => f.status === 'Online');
    
    if (onlineFriends.length === 0) {
        onlineList.innerHTML = '<div class="friends-empty">Никого нет в сети</div>';
    } else {
        onlineFriends.forEach(friend => {
            onlineList.appendChild(createFriendItem(friend));
        });
    }
    
    friends.forEach(friend => {
        allList.appendChild(createFriendItem(friend));
    });
}

function createFriendItem(friend) {
    const div = document.createElement('div');
    div.className = 'friend-item';
    
    div.innerHTML = `
        <div class="friend-avatar">${friend.avatar || friend.username.charAt(0).toUpperCase()}</div>
        <div class="friend-info">
            <div class="friend-name">${friend.username}</div>
            <div class="friend-status ${friend.status === 'Online' ? '' : 'offline'}">${friendStatusLabel(friend.status)}</div>
        </div>
        <div class="friend-actions">
            <button class="friend-action-btn message" title="Написать">💬</button>
            <button class="friend-action-btn audio-call" title="Аудиозвонок">📞</button>
            <button class="friend-action-btn video-call" title="Видеозвонок">📹</button>
            <button class="friend-action-btn remove" title="Удалить из друзей">🗑️</button>
        </div>
    `;

    div.querySelector('.message').addEventListener('click', () => startDM(friend.id, friend.username));
    div.querySelector('.audio-call').addEventListener('click', () => initiateCall(friend.id, 'audio'));
    div.querySelector('.video-call').addEventListener('click', () => initiateCall(friend.id, 'video'));
    div.querySelector('.remove').addEventListener('click', () => removeFriend(friend.id));
    
    return div;
}

async function searchUsers() {
    const searchInput = document.getElementById('searchUserInput');
    const query = searchInput.value.trim();
    
    if (!query) return;
    
    try {
        const response = await fetch(florApi('/api/users'), {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const users = await response.json();
        
        const results = users.filter(u => 
            u.username.toLowerCase().includes(query.toLowerCase()) && 
            u.id !== currentUser.id
        );
        
        displaySearchResults(results);
        await florRefreshUserKeyCache();
    } catch (error) {
        console.error('Error searching users:', error);
    }
}

function displaySearchResults(users) {
    const resultsDiv = document.getElementById('searchResults');
    resultsDiv.innerHTML = '';
    
    if (users.length === 0) {
        resultsDiv.innerHTML = '<div class="friends-empty">Пользователи не найдены</div>';
        return;
    }
    
    users.forEach(user => {
        const div = document.createElement('div');
        div.className = 'user-search-item';
        
        div.innerHTML = `
            <div class="user-avatar">${user.avatar || user.username.charAt(0).toUpperCase()}</div>
            <div class="user-info">
                <div class="user-name">${user.username}</div>
            </div>
            <button class="add-friend-btn" onclick="sendFriendRequest(${user.id})">В друзья</button>
        `;
        
        resultsDiv.appendChild(div);
    });
}

window.sendFriendRequest = async function(friendId) {
    try {
        const response = await fetch(florApi('/api/friends/request'), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ friendId })
        });
        
        if (response.ok) {
            alert('Заявка отправлена');
        } else {
            const error = await response.json();
            alert(error.error || 'Не удалось отправить заявку');
        }
    } catch (error) {
        console.error('Error sending friend request:', error);
        alert('Не удалось отправить заявку');
    }
};

async function loadPendingRequests() {
    try {
        const response = await fetch(florApi('/api/friends/pending'), {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const requests = await response.json();
        
        const pendingList = document.getElementById('friendsPending');
        pendingList.innerHTML = '';
        
        if (requests.length === 0) {
            pendingList.innerHTML = '<div class="friends-empty">Нет входящих заявок</div>';
            return;
        }
        
        requests.forEach(request => {
            const div = document.createElement('div');
            div.className = 'friend-item';
            
            div.innerHTML = `
                <div class="friend-avatar">${request.avatar || request.username.charAt(0).toUpperCase()}</div>
                <div class="friend-info">
                    <div class="friend-name">${request.username}</div>
                    <div class="friend-status">Входящая заявка в друзья</div>
                </div>
                <div class="friend-actions">
                    <button class="friend-action-btn accept" onclick="acceptFriendRequest(${request.id})">✓</button>
                    <button class="friend-action-btn reject" onclick="rejectFriendRequest(${request.id})">✕</button>
                </div>
            `;
            
            pendingList.appendChild(div);
        });
    } catch (error) {
        console.error('Error loading pending requests:', error);
    }
}

window.acceptFriendRequest = async function(friendId) {
    try {
        const response = await fetch(florApi('/api/friends/accept'), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ friendId })
        });
        
        if (response.ok) {
            loadPendingRequests();
            loadFriends();
        }
    } catch (error) {
        console.error('Error accepting friend request:', error);
    }
};

window.rejectFriendRequest = async function(friendId) {
    try {
        const response = await fetch(florApi('/api/friends/reject'), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ friendId })
        });
        
        if (response.ok) {
            loadPendingRequests();
        }
    } catch (error) {
        console.error('Error rejecting friend request:', error);
    }
};

window.removeFriend = async function(friendId) {
    if (!confirm('Удалить этого пользователя из друзей?')) return;
    
    try {
        const response = await fetch(florApi(`/api/friends/${friendId}`), {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (response.ok) {
            loadFriends();
        }
    } catch (error) {
        console.error('Error removing friend:', error);
    }
};

// Initiate call function
async function initiateCall(friendId, type) {
    try {
        // Always request both video and audio, but disable video if it's audio call
        const constraints = { video: true, audio: true };
        
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // If audio call, disable video track initially
        if (type === 'audio') {
            localStream.getVideoTracks().forEach(track => {
                track.enabled = false;
            });
        }
        
        // Show call interface
        const callInterface = document.getElementById('callInterface');
        callInterface.classList.remove('hidden');
        
        // Update call header
        document.querySelector('.call-channel-name').textContent = 'Вызов…';
        
        // Set local video
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = localStream;
        
        // Store call details
        window.currentCallDetails = {
            friendId: friendId,
            type: type,
            isInitiator: true,
            originalType: type
        };
        
        // Emit call request via socket
        if (socket && socket.connected) {
            socket.emit('initiate-call', {
                to: friendId,
                type: type,
                from: {
                    id: currentUser.id,
                    username: currentUser.username,
                    socketId: socket.id
                }
            });
        }
        
        inCall = true;
        isVideoEnabled = type === 'video';
        isAudioEnabled = true;
        updateCallButtons();
        
        // Initialize resizable functionality after a short delay
        setTimeout(() => {
            if (typeof initializeResizableVideos === 'function') {
                initializeResizableVideos();
            }
        }, 100);
        
    } catch (error) {
        console.error('Error initiating call:', error);
        alert(florMediaAccessHint());
    }
}

// Show incoming call notification
function showIncomingCall(caller, type) {
    const incomingCallDiv = document.getElementById('incomingCall');
    const callerName = incomingCallDiv.querySelector('.caller-name');
    const callerAvatar = incomingCallDiv.querySelector('.caller-avatar');
    
    callerName.textContent = caller.username || 'Неизвестный';
    callerAvatar.textContent = caller.avatar || caller.username?.charAt(0).toUpperCase() || 'U';
    
    incomingCallDiv.classList.remove('hidden');
    
    // Set up accept/reject handlers
    const acceptBtn = document.getElementById('acceptCallBtn');
    const rejectBtn = document.getElementById('rejectCallBtn');
    
    acceptBtn.onclick = async () => {
        incomingCallDiv.classList.add('hidden');
        await acceptCall(caller, type);
    };
    
    rejectBtn.onclick = () => {
        incomingCallDiv.classList.add('hidden');
        rejectCall(caller);
    };
    
    // Auto-reject after 30 seconds
    setTimeout(() => {
        if (!incomingCallDiv.classList.contains('hidden')) {
            incomingCallDiv.classList.add('hidden');
            rejectCall(caller);
        }
    }, 30000);
}

// Accept incoming call
async function acceptCall(caller, type) {
    try {
        // Always request both video and audio
        const constraints = { video: true, audio: true };
        
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // If audio call, disable video track initially
        if (type === 'audio') {
            localStream.getVideoTracks().forEach(track => {
                track.enabled = false;
            });
        }
        
        // Show call interface
        const callInterface = document.getElementById('callInterface');
        callInterface.classList.remove('hidden');
        
        document.querySelector('.call-channel-name').textContent = `Звонок с ${caller.username}`;
        
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = localStream;
        
        // Store call details
        window.currentCallDetails = {
            peerId: caller.socketId,
            type: type,
            isInitiator: false,
            originalType: type
        };
        
        if (socket && socket.connected) {
            socket.emit('accept-call', {
                to: caller.socketId,
                from: {
                    id: currentUser.id,
                    username: currentUser.username,
                    socketId: socket.id
                }
            });
        }
        
        inCall = true;
        isVideoEnabled = type === 'video';
        isAudioEnabled = true;
        updateCallButtons();
        
        // Create peer connection as receiver (not initiator)
        if (!peerConnections[caller.socketId]) {
            createPeerConnection(caller.socketId, false);
        }
        
        // Initialize resizable functionality after a short delay
        setTimeout(() => {
            if (typeof initializeResizableVideos === 'function') {
                initializeResizableVideos();
            }
        }, 100);
        
    } catch (error) {
        console.error('Error accepting call:', error);
        alert(florMediaAccessHint());
    }
}

// Reject incoming call
function rejectCall(caller) {
    if (socket && socket.connected) {
        socket.emit('reject-call', { to: caller.socketId });
    }
}

window.startDM = async function(friendId, friendUsername) {
    currentView = 'dm';
    currentDMUserId = friendId;
    currentServerId = null;
    currentTextChannelId = null;

    document.getElementById('friendsView').style.display = 'none';
    document.getElementById('chatView').style.display = 'flex';
    document.getElementById('channelsView').style.display = 'none';
    document.getElementById('dmListView').style.display = 'block';

    const chatHeaderInfo = document.getElementById('chatHeaderInfo');
    chatHeaderInfo.innerHTML = `
        <div class="friend-avatar">${friendUsername.charAt(0).toUpperCase()}</div>
        <span class="channel-name">${friendUsername}</span>
    `;
    
    document.getElementById('messageInput').placeholder = `Сообщение для @${friendUsername}`;
    
    await loadDMHistory(friendId);
    syncServerHeaderMenuVisibility();
};

// Show friends view
function showFriendsView() {
    if (activeVoiceRoomKey) {
        leaveVoiceChannel(true);
    }

    currentView = 'friends';
    currentDMUserId = null;
    currentServerId = null;
    currentTextChannelId = null;
    currentChannel = '';

    document.getElementById('friendsView').style.display = 'flex';
    document.getElementById('chatView').style.display = 'none';
    document.getElementById('channelsView').style.display = 'none';
    document.getElementById('dmListView').style.display = 'block';
    
    document.getElementById('serverName').textContent = 'Друзья';

    const membersBtn = document.getElementById('membersBtn');
    if (membersBtn) membersBtn.hidden = true;
    
    document.querySelectorAll('.server-icon').forEach(icon => icon.classList.remove('active'));
    document.getElementById('friendsBtn').classList.add('active');
    
    // Hide chat and show friends content
    document.getElementById('chatView').style.display = 'none';
    document.getElementById('friendsView').style.display = 'flex';
    syncServerHeaderMenuVisibility();
}

// Show server view
async function showServerView(server) {
    if (inCall && currentServerId != null && currentServerId !== server.id) {
        leaveVoiceChannel(true);
    }
    currentView = 'server';
    currentServerId = Number(server.id);
    currentServerRecord = server;
    currentDMUserId = null;

    const membersBtn = document.getElementById('membersBtn');
    if (membersBtn) membersBtn.hidden = false;

    document.getElementById('friendsView').style.display = 'none';
    document.getElementById('chatView').style.display = 'flex';
    document.getElementById('channelsView').style.display = 'block';
    document.getElementById('dmListView').style.display = 'none';

    document.getElementById('serverName').textContent = server.name;
    const tree = await fetchServerChannels(server.id);
    if (tree) {
        renderChannelTree(tree);
    }
    const firstText = currentServerChannelMap.general != null
        ? 'general'
        : Object.keys(currentServerChannelMap)[0];
    if (firstText) {
        switchChannel(firstText);
    } else {
        currentChannel = '';
        currentTextChannelId = null;
        document.getElementById('messagesContainer').innerHTML =
            '<p class="empty-channel-hint" style="padding:16px;color:var(--flor-muted);">Нет текстовых каналов на этом сервере.</p>';
    }
    if (socket && socket.connected) {
        socket.emit('resync-server-rooms');
    }
    syncServerHeaderMenuVisibility();
}

function syncServerHeaderMenuVisibility() {
    const btn = document.getElementById('serverHeaderMenuBtn');
    const drop = document.getElementById('serverHeaderDropdown');
    if (!btn) return;
    if (currentView !== 'server') {
        btn.style.visibility = 'hidden';
        if (drop) drop.classList.add('hidden');
    } else {
        btn.style.visibility = 'visible';
    }
}

async function loadUserServers() {
    try {
        const response = await fetch(florApi('/api/servers'), {
            headers: { Authorization: `Bearer ${token}` }
        });
        const next = await response.json();
        document.querySelectorAll('.server-icon[data-server-id]').forEach((el) => el.remove());
        servers = Array.isArray(next) ? next : [];
        servers.forEach((server) => addServerToUI(server, false));
        const cur =
            currentServerId != null && currentServerId !== ''
                ? Number(currentServerId)
                : NaN;
        if (Number.isFinite(cur)) {
            const srv = servers.find((s) => Number(s.id) === cur);
            if (srv) {
                await showServerView(srv);
            }
        }
    } catch (error) {
        console.error('Error loading servers:', error);
    }
}

function initializeMobileNav() {
    const shell = document.getElementById('florSidebarShell');
    const backdrop = document.getElementById('florMobileNavBackdrop');
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 768px)') : null;

    function isMobileNavLayout() {
        return mq ? mq.matches : window.innerWidth <= 768;
    }

    function syncMobileNavBackdropAria() {
        if (!backdrop) return;
        const open = document.body.classList.contains('flor-mobile-sidebar-open');
        backdrop.setAttribute('aria-hidden', open && isMobileNavLayout() ? 'false' : 'true');
    }

    function setMobileSidebarOpen(open) {
        document.body.classList.toggle('flor-mobile-sidebar-open', Boolean(open));
        document.querySelectorAll('.flor-mobile-nav-btn').forEach((btn) => {
            btn.setAttribute('aria-expanded', open && isMobileNavLayout() ? 'true' : 'false');
        });
        syncMobileNavBackdropAria();
    }

    function closeMobileSidebarIfMobile() {
        if (isMobileNavLayout()) setMobileSidebarOpen(false);
    }

    function toggleSidebar() {
        if (!isMobileNavLayout()) return;
        setMobileSidebarOpen(!document.body.classList.contains('flor-mobile-sidebar-open'));
    }

    document.getElementById('florMobileNavBtnChat')?.addEventListener('click', toggleSidebar);
    document.getElementById('florMobileNavBtnFriends')?.addEventListener('click', toggleSidebar);
    backdrop?.addEventListener('click', () => setMobileSidebarOpen(false));

    shell?.addEventListener('click', (e) => {
        if (!isMobileNavLayout()) return;
        if (e.target.closest('.server-icon')) closeMobileSidebarIfMobile();
        if (e.target.closest('#dmList .channel, #channelsTreeRoot .channel')) closeMobileSidebarIfMobile();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setMobileSidebarOpen(false);
    });

    const onLayoutChange = () => {
        if (!isMobileNavLayout()) setMobileSidebarOpen(false);
        else syncMobileNavBackdropAria();
    };
    mq?.addEventListener('change', onLayoutChange);
    window.addEventListener('orientationchange', () => setTimeout(onLayoutChange, 280));

    window.florOpenMobileSidebar = () => {
        if (isMobileNavLayout()) setMobileSidebarOpen(true);
    };
    window.florCloseMobileSidebar = () => setMobileSidebarOpen(false);
}

function initializeMobileTabbar() {
    document.getElementById('florTabChats')?.addEventListener('click', () => {
        window.florOpenMobileSidebar?.();
    });
    document.getElementById('florTabFriends')?.addEventListener('click', () => {
        window.florCloseMobileSidebar?.();
        showFriendsView();
    });
    document.getElementById('florTabCompose')?.addEventListener('click', () => {
        window.florOpenMobileSidebar?.();
    });
    document.getElementById('florTabProfile')?.addEventListener('click', () => {
        window.florOpenMobileSidebar?.();
    });
    document.getElementById('florTabSettings')?.addEventListener('click', () => {
        document.getElementById('settingsBtn')?.click();
    });
}

/**
 * Мобильный жест «назад»: от левого края экрана свайп вправо.
 * Открыта панель — закрыть; открыт чат ЛС — к друзьям; канал сервера — открыть список каналов; экран друзей — открыть панель чатов.
 */
function initializeMobileSwipeNav() {
    const edgePx = 40;
    const thresholdPx = 90;
    let startX = 0;
    let startY = 0;
    let armed = false;

    function onTouchStart(e) {
        if (window.innerWidth > 768) return;
        if (!e.touches || e.touches.length !== 1) return;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        armed = startX <= edgePx;
    }

    function onTouchEnd(e) {
        if (!armed) return;
        armed = false;
        if (window.innerWidth > 768) return;
        if (!e.changedTouches || e.changedTouches.length !== 1) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (dx < thresholdPx) return;
        if (Math.abs(dy) > Math.abs(dx) * 0.92) return;

        if (document.body.classList.contains('flor-mobile-sidebar-open')) {
            window.florCloseMobileSidebar?.();
            return;
        }

        const chatEl = document.getElementById('chatView');
        const friendsEl = document.getElementById('friendsView');
        const chatOpen = chatEl && chatEl.style.display === 'flex';
        const friendsOpen = friendsEl && friendsEl.style.display === 'flex';

        if (chatOpen) {
            if (currentView === 'dm') {
                showFriendsView();
            } else {
                window.florOpenMobileSidebar?.();
            }
            return;
        }
        if (friendsOpen) {
            window.florOpenMobileSidebar?.();
        }
    }

    document.getElementById('chatView')?.addEventListener('touchstart', onTouchStart, { passive: true });
    document.getElementById('chatView')?.addEventListener('touchend', onTouchEnd, { passive: true });
    document.getElementById('friendsView')?.addEventListener('touchstart', onTouchStart, { passive: true });
    document.getElementById('friendsView')?.addEventListener('touchend', onTouchEnd, { passive: true });
    document.getElementById('florSidebarShell')?.addEventListener('touchstart', onTouchStart, { passive: true });
    document.getElementById('florSidebarShell')?.addEventListener('touchend', onTouchEnd, { passive: true });
}

function initializeServerManagement() {
    const friendsBtn = document.getElementById('friendsBtn');
    const addServerBtn = document.getElementById('addServerBtn');
    
    friendsBtn.addEventListener('click', () => {
        showFriendsView();
    });
    
    addServerBtn.addEventListener('click', () => {
        createNewServer();
    });
}

async function createNewServer() {
    const serverName = prompt('Название сервера:');

    if (!serverName || serverName.trim() === '') return;

    try {
        const response = await fetch(florApi('/api/servers'), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: serverName.trim() })
        });
        let data = {};
        try {
            data = await response.json();
        } catch (_) {}
        if (!response.ok) {
            alert(data.error || `Не удалось создать сервер (код ${response.status})`);
            return;
        }
        const newId = Number(data.id);
        if (!Number.isFinite(newId)) {
            alert('Сервер создан, но ответ некорректен. Обновите страницу (F5).');
            await loadUserServers();
            return;
        }
        if (socket && socket.connected) {
            socket.emit('resync-server-rooms');
        }
        await loadUserServers();
        const icon = document.querySelector(`.server-icon[data-server-id="${newId}"]`);
        if (icon) {
            icon.click();
        }
    } catch (error) {
        console.error('Error creating server:', error);
        alert('Не удалось создать сервер');
    }
}

function addServerToUI(server, switchTo = false) {
    const serverList = document.querySelector('.server-list');
    const addServerBtn = document.getElementById('addServerBtn');
    
    const serverIcon = document.createElement('div');
    serverIcon.className = 'server-icon';
    serverIcon.textContent = server.icon;
    serverIcon.title = server.name;
    serverIcon.setAttribute('data-server-id', String(server.id));
    
    serverIcon.addEventListener('click', () => {
        document.querySelectorAll('.server-icon').forEach(icon => icon.classList.remove('active'));
        serverIcon.classList.add('active');
        showServerView(server);
    });
    
    serverList.insertBefore(serverIcon, addServerBtn);
    
    if (switchTo) {
        serverIcon.click();
    }
}

function initializeChannels() {
    const root = document.getElementById('channelsTreeRoot');
    if (!root) return;
    root.addEventListener('click', (e) => {
        const ch = e.target.closest('.channel');
        if (!ch || !root.contains(ch)) return;
        const channelName = ch.getAttribute('data-channel');
        const channelId = parseInt(ch.getAttribute('data-channel-id'), 10);
        if (!channelName || !Number.isFinite(channelId)) return;
        if (ch.classList.contains('voice-channel')) {
            joinVoiceChannel(channelId, channelDisplayName(channelName));
        } else {
            switchChannel(channelName);
        }
    });
}

function switchChannel(channelName) {
    if (!channelName) return;
    currentChannel = channelName;
    currentTextChannelId = getChannelIdByName(channelName);
    
    document.querySelectorAll('.text-channel').forEach((ch) => ch.classList.remove('active'));
    const cid = getChannelIdByName(channelName);
    const esc =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(channelName)
            : String(channelName).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const channelEl =
        cid != null
            ? document.querySelector(`.text-channel[data-channel-id="${cid}"]`)
            : document.querySelector(`.text-channel[data-channel="${esc}"]`);
    if (channelEl) channelEl.classList.add('active');
    
    const chatHeaderInfo = document.getElementById('chatHeaderInfo');
    if (chatHeaderInfo) {
        const label = channelDisplayName(channelName);
        chatHeaderInfo.innerHTML = `<span class="channel-name">#${label}</span>`;
    }
    document.getElementById('messageInput').placeholder = `Сообщение в #${channelDisplayName(channelName)}`;
    
    loadChannelMessages(channelName);
}

async function loadChannelMessages(channelName) {
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.innerHTML = '';

    const channelId = getChannelIdByName(channelName);
    if (channelId == null) {
        messagesContainer.innerHTML =
            '<p class="empty-channel-hint" style="padding:16px;color:var(--flor-muted);">Канал недоступен. Обновите список сервера.</p>';
        return;
    }

    if (window.florE2ee && currentServerRecord) {
        try {
            await florE2ee.redistributeMissingWraps(
                channelId,
                currentServerRecord.id,
                florApi,
                token,
                currentUser.id,
                florFetchMembersForE2ee
            );
        } catch (_) {}
    }

    const cached = await idbGetChannelMessages(channelId);
    if (cached && cached.length) {
        if (window.florE2ee && currentServerRecord) {
            for (const message of cached) {
                const text = await florDecryptChannelMessage(channelId, message.content);
                addMessageToUI({
                    id: message.id,
                    userId: message.user_id,
                    author: message.username,
                    avatar: message.avatar || message.username.charAt(0).toUpperCase(),
                    text,
                    timestamp: message.created_at
                });
            }
        } else {
            cached.forEach((message) => {
                addMessageToUI({
                    id: message.id,
                    userId: message.user_id,
                    author: message.username,
                    avatar: message.avatar || message.username.charAt(0).toUpperCase(),
                    text: message.content,
                    timestamp: message.created_at
                });
            });
        }
    }

    try {
        const response = await fetch(florApi(`/api/messages/${channelId}`), {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
            const messages = await response.json();
            lastLoadedMessagesForExport = messages.map((m) => ({
                id: m.id,
                author: m.username,
                content: m.content,
                created_at: m.created_at
            }));
            messagesContainer.innerHTML = '';
            for (const message of messages) {
                const text =
                    window.florE2ee && currentServerRecord
                        ? await florDecryptChannelMessage(channelId, message.content)
                        : message.content;
                addMessageToUI({
                    id: message.id,
                    userId: message.user_id,
                    author: message.username,
                    avatar: message.avatar || message.username.charAt(0).toUpperCase(),
                    text,
                    timestamp: message.created_at
                });
            }
            await idbPutChannelMessages(channelId, messages);
        } else {
            console.error('Failed to load messages');
        }
    } catch (error) {
        console.error('Error loading messages:', error);
    }

    scrollToBottom();
    filterChatMessages(document.getElementById('chatMessageSearch')?.value || '');
}

function initializeMessageInput() {
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('messageSendBtn');

    const trySend = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };
    messageInput.addEventListener('keydown', trySend);
    sendBtn?.addEventListener('click', () => sendMessage());
}

async function sendMessage() {
    const messageInput = document.getElementById('messageInput');
    if (!messageInput) return;
    const text = messageInput.value.trim();

    if (text === '') return;

    if (currentView === 'dm' && currentDMUserId) {
        if (!socket || !socket.connected) {
            alert('Нет соединения с сервером. Дождитесь подключения или обновите страницу.');
            return;
        }
        let payloadText = text;
        if (window.florE2ee) {
            try {
                payloadText = await florE2ee.encryptDmPlaintext(currentDMUserId, text);
            } catch (e) {
                alert(e.message || 'Не удалось зашифровать сообщение');
                return;
            }
        }
        socket.emit('send-dm', {
            receiverId: currentDMUserId,
            message: { text: payloadText }
        });
        messageInput.value = '';
        return;
    }

    if (currentView === 'server') {
        const byName = currentChannel ? getChannelIdByName(currentChannel) : null;
        const channelId = byName != null ? byName : currentTextChannelId;
        if (channelId == null) {
            alert('Выберите текстовый канал в списке слева (не голосовой).');
            return;
        }
        const cid = Number(channelId);
        if (!Number.isFinite(cid)) {
            alert('Сбой выбора канала. Откройте сервер ещё раз.');
            return;
        }
        try {
            let outText = text;
            if (window.florE2ee && currentServerRecord) {
                try {
                    const raw = await florE2ee.ensureChannelKey(
                        cid,
                        currentServerRecord.id,
                        florApi,
                        token,
                        currentUser.id,
                        florFetchMembersForE2ee
                    );
                    outText = await florE2ee.encryptWithChannelKey(raw, text);
                } catch (e) {
                    alert(e.message || 'Не удалось зашифровать для канала');
                    return;
                }
            }
            const response = await fetch(florApi('/api/messages'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ channelId: cid, text: outText }),
                credentials: 'same-origin'
            });
            let data = {};
            try {
                data = await response.json();
            } catch (_) {}
            if (!response.ok) {
                throw new Error(
                    data.error || `Не удалось отправить (${response.status}). Выйдите и войти снова, если просрочен вход.`
                );
            }
            messageInput.value = '';
            const box = document.getElementById('messagesContainer');
            let m = data.message;
            if (m && window.florE2ee && currentServerRecord && m.text) {
                try {
                    const raw = await florE2ee.ensureChannelKey(
                        cid,
                        currentServerRecord.id,
                        florApi,
                        token,
                        currentUser.id,
                        florFetchMembersForE2ee
                    );
                    m = { ...m, text: await florE2ee.decryptWithChannelKey(raw, m.text) };
                } catch (_) {}
            }
            if (m && m.id != null && box && !box.querySelector(`[data-message-id="${m.id}"]`)) {
                addMessageToUI(m);
                scrollToBottom();
            }
        } catch (e) {
            alert(e.message || 'Ошибка сети');
        }
        return;
    }

    alert('Откройте чат: сервер с текстовым каналом или личные сообщения.');
}

function florMessageIsOwn(message) {
    if (!currentUser) return false;
    if (message.senderId != null && Number(message.senderId) === Number(currentUser.id)) return true;
    if (message.userId != null && Number(message.userId) === Number(currentUser.id)) return true;
    return String(message.author || '') === String(currentUser.username || '');
}

function addMessageToUI(message) {
    const messagesContainer = document.getElementById('messagesContainer');
    if (!messagesContainer) return;
    const mid = message && message.id;
    if (mid != null && messagesContainer.querySelector(`[data-message-id="${mid}"]`)) {
        return;
    }

    const own = florMessageIsOwn(message);

    const messageGroup = document.createElement('div');
    messageGroup.className = 'message-group' + (own ? ' message-group--own' : '');
    messageGroup.setAttribute('data-message-id', message.id || Date.now());

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = message.avatar;

    const content = document.createElement('div');
    content.className = 'message-content';

    const header = document.createElement('div');
    header.className = 'message-header';

    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = message.author;

    const timestamp = document.createElement('span');
    timestamp.className = 'message-timestamp';
    timestamp.textContent = formatTimestamp(message.timestamp);

    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.type = 'button';
    bookmarkBtn.className = 'message-bookmark-btn';
    bookmarkBtn.title = 'В закладки';
    const ctx = bookmarkContextKey();
    const bid = message.id || Date.now();
    const isBm = getBookmarks().some((x) => x.id === bid && x.context === ctx);
    bookmarkBtn.textContent = isBm ? '★' : '☆';
    if (isBm) bookmarkBtn.classList.add('is-bookmarked');
    bookmarkBtn.addEventListener('click', () => {
        const added = toggleBookmarkEntry({
            id: bid,
            context: ctx,
            author: message.author,
            text: message.text,
            ts: message.timestamp
        });
        bookmarkBtn.textContent = added ? '★' : '☆';
        bookmarkBtn.classList.toggle('is-bookmarked', added);
    });

    const text = document.createElement('div');
    text.className = 'message-text';
    text.appendChild(linkifyToFragment(message.text));

    const reactionsContainer = document.createElement('div');
    reactionsContainer.className = 'message-reactions';

    const addReactionBtn = document.createElement('button');
    addReactionBtn.className = 'add-reaction-btn';
    addReactionBtn.textContent = '😊';
    addReactionBtn.title = 'Добавить реакцию';
    addReactionBtn.onclick = () => showEmojiPickerForMessage(message.id || Date.now());

    if (!own) {
        header.appendChild(author);
    }
    header.appendChild(timestamp);
    header.appendChild(bookmarkBtn);
    content.appendChild(header);
    content.appendChild(text);
    content.appendChild(reactionsContainer);
    content.appendChild(addReactionBtn);

    if (own) {
        messageGroup.appendChild(content);
        messageGroup.appendChild(avatar);
    } else {
        messageGroup.appendChild(avatar);
        messageGroup.appendChild(content);
    }

    messagesContainer.appendChild(messageGroup);
}

function formatTimestamp(date) {
    const messageDate = new Date(date);
    const today = new Date();
    const sameDay =
        messageDate.getDate() === today.getDate() &&
        messageDate.getMonth() === today.getMonth() &&
        messageDate.getFullYear() === today.getFullYear();
    const time = messageDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `Сегодня в ${time}`;
    return messageDate.toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function scrollToBottom() {
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Emoji picker
function initializeEmojiPicker() {
    const emojiBtn = document.querySelector('.emoji-btn');
    if (emojiBtn) {
        emojiBtn.addEventListener('click', () => {
            showEmojiPickerForInput();
        });
    }
}

function showEmojiPickerForInput() {
    const emojis = ['😀', '😂', '❤️', '👍', '👎', '🎉', '🔥', '✨', '💯', '🚀'];
    const picker = createEmojiPicker(emojis, (emoji) => {
        const input = document.getElementById('messageInput');
        input.value += emoji;
        input.focus();
    });
    document.body.appendChild(picker);
}

function showEmojiPickerForMessage(messageId) {
    const emojis = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
    const picker = createEmojiPicker(emojis, (emoji) => {
        addReaction(messageId, emoji);
    });
    document.body.appendChild(picker);
}

function createEmojiPicker(emojis, onSelect) {
    const picker = document.createElement('div');
    picker.className = 'emoji-picker';
    
    emojis.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'emoji-option';
        btn.textContent = emoji;
        btn.addEventListener('click', () => {
            onSelect(emoji);
            picker.remove();
        });
        picker.appendChild(btn);
    });
    
    setTimeout(() => {
        document.addEventListener('click', function closePickerAnywhere(e) {
            if (!picker.contains(e.target)) {
                picker.remove();
                document.removeEventListener('click', closePickerAnywhere);
            }
        });
    }, 100);
    
    return picker;
}

function addReaction(messageId, emoji) {
    if (socket && socket.connected) {
        socket.emit('add-reaction', { messageId, emoji });
    }
}

function updateMessageReactions(messageId, reactions) {
    const reactionsContainer = document.querySelector(`[data-message-id="${messageId}"] .message-reactions`);
    if (!reactionsContainer) return;
    
    reactionsContainer.innerHTML = '';
    
    reactions.forEach(reaction => {
        const reactionEl = document.createElement('div');
        reactionEl.className = 'reaction';
        reactionEl.innerHTML = `${reaction.emoji} <span>${reaction.count}</span>`;
        reactionEl.title = reaction.users;
        reactionEl.addEventListener('click', () => {
            if (socket && socket.connected) {
                socket.emit('remove-reaction', { messageId, emoji: reaction.emoji });
            }
        });
        reactionsContainer.appendChild(reactionEl);
    });
}

// File upload
function initializeFileUpload() {
    const attachBtn = document.querySelector('.attach-btn');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    
    attachBtn.addEventListener('click', () => {
        fileInput.click();
    });
    
    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
            await uploadFile(file);
        }
        fileInput.value = '';
    });
}

async function uploadFile(file) {
    try {
        const channelId =
            currentTextChannelId != null ? currentTextChannelId : getChannelIdByName(currentChannel);
        if (channelId == null) {
            alert('Вложения можно отправлять только в текстовом канале сервера.');
            return;
        }
        const formData = new FormData();
        formData.append('file', file);
        formData.append('channelId', String(channelId));
        
        const response = await fetch(florApi('/api/upload'), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: formData
        });
        
        if (!response.ok) {
            throw new Error('Upload failed');
        }
        
        const fileData = await response.json();
        const line = `Файл: ${file.name} — ${fileData.url}`;
        const cid = Number(channelId);
        const post = await fetch(florApi('/api/messages'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ channelId: cid, text: line })
        });
        const pdata = await post.json().catch(() => ({}));
        if (!post.ok) {
            throw new Error(pdata.error || 'Не удалось отправить сообщение о файле');
        }
        const box = document.getElementById('messagesContainer');
        const m = pdata.message;
        if (m && m.id != null && box && !box.querySelector(`[data-message-id="${m.id}"]`)) {
            addMessageToUI(m);
            scrollToBottom();
        }
    } catch (error) {
        console.error('Upload error:', error);
        alert('Не удалось загрузить файл');
    }
}

// User controls
function initializeUserControls() {
    const muteBtn = document.getElementById('muteBtn');
    const deafenBtn = document.getElementById('deafenBtn');

    muteBtn.addEventListener('click', () => {
        isMuted = !isMuted;
        muteBtn.querySelector('.icon-normal').style.display = isMuted ? 'none' : 'block';
        muteBtn.querySelector('.icon-slashed').style.display = isMuted ? 'block' : 'none';
        
        if (localStream) {
            localStream.getAudioTracks().forEach(track => {
                track.enabled = !isMuted;
            });
        }
    });
    
    deafenBtn.addEventListener('click', () => {
        isDeafened = !isDeafened;
        deafenBtn.querySelector('.icon-normal').style.display = isDeafened ? 'none' : 'block';
        deafenBtn.querySelector('.icon-slashed').style.display = isDeafened ? 'block' : 'none';
        
        // When deafened, also mute microphone
        if (isDeafened) {
            if (!isMuted) {
                isMuted = true;
                muteBtn.querySelector('.icon-normal').style.display = 'none';
                muteBtn.querySelector('.icon-slashed').style.display = 'block';
            }
            
            // Mute all remote audio
            document.querySelectorAll('video[id^="remote-"]').forEach(video => {
                video.volume = 0;
            });
        } else {
            // Unmute remote audio
            document.querySelectorAll('video[id^="remote-"]').forEach(video => {
                video.volume = 1;
            });
        }

        // Update local stream audio tracks
        if (localStream) {
            localStream.getAudioTracks().forEach(track => {
                track.enabled = !isMuted;
            });
        }
    });
}

function renderLoginHistoryList() {
    const el = document.getElementById('loginHistoryList');
    if (!el) return;
    try {
        const arr = JSON.parse(localStorage.getItem(LOGIN_HISTORY_KEY) || '[]');
        el.innerHTML = '';
        if (!arr.length) {
            el.textContent = 'Записей пока нет. История пополняется при входе в этом браузере.';
            return;
        }
        arr.slice(0, 15).forEach((row) => {
            const div = document.createElement('div');
            div.textContent = `${new Date(row.t).toLocaleString('ru-RU')} — ${row.email || ''}`;
            el.appendChild(div);
        });
    } catch {
        el.textContent = 'Не удалось прочитать историю.';
    }
}

async function populateAudioDeviceSelects() {
    const inSel = document.getElementById('audioInputDevice');
    const outSel = document.getElementById('audioOutputDevice');
    updateFlorMediaHttpsWarningEl();
    if (!inSel || !outSel) return;
    if (!navigator.mediaDevices?.enumerateDevices) {
        inSel.innerHTML = '<option value="">API недоступен в этом браузере</option>';
        outSel.innerHTML = '<option value="">—</option>';
        return;
    }
    try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
        if (florMediaNeedsSecurePage()) {
            inSel.innerHTML = '<option value="">Нет доступа: https:// или USE_HTTPS / Electron (.env)</option>';
            outSel.innerHTML = '<option value="">—</option>';
            return;
        }
        /* нет разрешения или устройства — ниже попробуем enumerate */
    }
    const list = await navigator.mediaDevices.enumerateDevices();
    const s = getMessengerSettings();
    inSel.innerHTML = '<option value="">По умолчанию</option>';
    outSel.innerHTML = '<option value="">По умолчанию</option>';
    list.forEach((d) => {
        if (d.kind === 'audioinput') {
            const o = document.createElement('option');
            o.value = d.deviceId;
            o.textContent = d.label || `Микрофон ${inSel.length}`;
            inSel.appendChild(o);
        }
        if (d.kind === 'audiooutput') {
            const o = document.createElement('option');
            o.value = d.deviceId;
            o.textContent = d.label || `Вывод ${outSel.length}`;
            outSel.appendChild(o);
        }
    });
    inSel.value = s.audioInputDeviceId || '';
    outSel.value = s.audioOutputDeviceId || '';
}

function stopMicTest() {
    if (micTestRaf) {
        cancelAnimationFrame(micTestRaf);
        micTestRaf = null;
    }
    if (micTestStream) {
        micTestStream.getTracks().forEach((t) => t.stop());
        micTestStream = null;
    }
    micTestAnalyser = null;
    const fill = document.getElementById('micMeterFill');
    if (fill) fill.style.width = '0%';
    const startBtn = document.getElementById('micTestStartBtn');
    const stopBtn = document.getElementById('micTestStopBtn');
    if (startBtn) startBtn.hidden = false;
    if (stopBtn) stopBtn.hidden = true;
}

function initializeSettingsHub() {
    const overlay = document.getElementById('settingsOverlay');
    const settingsBtn = document.getElementById('settingsBtn');
    const closeBtn = document.getElementById('settingsCloseBtn');
    const saveBtn = document.getElementById('settingsSaveBtn');
    const logoutBtn = document.getElementById('settingsLogoutBtn');
    const nav = document.getElementById('settingsNav');

    if (!overlay || !settingsBtn || !closeBtn || !saveBtn || !logoutBtn) {
        return;
    }

    function showPanel(id) {
        document.querySelectorAll('.settings-nav-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-panel') === id);
        });
        document.querySelectorAll('.settings-panel-page').forEach((p) => {
            p.classList.toggle('active', p.getAttribute('data-panel') === id);
        });
    }

    function openSettings() {
        const s = getMessengerSettings();
        const notifyCb = document.getElementById('settingsNotifyDesktop');
        const soundCb = document.getElementById('settingsSoundInApp');
        const compactCb = document.getElementById('settingsCompactMessages');
        if (notifyCb) notifyCb.checked = s.desktopNotifications !== false;
        if (soundCb) soundCb.checked = s.soundInApp === true;
        if (compactCb) compactCb.checked = s.compactMessages === true;
        const avatarInput = document.getElementById('settingsAvatarInput');
        if (avatarInput) {
            avatarInput.value = currentUser && currentUser.avatar ? String(currentUser.avatar) : '';
        }
        const dn = document.getElementById('settingsDisplayName');
        const bio = document.getElementById('settingsBio');
        if (dn) dn.value = s.displayName || '';
        if (bio) bio.value = s.bio || '';
        const pdm = document.getElementById('privacyDmFriendsOnly');
        const pgi = document.getElementById('privacyGroupInvitesFriends');
        const pho = document.getElementById('privacyHideOnline');
        if (pdm) pdm.checked = !!s.privacyDmFriendsOnly;
        if (pgi) pgi.checked = !!s.privacyGroupInvitesFriends;
        if (pho) pho.checked = !!s.privacyHideOnline;
        const dndE = document.getElementById('dndEnabled');
        const dndS = document.getElementById('dndStart');
        const dndX = document.getElementById('dndEnd');
        if (dndE) dndE.checked = !!s.dndEnabled;
        if (dndS) dndS.value = s.dndStart || '22:00';
        if (dndX) dndX.value = s.dndEnd || '08:00';
        const fs = document.getElementById('fontScaleRange');
        const fsVal = document.getElementById('fontScaleVal');
        if (fs) fs.value = String(s.fontScale || 100);
        if (fsVal) fsVal.textContent = String(s.fontScale || 100);
        const sw = document.getElementById('sidebarWidthRange');
        const swVal = document.getElementById('sidebarWidthVal');
        if (sw) sw.value = String(s.sidebarWidthPx || 260);
        if (swVal) swVal.textContent = String(s.sidebarWidthPx || 260);
        const lot = document.getElementById('linksOpenNewTab');
        if (lot) lot.checked = s.linksOpenNewTab !== false;
        const wp = document.getElementById('chatWallpaperPreset');
        const wu = document.getElementById('chatWallpaperUrl');
        const wb = document.getElementById('chatWallpaperBlur');
        const wbv = document.getElementById('chatBlurVal');
        if (wp) wp.value = s.chatWallpaperPreset || '';
        if (wu) wu.value = s.chatWallpaperUrl || '';
        if (wb) wb.value = String(s.chatWallpaperBlur || 0);
        if (wbv) wbv.textContent = String(s.chatWallpaperBlur || 0);
        renderLoginHistoryList();
        populateAudioDeviceSelects();
        showPanel('profile');
        overlay.classList.remove('hidden');
        overlay.setAttribute('aria-hidden', 'false');
    }

    function closeSettings() {
        overlay.classList.add('hidden');
        overlay.setAttribute('aria-hidden', 'true');
        stopMicTest();
    }

    settingsBtn.addEventListener('click', openSettings);
    closeBtn.addEventListener('click', closeSettings);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeSettings();
    });

    if (nav) {
        nav.addEventListener('click', (e) => {
            const btn = e.target.closest('.settings-nav-btn');
            if (!btn) return;
            const id = btn.getAttribute('data-panel');
            showPanel(id);
            if (id === 'devices') populateAudioDeviceSelects();
        });
    }

    const fontScaleRange = document.getElementById('fontScaleRange');
    if (fontScaleRange) {
        fontScaleRange.addEventListener('input', () => {
            const v = document.getElementById('fontScaleVal');
            if (v) v.textContent = fontScaleRange.value;
        });
    }
    const sidebarWidthRange = document.getElementById('sidebarWidthRange');
    if (sidebarWidthRange) {
        sidebarWidthRange.addEventListener('input', () => {
            const v = document.getElementById('sidebarWidthVal');
            if (v) v.textContent = sidebarWidthRange.value;
        });
    }
    const chatWallpaperBlur = document.getElementById('chatWallpaperBlur');
    if (chatWallpaperBlur) {
        chatWallpaperBlur.addEventListener('input', () => {
            const v = document.getElementById('chatBlurVal');
            if (v) v.textContent = chatWallpaperBlur.value;
        });
    }

    document.getElementById('refreshDevicesBtn')?.addEventListener('click', () => populateAudioDeviceSelects());

    document.getElementById('micTestStartBtn')?.addEventListener('click', async () => {
        stopMicTest();
        const s = getMessengerSettings();
        const audio = { echoCancellation: true };
        if (s.audioInputDeviceId) {
            audio.deviceId = { exact: s.audioInputDeviceId };
        }
        try {
            micTestStream = await navigator.mediaDevices.getUserMedia({ audio });
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const src = ctx.createMediaStreamSource(micTestStream);
            micTestAnalyser = ctx.createAnalyser();
            micTestAnalyser.fftSize = 256;
            src.connect(micTestAnalyser);
            const data = new Uint8Array(micTestAnalyser.frequencyBinCount);
            const fill = document.getElementById('micMeterFill');
            function tick() {
                if (!micTestAnalyser) return;
                micTestAnalyser.getByteFrequencyData(data);
                let sum = 0;
                for (let i = 0; i < data.length; i++) sum += data[i];
                const avg = sum / data.length / 255;
                if (fill) fill.style.width = `${Math.min(100, Math.round(avg * 180))}%`;
                micTestRaf = requestAnimationFrame(tick);
            }
            tick();
            document.getElementById('micTestStartBtn').hidden = true;
            document.getElementById('micTestStopBtn').hidden = false;
        } catch (err) {
            console.error(err);
            alert(florMediaAccessHint());
        }
    });
    document.getElementById('micTestStopBtn')?.addEventListener('click', () => stopMicTest());

    document.getElementById('pwdChangeBtn')?.addEventListener('click', async () => {
        const cur = document.getElementById('pwdCurrent')?.value || '';
        const neu = document.getElementById('pwdNew')?.value || '';
        try {
            const response = await fetch(florApi('/api/user/change-password'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ currentPassword: cur, newPassword: neu })
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Ошибка');
            }
            alert('Пароль обновлён');
            document.getElementById('pwdCurrent').value = '';
            document.getElementById('pwdNew').value = '';
        } catch (e) {
            alert(e.message || 'Не удалось сменить пароль');
        }
    });

    saveBtn.addEventListener('click', async () => {
        const notifyCb = document.getElementById('settingsNotifyDesktop');
        const soundCb = document.getElementById('settingsSoundInApp');
        const compactCb = document.getElementById('settingsCompactMessages');
        const avatarInput = document.getElementById('settingsAvatarInput');
        saveMessengerSettings({
            desktopNotifications: notifyCb ? notifyCb.checked : true,
            soundInApp: soundCb ? soundCb.checked : false,
            compactMessages: compactCb ? compactCb.checked : false,
            displayName: document.getElementById('settingsDisplayName')?.value?.trim() || '',
            bio: document.getElementById('settingsBio')?.value?.trim() || '',
            privacyDmFriendsOnly: !!document.getElementById('privacyDmFriendsOnly')?.checked,
            privacyGroupInvitesFriends: !!document.getElementById('privacyGroupInvitesFriends')?.checked,
            privacyHideOnline: !!document.getElementById('privacyHideOnline')?.checked,
            dndEnabled: !!document.getElementById('dndEnabled')?.checked,
            dndStart: document.getElementById('dndStart')?.value || '22:00',
            dndEnd: document.getElementById('dndEnd')?.value || '08:00',
            fontScale: parseInt(document.getElementById('fontScaleRange')?.value, 10) || 100,
            sidebarWidthPx: parseInt(document.getElementById('sidebarWidthRange')?.value, 10) || 260,
            linksOpenNewTab: !!document.getElementById('linksOpenNewTab')?.checked,
            chatWallpaperPreset: document.getElementById('chatWallpaperPreset')?.value || '',
            chatWallpaperUrl: document.getElementById('chatWallpaperUrl')?.value?.trim() || '',
            chatWallpaperBlur: parseInt(document.getElementById('chatWallpaperBlur')?.value, 10) || 0,
            audioInputDeviceId: document.getElementById('audioInputDevice')?.value || '',
            audioOutputDeviceId: document.getElementById('audioOutputDevice')?.value || ''
        });
        applyCompactMessages();
        applyFontScale();
        applySidebarWidth();
        applyChatWallpaper();
        updateUserInfo();
        const raw = avatarInput ? avatarInput.value.trim().slice(0, 4) : '';
        try {
            const response = await fetch(florApi('/api/user/profile'), {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ avatar: raw })
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'save failed');
            }
            currentUser.avatar = data.avatar;
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            updateUserInfo();
            closeSettings();
        } catch (err) {
            console.error(err);
            alert('Не удалось сохранить аватар на сервере; остальные настройки сохранены локально.');
            closeSettings();
        }
    });

    logoutBtn.addEventListener('click', () => {
        if (!confirm('Выйти из аккаунта?')) return;
        if (inCall) leaveVoiceChannel(true);
        localStorage.removeItem('token');
        localStorage.removeItem('currentUser');
        if (socket) socket.disconnect();
        window.location.replace('login.html');
    });
}

function initializeServerHeaderMenu() {
    const btn = document.getElementById('serverHeaderMenuBtn');
    const drop = document.getElementById('serverHeaderDropdown');
    if (!btn || !drop) return;

    function closeDrop() {
        drop.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
    }

    function buildMenu() {
        drop.innerHTML = '';
        if (currentView !== 'server' || !currentServerRecord) {
            return;
        }
        const b0 = document.createElement('button');
        b0.type = 'button';
        b0.textContent = 'Участники и приглашения';
        b0.addEventListener('click', () => {
            closeDrop();
            openMembersOverlay();
        });
        drop.appendChild(b0);
        const isOwner = currentUser && currentServerRecord.owner_id === currentUser.id;
        if (isOwner) {
            const b1 = document.createElement('button');
            b1.type = 'button';
            b1.textContent = 'Настройки сервера';
            b1.addEventListener('click', () => {
                closeDrop();
                openServerSettingsModal();
            });
            drop.appendChild(b1);
        }
        const b2 = document.createElement('button');
        b2.type = 'button';
        b2.textContent = 'Настройки канала…';
        b2.addEventListener('click', () => {
            closeDrop();
            openChannelSettingsModal();
        });
        drop.appendChild(b2);
    }

    drop.addEventListener('click', (e) => e.stopPropagation());

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentView !== 'server') return;
        const open = drop.classList.contains('hidden');
        if (open) {
            buildMenu();
            drop.classList.remove('hidden');
            btn.setAttribute('aria-expanded', 'true');
        } else {
            closeDrop();
        }
    });
    document.addEventListener('click', () => closeDrop());
}

function openServerSettingsModal() {
    const ov = document.getElementById('serverSettingsOverlay');
    if (!ov || !currentServerRecord) return;
    document.getElementById('serverSettingsName').value = currentServerRecord.name || '';
    document.getElementById('serverSettingsIcon').value = currentServerRecord.icon || '';
    const ownerExtras = document.getElementById('serverSettingsOwnerExtras');
    const isOwner = currentUser && currentServerRecord.owner_id === currentUser.id;
    if (ownerExtras) {
        ownerExtras.classList.toggle('hidden', !isOwner);
    }
    ov.classList.remove('hidden');
    ov.setAttribute('aria-hidden', 'false');
}

function openChannelSettingsModal() {
    const ov = document.getElementById('channelSettingsOverlay');
    if (!ov) return;
    const sub = document.getElementById('channelSettingsSubtitle');
    if (sub) {
        sub.textContent =
            currentView === 'server' && currentChannel
                ? `Канал: #${channelDisplayName(currentChannel)}`
                : 'Откройте канал сервера';
    }
    const prefs = getMessengerSettings().channelPrefs[currentChannel] || {};
    document.getElementById('chSlowLocal').checked = !!prefs.slowHint;
    document.getElementById('chVoiceBitrate').value = String(prefs.voiceBitrate || 64);
    document.getElementById('chVoiceLimit').value = String(prefs.voiceLimit || 32);
    ov.classList.remove('hidden');
    ov.setAttribute('aria-hidden', 'false');
}

function initializeChannelSettingsPanel() {
    document.getElementById('channelSettingsCloseBtn')?.addEventListener('click', () => {
        const ov = document.getElementById('channelSettingsOverlay');
        if (ov) {
            ov.classList.add('hidden');
            ov.setAttribute('aria-hidden', 'true');
        }
    });
    document.getElementById('channelSettingsSaveBtn')?.addEventListener('click', () => {
        if (!currentChannel) return;
        const prefs = { ...getMessengerSettings().channelPrefs };
        prefs[currentChannel] = {
            slowHint: !!document.getElementById('chSlowLocal')?.checked,
            voiceBitrate: parseInt(document.getElementById('chVoiceBitrate')?.value, 10) || 64,
            voiceLimit: parseInt(document.getElementById('chVoiceLimit')?.value, 10) || 32
        };
        saveMessengerSettings({ channelPrefs: prefs });
        document.getElementById('channelSettingsOverlay')?.classList.add('hidden');
    });
    document.getElementById('channelSettingsOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'channelSettingsOverlay') {
            e.currentTarget.classList.add('hidden');
        }
    });
}

function initializeServerSettingsSave() {
    document.getElementById('serverSettingsCloseBtn')?.addEventListener('click', () => {
        const ov = document.getElementById('serverSettingsOverlay');
        if (ov) {
            ov.classList.add('hidden');
            ov.setAttribute('aria-hidden', 'true');
        }
    });
    document.getElementById('serverSettingsOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'serverSettingsOverlay') {
            e.currentTarget.classList.add('hidden');
        }
    });
    document.getElementById('serverSettingsSaveBtn')?.addEventListener('click', async () => {
        if (!currentServerRecord) return;
        const name = document.getElementById('serverSettingsName')?.value?.trim();
        const icon = document.getElementById('serverSettingsIcon')?.value?.trim();
        try {
            const response = await fetch(florApi(`/api/servers/${currentServerRecord.id}`), {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ name, icon })
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Ошибка');
            }
            currentServerRecord = data;
            const idx = servers.findIndex((s) => Number(s.id) === Number(data.id));
            if (idx >= 0) servers[idx] = data;
            const iconEl = document.querySelector(`.server-icon[data-server-id="${data.id}"]`);
            if (iconEl) {
                iconEl.textContent = data.icon;
                iconEl.title = data.name;
            }
            document.getElementById('serverName').textContent = data.name;
            document.getElementById('serverSettingsOverlay').classList.add('hidden');
        } catch (e) {
            alert(e.message || 'Не удалось сохранить');
        }
    });
}

function initializeServerCreateChannel() {
    document.getElementById('serverSettingsCreateChBtn')?.addEventListener('click', async () => {
        if (!currentServerRecord || currentUser?.id !== currentServerRecord.owner_id) return;
        const nameInp = document.getElementById('serverSettingsNewChName');
        const name = nameInp?.value?.trim();
        const type = document.getElementById('serverSettingsNewChType')?.value || 'text';
        if (!name) {
            alert('Введите имя канала');
            return;
        }
        try {
            const response = await fetch(florApi(`/api/servers/${currentServerRecord.id}/channels`), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ name, type })
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Ошибка');
            }
            if (nameInp) nameInp.value = '';
            if (data.tree) {
                renderChannelTree(data.tree);
                flattenChannelTreeToMaps(data.tree);
            }
            if (type === 'text' && data.channel?.name) {
                switchChannel(data.channel.name);
            }
        } catch (e) {
            alert(e.message || 'Не удалось создать канал');
        }
    });
}

function openMembersOverlay() {
    const ov = document.getElementById('membersOverlay');
    if (!ov || !currentServerRecord) return;
    const sub = document.getElementById('membersSubtitle');
    if (sub) sub.textContent = currentServerRecord.name || '';
    loadMembersList();
    ov.classList.remove('hidden');
    ov.setAttribute('aria-hidden', 'false');
}

async function loadMembersList() {
    const list = document.getElementById('membersList');
    if (!list || !currentServerRecord) return;
    list.innerHTML = '<p class="settings-hint" style="margin:0;">Загрузка…</p>';
    try {
        const response = await fetch(florApi(`/api/servers/${currentServerRecord.id}/members`), {
            headers: { Authorization: `Bearer ${token}` }
        });
        const members = await response.json();
        if (!response.ok) {
            list.textContent = members.error || 'Не удалось загрузить список';
            return;
        }
        list.innerHTML = '';
        if (!members.length) {
            list.innerHTML = '<p class="settings-hint" style="margin:0;">Пока только вы.</p>';
            return;
        }
        members.forEach((m) => {
            const row = document.createElement('div');
            row.className = 'member-row';
            const av = escapeHtml(m.avatar || (m.username && m.username.charAt(0).toUpperCase()) || '?');
            const un = escapeHtml(m.username || '');
            const st = escapeHtml(friendStatusLabel(m.status));
            row.innerHTML = `<div class="member-avatar">${av}</div><div><strong>${un}</strong><div class="settings-hint" style="margin:0;font-size:12px;">${st}</div></div>`;
            list.appendChild(row);
        });
    } catch (e) {
        list.textContent = 'Ошибка загрузки участников';
    }
}

function initializeMembersPanel() {
    document.getElementById('membersBtn')?.addEventListener('click', () => {
        if (currentView === 'server' && currentServerRecord) openMembersOverlay();
    });
    document.getElementById('membersCloseBtn')?.addEventListener('click', () => {
        const ov = document.getElementById('membersOverlay');
        if (ov) {
            ov.classList.add('hidden');
            ov.setAttribute('aria-hidden', 'true');
        }
    });
    document.getElementById('membersOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'membersOverlay') {
            e.currentTarget.classList.add('hidden');
            e.currentTarget.setAttribute('aria-hidden', 'true');
        }
    });
    document.getElementById('inviteMemberBtn')?.addEventListener('click', async () => {
        if (!currentServerRecord) return;
        const inp = document.getElementById('inviteUsernameInput');
        const username = inp?.value?.trim();
        if (!username) {
            alert('Введите никнейм друга');
            return;
        }
        try {
            const response = await fetch(florApi(`/api/servers/${currentServerRecord.id}/members`), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ username })
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Ошибка');
            }
            if (inp) inp.value = '';
            await loadMembersList();
        } catch (e) {
            alert(e.message || 'Не удалось пригласить');
        }
    });
}

function renderBookmarksPanelList() {
    const list = document.getElementById('bookmarksList');
    if (!list) return;
    const arr = getBookmarks();
    list.innerHTML = '';
    if (!arr.length) {
        list.textContent = 'Помечайте важные сообщения звёздочкой рядом с временем.';
        return;
    }
    arr.forEach((b) => {
        const wrap = document.createElement('div');
        wrap.className = 'bookmark-item';
        wrap.innerHTML = `<strong>${escapeHtml(b.author)}</strong><div>${escapeHtml(b.text || '').slice(0, 500)}</div>`;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'settings-btn';
        rm.textContent = 'Удалить';
        rm.addEventListener('click', () => {
            const next = getBookmarks().filter((x) => !(x.id === b.id && x.context === b.context));
            saveBookmarks(next);
            renderBookmarksPanelList();
        });
        wrap.appendChild(rm);
        list.appendChild(wrap);
    });
}

function initializeBookmarksPanel() {
    document.getElementById('bookmarksPanelBtn')?.addEventListener('click', () => {
        const ov = document.getElementById('bookmarksOverlay');
        if (!ov) return;
        renderBookmarksPanelList();
        ov.classList.remove('hidden');
        ov.setAttribute('aria-hidden', 'false');
    });
    document.getElementById('bookmarksCloseBtn')?.addEventListener('click', () => {
        document.getElementById('bookmarksOverlay')?.classList.add('hidden');
    });
    document.getElementById('bookmarksOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'bookmarksOverlay') {
            e.currentTarget.classList.add('hidden');
        }
    });
}

function initializeChatTools() {
    document.getElementById('chatMessageSearch')?.addEventListener('input', (e) => {
        filterChatMessages(e.target.value);
    });
    document.getElementById('exportChatBtn')?.addEventListener('click', () => {
        if (!lastLoadedMessagesForExport.length) {
            alert('Сначала откройте чат — в файл попадут уже загруженные сообщения.');
            return;
        }
        const blob = new Blob([JSON.stringify(lastLoadedMessagesForExport, null, 2)], {
            type: 'application/json'
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `flor-chat-export-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    });
}

function closeAllOverlays() {
    document.querySelectorAll('.settings-overlay').forEach((el) => {
        if (!el.classList.contains('hidden')) {
            el.classList.add('hidden');
            el.setAttribute('aria-hidden', 'true');
        }
    });
    stopMicTest();
}

function initializeHotkeys() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAllOverlays();
        }
        if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
            const inp = document.getElementById('chatMessageSearch');
            if (inp && document.getElementById('chatView')?.style.display !== 'none') {
                e.preventDefault();
                inp.focus();
            }
        }
    });
}

// Voice channel functions - call persists when switching views
async function joinVoiceChannel(channelId, displayLabel) {
    if (currentServerId == null || !Number.isFinite(channelId)) return;

    const roomKey = `${currentServerId}:${channelId}`;
    if (inCall) {
        if (activeVoiceRoomKey === roomKey) {
            const callInterface = document.getElementById('callInterface');
            if (callInterface && callInterface.classList.contains('hidden')) {
                callInterface.classList.remove('hidden');
            }
            return;
        }
        leaveVoiceChannel(true);
    }

    inCall = true;
    activeVoiceRoomKey = roomKey;
    activeVoiceChannelName = displayLabel;

    document.querySelectorAll('.voice-channel').forEach((ch) => ch.classList.remove('in-call'));
    document.querySelector(`.voice-channel[data-channel-id="${channelId}"]`)?.classList.add('in-call');

    const callInterface = document.getElementById('callInterface');
    callInterface.classList.remove('hidden');

    const nameEl = document.querySelector('.call-channel-name');
    if (nameEl) nameEl.textContent = displayLabel;

    try {
        await initializeMedia({ voice: true });

        if (socket && socket.connected) {
            socket.emit('join-voice-channel', {
                serverId: currentServerId,
                channelId
            });
        }
    } catch (error) {
        console.error('Error initializing media:', error);
        alert(florMediaAccessHint());
        leaveVoiceChannel(true);
    }
}

async function initializeMedia(opts) {
    opts = opts || {};
    const voiceOnly = opts.voice === true;
    try {
        const s = getMessengerSettings();
        const audio = {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            sampleSize: 16,
            channelCount: 1
        };
        if (s.audioInputDeviceId && String(s.audioInputDeviceId).trim()) {
            audio.deviceId = { exact: String(s.audioInputDeviceId).trim() };
        }
        const constraints = {
            audio,
            video: voiceOnly
                ? false
                : {
                      width: { ideal: 1280 },
                      height: { ideal: 720 }
                  }
        };

        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = localStream;
        
        // Log audio track status
        const audioTracks = localStream.getAudioTracks();
        florDevLog('Local audio tracks:', audioTracks.length);
        audioTracks.forEach(track => {
            florDevLog(`Audio track: ${track.label}, enabled: ${track.enabled}, readyState: ${track.readyState}`);
        });
        
        if (isMuted || isDeafened) {
            audioTracks.forEach(track => {
                track.enabled = false;
            });
        }
    } catch (error) {
        console.error('Error getting media devices:', error);
        throw error;
    }
}

function leaveVoiceChannel(force = false) {
    if (!inCall) return;

    if (force) {
        inCall = false;

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }

        if (screenStream) {
            screenStream.getTracks().forEach(track => track.stop());
            screenStream = null;
        }
        
        const voiceRoom = activeVoiceRoomKey;
        if (socket && socket.connected && voiceRoom) {
            socket.emit('leave-voice-channel', voiceRoom);
        }
        activeVoiceChannelName = null;
        activeVoiceRoomKey = null;

        Object.values(peerConnections).forEach(pc => pc.close());
        peerConnections = {};

        document.querySelectorAll('.voice-channel').forEach(ch => ch.classList.remove('in-call'));
        document.getElementById('remoteParticipants').innerHTML = '';
    }

    const callInterface = document.getElementById('callInterface');
    callInterface.classList.add('hidden');

    if (force) {
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = null;
        isVideoEnabled = true;
        isAudioEnabled = true;
        updateCallButtons();
    }
}

function initializeCallControls() {
    const closeCallBtn = document.getElementById('closeCallBtn');
    const toggleVideoBtn = document.getElementById('toggleVideoBtn');
    const toggleAudioBtn = document.getElementById('toggleAudioBtn');
    const toggleScreenBtn = document.getElementById('toggleScreenBtn');
    
    closeCallBtn.addEventListener('click', () => {
        // End call for both voice channels and direct calls
        if (window.currentCallDetails) {
            // End a direct call
            Object.keys(peerConnections).forEach(socketId => {
                if (socket && socket.connected) {
                    socket.emit('end-call', { to: socketId });
                }
            });
        }
        leaveVoiceChannel(true); // Force leave on button click
    });
    
    toggleVideoBtn.addEventListener('click', () => {
        toggleVideo();
    });
    
    toggleAudioBtn.addEventListener('click', () => {
        toggleAudio();
    });
    
    toggleScreenBtn.addEventListener('click', () => {
        toggleScreenShare();
    });
}

function toggleVideo() {
    if (!localStream) return;
    
    isVideoEnabled = !isVideoEnabled;
    localStream.getVideoTracks().forEach(track => {
        track.enabled = isVideoEnabled;
    });
    
    // Notify peer about video state change
    Object.keys(peerConnections).forEach(socketId => {
        if (socket && socket.connected) {
            socket.emit('video-toggle', {
                to: socketId,
                enabled: isVideoEnabled
            });
        }
    });
    
    updateCallButtons();
}

function toggleAudio() {
    if (!localStream) return;
    
    isAudioEnabled = !isAudioEnabled;
    localStream.getAudioTracks().forEach(track => {
        track.enabled = isAudioEnabled;
    });
    
    if (!isAudioEnabled) {
        isMuted = true;
        document.getElementById('muteBtn').classList.add('active');
    } else {
        isMuted = false;
        document.getElementById('muteBtn').classList.remove('active');
    }
    
    updateCallButtons();
}

async function toggleScreenShare() {
    if (screenStream) {
        // Stop screen sharing
        screenStream.getTracks().forEach(track => track.stop());
        
        // Replace screen track with camera track in all peer connections
        const videoTrack = localStream.getVideoTracks()[0];
        Object.values(peerConnections).forEach(pc => {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender && videoTrack) {
                sender.replaceTrack(videoTrack);
            }
        });
        
        screenStream = null;
        
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = localStream;
        
        updateCallButtons();
    } else {
        try {
            // Start screen sharing
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: 'always',
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 44100
                }
            });
            
            const screenTrack = screenStream.getVideoTracks()[0];
            
            // Replace video track in all peer connections
            Object.values(peerConnections).forEach(pc => {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(screenTrack);
                }
            });
            
            // Show screen share in local video
            const localVideo = document.getElementById('localVideo');
            const mixedStream = new MediaStream([
                screenTrack,
                ...localStream.getAudioTracks()
            ]);
            localVideo.srcObject = mixedStream;
            
            // Handle screen share ending
            screenTrack.addEventListener('ended', () => {
                toggleScreenShare(); // This will stop screen sharing
            });
            
            updateCallButtons();
        } catch (error) {
            console.error('Error sharing screen:', error);
            if (error.name === 'NotAllowedError') {
                alert('Нет разрешения на демонстрацию экрана');
            } else {
                alert('Ошибка при демонстрации экрана. Попробуйте снова.');
            }
        }
    }
}

function updateCallButtons() {
    const toggleVideoBtn = document.getElementById('toggleVideoBtn');
    const toggleAudioBtn = document.getElementById('toggleAudioBtn');
    const toggleScreenBtn = document.getElementById('toggleScreenBtn');
    
    if (toggleVideoBtn) {
        toggleVideoBtn.classList.toggle('active', !isVideoEnabled);
    }
    
    if (toggleAudioBtn) {
        toggleAudioBtn.classList.toggle('active', !isAudioEnabled);
    }
    
    if (toggleScreenBtn) {
        toggleScreenBtn.classList.toggle('active', screenStream !== null);
    }
}

function initializeDraggableCallWindow() {
   const callInterface = document.getElementById('callInterface');
   const callHeader = callInterface.querySelector('.call-header');
   let isDragging = false;
   let offsetX, offsetY;

   callHeader.addEventListener('mousedown', (e) => {
       isDragging = true;
       offsetX = e.clientX - callInterface.offsetLeft;
       offsetY = e.clientY - callInterface.offsetTop;
       callInterface.style.transition = 'none'; // Disable transition during drag
   });

   document.addEventListener('mousemove', (e) => {
       if (isDragging) {
           let newX = e.clientX - offsetX;
           let newY = e.clientY - offsetY;

           // Constrain within viewport
           const maxX = window.innerWidth - callInterface.offsetWidth;
           const maxY = window.innerHeight - callInterface.offsetHeight;

           newX = Math.max(0, Math.min(newX, maxX));
           newY = Math.max(0, Math.min(newY, maxY));

           callInterface.style.left = `${newX}px`;
           callInterface.style.top = `${newY}px`;
       }
   });

   document.addEventListener('mouseup', () => {
       if (isDragging) {
           isDragging = false;
           callInterface.style.transition = 'all 0.3s ease'; // Re-enable transition
       }
   });
}

async function loadDMHistory(userId) {
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.innerHTML = '';

    try {
        const response = await fetch(florApi(`/api/dm/${userId}`), {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
            const messages = await response.json();
            lastLoadedMessagesForExport = messages.map((m) => ({
                id: m.id,
                author: m.username,
                content: m.content,
                created_at: m.created_at
            }));
            for (const message of messages) {
                const peerId =
                    Number(message.sender_id) === Number(currentUser.id)
                        ? message.receiver_id
                        : message.sender_id;
                let txt = message.content;
                if (window.florE2ee) {
                    txt = await florE2ee.decryptDmPayload(txt, peerId);
                }
                addMessageToUI({
                    id: message.id,
                    senderId: message.sender_id,
                    userId: message.sender_id,
                    author: message.username,
                    avatar: message.avatar || message.username.charAt(0).toUpperCase(),
                    text: txt,
                    timestamp: message.created_at
                });
            }
        } else {
            console.error('Failed to load DM history');
        }
    } catch (error) {
        console.error('Error loading DM history:', error);
    }

    scrollToBottom();
    filterChatMessages(document.getElementById('chatMessageSearch')?.value || '');
}

florDevLog('FLOR MESSENGER initialized successfully!');
if (currentUser) {
   florDevLog('Logged in as:', currentUser.username);
}

function populateDMList(friends) {
   const dmList = document.getElementById('dmList');
   dmList.innerHTML = '';

   if (friends.length === 0) {
       const emptyDM = document.createElement('div');
       emptyDM.className = 'empty-dm-list';
       emptyDM.textContent = 'Пока нет переписок.';
       dmList.appendChild(emptyDM);
       return;
   }

   friends.forEach(friend => {
       const dmItem = document.createElement('div');
       dmItem.className = 'channel flor-dm-row';
       dmItem.setAttribute('data-dm-id', friend.id);
       const letter = friend.avatar || friend.username.charAt(0).toUpperCase();
       dmItem.innerHTML = `
           <div class="friend-avatar">${letter}</div>
           <div class="flor-dm-row__main">
               <div class="flor-dm-row__line1">
                   <span class="flor-dm-row__name">${friend.username}</span>
                   <span class="flor-dm-row__meta">ЛС</span>
               </div>
               <div class="flor-dm-row__preview">Написать сообщение</div>
           </div>
       `;
       dmItem.addEventListener('click', () => {
           startDM(friend.id, friend.username);
       });
       dmList.appendChild(dmItem);
   });
}

// WebRTC Functions
function createPeerConnection(remoteSocketId, isInitiator) {
    florDevLog(`Creating peer connection with ${remoteSocketId}, initiator: ${isInitiator}`);
    
    if (peerConnections[remoteSocketId]) {
        florDevLog('Peer connection already exists');
        return peerConnections[remoteSocketId];
    }
    
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ],
        iceCandidatePoolSize: 10
    });

    peerConnections[remoteSocketId] = pc;

    // Add local stream tracks with better error handling
    if (localStream) {
        const audioTracks = localStream.getAudioTracks();
        const videoTracks = localStream.getVideoTracks();
        
        florDevLog(`Adding tracks - Audio: ${audioTracks.length}, Video: ${videoTracks.length}`);
        
        // Add audio tracks first (priority for voice calls)
        audioTracks.forEach(track => {
            florDevLog(`Adding audio track: ${track.label}, enabled: ${track.enabled}`);
            pc.addTrack(track, localStream);
        });
        
        // Then add video tracks
        videoTracks.forEach(track => {
            florDevLog(`Adding video track: ${track.label}, enabled: ${track.enabled}`);
            pc.addTrack(track, localStream);
        });
    } else {
        console.error('No local stream available');
    }

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            florDevLog('Sending ICE candidate');
            socket.emit('ice-candidate', {
                to: remoteSocketId,
                candidate: event.candidate
            });
        }
    };
    
    // Handle connection state changes
    pc.oniceconnectionstatechange = () => {
        florDevLog(`ICE connection state: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
            console.error('ICE connection failed');
            // Try to restart ICE
            pc.restartIce();
        }
        if (pc.iceConnectionState === 'connected') {
            florDevLog('Peer connection established successfully!');
        }
    };

    // Handle incoming remote stream
    pc.ontrack = (event) => {
        florDevLog('Received remote track:', event.track.kind, 'Stream ID:', event.streams[0]?.id);
        
        const remoteParticipants = document.getElementById('remoteParticipants');
        
        let participantDiv = document.getElementById(`participant-${remoteSocketId}`);
        let remoteVideo = document.getElementById(`remote-${remoteSocketId}`);
        
        if (!participantDiv) {
            participantDiv = document.createElement('div');
            participantDiv.className = 'participant';
            participantDiv.id = `participant-${remoteSocketId}`;
            
            remoteVideo = document.createElement('video');
            remoteVideo.id = `remote-${remoteSocketId}`;
            remoteVideo.autoplay = true;
            remoteVideo.playsInline = true;
            remoteVideo.setAttribute('playsinline', '');
            remoteVideo.setAttribute('webkit-playsinline', '');
            remoteVideo.volume = isDeafened ? 0 : 1; // Respect deafened state
            
            const participantName = document.createElement('div');
            participantName.className = 'participant-name';
            participantName.textContent = 'Собеседник';
            
            participantDiv.appendChild(remoteVideo);
            participantDiv.appendChild(participantName);
            remoteParticipants.appendChild(participantDiv);
        }
        
        // Set the stream to the video element
        if (event.streams && event.streams[0]) {
            florDevLog('Setting remote stream to video element');
            remoteVideo = document.getElementById(`remote-${remoteSocketId}`);
            if (remoteVideo) {
                remoteVideo.srcObject = event.streams[0];
                florTryPlayMediaElement(remoteVideo);
                const el = remoteVideo;
                document.addEventListener(
                    'pointerdown',
                    () => florTryPlayMediaElement(el),
                    { capture: true, once: true }
                );
            }
        }
        
        // Initialize resizable videos
        function initializeResizableVideos() {
            const callInterface = document.getElementById('callInterface');
            const participants = callInterface.querySelectorAll('.participant');
            
            participants.forEach(participant => {
                makeResizable(participant);
            });
            
            // Make call interface resizable too
            makeInterfaceResizable(callInterface);
        }
        
        // Make individual video resizable
        function makeResizable(element) {
            // Add resize handle
            const resizeHandle = document.createElement('div');
            resizeHandle.className = 'resize-handle';
            resizeHandle.innerHTML = '↘';
            resizeHandle.style.cssText = `
                position: absolute;
                bottom: 5px;
                right: 5px;
                width: 20px;
                height: 20px;
                background: rgba(255,255,255,0.3);
                cursor: nwse-resize;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
                font-size: 12px;
                color: white;
                user-select: none;
            `;
            
            // Add video size controls
            const sizeControls = document.createElement('div');
            sizeControls.className = 'video-size-controls';
            sizeControls.innerHTML = `
                <button class="size-control-btn minimize-btn" title="Свернуть">_</button>
                <button class="size-control-btn maximize-btn" title="Размер">□</button>
                <button class="size-control-btn fullscreen-btn" title="На весь экран">⛶</button>
            `;
            
            if (!element.querySelector('.resize-handle')) {
                element.appendChild(resizeHandle);
                element.appendChild(sizeControls);
                element.style.resize = 'both';
                element.style.overflow = 'auto';
                element.style.minWidth = '150px';
                element.style.minHeight = '100px';
                element.style.maxWidth = '90vw';
                element.style.maxHeight = '90vh';
                element.setAttribute('data-resizable', 'true');
                
                // Add double-click for fullscreen
                element.addEventListener('dblclick', function(e) {
                    if (!e.target.closest('.video-size-controls')) {
                        toggleVideoFullscreen(element);
                    }
                });
                
                // Size control buttons
                const minimizeBtn = sizeControls.querySelector('.minimize-btn');
                const maximizeBtn = sizeControls.querySelector('.maximize-btn');
                const fullscreenBtn = sizeControls.querySelector('.fullscreen-btn');
                
                minimizeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    element.classList.toggle('minimized');
                    element.classList.remove('maximized');
                });
                
                maximizeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    element.classList.toggle('maximized');
                    element.classList.remove('minimized');
                });
                
                fullscreenBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const video = element.querySelector('video');
                    if (video && video.requestFullscreen) {
                        video.requestFullscreen();
                    }
                });
            }
        }
        
        // Toggle video fullscreen
        function toggleVideoFullscreen(element) {
            element.classList.toggle('maximized');
            if (element.classList.contains('maximized')) {
                element.classList.remove('minimized');
            }
        }
        
        // Make call interface resizable
        function makeInterfaceResizable(callInterface) {
            const resizeHandle = document.createElement('div');
            resizeHandle.className = 'interface-resize-handle';
            resizeHandle.style.cssText = `
                position: absolute;
                bottom: 0;
                right: 0;
                width: 15px;
                height: 15px;
                cursor: nwse-resize;
                background: linear-gradient(135deg, transparent 50%, #5865f2 50%);
                border-bottom-right-radius: 12px;
            `;
            
            if (!callInterface.querySelector('.interface-resize-handle')) {
                callInterface.appendChild(resizeHandle);
                
                let isResizing = false;
                let startWidth = 0;
                let startHeight = 0;
                let startX = 0;
                let startY = 0;
                
                resizeHandle.addEventListener('mousedown', (e) => {
                    isResizing = true;
                    startWidth = parseInt(document.defaultView.getComputedStyle(callInterface).width, 10);
                    startHeight = parseInt(document.defaultView.getComputedStyle(callInterface).height, 10);
                    startX = e.clientX;
                    startY = e.clientY;
                    e.preventDefault();
                });
                
                document.addEventListener('mousemove', (e) => {
                    if (!isResizing) return;
                    
                    const newWidth = startWidth + e.clientX - startX;
                    const newHeight = startHeight + e.clientY - startY;
                    
                    if (newWidth > 300 && newWidth < window.innerWidth * 0.9) {
                        callInterface.style.width = newWidth + 'px';
                    }
                    if (newHeight > 200 && newHeight < window.innerHeight * 0.9) {
                        callInterface.style.height = newHeight + 'px';
                    }
                });
                
                document.addEventListener('mouseup', () => {
                    isResizing = false;
                });
            }
        }
        
        // Update resizable functionality when new participants join
        const originalOntrack = RTCPeerConnection.prototype.ontrack;
        window.observeNewParticipants = function() {
            setTimeout(() => {
                const participants = document.querySelectorAll('.participant:not([data-resizable])');
                participants.forEach(participant => {
                    participant.setAttribute('data-resizable', 'true');
                    makeResizable(participant);
                });
            }, 500);
        };
        
        // Make the new participant video resizable after a short delay
        setTimeout(() => {
            if (typeof makeResizable === 'function' && participantDiv) {
                makeResizable(participantDiv);
            }
        }, 100);
    };

    // Create offer if initiator with modern constraints
    if (isInitiator) {
        pc.createOffer()
        .then(offer => {
            florDevLog('Created offer with SDP:', offer.sdp.substring(0, 200));
            return pc.setLocalDescription(offer);
        })
        .then(() => {
            florDevLog('Sending offer to:', remoteSocketId);
            socket.emit('offer', {
                to: remoteSocketId,
                offer: pc.localDescription
            });
        })
        .catch(error => {
            console.error('Error creating offer:', error);
        });
    }
    
    return pc;
}

// Initialize resizable videos
function initializeResizableVideos() {
    const callInterface = document.getElementById('callInterface');
    if (!callInterface) return;
    
    const participants = callInterface.querySelectorAll('.participant');
    participants.forEach(participant => {
        makeResizable(participant);
    });
    
    // Make call interface resizable too
    makeInterfaceResizable(callInterface);
}

// Make individual video resizable
function makeResizable(element) {
    if (!element || element.hasAttribute('data-resizable')) return;
    
    // Add resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'resize-handle';
    resizeHandle.innerHTML = '↘';
    resizeHandle.style.cssText = `
        position: absolute;
        bottom: 5px;
        right: 5px;
        width: 20px;
        height: 20px;
        background: rgba(255,255,255,0.3);
        cursor: nwse-resize;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 3px;
        font-size: 12px;
        color: white;
        user-select: none;
        z-index: 10;
    `;
    
    // Add video size controls
    const sizeControls = document.createElement('div');
    sizeControls.className = 'video-size-controls';
    sizeControls.innerHTML = `
        <button class="size-control-btn minimize-btn" title="Свернуть">_</button>
        <button class="size-control-btn maximize-btn" title="Размер">□</button>
        <button class="size-control-btn fullscreen-btn" title="На весь экран">⛶</button>
    `;
    sizeControls.style.cssText = `
        position: absolute;
        top: 8px;
        right: 8px;
        display: flex;
        gap: 4px;
        opacity: 0;
        transition: opacity 0.3s ease;
        z-index: 10;
    `;
    
    element.appendChild(resizeHandle);
    element.appendChild(sizeControls);
    element.style.resize = 'both';
    element.style.overflow = 'auto';
    element.style.minWidth = '150px';
    element.style.minHeight = '100px';
    element.style.maxWidth = '90vw';
    element.style.maxHeight = '90vh';
    element.setAttribute('data-resizable', 'true');
    
    // Show controls on hover
    element.addEventListener('mouseenter', () => {
        sizeControls.style.opacity = '1';
    });
    
    element.addEventListener('mouseleave', () => {
        sizeControls.style.opacity = '0';
    });
    
    // Add double-click for fullscreen
    element.addEventListener('dblclick', function(e) {
        if (!e.target.closest('.video-size-controls')) {
            toggleVideoFullscreen(element);
        }
    });
    
    // Size control buttons
    const minimizeBtn = sizeControls.querySelector('.minimize-btn');
    const maximizeBtn = sizeControls.querySelector('.maximize-btn');
    const fullscreenBtn = sizeControls.querySelector('.fullscreen-btn');
    
    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            element.classList.toggle('minimized');
            element.classList.remove('maximized');
        });
    }
    
    if (maximizeBtn) {
        maximizeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            element.classList.toggle('maximized');
            element.classList.remove('minimized');
        });
    }
    
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const video = element.querySelector('video');
            if (video && video.requestFullscreen) {
                video.requestFullscreen();
            }
        });
    }
}

// Toggle video fullscreen
function toggleVideoFullscreen(element) {
    element.classList.toggle('maximized');
    if (element.classList.contains('maximized')) {
        element.classList.remove('minimized');
    }
}

// Make interface resizable
function makeInterfaceResizable(callInterface) {
    if (!callInterface || callInterface.hasAttribute('data-interface-resizable')) return;
    
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'interface-resize-handle';
    resizeHandle.style.cssText = `
        position: absolute;
        bottom: 0;
        right: 0;
        width: 15px;
        height: 15px;
        cursor: nwse-resize;
        background: linear-gradient(135deg, transparent 50%, #5865f2 50%);
        border-bottom-right-radius: 12px;
    `;
    
    callInterface.appendChild(resizeHandle);
    callInterface.setAttribute('data-interface-resizable', 'true');
    
    let isResizing = false;
    let startWidth = 0;
    let startHeight = 0;
    let startX = 0;
    let startY = 0;
    
    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startWidth = parseInt(document.defaultView.getComputedStyle(callInterface).width, 10);
        startHeight = parseInt(document.defaultView.getComputedStyle(callInterface).height, 10);
        startX = e.clientX;
        startY = e.clientY;
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        const newWidth = startWidth + e.clientX - startX;
        const newHeight = startHeight + e.clientY - startY;
        
        if (newWidth > 400 && newWidth < window.innerWidth * 0.9) {
            callInterface.style.width = newWidth + 'px';
        }
        if (newHeight > 300 && newHeight < window.innerHeight * 0.9) {
            callInterface.style.height = newHeight + 'px';
        }
    });
    
    document.addEventListener('mouseup', () => {
        isResizing = false;
    });
}