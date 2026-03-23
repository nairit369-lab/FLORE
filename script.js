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
let florVoiceRosterRepairTimer = null;
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
/** true пока окно звонка в нативном браузерном fullscreen (не псевдо-класс на iOS) */
let florCallNativeFullscreenActive = false;
/** id активного текстового канала (надёжнее, чем только имя) */
let currentTextChannelId = null;
let currentServerRecord = null;
let lastLoadedMessagesForExport = [];
/** socketId → { username, avatar } для плиток голоса */
const florVoicePeerMeta = {};
/** SVG для списка участников голоса в сайдбаре */
const FLOR_ROSTER_MIC_ON =
    '<svg class="flor-voice-roster-svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5h-2c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';
const FLOR_ROSTER_MIC_OFF =
    '<svg class="flor-voice-roster-svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.92-4.65H5c0 .94.21 1.82.58 2.64L4.27 15H7v2.27L2 19.27v2.46l16-16L3 3l1.27 1z"/></svg>';
const FLOR_ROSTER_DEAF =
    '<svg class="flor-voice-roster-svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
/** последний ростер голоса для перерисовки после сброса настроек */
let florLastVoiceRoster = [];
/** roomKey → участники для превью в дереве каналов (без входа в войс) */
const florVoiceSidebarPresenceByRoomKey = Object.create(null);

function florRememberVoiceSidebarPresence(roomKey, participants) {
    if (!roomKey) return;
    const list = Array.isArray(participants) ? participants : [];
    if (list.length === 0) {
        delete florVoiceSidebarPresenceByRoomKey[roomKey];
    } else {
        florVoiceSidebarPresenceByRoomKey[roomKey] = list;
    }
}

function florApplyVoiceSidebarPresenceForCurrentServer() {
    if (currentServerId == null) return;
    const sid = Number(currentServerId);
    if (!Number.isFinite(sid)) return;
    const prefix = `${sid}:`;
    for (const rk of Object.keys(florVoiceSidebarPresenceByRoomKey)) {
        if (!rk.startsWith(prefix)) continue;
        renderVoiceChannelSidebarRoster(rk, florVoiceSidebarPresenceByRoomKey[rk]);
    }
}
/** userId → JWK публичного ключа (E2EE) */
let florUserKeyCache = new Map();
/** id сообщения → повторная расшифровка, когда появятся ключи / кэш канала */
const florE2eeRetryByMessageId = new Map();
const FLOR_E2EE_CH_STORE_PREFIX = 'florE2ee_ch_';

function florClearStoredChannelKey(channelId) {
    try {
        sessionStorage.removeItem(FLOR_E2EE_CH_STORE_PREFIX + channelId);
    } catch (_) {}
}
let micTestStream = null;
let micTestAnalyser = null;
let micTestRaf = null;
let florLocalVoiceActCtx = null;
let florLocalVoiceActRAF = null;
let florVoiceActivityLastEmit = false;
/** Однократный звук «собеседник в эфире» для ЛС (по socketId) */
const florRemoteJoinSfxDone = new Set();
let florIncomingRingTimer = null;
let florOutgoingRingTimer = null;

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

function florFlattenIdentityJwksList(raw) {
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
                out.push({ ...v, crv: 'P-256' });
            }
        }
    };
    visit(raw);
    return out;
}

function florIdentityJwksFromUser(u) {
    if (!u) return [];
    if (Array.isArray(u.identityPublicJwks) && u.identityPublicJwks.length) {
        return florFlattenIdentityJwksList(u.identityPublicJwks);
    }
    if (u.identityPublicJwk) return florFlattenIdentityJwksList([u.identityPublicJwk]);
    return [];
}

async function florRefreshUserKeyCache() {
    try {
        const r = await fetch(florApi('/api/users'), { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const users = await r.json();
        florUserKeyCache.clear();
        users.forEach((u) => {
            const jwks = florIdentityJwksFromUser(u);
            if (jwks.length) florUserKeyCache.set(Number(u.id), jwks);
        });
    } catch (_) {}
}

/** Перед шифрованием ЛС — актуальные ключи всех устройств с сервера (иначе новый телефон не попадает в wraps). */
async function florRefreshPeerKeysBeforeDmEncrypt() {
    if (!window.florE2ee || typeof florE2ee.isActive !== 'function' || !florE2ee.isActive()) return;
    await florRefreshUserKeyCache();
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
    const cid = Number(channelId);
    if (!Number.isFinite(cid)) return text;

    const ensureAndDecrypt = async () => {
        const raw = await florE2ee.ensureChannelKey(
            cid,
            currentServerRecord.id,
            florApi,
            token,
            currentUser.id,
            florFetchMembersForE2ee
        );
        return await florE2ee.decryptWithChannelKey(raw, text);
    };

    const refreshWrapsAndRetry = async () => {
        await florRefreshUserKeyCache();
        florClearStoredChannelKey(cid);
        try {
            await florE2ee.redistributeMissingWraps(
                cid,
                currentServerRecord.id,
                florApi,
                token,
                currentUser.id,
                florFetchMembersForE2ee
            );
        } catch (_) {}
        return await ensureAndDecrypt();
    };

    try {
        let out = await ensureAndDecrypt();
        if (typeof out === 'string' && out.startsWith('🔒')) {
            out = await refreshWrapsAndRetry();
        }
        return out;
    } catch (_) {
        try {
            return await refreshWrapsAndRetry();
        } catch (e2) {
            return '🔒 Не удалось расшифровать (нет ключа канала)';
        }
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
            if (isVoice) {
                const main = document.createElement('div');
                main.className = 'voice-channel__main';
                main.innerHTML = `${VOICE_CH_SVG}<span class="voice-channel__title">${escapeHtml(channelDisplayName(c.name))}</span>`;
                row.appendChild(main);
                const roster = document.createElement('div');
                roster.className = 'flor-voice-roster-preview';
                roster.setAttribute('aria-label', 'Участники в голосе');
                row.appendChild(roster);
            } else {
                row.innerHTML = `${TEXT_CH_SVG}<span>${escapeHtml(channelDisplayName(c.name))}</span>`;
            }
            wrap.appendChild(row);
        });
        root.appendChild(wrap);
    });
    florApplyVoiceSidebarPresenceForCurrentServer();
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
}

function florIsAvatarImageUrl(s) {
    if (!s || typeof s !== 'string') return false;
    const t = s.trim();
    return t.startsWith('/uploads/') || /^https?:\/\//i.test(t);
}

function florMediaUrl(pathOrUrl) {
    if (!pathOrUrl) return '';
    const t = String(pathOrUrl).trim();
    if (/^https?:\/\//i.test(t)) return t;
    if (t.startsWith('/')) return florApi(t);
    return florApi('/' + t);
}

function florFillAvatarEl(el, avatar, username) {
    if (!el) return;
    el.textContent = '';
    el.classList.remove('has-image');
    const fallback = (username && String(username).charAt(0).toUpperCase()) || '?';
    if (florIsAvatarImageUrl(avatar)) {
        el.classList.add('has-image');
        const img = document.createElement('img');
        img.src = florMediaUrl(avatar);
        img.alt = '';
        img.loading = 'lazy';
        el.appendChild(img);
    } else {
        const letter = (avatar && String(avatar).trim()) || fallback;
        el.textContent = letter.slice(0, 4);
    }
}

function florMessageReactionKey(ctx, messageId) {
    return `${ctx}:${messageId}`;
}

function florEscapeSelector(s) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function florRenderServerIcon(el, server) {
    if (!el || !server) return;
    el.textContent = '';
    const ic = server.icon;
    if (florIsAvatarImageUrl(ic)) {
        const img = document.createElement('img');
        img.className = 'server-icon-img';
        img.src = florMediaUrl(ic);
        img.alt = '';
        el.appendChild(img);
    } else {
        el.textContent =
            (ic && String(ic).trim()) || (server.name && server.name.charAt(0).toUpperCase()) || '?';
    }
}

function florBroadcastVoiceSelfState() {
    if (!activeVoiceRoomKey || !socket || !socket.connected) return;
    const micOff = !localStream || !localStream.getAudioTracks().some((t) => t.enabled);
    socket.emit('voice-self-state', {
        roomKey: activeVoiceRoomKey,
        micMuted: micOff,
        deafened: !!isDeafened
    });
}

function florStopLocalVoiceActivityMonitor() {
    if (florLocalVoiceActRAF) {
        cancelAnimationFrame(florLocalVoiceActRAF);
        florLocalVoiceActRAF = null;
    }
    if (florLocalVoiceActCtx) {
        try {
            florLocalVoiceActCtx.close();
        } catch (_) {}
        florLocalVoiceActCtx = null;
    }
    florVoiceActivityLastEmit = false;
    if (socket && socket.connected && activeVoiceRoomKey) {
        try {
            socket.emit('voice-activity', { speaking: false });
        } catch (_) {}
    }
    document.getElementById('localParticipantTile')?.classList.remove('flor-speaking');
}

function florStartLocalVoiceActivityMonitor() {
    florStopLocalVoiceActivityMonitor();
    if (!localStream || !inCall) return;
    const at = localStream.getAudioTracks()[0];
    if (!at || !at.enabled) return;
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        florLocalVoiceActCtx = ctx;
        const src = ctx.createMediaStreamSource(new MediaStream([at]));
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        an.smoothingTimeConstant = 0.55;
        src.connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        let lastUi = false;
        const tick = () => {
            if (!florLocalVoiceActCtx) return;
            const track = localStream.getAudioTracks()[0];
            if (!track || !track.enabled) {
                if (lastUi) {
                    lastUi = false;
                    document.getElementById('localParticipantTile')?.classList.remove('flor-speaking');
                    if (activeVoiceRoomKey && socket && socket.connected) {
                        socket.emit('voice-activity', { speaking: false });
                        florVoiceActivityLastEmit = false;
                    }
                }
                florLocalVoiceActRAF = requestAnimationFrame(tick);
                return;
            }
            an.getByteFrequencyData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i];
            const avg = sum / buf.length;
            const speaking = avg > 14;
            if (speaking !== lastUi) {
                lastUi = speaking;
                document.getElementById('localParticipantTile')?.classList.toggle('flor-speaking', speaking);
            }
            if (activeVoiceRoomKey && socket && socket.connected) {
                if (speaking !== florVoiceActivityLastEmit) {
                    florVoiceActivityLastEmit = speaking;
                    socket.emit('voice-activity', { speaking });
                }
            }
            florLocalVoiceActRAF = requestAnimationFrame(tick);
        };
        tick();
    } catch (e) {
        florDevLog('voice activity monitor', e);
    }
}

function florRestartLocalVoiceActivityMonitor() {
    florStopLocalVoiceActivityMonitor();
    florStartLocalVoiceActivityMonitor();
}

function updateLocalCallParticipantUI() {
    const vid = document.getElementById('localVideo');
    const av = document.getElementById('localCallAvatar');
    if (!vid || !av) return;
    const hasLiveVideo =
        isVideoEnabled &&
        localStream &&
        localStream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled);
    if (hasLiveVideo) {
        vid.classList.remove('hidden');
        av.classList.add('hidden');
        vid.srcObject = localStream;
    } else {
        vid.classList.add('hidden');
        av.classList.remove('hidden');
        florFillAvatarEl(av, currentUser && currentUser.avatar, currentUser && currentUser.username);
    }
}

function renderCallVoiceRoster(participants) {
    const el = document.getElementById('callRosterList');
    const metaEl = document.getElementById('callVoiceMeta');
    if (!el) return;
    const list = Array.isArray(participants) ? participants : [];
    if (metaEl && activeVoiceRoomKey) {
        const n = list.length;
        metaEl.textContent =
            n === 0 ? 'Никого в комнате' : `${n} в комнате: ` + list.map((p) => p.username || '?').join(', ');
    }
    el.innerHTML = '';
    list.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'call-roster-row';
        if (p.userId != null) row.setAttribute('data-user-id', String(p.userId));

        const inner = document.createElement('div');
        inner.className = 'call-roster-row-inner';

        const av = document.createElement('div');
        av.className = 'call-roster-avatar';
        florFillAvatarEl(av, p.avatar, p.username);
        const info = document.createElement('div');
        info.className = 'call-roster-info';
        const nm = document.createElement('div');
        nm.className = 'call-roster-name';
        nm.textContent = p.username || 'Участник';
        const badges = document.createElement('div');
        badges.className = 'call-roster-badges';
        if (p.micMuted) {
            const s1 = document.createElement('span');
            s1.className = 'call-roster-badge call-roster-badge--muted';
            s1.textContent = 'Мьют';
            badges.appendChild(s1);
        }
        if (p.deafened) {
            const s2 = document.createElement('span');
            s2.className = 'call-roster-badge call-roster-badge--deaf';
            s2.textContent = 'Без звука';
            badges.appendChild(s2);
        }
        if (!p.micMuted && !p.deafened) {
            const s3 = document.createElement('span');
            s3.className = 'call-roster-badge call-roster-badge--live';
            s3.textContent = 'В эфире';
            badges.appendChild(s3);
        }
        info.appendChild(nm);
        info.appendChild(badges);
        inner.appendChild(av);
        inner.appendChild(info);

        const isSelf = currentUser && Number(p.userId) === Number(currentUser.id);
        if (!isSelf && p.userId != null && Number.isFinite(Number(p.userId))) {
            const gear = document.createElement('button');
            gear.type = 'button';
            gear.className = 'call-roster-prefs-btn icon-btn';
            gear.setAttribute('aria-expanded', 'false');
            gear.setAttribute('aria-label', 'Звук у вас');
            gear.title = 'Громкость и мьют только у вас';
            gear.innerHTML =
                '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.65.07-1s-.03-.68-.07-1l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.06-.73-1.69-.98l-.38-2.65A.488.488 0 0 0 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.68.07 1l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.06.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.63-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65z"/></svg>';

            const panel = document.createElement('div');
            panel.className = 'call-roster-prefs-panel hidden';
            panel.addEventListener('click', (e) => e.stopPropagation());

            const prefs = florGetVoiceParticipantPrefs(p.userId);
            const volRow = document.createElement('div');
            volRow.className = 'call-roster-prefs-vol-row';
            const volLab = document.createElement('label');
            volLab.className = 'call-roster-prefs-label';
            const volVal = document.createElement('span');
            volVal.className = 'call-roster-prefs-vol-val';
            volVal.textContent = String(prefs.volume);
            volLab.appendChild(document.createTextNode('Громкость у вас: '));
            volLab.appendChild(volVal);
            volLab.appendChild(document.createTextNode('%'));
            const range = document.createElement('input');
            range.type = 'range';
            range.className = 'call-roster-prefs-range';
            range.min = '0';
            range.max = '100';
            range.value = String(prefs.volume);
            range.addEventListener('input', () => {
                const v = parseInt(range.value, 10) || 0;
                volVal.textContent = String(v);
                florSetVoiceParticipantPref(p.userId, { volume: v });
                florApplyVoicePrefsForUserId(p.userId);
            });

            const muteLab = document.createElement('label');
            muteLab.className = 'call-roster-prefs-mute checkbox-row';
            const muteCb = document.createElement('input');
            muteCb.type = 'checkbox';
            muteCb.checked = prefs.localMute;
            muteCb.addEventListener('change', () => {
                florSetVoiceParticipantPref(p.userId, { localMute: muteCb.checked });
                florApplyVoicePrefsForUserId(p.userId);
            });
            muteLab.appendChild(muteCb);
            muteLab.appendChild(document.createTextNode(' Не слышать у себя'));

            const hint = document.createElement('p');
            hint.className = 'call-roster-prefs-hint';
            hint.textContent = 'Только на вашем устройстве, другие не видят.';

            volRow.appendChild(volLab);
            volRow.appendChild(range);
            panel.appendChild(volRow);
            panel.appendChild(muteLab);
            panel.appendChild(hint);

            gear.addEventListener('click', (e) => {
                e.stopPropagation();
                const wasHidden = panel.classList.contains('hidden');
                if (wasHidden) {
                    document.querySelectorAll('.call-roster-prefs-panel').forEach((other) => {
                        if (other !== panel) other.classList.add('hidden');
                    });
                    document.querySelectorAll('.call-roster-prefs-btn').forEach((b) => {
                        if (b !== gear) b.setAttribute('aria-expanded', 'false');
                    });
                    panel.classList.remove('hidden');
                    gear.setAttribute('aria-expanded', 'true');
                } else {
                    panel.classList.add('hidden');
                    gear.setAttribute('aria-expanded', 'false');
                }
            });

            inner.appendChild(gear);
            row.appendChild(inner);
            row.appendChild(panel);
        } else {
            inner.appendChild(document.createElement('div')).className = 'call-roster-prefs-spacer';
            row.appendChild(inner);
        }

        el.appendChild(row);
    });
}

function renderVoiceChannelSidebarRoster(roomKey, participants) {
    if (!roomKey || !currentServerId) return;
    const parts = String(roomKey).split(':');
    const sid = parseInt(parts[0], 10);
    const cid = parseInt(parts[1], 10);
    if (!Number.isFinite(sid) || sid !== Number(currentServerId) || !Number.isFinite(cid)) return;

    const row = document.querySelector(`.voice-channel[data-channel-id="${cid}"]`);
    if (!row) return;

    row.querySelectorAll('.flor-voice-count').forEach((el) => el.remove());

    let wrap = row.querySelector('.flor-voice-roster-preview');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'flor-voice-roster-preview';
        wrap.setAttribute('aria-label', 'Участники в голосе');
        row.appendChild(wrap);
    }

    const list = Array.isArray(participants) ? participants : [];
    wrap.innerHTML = '';

    if (list.length === 0) {
        wrap.classList.remove('flor-voice-roster-preview--visible');
        return;
    }

    wrap.classList.add('flor-voice-roster-preview--visible');

    list
        .slice()
        .sort((a, b) =>
            String(a.username || '').localeCompare(String(b.username || ''), 'ru', { sensitivity: 'base' })
        )
        .forEach((p) => {
            const line = document.createElement('div');
            line.className = 'flor-voice-roster-user';

            const av = document.createElement('div');
            av.className = 'flor-voice-roster-avatar';
            florFillAvatarEl(av, p.avatar, p.username);

            const name = document.createElement('span');
            name.className = 'flor-voice-roster-name';
            name.textContent = p.username || 'Участник';

            const st = document.createElement('span');
            st.className = 'flor-voice-roster-status';
            if (p.micMuted) {
                st.classList.add('flor-voice-roster-status--muted');
                st.innerHTML = FLOR_ROSTER_MIC_OFF;
                st.title = 'Микрофон выключен';
            } else if (p.deafened) {
                st.classList.add('flor-voice-roster-status--deaf');
                st.innerHTML = FLOR_ROSTER_DEAF;
                st.title = 'Режим без звука';
            } else {
                st.innerHTML = FLOR_ROSTER_MIC_ON;
                st.title = 'Микрофон включён';
            }

            line.appendChild(av);
            line.appendChild(name);
            line.appendChild(st);
            wrap.appendChild(line);
        });
}

function florResetMessageMenuPosition(menu) {
    if (!menu) return;
    menu.classList.remove('message-more-menu--fixed');
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.right = '';
    menu.style.bottom = '';
}

function florPositionMessageMenuFixed(menu, anchorBtn) {
    if (!menu || !anchorBtn) return;
    menu.classList.add('message-more-menu--fixed');
    const apply = () => {
        const r = anchorBtn.getBoundingClientRect();
        const pad = 8;
        const gap = 8;
        menu.style.position = 'fixed';
        menu.style.right = 'auto';
        menu.style.bottom = 'auto';
        const mw = menu.offsetWidth;
        const mh = menu.offsetHeight;
        let left = r.right - mw;
        let top = r.bottom + gap;
        if (left < pad) left = pad;
        if (left + mw > window.innerWidth - pad) left = window.innerWidth - mw - pad;
        if (top + mh > window.innerHeight - pad) {
            top = Math.max(pad, r.top - mh - gap);
        }
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
    };
    requestAnimationFrame(() => {
        requestAnimationFrame(apply);
    });
}

function closeAllOpenMessageMenus() {
    document.querySelectorAll('.message-more-menu').forEach((m) => {
        m.classList.add('hidden');
        florResetMessageMenuPosition(m);
    });
    document.querySelectorAll('.message-more-btn[aria-expanded="true"]').forEach((b) =>
        b.setAttribute('aria-expanded', 'false')
    );
}

function removeFlorMessageFromUI(messageId, ctx) {
    const key = florMessageReactionKey(ctx, messageId);
    const row = document.querySelector(`[data-flor-msg-key="${florEscapeSelector(key)}"]`);
    if (row) row.remove();
}

function getMessengerSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        const s = raw ? JSON.parse(raw) : {};
        if (s.desktopNotifications === undefined) s.desktopNotifications = true;
        if (s.soundInApp === undefined) s.soundInApp = true;
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
        if (!s.voiceParticipantPrefs || typeof s.voiceParticipantPrefs !== 'object') {
            s.voiceParticipantPrefs = {};
        }
        return s;
    } catch {
        return {
            desktopNotifications: true,
            soundInApp: true,
            compactMessages: false,
            theme: 'light',
            fontScale: 100,
            sidebarWidthPx: 260,
            linksOpenNewTab: true,
            dndEnabled: false,
            dndStart: '22:00',
            dndEnd: '08:00',
            channelPrefs: {},
            voiceParticipantPrefs: {}
        };
    }
}

function florGetVoiceParticipantPrefs(userId) {
    const uid = String(Number(userId));
    if (!Number.isFinite(Number(uid))) {
        return { volume: 100, localMute: false };
    }
    const all = getMessengerSettings().voiceParticipantPrefs || {};
    const p = all[uid] || {};
    let vol = Number(p.volume);
    if (!Number.isFinite(vol)) vol = 100;
    vol = Math.min(100, Math.max(0, vol));
    return { volume: vol, localMute: p.localMute === true };
}

function florSetVoiceParticipantPref(userId, patch) {
    const uid = String(Number(userId));
    if (!Number.isFinite(Number(uid))) return;
    const s = getMessengerSettings();
    const all = { ...(s.voiceParticipantPrefs || {}) };
    const cur = florGetVoiceParticipantPrefs(uid);
    const next = { ...cur, ...patch };
    if (next.volume !== undefined) {
        next.volume = Math.min(100, Math.max(0, Number(next.volume) || 100));
    }
    if (next.localMute !== undefined) {
        next.localMute = !!next.localMute;
    }
    all[uid] = next;
    saveMessengerSettings({ voiceParticipantPrefs: all });
}

function florApplyRemoteParticipantAudio(remoteSocketId) {
    const vid = document.getElementById(`remote-${remoteSocketId}`);
    if (!vid) return;
    const meta = florVoicePeerMeta[remoteSocketId] || {};
    const uid = meta.userId != null ? Number(meta.userId) : null;
    if (uid == null || !Number.isFinite(uid)) {
        vid.volume = isDeafened ? 0 : 1;
        return;
    }
    const prefs = florGetVoiceParticipantPrefs(uid);
    let vol = (prefs.volume / 100) * (isDeafened ? 0 : 1);
    if (prefs.localMute) vol = 0;
    vid.volume = Math.min(1, Math.max(0, vol));
}

function florApplyVoicePrefsForUserId(userId) {
    const uid = Number(userId);
    if (!Number.isFinite(uid)) return;
    Object.keys(florVoicePeerMeta).forEach((socketId) => {
        if (Number(florVoicePeerMeta[socketId]?.userId) === uid) {
            florApplyRemoteParticipantAudio(socketId);
        }
    });
}

function florRefreshAllRemoteVoiceVolumes() {
    document.querySelectorAll('video[id^="remote-"]').forEach((video) => {
        const m = /^remote-(.+)$/.exec(video.id || '');
        if (m) florApplyRemoteParticipantAudio(m[1]);
    });
}

function closeAllOpenRosterPrefPanels() {
    document.querySelectorAll('.call-roster-prefs-panel').forEach((p) => p.classList.add('hidden'));
    document.querySelectorAll('.call-roster-prefs-btn').forEach((b) => b.setAttribute('aria-expanded', 'false'));
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

const FLOR_FILE_MESSAGE_RE = /^Файл:\s*(.+?)\s*[\u2014\u2013\-]\s*(\/uploads\/\S+)$/;
const FLOR_VOICE_MESSAGE_RE = /^Голосовое:\s*[\u2014\u2013\-]\s*(\/uploads\/\S+)$/;

function florMessageIsAttachmentOnlyText(text) {
    const lines = String(text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    if (lines.length === 0) return false;
    return lines.every(
        (l) => FLOR_FILE_MESSAGE_RE.test(l) || FLOR_VOICE_MESSAGE_RE.test(l)
    );
}

function florAttachmentExt(displayName, path) {
    const pick = displayName && String(displayName).includes('.') ? displayName : path;
    const base = String(pick || '');
    const i = base.lastIndexOf('.');
    return i >= 0 ? base.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

function florAppendLinkifiedLine(frag, line) {
    const inner = linkifyToFragment(line);
    while (inner.firstChild) frag.appendChild(inner.firstChild);
}

function florAppendAttachmentBlock(frag, displayName, path) {
    const url = florMediaUrl(path);
    const ext = florAttachmentExt(displayName, path);
    const imageExt =
        /^(jpe?g|png|gif|webp|avif|svg|bmp|ico)$/i.test(ext);
    const videoExt = /^(mp4|webm|mov|m4v|ogv)$/i.test(ext);
    const openNew = getMessengerSettings().linksOpenNewTab !== false;

    const wrap = document.createElement('div');
    wrap.className = 'message-attachment';

    if (imageExt) {
        wrap.classList.add('message-attachment--image');
        const link = document.createElement('a');
        link.className = 'message-attachment-img-link';
        link.href = url;
        link.setAttribute('aria-label', 'Открыть изображение');
        if (openNew) {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
        }
        const img = document.createElement('img');
        img.className = 'message-attachment-img';
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        link.appendChild(img);
        wrap.appendChild(link);
        frag.appendChild(wrap);
        return;
    }

    if (videoExt) {
        wrap.classList.add('message-attachment--video');
        const v = document.createElement('video');
        v.className = 'message-attachment-video';
        v.src = url;
        v.controls = true;
        v.preload = 'metadata';
        v.playsInline = true;
        wrap.appendChild(v);
        frag.appendChild(wrap);
        return;
    }

    wrap.classList.add('message-attachment--file');
    const a = document.createElement('a');
    a.className = 'message-attachment-link message-attachment-link--file';
    a.href = url;
    a.textContent = `📎 ${displayName || 'Файл'}`;
    if (openNew) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
    }
    wrap.appendChild(a);
    frag.appendChild(wrap);
}

function florAppendVoiceMessageBlock(frag, uploadPath) {
    const url = florMediaUrl(uploadPath);
    const wrap = document.createElement('div');
    wrap.className = 'message-attachment message-attachment--voice';

    const label = document.createElement('div');
    label.className = 'message-attachment-voice-label';
    label.innerHTML =
        '<span class="message-attachment-voice-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5h-2c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg></span><span>Голосовое</span>';

    const audio = document.createElement('audio');
    audio.className = 'message-attachment-audio';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    audio.setAttribute('aria-label', 'Воспроизвести голосовое сообщение');

    wrap.appendChild(label);
    wrap.appendChild(audio);
    frag.appendChild(wrap);
}

function florMessageTextToFragment(text) {
    const frag = document.createDocumentFragment();
    if (text == null || text === '') return frag;
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (i > 0) frag.appendChild(document.createElement('br'));
        const line = lines[i];
        const trimmed = line.trim();
        const vm = trimmed ? FLOR_VOICE_MESSAGE_RE.exec(trimmed) : null;
        if (vm) {
            florAppendVoiceMessageBlock(frag, vm[1].trim());
            continue;
        }
        const m = trimmed ? FLOR_FILE_MESSAGE_RE.exec(trimmed) : null;
        if (m) {
            florAppendAttachmentBlock(frag, m[1].trim(), m[2].trim());
        } else {
            florAppendLinkifiedLine(frag, line);
        }
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
    const isDark = theme === 'dark';
    const title = isDark ? 'Светлая тема' : 'Тёмная тема';
    document.querySelectorAll('[data-flor-theme-toggle]').forEach((btn) => {
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
        btn.innerHTML = isDark ? THEME_SUN_SVG : THEME_MOON_SVG;
    });
}

function initializeThemeToggle() {
    const toggle = () => {
        const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
        saveMessengerSettings({ theme: next });
        applyTheme(next);
    };
    document.querySelectorAll('[data-flor-theme-toggle]').forEach((btn) => {
        btn.addEventListener('click', toggle);
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
            out[i] = Math.round(0.12 * 32767 * env * Math.sin((2 * Math.PI * f * i) / sr));
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
            let touchFirst = false;
            try {
                if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) touchFirst = true;
            } catch (_) {}
            try {
                if (/Android|webOS|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')) {
                    touchFirst = true;
                }
            } catch (_) {}
            if (!florPingAudio) {
                florPingAudio = new Audio(florGetPingDataUrl());
                florPingAudio.preload = 'auto';
                florPingAudio.volume = 0.14;
            }
            if (touchFirst) {
                /* На телефоне не вызываем play() для «разблокировки» — иначе слышен щелчок/пик при первом касании */
            } else {
                florPingAudio.volume = 0;
                florPingAudio.play().then(() => {
                    florPingAudio.pause();
                    florPingAudio.currentTime = 0;
                    florPingAudio.volume = 0.14;
                }).catch(() => {
                    florPingAudio.volume = 0.14;
                });
            }
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

function florUseRelaxedMediaConstraints() {
    try {
        if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
    } catch (_) {}
    try {
        return /Android|webOS|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    } catch (_) {
        return false;
    }
}

function florVideoCaptureConstraints() {
    if (florUseRelaxedMediaConstraints()) {
        return {
            facingMode: 'user',
            width: { ideal: 640, max: 1280 },
            height: { ideal: 480, max: 720 }
        };
    }
    return { width: { ideal: 1280 }, height: { ideal: 720 } };
}

function florAudioCaptureConstraints() {
    const s = getMessengerSettings();
    /** Не задаём sampleRate/sampleSize жёстко — иначе на части ПК/гарнитур WebRTC даёт металлический/рваный звук из‑за ресэмплинга. */
    const audio = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: { ideal: 1 }
    };
    const id = s.audioInputDeviceId && String(s.audioInputDeviceId).trim();
    if (id) {
        audio.deviceId = florUseRelaxedMediaConstraints() ? { ideal: id } : { exact: id };
    }
    return audio;
}

async function florGetUserMediaReliable(constraints) {
    const needVideo = !!(constraints && constraints.video);
    const needAudio = !!(constraints && constraints.audio);
    try {
        return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e1) {
        if (
            e1 &&
            e1.name === 'OverconstrainedError' &&
            constraints &&
            constraints.audio &&
            typeof constraints.audio === 'object'
        ) {
            const looseAudio = { ...constraints.audio };
            delete looseAudio.deviceId;
            delete looseAudio.sampleRate;
            delete looseAudio.sampleSize;
            delete looseAudio.channelCount;
            try {
                return await navigator.mediaDevices.getUserMedia({
                    audio: looseAudio,
                    video: constraints.video === false ? false : constraints.video
                });
            } catch (_) {
                /* continue */
            }
        }
        if (needVideo && constraints.video !== false) {
            try {
                const v = florUseRelaxedMediaConstraints()
                    ? { facingMode: 'user' }
                    : true;
                return await navigator.mediaDevices.getUserMedia({
                    audio: needAudio ? true : false,
                    video: v
                });
            } catch (e3) {
                if (needAudio && needVideo) {
                    return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                }
                throw e3;
            }
        }
        throw e1;
    }
}

function florCallSfxAllowed() {
    return getMessengerSettings().soundInApp === true && !isDoNotDisturbNow();
}

function florEnsureFlorAudioCtx() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !window.isSecureContext) return null;
    if (!florAudioCtx) florAudioCtx = new Ctx();
    if (florAudioCtx.state === 'suspended') florAudioCtx.resume().catch(() => {});
    return florAudioCtx;
}

/** Низкочастотный фильтр + тише выход — «демо»-звуки не режут ухо синусом на полную громкость */
function florConnectCallSfxToDestination(ctx, t0) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t0);
    lp.Q.setValueAtTime(0.65, t0);
    lp.connect(ctx.destination);
    const master = ctx.createGain();
    master.connect(lp);
    return master;
}

/** join | leave | notify — мягкие короткие сигналы (звонок / войс) */
function florPlayCallSfx(kind) {
    if (!florCallSfxAllowed()) return;
    try {
        const ctx = florEnsureFlorAudioCtx();
        if (!ctx) {
            if (kind === 'notify' && florPingAudio) {
                florPingAudio.currentTime = 0;
                florPingAudio.play().catch(() => {});
            }
            return;
        }
        const t0 = ctx.currentTime;
        const master = florConnectCallSfxToDestination(ctx, t0);
        master.gain.value = kind === 'notify' ? 0.038 : 0.048;

        const tone = (freq, t, dur, vol) => {
            const o = ctx.createOscillator();
            o.type = 'triangle';
            o.frequency.setValueAtTime(freq, t);
            const g = ctx.createGain();
            o.connect(g);
            g.connect(master);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(vol, t + 0.028);
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            o.start(t);
            o.stop(t + dur + 0.035);
        };

        if (kind === 'join') {
            tone(523.25, t0, 0.1, 0.32);
            tone(659.25, t0 + 0.09, 0.12, 0.34);
        } else if (kind === 'leave') {
            tone(659.25, t0, 0.09, 0.3);
            tone(392.0, t0 + 0.09, 0.15, 0.32);
        } else if (kind === 'notify') {
            tone(660, t0, 0.07, 0.36);
            tone(880, t0 + 0.065, 0.055, 0.24);
        }
    } catch (_) {
        try {
            if (kind === 'notify' && florPingAudio) {
                florPingAudio.currentTime = 0;
                florPingAudio.play().catch(() => {});
            }
        } catch (_) {}
    }
}

function florPlayRingBurst(incoming) {
    if (!florCallSfxAllowed()) return;
    const ctx = florEnsureFlorAudioCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const master = florConnectCallSfxToDestination(ctx, t0);
    master.gain.value = incoming ? 0.055 : 0.042;
    const pulse = (base, t) => {
        for (let i = 0; i < 2; i++) {
            const o = ctx.createOscillator();
            o.type = 'triangle';
            o.frequency.setValueAtTime(base + i * 32, t + i * 0.22);
            const g = ctx.createGain();
            o.connect(g);
            g.connect(master);
            const st = t + i * 0.24;
            g.gain.setValueAtTime(0.0001, st);
            g.gain.linearRampToValueAtTime(0.32, st + 0.035);
            g.gain.exponentialRampToValueAtTime(0.0001, st + 0.4);
            o.start(st);
            o.stop(st + 0.45);
        }
    };
    pulse(incoming ? 400 : 320, t0);
    if (incoming) pulse(460, t0 + 0.58);
}

function florStopIncomingRingtone() {
    if (florIncomingRingTimer) {
        clearInterval(florIncomingRingTimer);
        florIncomingRingTimer = null;
    }
}

function florStartIncomingRingtone() {
    florStopIncomingRingtone();
    florPlayRingBurst(true);
    florIncomingRingTimer = setInterval(() => florPlayRingBurst(true), 2800);
}

function florStopOutgoingRingtone() {
    if (florOutgoingRingTimer) {
        clearInterval(florOutgoingRingTimer);
        florOutgoingRingTimer = null;
    }
}

function florStartOutgoingRingtone() {
    florStopOutgoingRingtone();
    florPlayRingBurst(false);
    florOutgoingRingTimer = setInterval(() => florPlayRingBurst(false), 2600);
}

function florResetCallRingAndJoinSfx() {
    florStopIncomingRingtone();
    florStopOutgoingRingtone();
    florRemoteJoinSfxDone.clear();
}

/** Горизонтальная сетка только для видеозвонка ЛС (не голосовой канал сервера) */
function florSyncDmVideoCallLayout() {
    const el = document.getElementById('callInterface');
    if (!el) return;
    const d = window.currentCallDetails;
    const dmVideo = !!(d && d.type === 'video' && !activeVoiceRoomKey);
    const dmDirect = !!(d && !activeVoiceRoomKey);
    el.classList.toggle('flor-call-shell--dm-video', dmVideo);
    el.classList.toggle('flor-call-shell--dm-direct', dmDirect);
}

/** Подзаголовок в шапке звонка (не путать с ростером голосового канала) */
function florSetCallVoiceMeta(text) {
    const meta = document.getElementById('callVoiceMeta');
    if (!meta) return;
    meta.textContent = text == null || text === '' ? '—' : String(text);
}

function playSoftPing() {
    florPlayCallSfx('notify');
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
    document.addEventListener('click', () => {
        closeAllOpenMessageMenus();
        closeAllOpenRosterPrefPanels();
    });
    florInitMediaPlaybackUnlock();
    initializeFlorSplash();
    initializeFlorUserProfileOverlay();
    florRefreshUserProfileFromServer();
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
    initializeServerDeleteChannel();
    initializeMembersPanel();
    initializeChatTools();
    initializeNotificationButtons();
    initializeHotkeys();
    initializeCallControls();
    initializeServerManagement();
    initializeMobileNav();
    initializeMobileTabbar();
    initializeMobileSwipeNav();
    initializeFileUpload();
    initializeVoiceMessageButton();
    initializeEmojiPicker();
    initializeDraggableCallWindow();
    connectToSocketIO();
    requestNotificationPermission();
    loadUserServers();
    showFriendsView();
    if (florIsMobileTabbarLayout()) {
        requestAnimationFrame(() => {
            window.florOpenMobileSidebar?.();
        });
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (currentView === 'dm' && currentDMUserId != null) {
            void florMarkDmConversationRead(currentDMUserId);
        }
        void florRetryPendingE2eeDecrypt();
    });

    (async () => {
        try {
            await florRefreshUserKeyCache();
            if (window.florE2ee) {
                await window.florE2ee.init(
                    florApi,
                    token,
                    async (userId) => {
                        const uid = Number(userId);
                        let keys = florUserKeyCache.get(uid);
                        if (keys && keys.length) return keys;
                        await florRefreshUserKeyCache();
                        keys = florUserKeyCache.get(uid);
                        return keys && keys.length ? keys : [];
                    },
                    currentUser && currentUser.id != null ? Number(currentUser.id) : null
                );
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
        void florRetryPendingE2eeDecrypt();
    })();
}

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function showNotification(title, body, options) {
    const s = getMessengerSettings();
    if (s.desktopNotifications === false) return;
    if (isDoNotDisturbNow()) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const o = options && typeof options === 'object' ? options : {};
    const n = new Notification(title, {
        body: body || '',
        icon: '/assets/apple-touch-icon.png',
        tag: o.tag != null ? String(o.tag) : 'flor-default',
        requireInteraction: !!o.requireInteraction
    });
    if (o.onclickFocus) {
        n.onclick = () => {
            try {
                window.focus();
            } catch (_) {}
            try {
                n.close();
            } catch (_) {}
        };
    }
}

function florNotifyIncomingCall(caller, type) {
    const name = (caller && caller.username) || 'Контакт';
    const kind = type === 'video' ? 'Видеозвонок' : 'Звонок';
    showNotification(`${kind}: ${name}`, 'Входящий вызов — откройте приложение', {
        tag: 'flor-incoming-call',
        requireInteraction: true,
        onclickFocus: true
    });
}

/** Досоздаёт WebRTC-связи с участниками голоса, если события join/existing пропустились */
function florVoiceRepairMissingPeers(participants) {
    if (!inCall || !activeVoiceRoomKey || !localStream || !socket) return;
    if (!Array.isArray(participants)) return;
    for (const p of participants) {
        const sid = p && p.socketId;
        if (!sid || sid === socket.id) continue;
        if (peerConnections[sid]) continue;
        florVoicePeerMeta[sid] = {
            userId: p.userId,
            username: p.username || '',
            avatar: p.avatar || ''
        };
        const iOffer = String(socket.id).localeCompare(String(sid)) < 0;
        florDevLog('Voice repair peer', sid, 'initiator=', iOffer);
        createPeerConnection(sid, iOffer);
    }
}

function updateUserInfo() {
    const userAvatar = document.querySelector('.user-avatar');
    const username = document.querySelector('.username');
    const userStatus = document.querySelector('.user-status');
    const heroAv = document.getElementById('florDmHeroMeAv');

    if (userAvatar) {
        florFillAvatarEl(userAvatar, currentUser && currentUser.avatar, currentUser && currentUser.username);
    }
    if (heroAv) {
        florFillAvatarEl(heroAv, currentUser && currentUser.avatar, currentUser && currentUser.username);
    }
    const disp = getMessengerSettings().displayName;
    if (username) username.textContent = (disp && disp.trim()) || currentUser.username;
    if (userStatus) {
        userStatus.textContent = getMessengerSettings().privacyHideOnline ? 'Невидимка' : 'В сети';
    }
}

function initializeFlorSplash() {
    const sp = document.getElementById('florSplash');
    if (!sp) return;
    const t0 = Date.now();
    const done = () => {
        sp.classList.add('flor-splash--hide');
        setTimeout(() => sp.remove(), 500);
    };
    const finish = () => {
        const elapsed = Date.now() - t0;
        const minMs = 650;
        setTimeout(done, elapsed < minMs ? minMs - elapsed : 0);
    };
    const logo = sp.querySelector('.flor-splash__logo');
    if (logo) {
        logo.addEventListener('animationend', finish, { once: true });
    }
    setTimeout(finish, 2800);
}

function closeFlorUserProfile() {
    const overlay = document.getElementById('userProfileOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
}

async function openFlorUserProfile(userId) {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || !token) return;
    const overlay = document.getElementById('userProfileOverlay');
    const content = document.getElementById('userProfileContent');
    if (!overlay || !content) return;
    content.textContent = '';
    const loading = document.createElement('p');
    loading.className = 'settings-hint';
    loading.style.padding = '20px';
    loading.textContent = 'Загрузка…';
    content.appendChild(loading);
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    try {
        const r = await fetch(florApi(`/api/users/${uid}/public`), {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await r.json();
        if (!r.ok) {
            throw new Error(data.error || 'Не удалось открыть профиль');
        }
        content.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'flor-profile-card';
        const banner = document.createElement('div');
        banner.className = 'flor-profile-card__banner';
        if (data.profile_banner) {
            const bu = florMediaUrl(data.profile_banner);
            banner.style.backgroundImage = `url("${bu.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
        }
        const body = document.createElement('div');
        body.className = 'flor-profile-card__body';
        const avWrap = document.createElement('div');
        avWrap.className = 'flor-profile-card__avatar';
        if (florIsAvatarImageUrl(data.avatar)) {
            const img = document.createElement('img');
            img.src = florMediaUrl(data.avatar);
            img.alt = '';
            avWrap.appendChild(img);
        } else {
            avWrap.textContent =
                (data.avatar && String(data.avatar).trim()) || data.username.charAt(0).toUpperCase();
        }
        const title = document.createElement('h3');
        title.className = 'flor-profile-card__title';
        title.id = 'userProfileTitle';
        title.textContent = data.username;
        const handle = document.createElement('div');
        handle.className = 'flor-profile-card__handle';
        handle.textContent = '@' + data.username;
        const bio = document.createElement('div');
        bio.className = 'flor-profile-card__bio';
        if (data.bio && String(data.bio).trim()) {
            bio.textContent = data.bio;
        } else {
            bio.classList.add('settings-hint');
            bio.textContent = 'Нет описания';
        }
        const meta = document.createElement('div');
        meta.className = 'flor-profile-card__meta';
        meta.textContent = friendStatusLabel(data.status);
        body.appendChild(avWrap);
        body.appendChild(title);
        body.appendChild(handle);
        body.appendChild(bio);
        body.appendChild(meta);
        if (currentView === 'dm' && Number(currentDMUserId) === uid) {
            const ex = document.createElement('button');
            ex.type = 'button';
            ex.className = 'settings-btn settings-btn--secondary';
            ex.style.marginTop = '14px';
            ex.style.width = '100%';
            ex.textContent = 'Скачать историю чата (JSON)';
            ex.addEventListener('click', () => florExportChatJson());
            body.appendChild(ex);
        }
        card.appendChild(banner);
        card.appendChild(body);
        content.appendChild(card);
    } catch (e) {
        content.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'settings-hint';
        p.style.padding = '20px';
        p.textContent = e.message || 'Ошибка';
        content.appendChild(p);
    }
}

function initializeFlorUserProfileOverlay() {
    const overlay = document.getElementById('userProfileOverlay');
    const closeBtn = document.getElementById('userProfileCloseBtn');
    if (!overlay) return;
    closeBtn?.addEventListener('click', closeFlorUserProfile);
    overlay.addEventListener('click', (e) => {
        if (e.target.getAttribute('data-close-profile') === '1') {
            closeFlorUserProfile();
        }
    });
    const sheet = overlay.querySelector('.user-profile-sheet');
    let sy = 0;
    let armed = false;
    sheet?.addEventListener(
        'touchstart',
        (e) => {
            if (!e.touches || e.touches.length !== 1) return;
            sy = e.touches[0].clientY;
            armed = sheet.scrollTop <= 0;
        },
        { passive: true }
    );
    sheet?.addEventListener(
        'touchend',
        (e) => {
            if (!armed || !e.changedTouches || e.changedTouches.length !== 1) return;
            armed = false;
            const dy = e.changedTouches[0].clientY - sy;
            if (dy > 72) {
                closeFlorUserProfile();
            }
        },
        { passive: true }
    );
}

async function florRefreshUserProfileFromServer() {
    if (!token) return;
    try {
        const r = await fetch(florApi('/api/user/profile'), {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!r.ok) return;
        const u = await r.json();
        const av =
            u.avatar && String(u.avatar).trim()
                ? u.avatar
                : (currentUser && currentUser.username && currentUser.username.charAt(0).toUpperCase()) || '?';
        currentUser = {
            ...currentUser,
            id: u.id,
            username: u.username,
            email: u.email,
            avatar: av,
            bio: u.bio,
            profile_banner: u.profile_banner
        };
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        updateUserInfo();
    } catch (_) {}
}

function connectToSocketIO() {
    if (typeof io !== 'undefined') {
        socket = io(florOrigin(), { auth: { token: token } });
        
        socket.on('connect', () => {
            florDevLog('Connected to server');
            void florRetryPendingE2eeDecrypt();
        });

        socket.on('server-membership-update', (payload) => {
            if (payload?.removed && payload.serverId != null) {
                if (currentServerId != null && Number(currentServerId) === Number(payload.serverId)) {
                    currentServerRecord = null;
                    showFriendsView();
                }
                servers = servers.filter((s) => Number(s.id) !== Number(payload.serverId));
            }
            if (socket && socket.connected) {
                socket.emit('resync-server-rooms');
            }
            loadUserServers();
        });

        socket.on('server-channels-updated', (payload) => {
            if (!payload || Number(payload.serverId) !== Number(currentServerId)) return;
            if (payload.tree) {
                renderChannelTree(payload.tree);
                flattenChannelTreeToMaps(payload.tree);
            }
            if (
                payload.deletedChannelId != null &&
                Number(payload.deletedChannelId) === Number(currentTextChannelId)
            ) {
                const keys = Object.keys(currentServerChannelMap || {});
                if (keys.length) {
                    switchChannel(keys[0]);
                } else {
                    const box = document.getElementById('messagesContainer');
                    if (box) {
                        box.innerHTML =
                            '<p class="empty-channel-hint" style="padding:16px;color:var(--flor-muted);">Канал удалён. Выберите другой канал в списке слева.</p>';
                    }
                    currentChannel = '';
                    currentTextChannelId = null;
                }
            }
            const ov = document.getElementById('serverSettingsOverlay');
            if (
                ov &&
                !ov.classList.contains('hidden') &&
                currentUser &&
                currentServerRecord &&
                Number(currentServerRecord.owner_id) === Number(currentUser.id)
            ) {
                void populateServerSettingsDeleteChannels();
            }
        });

        socket.on('voice-channel-removed', (data) => {
            if (!data || data.serverId == null || data.channelId == null) return;
            const rk = `${data.serverId}:${data.channelId}`;
            florRememberVoiceSidebarPresence(rk, []);
            if (activeVoiceRoomKey === rk) {
                leaveVoiceChannel(true);
            }
        });

        socket.on('voice-channel-roster', (data) => {
            if (!data || !data.roomKey) return;
            florRememberVoiceSidebarPresence(data.roomKey, data.participants);
            renderVoiceChannelSidebarRoster(data.roomKey, data.participants);
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
                const fk = mid != null ? florMessageReactionKey('channel', mid) : null;
                if (mid != null && box && box.querySelector(`[data-flor-msg-key="${florEscapeSelector(fk)}"]`)) {
                    return;
                }
                let msg = data.message;
                const rawCipher =
                    msg && window.florE2ee && florE2ee.isE2eePayload(msg.text) ? msg.text : null;
                if (msg && window.florE2ee && currentServerRecord && data.channelId != null) {
                    const text = await florDecryptChannelMessage(data.channelId, msg.text);
                    msg = { ...msg, text, florPendingCipher: rawCipher, channelId: data.channelId };
                } else if (rawCipher) {
                    msg = { ...msg, florPendingCipher: rawCipher, channelId: data.channelId };
                }
                msg = {
                    ...msg,
                    userId: msg.senderId != null ? msg.senderId : msg.userId
                };
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
            
            const viewingThisChannel =
                channelName === currentChannel && currentView === 'server';
            if (
                getMessengerSettings().desktopNotifications !== false &&
                !isDoNotDisturbNow() &&
                'Notification' in window &&
                Notification.permission === 'granted' &&
                (!viewingThisChannel || document.hidden)
            ) {
                const rawT = data.message.text;
                const preview =
                    window.florE2ee && florE2ee.isE2eePayload(rawT) ? 'зашифрованное сообщение' : rawT;
                showNotification(channelName || 'Канал', `${data.message.author}: ${preview}`, {
                    tag: `flor-ch-${channelId}`,
                    onclickFocus: true
                });
            }
        });
        
        socket.on('reaction-update', (data) => {
            updateMessageReactions(data.messageId, data.reactions, data.context);
        });

        // WebRTC Signaling
        socket.on('user-joined-voice', (data) => {
            florDevLog('User joined voice:', data);
            if (!data || !data.socketId) return;
            if (
                inCall &&
                socket &&
                data.socketId !== socket.id &&
                activeVoiceRoomKey
            ) {
                florPlayCallSfx('join');
            }
            if (peerConnections[data.socketId]) {
                try {
                    peerConnections[data.socketId].close();
                } catch (_) {}
                delete peerConnections[data.socketId];
            }
            florVoicePeerMeta[data.socketId] = {
                userId: data.userId,
                username: data.username || '',
                avatar: data.avatar || ''
            };
            createPeerConnection(data.socketId, true);
        });

        socket.on('existing-voice-users', (userList) => {
            userList.forEach((user) => {
                if (!user || !user.socketId) return;
                if (peerConnections[user.socketId]) {
                    try {
                        peerConnections[user.socketId].close();
                    } catch (_) {}
                    delete peerConnections[user.socketId];
                }
                florVoicePeerMeta[user.socketId] = {
                    userId: user.id,
                    username: user.username || '',
                    avatar: user.avatar || ''
                };
                createPeerConnection(user.socketId, false);
            });
        });

        socket.on('voice-roster', (data) => {
            if (!data || !data.roomKey) return;
            florLastVoiceRoster = Array.isArray(data.participants) ? data.participants : [];
            florRememberVoiceSidebarPresence(data.roomKey, data.participants);
            renderVoiceChannelSidebarRoster(data.roomKey, data.participants);
            if (activeVoiceRoomKey === data.roomKey) {
                renderCallVoiceRoster(data.participants);
                clearTimeout(florVoiceRosterRepairTimer);
                florVoiceRosterRepairTimer = setTimeout(() => {
                    florVoiceRosterRepairTimer = null;
                    if (activeVoiceRoomKey !== data.roomKey) return;
                    florVoiceRepairMissingPeers(florLastVoiceRoster);
                }, 450);
            }
        });

        socket.on('user-left-voice', (socketId) => {
            if (inCall && socketId !== socket?.id) {
                florPlayCallSfx('leave');
            }
            delete florVoicePeerMeta[socketId];
            if (peerConnections[socketId]) {
                peerConnections[socketId].close();
                delete peerConnections[socketId];
            }
            const part = document.getElementById(`participant-${socketId}`);
            if (part) part.remove();
        });

        socket.on('user-speaking', (data) => {
            if (!data || !data.socketId) return;
            const el = document.getElementById(`participant-${data.socketId}`);
            el?.classList.toggle('flor-speaking', !!data.speaking);
        });

        socket.on('message-deleted', (data) => {
            if (!data || data.channelId == null || data.messageId == null) return;
            if (
                currentView !== 'server' ||
                currentTextChannelId == null ||
                Number(data.channelId) !== Number(currentTextChannelId)
            ) {
                return;
            }
            removeFlorMessageFromUI(data.messageId, 'channel');
        });

        socket.on('dm-message-deleted', (data) => {
            if (!data || data.messageId == null) return;
            if (currentView !== 'dm') return;
            removeFlorMessageFromUI(data.messageId, 'dm');
        });

        socket.on('offer', async (data) => {
            try {
                let pc = peerConnections[data.from];
                if (
                    pc &&
                    (pc.signalingState === 'closed' ||
                        pc.connectionState === 'closed' ||
                        pc.iceConnectionState === 'closed' ||
                        pc.iceConnectionState === 'failed')
                ) {
                    try {
                        pc.close();
                    } catch (_) {}
                    delete peerConnections[data.from];
                    pc = null;
                }
                if (!peerConnections[data.from]) {
                    createPeerConnection(data.from, false);
                }
                pc = peerConnections[data.from];
                if (!pc) return;
                await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                void florApplyRtcOpusVoiceTuning(pc);
                socket.emit('answer', { to: data.from, answer: answer });
            } catch (e) {
                console.error('WebRTC offer:', e);
            }
        });

        socket.on('answer', async (data) => {
            try {
                const pc = peerConnections[data.from];
                if (pc) {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                    void florApplyRtcOpusVoiceTuning(pc);
                }
            } catch (e) {
                console.error('WebRTC answer:', e);
            }
        });

        socket.on('ice-candidate', async (data) => {
            try {
                const pc = peerConnections[data.from];
                if (pc && data.candidate) {
                    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                }
            } catch (e) {
                florDevLog('ICE candidate:', e);
            }
        });
        
        socket.on('video-toggle', (data) => {
            const participantDiv = document.getElementById(`participant-${data.from}`);
            if (!participantDiv) return;
            const vid = participantDiv.querySelector('.flor-call-tile-video');
            const av = participantDiv.querySelector('.flor-call-tile-avatar');
            if (data.enabled) {
                if (vid) vid.classList.remove('hidden');
                if (av) av.classList.add('hidden');
            } else {
                if (vid) vid.classList.add('hidden');
                if (av) av.classList.remove('hidden');
            }
        });
        socket.on('new-dm', async (data) => {
            const fromId = data.senderId;
            const rawCipher =
                window.florE2ee && data.message && florE2ee.isE2eePayload(data.message.text)
                    ? data.message.text
                    : null;
            let t = data.message.text;
            if (window.florE2ee) {
                t = await florDecryptDmLine(t, fromId);
            }
            const preview = florTruncateDmPreview(florHumanizeDmPreviewLine(t));
            const viewing = currentView === 'dm' && Number(currentDMUserId) === Number(fromId);

            if (viewing) {
                addMessageToUI({
                    id: data.message.id,
                    senderId: data.message.senderId,
                    userId: data.message.senderId,
                    author: data.message.author,
                    avatar: data.message.avatar,
                    text: t,
                    timestamp: data.message.timestamp,
                    read: data.message.read,
                    receiverId: data.message.receiverId ?? currentUser?.id,
                    florPendingCipher: rawCipher
                });
                scrollToBottom();
                if (document.visibilityState === 'visible') {
                    void florMarkDmConversationRead(fromId);
                }
                if (
                    getMessengerSettings().soundInApp === true &&
                    document.visibilityState === 'visible' &&
                    !isDoNotDisturbNow()
                ) {
                    playSoftPing();
                }
            }

            const showUnread = !(viewing && document.visibilityState === 'visible');
            await florPatchDmListRow(fromId, {
                previewText: preview,
                showUnread,
                previewTime: florFormatDmTime(data.message.timestamp),
                unreadCount: showUnread ? 1 : 0
            });

            if (
                getMessengerSettings().desktopNotifications !== false &&
                !isDoNotDisturbNow() &&
                'Notification' in window &&
                Notification.permission === 'granted' &&
                (!viewing || document.hidden)
            ) {
                const author = (data.message && data.message.author) || 'Личные сообщения';
                showNotification(author, preview || 'Новое сообщение', {
                    tag: `flor-dm-${fromId}`,
                    onclickFocus: true
                });
            }
        });

        socket.on('dm-sent', async (data) => {
            const rid = data.receiverId;
            const rawCipher =
                window.florE2ee && data.message && florE2ee.isE2eePayload(data.message.text)
                    ? data.message.text
                    : null;
            let t = data.message.text;
            if (window.florE2ee) {
                t = await florDecryptDmLine(t, rid);
            }
            const preview = florTruncateDmPreview(florHumanizeDmPreviewLine(t));
            const viewing = currentView === 'dm' && Number(currentDMUserId) === Number(rid);

            if (viewing) {
                addMessageToUI({
                    id: data.message.id,
                    senderId: data.senderId != null ? data.senderId : currentUser.id,
                    userId: currentUser.id,
                    author: currentUser.username,
                    avatar: currentUser.avatar,
                    text: t,
                    timestamp: data.message.timestamp,
                    read: data.message.read,
                    receiverId: rid,
                    florPendingCipher: rawCipher
                });
                scrollToBottom();
            }
            await florPatchDmListRow(rid, {
                previewText: preview ? `Вы: ${preview}` : 'Вы: …',
                showUnread: false,
                previewTime: florFormatDmTime(data.message.timestamp)
            });
        });

        socket.on('new-friend-request', () => {
            void loadPendingRequests();
            showNotification('Заявка в друзья', 'Вам пришла новая заявка в друзья.');
            if (document.visibilityState === 'visible') {
                florPlayCallSfx('notify');
            }
        });

        socket.on('incoming-call', (data) => {
            const { from, type } = data;
            if (from) {
                showIncomingCall(from, type);
            }
        });

        socket.on('call-queued', (data) => {
            if (!window.currentCallDetails || !window.currentCallDetails.isInitiator) return;
            const title = document.querySelector('.call-channel-name');
            if (title) title.textContent = 'Ожидание в сети';
            florSetCallVoiceMeta(
                (data && data.message) ||
                    'Собеседник сейчас не в приложении. Когда откроет FLOR — увидит входящий звонок (до 2 мин).'
            );
        });

        socket.on('call-delivered', () => {
            if (!window.currentCallDetails || !window.currentCallDetails.isInitiator) return;
            const el = document.querySelector('.call-channel-name');
            if (el) el.textContent = 'Звонок…';
            florSetCallVoiceMeta('Абонент в сети. Ждём ответа…');
        });

        socket.on('call-accepted', (data) => {
            florDevLog('Call accepted by:', data.from);
            florStopOutgoingRingtone();
            if (window.currentCallDetails && window.currentCallDetails.isInitiator) {
                florPlayCallSfx('join');
            }
            // When call is accepted, create peer connection
            document.querySelector('.call-channel-name').textContent = `Связь с ${data.from.username}`;
            florSetCallVoiceMeta('Соединение установлено');
            if (data.from?.socketId) {
                florVoicePeerMeta[data.from.socketId] = {
                    userId: data.from.id,
                    username: data.from.username,
                    avatar: data.from.avatar
                };
            }

            // Create peer connection as initiator
            if (!peerConnections[data.from.socketId]) {
                createPeerConnection(data.from.socketId, true);
            }
        });

        socket.on('call-rejected', (data) => {
            florStopIncomingRingtone();
            florStopOutgoingRingtone();
            alert((data && data.message) || 'Звонок отклонён или недоступен');
            const wasDirectInitiator = !!(
                window.currentCallDetails && window.currentCallDetails.isInitiator
            );
            const rk = activeVoiceRoomKey;
            const callInterface = document.getElementById('callInterface');
            callInterface.classList.add('hidden');
            if (wasDirectInitiator) {
                Object.keys(peerConnections).forEach((id) => {
                    try {
                        peerConnections[id].close();
                    } catch (_) {}
                    delete peerConnections[id];
                });
                if (socket && socket.connected && rk) {
                    socket.emit('leave-voice-channel', rk);
                }
                activeVoiceRoomKey = null;
                activeVoiceChannelName = null;
                document.querySelectorAll('.voice-channel').forEach((ch) => ch.classList.remove('in-call'));
                if (rk && currentServerId) {
                    const cid = parseInt(String(rk).split(':')[1], 10);
                    if (Number.isFinite(cid)) {
                        renderVoiceChannelSidebarRoster(rk, []);
                    }
                }
            }
            if (localStream) {
                localStream.getTracks().forEach((track) => track.stop());
                localStream = null;
            }
            inCall = false;
            window.currentCallDetails = null;
            florRemoteJoinSfxDone.clear();
            florSyncDmVideoCallLayout();
        });

        socket.on('dm-read-receipt', (data) => {
            if (!data || !Array.isArray(data.messageIds)) return;
            florUpdateDmReadReceiptsInUI(data.messageIds);
        });
        
        socket.on('call-ended', (data) => {
            florStopOutgoingRingtone();
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
    florUpdateMobileTabHighlight();
}

async function loadFriends() {
    try {
        const response = await fetch(florApi('/api/friends'), {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const friends = await response.json();
        displayFriends(friends);
        await florRefreshUserKeyCache();
        await populateDMList(friends);
        florPopulateDmStoriesStrip(friends);
        void florRefreshFriendRequestBadge();
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

    const av = document.createElement('div');
    av.className = 'friend-avatar flor-click-profile';
    florFillAvatarEl(av, friend.avatar, friend.username);
    av.addEventListener('click', () => openFlorUserProfile(friend.id));

    const info = document.createElement('div');
    info.className = 'friend-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'friend-name flor-click-profile';
    nameEl.textContent = friend.username;
    nameEl.addEventListener('click', () => openFlorUserProfile(friend.id));
    const st = document.createElement('div');
    st.className = 'friend-status' + (friend.status === 'Online' ? '' : ' offline');
    st.textContent = friendStatusLabel(friend.status);
    info.appendChild(nameEl);
    info.appendChild(st);

    const actions = document.createElement('div');
    actions.className = 'friend-actions';
    const bMsg = document.createElement('button');
    bMsg.type = 'button';
    bMsg.className = 'friend-action-btn message';
    bMsg.title = 'Написать';
    bMsg.textContent = '💬';
    bMsg.addEventListener('click', () => startDM(friend.id, friend.username, friend.avatar));
    const bAu = document.createElement('button');
    bAu.type = 'button';
    bAu.className = 'friend-action-btn audio-call';
    bAu.title = 'Аудиозвонок';
    bAu.textContent = '📞';
    bAu.addEventListener('click', () => initiateCall(friend.id, 'audio'));
    const bVi = document.createElement('button');
    bVi.type = 'button';
    bVi.className = 'friend-action-btn video-call';
    bVi.title = 'Видеозвонок';
    bVi.textContent = '📹';
    bVi.addEventListener('click', () => initiateCall(friend.id, 'video'));
    const bRm = document.createElement('button');
    bRm.type = 'button';
    bRm.className = 'friend-action-btn remove';
    bRm.title = 'Удалить из друзей';
    bRm.textContent = '🗑️';
    bRm.addEventListener('click', () => removeFriend(friend.id));
    actions.appendChild(bMsg);
    actions.appendChild(bAu);
    actions.appendChild(bVi);
    actions.appendChild(bRm);

    div.appendChild(av);
    div.appendChild(info);
    div.appendChild(actions);

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
    
    users.forEach((user) => {
        const div = document.createElement('div');
        div.className = 'user-search-item';

        const av = document.createElement('div');
        av.className = 'user-avatar flor-click-profile';
        florFillAvatarEl(av, user.avatar, user.username);
        av.addEventListener('click', () => openFlorUserProfile(user.id));

        const info = document.createElement('div');
        info.className = 'user-info';
        const nm = document.createElement('div');
        nm.className = 'user-name flor-click-profile';
        nm.textContent = user.username;
        nm.addEventListener('click', () => openFlorUserProfile(user.id));
        info.appendChild(nm);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'add-friend-btn';
        btn.textContent = 'В друзья';
        btn.addEventListener('click', () => sendFriendRequest(user.id));

        div.appendChild(av);
        div.appendChild(info);
        div.appendChild(btn);
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

function florSyncPendingRequestsTabDot(n) {
    const tab = document.querySelector('.friends-tab[data-tab="pending"]');
    const dot = tab?.querySelector('.friends-tab-pending-dot');
    if (!tab || !dot) return;
    const num = Number(n) || 0;
    if (num > 0) {
        dot.hidden = false;
        dot.setAttribute('aria-hidden', 'false');
        tab.classList.add('friends-tab--has-pending');
        tab.title = `Входящие заявки: ${num}`;
    } else {
        dot.hidden = true;
        dot.setAttribute('aria-hidden', 'true');
        tab.classList.remove('friends-tab--has-pending');
        tab.removeAttribute('title');
    }
}

function florSyncNotifBadgeFromCount(n) {
    const badges = document.querySelectorAll('.flor-notif-badge');
    const num = Number(n) || 0;
    const label = num > 99 ? '99+' : String(num);
    badges.forEach((badge) => {
        if (num > 0) {
            badge.hidden = false;
            badge.setAttribute('aria-hidden', 'false');
            badge.textContent = label;
        } else {
            badge.hidden = true;
            badge.setAttribute('aria-hidden', 'true');
            badge.textContent = '';
        }
    });
    florSyncPendingRequestsTabDot(num);
}

async function florRefreshFriendRequestBadge() {
    try {
        const response = await fetch(florApi('/api/friends/pending'), {
            headers: { Authorization: `Bearer ${token}` }
        });
        const requests = await response.json();
        florSyncNotifBadgeFromCount(Array.isArray(requests) ? requests.length : 0);
    } catch (e) {
        /* ignore */
    }
}

function initializeNotificationButtons() {
    const openPending = () => {
        showFriendsView();
        switchFriendsTab('pending');
        window.florCloseMobileSidebar?.();
    };
    document.getElementById('florDesktopNotifBtn')?.addEventListener('click', openPending);
}

async function loadPendingRequests() {
    try {
        const response = await fetch(florApi('/api/friends/pending'), {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const requests = await response.json();

        florSyncNotifBadgeFromCount(Array.isArray(requests) ? requests.length : 0);

        const pendingList = document.getElementById('friendsPending');
        pendingList.innerHTML = '';
        
        if (requests.length === 0) {
            pendingList.innerHTML = '<div class="friends-empty">Нет входящих заявок</div>';
            return;
        }
        
        requests.forEach((request) => {
            const div = document.createElement('div');
            div.className = 'friend-item';

            const av = document.createElement('div');
            av.className = 'friend-avatar';
            florFillAvatarEl(av, request.avatar, request.username);

            const info = document.createElement('div');
            info.className = 'friend-info';
            const nameEl = document.createElement('div');
            nameEl.className = 'friend-name';
            nameEl.textContent = request.username || '';
            const st = document.createElement('div');
            st.className = 'friend-status';
            st.textContent = 'Входящая заявка в друзья';
            info.appendChild(nameEl);
            info.appendChild(st);

            const actions = document.createElement('div');
            actions.className = 'friend-actions';
            const acc = document.createElement('button');
            acc.type = 'button';
            acc.className = 'friend-action-btn accept';
            acc.textContent = '✓';
            acc.addEventListener('click', () => acceptFriendRequest(request.id));
            const rej = document.createElement('button');
            rej.type = 'button';
            rej.className = 'friend-action-btn reject';
            rej.textContent = '✕';
            rej.addEventListener('click', () => rejectFriendRequest(request.id));
            actions.appendChild(acc);
            actions.appendChild(rej);

            div.appendChild(av);
            div.appendChild(info);
            div.appendChild(actions);
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

/** ЛС-звонок: не оставлять поток голосовой комнаты и использовать те же настройки микрофона, что и в войсе (с запасным вариантом без deviceId). */
async function florAcquireMediaForDirectCall(type) {
    if (activeVoiceRoomKey) {
        leaveVoiceChannel(true, { silent: true });
    } else if (localStream) {
        try {
            localStream.getTracks().forEach((t) => t.stop());
        } catch (_) {}
        localStream = null;
    }

    const isVideo = type === 'video';
    try {
        await initializeMedia({ voice: !isVideo });
    } catch (e) {
        console.warn('florAcquireMediaForDirectCall fallback', e);
        const constraints = isVideo
            ? { audio: true, video: florVideoCaptureConstraints() }
            : { audio: true, video: false };
        localStream = await florGetUserMediaReliable(constraints);
        const localVideo = document.getElementById('localVideo');
        if (localVideo) localVideo.srcObject = localStream;
    }

    if (isVideo && localStream) {
        localStream.getVideoTracks().forEach((t) => {
            t.enabled = false;
        });
    }
    if (localStream) {
        const muted = isMuted || isDeafened;
        localStream.getAudioTracks().forEach((t) => {
            t.enabled = !muted;
        });
    }
}

// Initiate call function
async function initiateCall(friendId, type) {
    try {
        await florAcquireMediaForDirectCall(type);

        // Show call interface
        const callInterface = document.getElementById('callInterface');
        callInterface.classList.remove('hidden');
        florUpdateCallFullscreenButton();
        
        // Update call header
        document.querySelector('.call-channel-name').textContent = 'Вызов…';
        florSetCallVoiceMeta('Отправляем запрос…');

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
                to: Number(friendId),
                type: type,
                from: {
                    id: currentUser.id,
                    username: currentUser.username,
                    socketId: socket.id
                }
            });
        }
        
        inCall = true;
        isVideoEnabled = false;
        isAudioEnabled = !(isMuted || isDeafened);
        activeVoiceRoomKey = null;
        updateCallButtons();
        updateLocalCallParticipantUI();
        florStartOutgoingRingtone();
        florSyncDmVideoCallLayout();
        requestAnimationFrame(() => void florEnterCallFullscreenForMobileVideo());
        
    } catch (error) {
        console.error('Error initiating call:', error);
        florStopOutgoingRingtone();
        alert(florMediaAccessHint());
        window.currentCallDetails = null;
        florSyncDmVideoCallLayout();
    }
}

// Show incoming call notification
function showIncomingCall(caller, type) {
    florNotifyIncomingCall(caller, type);
    const incomingCallDiv = document.getElementById('incomingCall');
    const callerName = incomingCallDiv.querySelector('.caller-name');
    const callerAvatar = incomingCallDiv.querySelector('.caller-avatar');
    
    callerName.textContent = caller.username || 'Неизвестный';
    florFillAvatarEl(callerAvatar, caller.avatar, caller.username || 'U');
    
    incomingCallDiv.classList.remove('hidden');
    florStartIncomingRingtone();
    
    // Set up accept/reject handlers
    const acceptBtn = document.getElementById('acceptCallBtn');
    const rejectBtn = document.getElementById('rejectCallBtn');
    
    acceptBtn.onclick = async () => {
        florStopIncomingRingtone();
        incomingCallDiv.classList.add('hidden');
        await acceptCall(caller, type);
    };
    
    rejectBtn.onclick = () => {
        florStopIncomingRingtone();
        incomingCallDiv.classList.add('hidden');
        rejectCall(caller);
    };
    
    // Auto-reject after 30 seconds
    setTimeout(() => {
        if (!incomingCallDiv.classList.contains('hidden')) {
            florStopIncomingRingtone();
            incomingCallDiv.classList.add('hidden');
            rejectCall(caller);
        }
    }, 30000);
}

// Accept incoming call
async function acceptCall(caller, type) {
    try {
        florStopIncomingRingtone();
        await florAcquireMediaForDirectCall(type);

        // Show call interface
        const callInterface = document.getElementById('callInterface');
        callInterface.classList.remove('hidden');
        florUpdateCallFullscreenButton();
        
        document.querySelector('.call-channel-name').textContent = `Звонок с ${caller.username}`;
        florSetCallVoiceMeta('Подключение…');

        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = localStream;

        // Store call details
        window.currentCallDetails = {
            peerId: caller.socketId,
            type: type,
            isInitiator: false,
            originalType: type
        };
        florVoicePeerMeta[caller.socketId] = {
            userId: caller.id,
            username: caller.username,
            avatar: caller.avatar
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
        isVideoEnabled = false;
        isAudioEnabled = !(isMuted || isDeafened);
        activeVoiceRoomKey = null;
        updateCallButtons();
        updateLocalCallParticipantUI();
        
        // Create peer connection as receiver (not initiator)
        if (!peerConnections[caller.socketId]) {
            createPeerConnection(caller.socketId, false);
        }
        florSyncDmVideoCallLayout();
        requestAnimationFrame(() => void florEnterCallFullscreenForMobileVideo());
        
    } catch (error) {
        console.error('Error accepting call:', error);
        alert(florMediaAccessHint());
        window.currentCallDetails = null;
        florSyncDmVideoCallLayout();
    }
}

// Reject incoming call
function rejectCall(caller) {
    florStopIncomingRingtone();
    if (socket && socket.connected) {
        socket.emit('reject-call', { to: caller.socketId });
    }
}

window.startDM = async function(friendId, friendUsername, friendAvatar) {
    currentView = 'dm';
    currentDMUserId = friendId;
    currentServerId = null;
    currentTextChannelId = null;

    document.getElementById('friendsView').style.display = 'none';
    document.getElementById('chatView').style.display = 'flex';
    document.getElementById('channelsView').style.display = 'none';
    document.getElementById('dmListView').style.display = 'block';

    const membersBtn = document.getElementById('membersBtn');
    if (membersBtn) membersBtn.hidden = true;

    const chatHeaderInfo = document.getElementById('chatHeaderInfo');
    chatHeaderInfo.textContent = '';
    chatHeaderInfo.classList.add('channel-info--dm');

    const headAv = document.createElement('div');
    headAv.className = 'friend-avatar flor-chat-header-avatar flor-click-profile';
    headAv.setAttribute('role', 'button');
    headAv.setAttribute('tabindex', '0');
    headAv.setAttribute('aria-label', `Профиль: ${friendUsername}`);
    florFillAvatarEl(headAv, friendAvatar, friendUsername);
    const openPeerProfile = (e) => {
        if (e) e.stopPropagation();
        openFlorUserProfile(friendId);
    };
    headAv.addEventListener('click', openPeerProfile);
    headAv.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPeerProfile();
        }
    });

    const headName = document.createElement('span');
    headName.className = 'channel-name';
    headName.textContent = friendUsername;

    chatHeaderInfo.appendChild(headAv);
    chatHeaderInfo.appendChild(headName);

    document.getElementById('messageInput').placeholder = `Сообщение для @${friendUsername}`;

    await florRefreshPeerKeysBeforeDmEncrypt();
    await loadDMHistory(friendId);
    syncServerHeaderMenuVisibility();
    florSyncDmChatHeaderControls();
    florUpdateMobileTabHighlight();
    florSetChannelListMode('dm');
    florSyncMobileChatChrome();
};

// Show friends view
function showFriendsView() {
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
    florSyncDmChatHeaderControls();
    florUpdateMobileTabHighlight();
    florSetChannelListMode('dm');
    florSyncMobileChatChrome();
}

// Show server view
async function showServerView(server) {
    if (activeVoiceRoomKey) {
        const curSid = parseInt(String(activeVoiceRoomKey).split(':')[0], 10);
        if (Number.isFinite(curSid) && curSid !== Number(server.id)) {
            leaveVoiceChannel(true);
        }
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
    florSyncDmChatHeaderControls();
    florUpdateMobileTabHighlight();
    florSetChannelListMode('server');
    florSyncMobileChatChrome();
}

function syncServerHeaderMenuVisibility() {
    const btn = document.getElementById('serverHeaderMenuBtn');
    const drop = document.getElementById('serverHeaderDropdown');
    if (btn) {
        if (currentView !== 'server') {
            btn.style.visibility = 'hidden';
            if (drop) drop.classList.add('hidden');
        } else {
            btn.style.visibility = 'visible';
        }
    }
    const exportBtn = document.getElementById('exportChatBtn');
    if (exportBtn) {
        const hideExport = currentView !== 'server';
        exportBtn.hidden = hideExport;
        exportBtn.style.display = hideExport ? 'none' : '';
    }
}

function florChatViewSetDmMode(isDm) {
    const cv = document.getElementById('chatView');
    if (cv) cv.classList.toggle('flor-chat-view--dm', Boolean(isDm));
}

function florSyncDmChatHeaderControls() {
    const voiceBtn = document.getElementById('dmCallVoiceBtn');
    const videoBtn = document.getElementById('dmCallVideoBtn');
    const isDm = currentView === 'dm' && currentDMUserId != null;
    if (voiceBtn) voiceBtn.hidden = !isDm;
    if (videoBtn) videoBtn.hidden = !isDm;
    const info = document.getElementById('chatHeaderInfo');
    if (info) {
        info.classList.toggle('channel-info--dm', isDm);
    }
    florChatViewSetDmMode(isDm);
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

function florIsMobileTabbarLayout() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
}

/** В мобильной вёрстке: в открытом чате скрываем нижний таббар и компактим шапку (класс на body). */
function florSyncMobileChatChrome() {
    const cv = document.getElementById('chatView');
    const chatOpen = !!(cv && cv.style.display !== 'none');
    const hideTabbar = florIsMobileTabbarLayout() && chatOpen;
    document.body.classList.toggle('flor-mobile-chat-active', hideTabbar);
    const tabbar = document.getElementById('florMobileTabbar');
    if (tabbar) {
        tabbar.setAttribute('aria-hidden', hideTabbar ? 'true' : 'false');
    }
}

/** Подсветка вкладок нижней панели (только мобильная вёрстка, UI-kit). */
function florUpdateMobileTabHighlight() {
    if (!florIsMobileTabbarLayout()) return;
    const tChats = document.getElementById('florTabChats');
    const tFriends = document.getElementById('florTabFriends');
    const tDiscover = document.getElementById('florTabDiscover');
    const tSettings = document.getElementById('florTabSettings');
    [tChats, tFriends, tDiscover, tSettings].forEach((el) => el?.classList.remove('flor-mobile-tab--active'));
    const sidebarOpen = document.body.classList.contains('flor-mobile-sidebar-open');
    const activeFriendsTab = document.querySelector('.friends-tab.active')?.getAttribute('data-tab');
    if (currentView === 'friends' && !sidebarOpen && activeFriendsTab === 'add' && tDiscover) {
        tDiscover.classList.add('flor-mobile-tab--active');
    } else if (currentView === 'friends' && !sidebarOpen && tFriends) {
        tFriends.classList.add('flor-mobile-tab--active');
    } else if (tChats) {
        tChats.classList.add('flor-mobile-tab--active');
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
        florUpdateMobileTabHighlight();
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
        florSyncMobileChatChrome();
    };
    mq?.addEventListener('change', onLayoutChange);
    window.addEventListener('orientationchange', () => setTimeout(onLayoutChange, 280));

    window.florOpenMobileSidebar = () => {
        if (isMobileNavLayout()) setMobileSidebarOpen(true);
    };
    window.florCloseMobileSidebar = () => setMobileSidebarOpen(false);
}

function initializeMobileTabbar() {
    document.getElementById('florDmHeroMenuBtn')?.addEventListener('click', () => {
        window.florOpenMobileSidebar?.();
    });
    document.getElementById('florDmHeroMeBtn')?.addEventListener('click', () => {
        if (currentUser && currentUser.id != null) {
            openFlorUserProfile(currentUser.id);
        }
    });
    document.getElementById('florTabChats')?.addEventListener('click', () => {
        window.florOpenMobileSidebar?.();
    });
    document.getElementById('florTabFriends')?.addEventListener('click', () => {
        showFriendsView();
        window.florCloseMobileSidebar?.();
    });
    document.getElementById('florTabCompose')?.addEventListener('click', () => {
        window.florCloseMobileSidebar?.();
        document.getElementById('addServerBtn')?.click();
    });
    document.getElementById('florTabDiscover')?.addEventListener('click', () => {
        showFriendsView();
        switchFriendsTab('add');
        window.florCloseMobileSidebar?.();
    });
    document.getElementById('florTabSettings')?.addEventListener('click', () => {
        window.florCloseMobileSidebar?.();
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
        const chatOpen = chatEl && (getComputedStyle(chatEl).display === 'flex' || getComputedStyle(chatEl).display === 'block');
        const friendsOpen =
            friendsEl &&
            (getComputedStyle(friendsEl).display === 'flex' || getComputedStyle(friendsEl).display === 'block');

        if (chatOpen) {
            if (currentView === 'dm') {
                showFriendsView();
                switchFriendsTab('online');
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
    serverIcon.title = server.name;
    serverIcon.setAttribute('data-server-id', String(server.id));
    florRenderServerIcon(serverIcon, server);
    
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
    florSyncDmChatHeaderControls();
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
                const raw = message.content;
                const pending = florE2ee.isE2eePayload(raw) ? raw : null;
                const text = await florDecryptChannelMessage(channelId, raw);
                addMessageToUI({
                    id: message.id,
                    userId: message.user_id,
                    author: message.username,
                    avatar: message.avatar || message.username.charAt(0).toUpperCase(),
                    text,
                    timestamp: message.created_at,
                    reactions: message.reactions,
                    channelId,
                    florPendingCipher: pending
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
                    timestamp: message.created_at,
                    reactions: message.reactions
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
                const raw = message.content;
                const pending =
                    window.florE2ee && currentServerRecord && florE2ee.isE2eePayload(raw) ? raw : null;
                const text =
                    window.florE2ee && currentServerRecord
                        ? await florDecryptChannelMessage(channelId, raw)
                        : raw;
                addMessageToUI({
                    id: message.id,
                    userId: message.user_id,
                    author: message.username,
                    avatar: message.avatar || message.username.charAt(0).toUpperCase(),
                    text,
                    timestamp: message.created_at,
                    reactions: message.reactions,
                    channelId,
                    florPendingCipher: pending
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
    florSyncGlobalChatSearchFromHeader();
    void florRetryPendingE2eeDecrypt();
}

function initializeMessageInput() {
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('messageSendBtn');

    document.getElementById('messagesContainer')?.addEventListener(
        'scroll',
        () => {
            closeAllOpenMessageMenus();
        },
        { passive: true }
    );
    window.addEventListener('resize', () => closeAllOpenMessageMenus());

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
                await florRefreshPeerKeysBeforeDmEncrypt();
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
            const msgKey = m && m.id != null ? florMessageReactionKey('channel', m.id) : null;
            if (
                m &&
                m.id != null &&
                box &&
                !box.querySelector(`[data-flor-msg-key="${florEscapeSelector(msgKey)}"]`)
            ) {
                addMessageToUI({ ...m, userId: m.senderId != null ? m.senderId : m.userId });
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

function florDmReadIsSeen(val) {
    return val === true || val === 1 || val === '1';
}

async function florMarkDmConversationRead(partnerId) {
    if (partnerId == null || !token) return;
    const pid = Number(partnerId);
    if (!Number.isFinite(pid)) return;
    try {
        const res = await fetch(florApi('/api/dm/read'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ partnerId: pid }),
            credentials: 'same-origin'
        });
        if (res.ok) {
            florSetDmRowUnread(pid, false);
        }
    } catch (_) {}
}

function florFormatDmTime(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        if (Number.isNaN(+d)) return '';
        const now = new Date();
        if (d.toDateString() === now.toDateString()) {
            return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    } catch (_) {
        return '';
    }
}

function florSetChannelListMode(mode) {
    const el = document.getElementById('channelList');
    if (!el) return;
    el.classList.toggle('flor-channel-list--dm', mode === 'dm');
    el.classList.toggle('flor-channel-list--server', mode === 'server');
}

function florSetDmRowUnread(peerId, show, unreadCount) {
    const row = document.querySelector(`#dmList .flor-dm-row[data-dm-id="${Number(peerId)}"]`);
    if (!row) return;
    const dot = row.querySelector('.flor-dm-row__unread');
    if (!dot) return;
    dot.hidden = !show;
    dot.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) {
        dot.classList.add('flor-dm-row__unread--badge');
        const n = unreadCount != null ? Number(unreadCount) : 0;
        dot.textContent = n > 99 ? '99+' : n > 1 ? String(n) : '1';
    } else {
        dot.classList.remove('flor-dm-row__unread--badge');
        dot.textContent = '';
    }
}

function florTruncateDmPreview(text, maxLen = 80) {
    const t = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!t) return '';
    return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

function florHumanizeDmPreviewLine(text) {
    const lines = String(text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    if (lines.length === 0) return '';
    const first = lines[0];
    if (FLOR_VOICE_MESSAGE_RE.test(first)) return 'Голосовое сообщение';
    if (FLOR_FILE_MESSAGE_RE.test(first)) return 'Файл';
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function florDmPreviewPlaintext(peerId, rawContent) {
    if (rawContent == null || rawContent === '') return '';
    try {
        if (window.florE2ee) {
            return await florDecryptDmLine(rawContent, peerId);
        }
        return String(rawContent);
    } catch (_) {
        return '';
    }
}

function florDmUnreadFromMessages(messages, peerId, myId) {
    const pid = Number(peerId);
    const mid = Number(myId);
    if (!Number.isFinite(pid) || !Number.isFinite(mid)) return 0;
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    let n = 0;
    for (const m of messages) {
        if (Number(m.sender_id) === pid && Number(m.receiver_id) === mid && !Number(m.read)) {
            n++;
        }
    }
    return n;
}

async function florFetchDmInboxMap() {
    const inboxByPeer = new Map();
    try {
        const inboxRes = await fetch(florApi('/api/dm/inbox'), {
            headers: { Authorization: `Bearer ${token}` },
            credentials: 'same-origin'
        });
        if (inboxRes.ok) {
            const inboxData = await inboxRes.json();
            for (const c of inboxData.conversations || []) {
                const pid = Number(c.peerId ?? c.peer_id);
                if (!Number.isFinite(pid)) continue;
                inboxByPeer.set(pid, c);
            }
        }
    } catch (_) {}
    return inboxByPeer;
}

async function florDmSummaryFromPeerFallback(peerId) {
    const pid = Number(peerId);
    if (!Number.isFinite(pid) || !currentUser || currentUser.id == null) return null;
    try {
        const r = await fetch(florApi(`/api/dm/${pid}`), {
            headers: { Authorization: `Bearer ${token}` },
            credentials: 'same-origin'
        });
        if (!r.ok) return null;
        const messages = await r.json();
        if (!Array.isArray(messages) || messages.length === 0) return null;
        const last = messages[messages.length - 1];
        const unreadCount = florDmUnreadFromMessages(messages, pid, currentUser.id);
        return {
            peerId: pid,
            unreadCount,
            lastMessage: {
                id: last.id,
                content: last.content,
                sender_id: last.sender_id,
                receiver_id: last.receiver_id,
                created_at: last.created_at
            }
        };
    } catch (_) {
        return null;
    }
}

async function florPatchDmListRow(peerId, opts) {
    const row = document.querySelector(`#dmList .flor-dm-row[data-dm-id="${Number(peerId)}"]`);
    if (!row) return;
    const prevEl = row.querySelector('.flor-dm-row__preview');
    const timeEl = row.querySelector('.flor-dm-row__time');
    const dot = row.querySelector('.flor-dm-row__unread');
    if (opts.previewText != null && prevEl) {
        prevEl.textContent = opts.previewText;
    }
    if (opts.previewTime != null && timeEl) {
        timeEl.textContent = opts.previewTime;
    }
    if (opts.showUnread != null && dot) {
        dot.hidden = !opts.showUnread;
        dot.setAttribute('aria-hidden', opts.showUnread ? 'false' : 'true');
        if (opts.showUnread) {
            dot.classList.add('flor-dm-row__unread--badge');
            const n = opts.unreadCount != null ? Number(opts.unreadCount) : 1;
            dot.textContent = n > 99 ? '99+' : String(Math.max(1, n));
        } else {
            dot.classList.remove('flor-dm-row__unread--badge');
            dot.textContent = '';
        }
    }
}

function florSyncGlobalChatSearchFromHeader() {
    const g = document.getElementById('florGlobalSearchInput');
    const ch = document.getElementById('chatMessageSearch');
    if (g && ch && window.matchMedia('(min-width: 769px)').matches) {
        g.value = ch.value;
    }
}

function florUpdateDmReadReceiptsInUI(messageIds) {
    if (!Array.isArray(messageIds)) return;
    const box = document.getElementById('messagesContainer');
    if (!box) return;
    messageIds.forEach((id) => {
        const row = box.querySelector(`[data-message-id="${String(id)}"]`);
        if (!row) return;
        const el = row.querySelector('.message-dm-read');
        if (!el) return;
        el.textContent = '✓✓';
        el.classList.add('message-dm-read--seen');
        el.setAttribute('aria-label', 'Прочитано');
        el.title = 'Прочитано';
    });
}

function florRenderMessageReactions(container, messageId, reactions, msgCtx) {
    if (!container) return;
    container.innerHTML = '';
    (reactions || []).forEach((reaction) => {
        const reactionEl = document.createElement('div');
        reactionEl.className = 'reaction';
        reactionEl.innerHTML = `${reaction.emoji} <span>${reaction.count}</span>`;
        reactionEl.title = reaction.users || '';
        reactionEl.addEventListener('click', () => {
            if (socket && socket.connected) {
                socket.emit('remove-reaction', { messageId, emoji: reaction.emoji });
            }
        });
        container.appendChild(reactionEl);
    });
}

function addMessageToUI(message) {
    const messagesContainer = document.getElementById('messagesContainer');
    if (!messagesContainer) return;
    const msgCtx = currentView === 'dm' ? 'dm' : 'channel';
    const mid = message && message.id;
    const florKey = mid != null ? florMessageReactionKey(msgCtx, mid) : null;
    if (florKey && messagesContainer.querySelector(`[data-flor-msg-key="${florEscapeSelector(florKey)}"]`)) {
        return;
    }

    const own = florMessageIsOwn(message);
    const numericId = mid != null ? mid : Date.now();

    const messageGroup = document.createElement('div');
    messageGroup.className = 'message-group' + (own ? ' message-group--own' : '');
    messageGroup.setAttribute('data-message-id', String(numericId));
    messageGroup.setAttribute('data-flor-msg-key', florKey || `${msgCtx}:t${numericId}`);

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    florFillAvatarEl(avatar, message.avatar, message.author);

    const content = document.createElement('div');
    content.className = 'message-content';

    const header = document.createElement('div');
    header.className = 'message-header';

    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = message.author;
    const uid =
        message.userId != null
            ? Number(message.userId)
            : message.senderId != null
              ? Number(message.senderId)
              : null;
    if (!own && uid && currentUser && Number(uid) !== Number(currentUser.id)) {
        author.classList.add('message-author--clickable');
        author.title = 'Профиль';
        author.addEventListener('click', () => openFlorUserProfile(uid));
    }

    const timestamp = document.createElement('span');
    timestamp.className = 'message-timestamp';
    timestamp.textContent = formatTimestamp(message.timestamp);

    const ctx = bookmarkContextKey();
    const bid = message.id || Date.now();

    const moreWrap = document.createElement('div');
    moreWrap.className = 'message-more-wrap';
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'message-more-btn';
    moreBtn.setAttribute('aria-label', 'Меню сообщения');
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.innerHTML =
        '<svg class="message-more-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>';

    const menu = document.createElement('div');
    menu.className = 'message-more-menu hidden';
    menu.addEventListener('click', (e) => e.stopPropagation());

    const reactionsContainer = document.createElement('div');
    reactionsContainer.className = 'message-reactions message-reactions--menu';
    if (message.reactions && message.reactions.length) {
        florRenderMessageReactions(reactionsContainer, numericId, message.reactions, msgCtx);
    }

    const addReactBtn = document.createElement('button');
    addReactBtn.type = 'button';
    addReactBtn.className = 'message-menu-item';
    addReactBtn.textContent = 'Добавить реакцию';
    addReactBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.add('hidden');
        moreBtn.setAttribute('aria-expanded', 'false');
        showEmojiPickerForMessage(numericId);
    });

    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.type = 'button';
    bookmarkBtn.className = 'message-menu-item';
    const syncBmLabel = () => {
        const isBm = getBookmarks().some((x) => x.id === bid && x.context === ctx);
        bookmarkBtn.textContent = isBm ? 'Убрать из закладок' : 'В закладки';
    };
    syncBmLabel();
    bookmarkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBookmarkEntry({
            id: bid,
            context: ctx,
            author: message.author,
            text: message.text,
            ts: message.timestamp
        });
        syncBmLabel();
    });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'message-menu-item';
    copyBtn.textContent = 'Копировать текст';
    copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        menu.classList.add('hidden');
        moreBtn.setAttribute('aria-expanded', 'false');
        try {
            await navigator.clipboard.writeText(String(message.text || ''));
        } catch (_) {}
    });

    menu.appendChild(reactionsContainer);
    menu.appendChild(addReactBtn);
    menu.appendChild(bookmarkBtn);
    menu.appendChild(copyBtn);

    if (own && mid != null && Number.isFinite(Number(mid))) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'message-menu-item message-menu-item--danger';
        delBtn.textContent = 'Удалить сообщение';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            menu.classList.add('hidden');
            moreBtn.setAttribute('aria-expanded', 'false');
            if (!confirm('Удалить это сообщение?')) return;
            try {
                const path =
                    msgCtx === 'dm'
                        ? `/api/dm-messages/${encodeURIComponent(mid)}`
                        : `/api/messages/${encodeURIComponent(mid)}`;
                const r = await fetch(florApi(path), {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${token}` }
                });
                const text = await r.text();
                let d = {};
                try {
                    d = text ? JSON.parse(text) : {};
                } catch (_) {
                    d = {};
                }
                if (!r.ok) throw new Error(d.error || 'Не удалось удалить');
                removeFlorMessageFromUI(mid, msgCtx);
            } catch (err) {
                alert(err.message || 'Ошибка удаления');
            }
        });
        menu.appendChild(delBtn);
    }
    moreWrap.appendChild(moreBtn);
    moreWrap.appendChild(menu);

    moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = menu.classList.contains('hidden');
        closeAllOpenMessageMenus();
        if (willOpen) {
            menu.classList.remove('hidden');
            moreBtn.setAttribute('aria-expanded', 'true');
            if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches) {
                florPositionMessageMenuFixed(menu, moreBtn);
            } else {
                florResetMessageMenuPosition(menu);
            }
        } else {
            menu.classList.add('hidden');
            moreBtn.setAttribute('aria-expanded', 'false');
            florResetMessageMenuPosition(menu);
        }
    });

    const text = document.createElement('div');
    text.className = 'message-text';
    if (florMessageIsAttachmentOnlyText(message.text)) {
        text.classList.add('message-text--attachment-only');
    }
    text.appendChild(florMessageTextToFragment(message.text));

    if (!own) {
        header.appendChild(author);
    }
    header.appendChild(timestamp);
    if (msgCtx === 'dm' && own) {
        const readEl = document.createElement('span');
        const seen = florDmReadIsSeen(message.read);
        readEl.className = 'message-dm-read' + (seen ? ' message-dm-read--seen' : '');
        readEl.textContent = seen ? '✓✓' : '✓';
        readEl.setAttribute('aria-label', seen ? 'Прочитано' : 'Доставлено');
        readEl.title = seen ? 'Прочитано' : 'Доставлено';
        header.appendChild(readEl);
    }
    header.appendChild(moreWrap);
    content.appendChild(header);
    content.appendChild(text);

    if (own) {
        messageGroup.appendChild(content);
        messageGroup.appendChild(avatar);
    } else {
        messageGroup.appendChild(avatar);
        messageGroup.appendChild(content);
    }

    florRegisterE2eeRetryIfFailed(message, msgCtx, numericId);
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
    closeAllOpenMessageMenus();
    const emojis = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
    const picker = createEmojiPicker(emojis, (emoji) => {
        addReaction(messageId, emoji);
    });
    document.body.appendChild(picker);
}

function createEmojiPicker(emojis, onSelect) {
    const picker = document.createElement('div');
    picker.className = 'emoji-picker';

    emojis.forEach((emoji) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'emoji-option';
        btn.textContent = emoji;
        const pick = () => {
            onSelect(emoji);
            picker.remove();
            document.removeEventListener('click', closePickerAnywhere);
            document.removeEventListener('touchend', closePickerTouch, true);
        };
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            pick();
        });
        picker.appendChild(btn);
    });

    function closePickerAnywhere(e) {
        if (!picker.contains(e.target)) {
            picker.remove();
            document.removeEventListener('click', closePickerAnywhere);
            document.removeEventListener('touchend', closePickerTouch, true);
        }
    }
    function closePickerTouch(e) {
        if (!picker.contains(e.target)) {
            picker.remove();
            document.removeEventListener('click', closePickerAnywhere);
            document.removeEventListener('touchend', closePickerTouch, true);
        }
    }

    setTimeout(() => {
        document.addEventListener('click', closePickerAnywhere);
        document.addEventListener('touchend', closePickerTouch, true);
    }, 120);

    return picker;
}

function addReaction(messageId, emoji) {
    if (socket && socket.connected) {
        socket.emit('add-reaction', { messageId, emoji });
    }
}

function updateMessageReactions(messageId, reactions, context) {
    const ctx = context || (currentView === 'dm' ? 'dm' : 'channel');
    const key = florMessageReactionKey(ctx, messageId);
    const reactionsContainer = document.querySelector(
        `[data-flor-msg-key="${florEscapeSelector(key)}"] .message-reactions`
    );
    if (!reactionsContainer) return;
    florRenderMessageReactions(reactionsContainer, messageId, reactions, ctx);
}

let florVoiceRecorder = null;
let florVoiceChunks = [];
let florVoiceMimeType = '';
let florVoiceRecording = false;
let florVoiceCancelled = false;
let florVoiceMaxTimer = null;
let florVoiceStartTs = 0;
let florVoiceIgnoreNextClick = false;
let florVoiceUploading = false;
let florVoiceCancelPendingStart = false;
let florVoiceInitializing = false;

function florPreferHoldToRecordVoice() {
    try {
        return window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
    } catch (_) {
        return false;
    }
}

function florVoiceRecordingConstraints() {
    const s = getMessengerSettings();
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const id = s.audioInputDeviceId && String(s.audioInputDeviceId).trim();
    if (id) {
        audio.deviceId = florUseRelaxedMediaConstraints() ? { ideal: id } : { exact: id };
    }
    return audio;
}

function florExtFromAudioMime(mime) {
    const base = String(mime || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    const map = {
        'audio/webm': 'webm',
        'audio/ogg': 'ogg',
        'audio/mp4': 'm4a',
        'audio/x-m4a': 'm4a',
        'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3',
        'audio/wav': 'wav',
        'audio/x-wav': 'wav',
        'audio/aac': 'aac'
    };
    return map[base] || 'webm';
}

function florPickVoiceRecorderMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    const types = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg',
        'audio/mp4',
        'audio/aac'
    ];
    for (let i = 0; i < types.length; i++) {
        if (MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
    return '';
}

function florUpdateVoiceBtnUI(recording) {
    const btn = document.getElementById('voiceMessageBtn');
    if (!btn) return;
    btn.classList.toggle('voice-msg-btn--recording', !!recording);
    btn.setAttribute('aria-pressed', recording ? 'true' : 'false');
}

function florUpdateVoiceBtnUploading(loading) {
    const btn = document.getElementById('voiceMessageBtn');
    if (!btn) return;
    btn.disabled = !!loading;
    btn.classList.toggle('voice-msg-btn--uploading', !!loading);
    btn.setAttribute('aria-busy', loading ? 'true' : 'false');
}

async function florStartVoiceMessageRecording() {
    if (florVoiceRecording || florVoiceUploading || florVoiceInitializing) return;
    florVoiceInitializing = true;
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('Микрофон недоступен в этом браузере');
            return;
        }
        const mime = florPickVoiceRecorderMime();
        if (!mime) {
            alert('Запись голоса не поддерживается в этом браузере');
            return;
        }
        florVoiceMimeType = mime;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: florVoiceRecordingConstraints(),
                video: false
            });
        } catch (e) {
            alert(e && e.message ? e.message : 'Не удалось включить микрофон');
            return;
        }
        if (florVoiceCancelPendingStart) {
            stream.getTracks().forEach((t) => t.stop());
            florVoiceCancelPendingStart = false;
            return;
        }
        florVoiceChunks = [];
        florVoiceCancelled = false;
        florVoiceStartTs = Date.now();
        let recorder;
        try {
            recorder = new MediaRecorder(stream, { mimeType: mime });
        } catch (e) {
            stream.getTracks().forEach((t) => t.stop());
            alert('Не удалось начать запись');
            return;
        }
        if (florVoiceCancelPendingStart) {
            stream.getTracks().forEach((t) => t.stop());
            florVoiceCancelPendingStart = false;
            return;
        }
        florVoiceRecorder = recorder;
        recorder.ondataavailable = (ev) => {
            if (ev.data && ev.data.size > 0) florVoiceChunks.push(ev.data);
        };
        recorder.onstop = () => {
            stream.getTracks().forEach((t) => t.stop());
            const rec = florVoiceRecorder;
            florVoiceRecorder = null;
            florVoiceRecording = false;
            florUpdateVoiceBtnUI(false);
            if (florVoiceCancelled) {
                florVoiceCancelled = false;
                florVoiceChunks = [];
                return;
            }
            const blobType = (rec && rec.mimeType) || florVoiceMimeType.split(';')[0] || 'audio/webm';
            const blob = new Blob(florVoiceChunks, { type: blobType });
            florVoiceChunks = [];
            const elapsed = Date.now() - florVoiceStartTs;
            if (elapsed < 450 || blob.size < 600) {
                return;
            }
            florSendVoiceBlob(blob).catch((err) => {
                console.error('Voice send:', err);
                alert(err.message || 'Не удалось отправить голосовое');
            });
        };
        try {
            recorder.start(250);
        } catch (e) {
            stream.getTracks().forEach((t) => t.stop());
            florVoiceRecorder = null;
            alert('Не удалось начать запись');
            return;
        }
        florVoiceRecording = true;
        florUpdateVoiceBtnUI(true);
        florVoiceMaxTimer = setTimeout(() => {
            if (florVoiceRecording) florStopVoiceMessageRecording(false);
        }, 120000);
    } finally {
        florVoiceInitializing = false;
    }
}

function florStopVoiceMessageRecording(cancel) {
    clearTimeout(florVoiceMaxTimer);
    florVoiceMaxTimer = null;
    if (!florVoiceRecorder) {
        if (florVoiceInitializing) florVoiceCancelPendingStart = true;
        return;
    }
    if (cancel) florVoiceCancelled = true;
    try {
        if (florVoiceRecorder.state === 'recording') {
            florVoiceRecorder.stop();
        } else {
            florVoiceRecorder.stream.getTracks().forEach((t) => t.stop());
            florVoiceRecorder = null;
            florVoiceRecording = false;
            florUpdateVoiceBtnUI(false);
        }
    } catch (e) {
        florVoiceRecorder = null;
        florVoiceRecording = false;
        florUpdateVoiceBtnUI(false);
    }
}

async function florSendVoiceBlob(blob) {
    if (florVoiceUploading) return;
    const mime = blob.type || 'audio/webm';
    const ext = florExtFromAudioMime(mime);
    const filename = `voice-${Date.now()}.${ext}`;
    const file = new File([blob], filename, { type: mime });

    florVoiceUploading = true;
    florUpdateVoiceBtnUploading(true);
    try {
        if (currentView === 'dm' && currentDMUserId) {
            if (!socket || !socket.connected) {
                throw new Error('Нет соединения с сервером');
            }
            const fd = new FormData();
            fd.append('file', file);
            fd.append('receiverId', String(currentDMUserId));
            const response = await fetch(florApi('/api/dm/upload'), {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: fd
            });
            const raw = await response.text();
            let fileData = {};
            try {
                fileData = raw ? JSON.parse(raw) : {};
            } catch (_) {}
            if (!response.ok) {
                throw new Error(fileData.error || 'Не удалось загрузить аудио');
            }
            const line = `Голосовое: — ${fileData.url}`;
            let payloadText = line;
            if (window.florE2ee) {
                await florRefreshPeerKeysBeforeDmEncrypt();
                payloadText = await florE2ee.encryptDmPlaintext(currentDMUserId, line);
            }
            socket.emit('send-dm', {
                receiverId: currentDMUserId,
                message: { text: payloadText }
            });
            return;
        }

        if (currentView === 'server') {
            const byName = currentChannel ? getChannelIdByName(currentChannel) : null;
            const channelId = byName != null ? byName : currentTextChannelId;
            if (channelId == null) {
                throw new Error('Выберите текстовый канал');
            }
            const cid = Number(channelId);
            if (!Number.isFinite(cid)) {
                throw new Error('Сбой выбора канала');
            }
            const formData = new FormData();
            formData.append('file', file);
            formData.append('channelId', String(channelId));
            const response = await fetch(florApi('/api/upload'), {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: formData
            });
            const rawUpload = await response.text();
            let fileData = {};
            try {
                fileData = rawUpload ? JSON.parse(rawUpload) : {};
            } catch (_) {}
            if (!response.ok) {
                throw new Error(fileData.error || 'Не удалось загрузить аудио');
            }
            let outText = `Голосовое: — ${fileData.url}`;
            if (window.florE2ee && currentServerRecord) {
                const rawKey = await florE2ee.ensureChannelKey(
                    cid,
                    currentServerRecord.id,
                    florApi,
                    token,
                    currentUser.id,
                    florFetchMembersForE2ee
                );
                outText = await florE2ee.encryptWithChannelKey(rawKey, outText);
            }
            const post = await fetch(florApi('/api/messages'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ channelId: cid, text: outText })
            });
            const pdata = await post.json().catch(() => ({}));
            if (!post.ok) {
                throw new Error(pdata.error || 'Не удалось отправить сообщение');
            }
            const box = document.getElementById('messagesContainer');
            let m = pdata.message;
            if (m && window.florE2ee && currentServerRecord && m.text) {
                try {
                    const rawKey = await florE2ee.ensureChannelKey(
                        cid,
                        currentServerRecord.id,
                        florApi,
                        token,
                        currentUser.id,
                        florFetchMembersForE2ee
                    );
                    m = { ...m, text: await florE2ee.decryptWithChannelKey(rawKey, m.text) };
                } catch (_) {}
            }
            const fk = m && m.id != null ? florMessageReactionKey('channel', m.id) : null;
            if (
                m &&
                m.id != null &&
                box &&
                !box.querySelector(`[data-flor-msg-key="${florEscapeSelector(fk)}"]`)
            ) {
                addMessageToUI({ ...m, userId: m.senderId != null ? m.senderId : m.userId });
                scrollToBottom();
            }
            return;
        }

        throw new Error('Откройте чат сервера или личные сообщения');
    } finally {
        florVoiceUploading = false;
        florUpdateVoiceBtnUploading(false);
    }
}

function initializeVoiceMessageButton() {
    const btn = document.getElementById('voiceMessageBtn');
    if (!btn) return;
    const hold = () => florPreferHoldToRecordVoice();
    if (hold()) {
        btn.title = 'Удерживайте для записи голосового сообщения';
    } else {
        btn.title =
            'Голосовое: нажмите — начать запись, нажмите снова — отправить. Esc — отмена.';
    }

    btn.addEventListener('pointerdown', (e) => {
        if (!hold() || e.button !== 0 || btn.disabled) return;
        e.preventDefault();
        if (typeof e.target.setPointerCapture === 'function') {
            e.target.setPointerCapture(e.pointerId);
        }
        florVoiceIgnoreNextClick = true;
        florVoiceCancelPendingStart = false;
        florStartVoiceMessageRecording();
    });
    btn.addEventListener('pointerup', (e) => {
        if (!hold() || btn.disabled) return;
        if (
            typeof e.target.releasePointerCapture === 'function' &&
            e.target.hasPointerCapture &&
            e.target.hasPointerCapture(e.pointerId)
        ) {
            e.target.releasePointerCapture(e.pointerId);
        }
        if (florVoiceRecording) florStopVoiceMessageRecording(false);
        else florVoiceCancelPendingStart = true;
    });
    btn.addEventListener('pointercancel', () => {
        if (!hold()) return;
        if (florVoiceRecording) florStopVoiceMessageRecording(true);
        else florVoiceCancelPendingStart = true;
    });
    btn.addEventListener('click', (e) => {
        if (hold()) {
            if (florVoiceIgnoreNextClick) {
                florVoiceIgnoreNextClick = false;
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }
        if (btn.disabled) return;
        e.preventDefault();
        if (florVoiceInitializing) {
            florVoiceCancelPendingStart = true;
            return;
        }
        if (florVoiceRecording) florStopVoiceMessageRecording(false);
        else florStartVoiceMessageRecording();
    });
    btn.addEventListener(
        'contextmenu',
        (e) => {
            if (hold() && florVoiceRecording) e.preventDefault();
        },
        true
    );

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !florVoiceRecording || hold()) return;
        florStopVoiceMessageRecording(true);
    });
}

// File upload
function initializeFileUpload() {
    const attachBtn = document.querySelector('.attach-btn');
    if (!attachBtn) return;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.setAttribute(
        'accept',
        'image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip,.rar,.mp3,.mp4,.webm,.mov,.ogg,.wav,.m4a'
    );
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
        
        const rawUpload = await response.text();
        let fileData = {};
        try {
            fileData = rawUpload ? JSON.parse(rawUpload) : {};
        } catch (_) {}
        if (!response.ok) {
            throw new Error(fileData.error || 'Не удалось загрузить файл');
        }
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
        const fk = m && m.id != null ? florMessageReactionKey('channel', m.id) : null;
        if (m && m.id != null && box && !box.querySelector(`[data-flor-msg-key="${florEscapeSelector(fk)}"]`)) {
            addMessageToUI({ ...m, userId: m.senderId != null ? m.senderId : m.userId });
            scrollToBottom();
        }
    } catch (error) {
        console.error('Upload error:', error);
        alert(error.message || 'Не удалось загрузить файл');
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
        florBroadcastVoiceSelfState();
        florRestartLocalVoiceActivityMonitor();
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
            
            florRefreshAllRemoteVoiceVolumes();
        } else {
            florRefreshAllRemoteVoiceVolumes();
        }

        // Update local stream audio tracks
        if (localStream) {
            localStream.getAudioTracks().forEach(track => {
                track.enabled = !isMuted;
            });
        }
        florBroadcastVoiceSelfState();
        florRestartLocalVoiceActivityMonitor();
    });

    const up = document.querySelector('.user-panel .user-info');
    if (up) {
        const openSelfProfile = () => {
            if (currentUser && currentUser.id != null) {
                openFlorUserProfile(Number(currentUser.id));
            }
        };
        up.addEventListener('click', openSelfProfile);
        up.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openSelfProfile();
            }
        });
    }
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
    let tempStream = null;
    try {
        try {
            tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            if (florMediaNeedsSecurePage()) {
                inSel.innerHTML = '<option value="">Нет доступа: https:// или USE_HTTPS / Electron (.env)</option>';
                outSel.innerHTML = '<option value="">—</option>';
                return;
            }
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
    } finally {
        if (tempStream) {
            try {
                tempStream.getTracks().forEach((t) => t.stop());
            } catch (_) {}
        }
    }
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
            if (currentUser && florIsAvatarImageUrl(currentUser.avatar)) {
                avatarInput.placeholder = 'Фото загружено — введите до 4 букв или оставьте пустым';
                avatarInput.value = '';
            } else {
                avatarInput.placeholder = '';
                avatarInput.value =
                    currentUser && currentUser.avatar && !florIsAvatarImageUrl(currentUser.avatar)
                        ? String(currentUser.avatar).slice(0, 4)
                        : '';
            }
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
        showPanel('profile');
        overlay.classList.remove('hidden');
        overlay.setAttribute('aria-hidden', 'false');

        fetch(florApi('/api/user/profile'), { headers: { Authorization: `Bearer ${token}` } })
            .then((r) => (r.ok ? r.json() : null))
            .then((u) => {
                if (!u) return;
                const bioEl = document.getElementById('settingsBio');
                if (bioEl && typeof u.bio === 'string') {
                    bioEl.value = u.bio;
                }
                const ai = document.getElementById('settingsAvatarInput');
                if (ai) {
                    if (florIsAvatarImageUrl(u.avatar)) {
                        ai.placeholder = 'Фото из файла';
                        ai.value = '';
                    } else {
                        ai.placeholder = '';
                        ai.value = (u.avatar && String(u.avatar).trim()) || '';
                    }
                }
            })
            .catch(() => {});
    }

    function closeSettings() {
        overlay.classList.add('hidden');
        overlay.setAttribute('aria-hidden', 'true');
        stopMicTest();
    }

    async function uploadProfileKind(input, kind) {
        const f = input.files && input.files[0];
        if (!f) return;
        const fd = new FormData();
        fd.append('file', f);
        const r = await fetch(florApi(`/api/user/profile-photo?kind=${encodeURIComponent(kind)}`), {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: fd
        });
        const text = await r.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch (_) {
            throw new Error('Ответ сервера не JSON. Проверьте консоль сервера и адрес API.');
        }
        if (!r.ok) {
            throw new Error(data.error || `Ошибка загрузки (${r.status})`);
        }
        if (data.avatar) {
            currentUser.avatar = data.avatar;
        }
        if (data.profile_banner !== undefined) {
            currentUser.profile_banner = data.profile_banner;
        }
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        updateUserInfo();
        input.value = '';
        loadFriends();
    }

    document.getElementById('settingsAvatarPickBtn')?.addEventListener('click', () => {
        document.getElementById('settingsAvatarFile')?.click();
    });
    document.getElementById('settingsBannerPickBtn')?.addEventListener('click', () => {
        document.getElementById('settingsBannerFile')?.click();
    });
    document.getElementById('settingsAvatarFile')?.addEventListener('change', async (e) => {
        try {
            await uploadProfileKind(e.target, 'avatar');
        } catch (err) {
            alert(err.message || 'Не удалось загрузить');
        }
    });
    document.getElementById('settingsBannerFile')?.addEventListener('change', async (e) => {
        try {
            await uploadProfileKind(e.target, 'banner');
        } catch (err) {
            alert(err.message || 'Не удалось загрузить');
        }
    });

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

    document.getElementById('resetVoiceParticipantPrefsBtn')?.addEventListener('click', () => {
        if (!confirm('Сбросить громкость и «не слышать» для всех участников в этом браузере?')) return;
        saveMessengerSettings({ voiceParticipantPrefs: {} });
        florRefreshAllRemoteVoiceVolumes();
        if (florLastVoiceRoster.length) {
            renderCallVoiceRoster(florLastVoiceRoster);
        }
    });

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
        const raw = avatarInput ? avatarInput.value.trim() : '';
        const bioVal = document.getElementById('settingsBio')?.value?.trim() || '';
        const patch = { bio: bioVal };
        if (raw.length > 0 && raw.length <= 4) {
            patch.avatar = raw;
        } else if (raw.length > 4) {
            alert('Текстовый аватар — не более 4 символов (или загрузите фото).');
            return;
        } else if (raw.length === 0 && !florIsAvatarImageUrl(currentUser && currentUser.avatar)) {
            patch.avatar = null;
        }
        try {
            const response = await fetch(florApi('/api/user/profile'), {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify(patch)
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'save failed');
            }
            currentUser.avatar = data.avatar;
            if (data.profile_banner !== undefined) {
                currentUser.profile_banner = data.profile_banner;
            }
            if (data.bio !== undefined) {
                currentUser.bio = data.bio;
            }
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            updateUserInfo();
            closeSettings();
        } catch (err) {
            console.error(err);
            alert('Не удалось сохранить профиль на сервере; остальные настройки сохранены локально.');
            closeSettings();
        }
    });

    logoutBtn.addEventListener('click', () => {
        if (!confirm('Выйти из аккаунта?')) return;
        if (inCall) leaveVoiceChannel(true, { silent: true });
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
        const isOwner =
            currentUser && Number(currentServerRecord.owner_id) === Number(currentUser.id);
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

async function populateServerSettingsDeleteChannels() {
    const sel = document.getElementById('serverSettingsDeleteChSelect');
    if (!sel || !currentServerRecord) return;
    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '— выберите канал —';
    sel.appendChild(opt0);
    const tree = await fetchServerChannels(currentServerRecord.id);
    if (!tree || !Array.isArray(tree.categories)) {
        return;
    }
    tree.categories.forEach((cat) => {
        (cat.channels || []).forEach((c) => {
            const opt = document.createElement('option');
            opt.value = String(c.id);
            const t = String(c.type || '').trim().toLowerCase() === 'voice' ? 'голос' : 'текст';
            const catLabel = cat.name ? `${cat.name} · ` : '';
            opt.textContent = `${catLabel}#${channelDisplayName(c.name)} (${t})`;
            sel.appendChild(opt);
        });
    });
}

function openServerSettingsModal() {
    const ov = document.getElementById('serverSettingsOverlay');
    if (!ov || !currentServerRecord) return;
    const iconFile = document.getElementById('serverSettingsIconFile');
    if (iconFile) iconFile.value = '';
    document.getElementById('serverSettingsName').value = currentServerRecord.name || '';
    document.getElementById('serverSettingsIcon').value = currentServerRecord.icon || '';
    const ownerExtras = document.getElementById('serverSettingsOwnerExtras');
    const isOwner = currentUser && Number(currentServerRecord.owner_id) === Number(currentUser.id);
    if (ownerExtras) {
        ownerExtras.classList.toggle('hidden', !isOwner);
    }
    if (isOwner) {
        void populateServerSettingsDeleteChannels();
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
    document.getElementById('serverSettingsIconPickBtn')?.addEventListener('click', () => {
        document.getElementById('serverSettingsIconFile')?.click();
    });
    document.getElementById('serverSettingsIconFile')?.addEventListener('change', async (e) => {
        const file = e.target?.files?.[0];
        if (!file || !currentServerRecord) return;
        if (Number(currentUser?.id) !== Number(currentServerRecord.owner_id)) {
            alert('Только владелец может менять аватар группы');
            e.target.value = '';
            return;
        }
        const fd = new FormData();
        fd.append('file', file);
        try {
            const response = await fetch(florApi(`/api/servers/${currentServerRecord.id}/icon`), {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: fd
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Ошибка загрузки');
            }
            if (data.server) {
                currentServerRecord = data.server;
                const idx = servers.findIndex((s) => Number(s.id) === Number(data.server.id));
                if (idx >= 0) servers[idx] = data.server;
                const iconEl = document.querySelector(`.server-icon[data-server-id="${data.server.id}"]`);
                if (iconEl) florRenderServerIcon(iconEl, data.server);
                document.getElementById('serverSettingsIcon').value = data.server.icon || '';
            }
        } catch (err) {
            alert(err.message || 'Не удалось загрузить изображение');
        }
        e.target.value = '';
    });

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
                iconEl.title = data.name;
                florRenderServerIcon(iconEl, data);
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
        if (!currentServerRecord || Number(currentUser?.id) !== Number(currentServerRecord.owner_id))
            return;
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

function initializeServerDeleteChannel() {
    document.getElementById('serverSettingsDeleteChBtn')?.addEventListener('click', async () => {
        if (!currentServerRecord || Number(currentUser?.id) !== Number(currentServerRecord.owner_id)) {
            return;
        }
        const sel = document.getElementById('serverSettingsDeleteChSelect');
        const id = sel?.value?.trim();
        if (!id) {
            alert('Выберите канал в списке');
            return;
        }
        const label = sel.options[sel.selectedIndex]?.text || id;
        if (
            !confirm(
                `Удалить канал «${label}»?\n\nВсе сообщения и вложения в этом канале будут удалены безвозвратно.`
            )
        ) {
            return;
        }
        try {
            const response = await fetch(
                florApi(`/api/servers/${currentServerRecord.id}/channels/${encodeURIComponent(id)}`),
                {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${token}` }
                }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || 'Не удалось удалить');
            }
            if (data.tree) {
                renderChannelTree(data.tree);
                flattenChannelTreeToMaps(data.tree);
            }
            if (Number(id) === Number(currentTextChannelId)) {
                const keys = Object.keys(currentServerChannelMap || {});
                if (keys.length) {
                    switchChannel(keys[0]);
                }
            }
            await populateServerSettingsDeleteChannels();
        } catch (e) {
            alert(e.message || 'Ошибка удаления');
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
        const myId = currentUser ? Number(currentUser.id) : null;
        const amOwner = currentUser && Number(currentServerRecord.owner_id) === Number(currentUser.id);
        members.forEach((m) => {
            const row = document.createElement('div');
            row.className = 'member-row';
            const uid = Number(m.id);
            const un = escapeHtml(m.username || '');
            const st = escapeHtml(friendStatusLabel(m.status));
            const ownerBadge = m.isOwner ? '<span class="member-owner-badge">владелец</span>' : '';

            const avEl = document.createElement('div');
            avEl.className = 'member-avatar';
            florFillAvatarEl(avEl, m.avatar, m.username);

            const info = document.createElement('div');
            info.className = 'member-row-info';
            info.innerHTML = `<strong>${un}</strong> ${ownerBadge}<div class="settings-hint" style="margin:0;font-size:12px;">${st}</div>`;

            const actions = document.createElement('div');
            actions.className = 'member-row-actions';

            row.appendChild(avEl);
            row.appendChild(info);
            row.appendChild(actions);

            if (myId != null && uid === myId) {
                const leaveBtn = document.createElement('button');
                leaveBtn.type = 'button';
                leaveBtn.className = 'settings-btn settings-btn--secondary';
                leaveBtn.textContent = 'Покинуть';
                leaveBtn.addEventListener('click', async () => {
                    if (!confirm('Покинуть эту группу?')) return;
                    try {
                        const r = await fetch(
                            florApi(`/api/servers/${currentServerRecord.id}/members/${uid}`),
                            { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
                        );
                        const d = await r.json();
                        if (!r.ok) throw new Error(d.error || 'Ошибка');
                        const membersOv = document.getElementById('membersOverlay');
                        if (membersOv) {
                            membersOv.classList.add('hidden');
                            membersOv.setAttribute('aria-hidden', 'true');
                        }
                        servers = servers.filter((s) => Number(s.id) !== Number(currentServerRecord.id));
                        currentServerRecord = null;
                        showFriendsView();
                    } catch (err) {
                        alert(err.message || 'Не удалось выйти');
                    }
                });
                actions.appendChild(leaveBtn);
            } else if (amOwner && !m.isOwner) {
                const kickBtn = document.createElement('button');
                kickBtn.type = 'button';
                kickBtn.className = 'settings-btn';
                kickBtn.textContent = 'Исключить';
                kickBtn.addEventListener('click', async () => {
                    if (!confirm(`Исключить ${m.username || 'участника'} из группы?`)) return;
                    try {
                        const r = await fetch(
                            florApi(`/api/servers/${currentServerRecord.id}/members/${uid}`),
                            { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
                        );
                        const d = await r.json();
                        if (!r.ok) throw new Error(d.error || 'Ошибка');
                        await loadMembersList();
                    } catch (err) {
                        alert(err.message || 'Не удалось исключить');
                    }
                });
                actions.appendChild(kickBtn);
            }

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
        list.textContent = 'Помечайте важные сообщения через кнопку меню у сообщения → «В закладки».';
        return;
    }
    arr.forEach((b) => {
        const wrap = document.createElement('div');
        wrap.className = 'bookmark-item';
        const authorEl = document.createElement('strong');
        authorEl.textContent = b.author || '';
        const body = document.createElement('div');
        body.className = 'bookmark-item__body';
        const raw = b.text == null ? '' : String(b.text);
        body.appendChild(florMessageTextToFragment(raw.length > 4000 ? `${raw.slice(0, 4000)}…` : raw));
        wrap.appendChild(authorEl);
        wrap.appendChild(body);
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

function florExportChatJson() {
    if (!lastLoadedMessagesForExport.length) {
        alert('Сначала откройте чат — в файл попадут уже загруженные сообщения.');
        return;
    }
    const blob = new Blob([JSON.stringify(lastLoadedMessagesForExport, null, 2)], {
        type: 'application/json'
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const kind = currentView === 'dm' ? 'flor-dm' : 'flor-chat';
    a.download = `${kind}-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
}

function initializeChatTools() {
    document.getElementById('chatMessageSearch')?.addEventListener('input', (e) => {
        filterChatMessages(e.target.value);
        const g = document.getElementById('florGlobalSearchInput');
        if (g && window.matchMedia('(min-width: 769px)').matches) {
            g.value = e.target.value;
        }
    });
    const globalS = document.getElementById('florGlobalSearchInput');
    if (globalS) {
        globalS.addEventListener('input', () => {
            const ch = document.getElementById('chatMessageSearch');
            const chatOpen = document.getElementById('chatView')?.style.display !== 'none';
            if (ch && chatOpen) {
                ch.value = globalS.value;
                filterChatMessages(globalS.value);
            }
        });
    }
    document.getElementById('exportChatBtn')?.addEventListener('click', () => florExportChatJson());
    document.getElementById('dmCallVoiceBtn')?.addEventListener('click', () => {
        if (currentView === 'dm' && currentDMUserId != null) {
            void initiateCall(currentDMUserId, 'voice');
        }
    });
    document.getElementById('dmCallVideoBtn')?.addEventListener('click', () => {
        if (currentView === 'dm' && currentDMUserId != null) {
            void initiateCall(currentDMUserId, 'video');
        }
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
            const chatOpen = document.getElementById('chatView')?.style.display !== 'none';
            if (!chatOpen) return;
            e.preventDefault();
            const desk =
                window.matchMedia('(min-width: 769px)').matches &&
                document.getElementById('florGlobalSearchInput');
            (desk || document.getElementById('chatMessageSearch'))?.focus();
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
                florUpdateCallFullscreenButton();
            }
            return;
        }
        leaveVoiceChannel(true, { silent: true });
    }

    inCall = true;
    activeVoiceRoomKey = roomKey;
    activeVoiceChannelName = displayLabel;
    isVideoEnabled = false;
    window.currentCallDetails = null;

    document.querySelectorAll('.voice-channel').forEach((ch) => ch.classList.remove('in-call'));
    document.querySelector(`.voice-channel[data-channel-id="${channelId}"]`)?.classList.add('in-call');

    const callInterface = document.getElementById('callInterface');
    callInterface.classList.remove('hidden');
    florUpdateCallFullscreenButton();

    const nameEl = document.querySelector('.call-channel-name');
    if (nameEl) nameEl.textContent = displayLabel;
    florSetCallVoiceMeta('Подключение к каналу…');

    try {
        await initializeMedia({ voice: true });
        /* Не слать join, если за время await пользователь уже вышел (ЛС-звонок, отклонение и т.д.) */
        if (!inCall || activeVoiceRoomKey !== roomKey) {
            return;
        }
        updateLocalCallParticipantUI();
        updateCallButtons();
        florBroadcastVoiceSelfState();

        if (socket && socket.connected) {
            socket.emit('join-voice-channel', {
                serverId: currentServerId,
                channelId
            });
        }
        florStartLocalVoiceActivityMonitor();
        florSyncDmVideoCallLayout();
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
        const constraints = {
            audio: florAudioCaptureConstraints(),
            video: voiceOnly ? false : florVideoCaptureConstraints()
        };

        localStream = await florGetUserMediaReliable(constraints);
        
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

function florGetDocumentFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function florUpdateCallFullscreenButton() {
    const btn = document.getElementById('callFullscreenBtn');
    if (!btn) return;
    const el = document.getElementById('callInterface');
    const fsEl = florGetDocumentFullscreenElement();
    const on = !!(el && !el.classList.contains('hidden') && (fsEl === el || el.classList.contains('fullscreen')));
    btn.classList.toggle('flor-call-fullscreen-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Выйти из полноэкранного режима' : 'На весь экран';
    const enter = btn.querySelector('.flor-fs-icon-enter');
    const exit = btn.querySelector('.flor-fs-icon-exit');
    if (enter) enter.hidden = on;
    if (exit) exit.hidden = !on;
}

function florExitCallFullscreenIfNeeded() {
    const el = document.getElementById('callInterface');
    if (!el) return;
    const fsEl = florGetDocumentFullscreenElement();
    if (fsEl === el) {
        if (document.exitFullscreen) void document.exitFullscreen().catch(() => {});
        else if (document.webkitExitFullscreen) void document.webkitExitFullscreen().catch(() => {});
    }
    florCallNativeFullscreenActive = false;
    el.classList.remove('fullscreen');
    el.style.left = '';
    el.style.top = '';
    el.style.transform = '';
    el.style.width = '';
    el.style.height = '';
    florUpdateCallFullscreenButton();
}

function florOnCallFullscreenChange() {
    const el = document.getElementById('callInterface');
    if (!el) return;
    const fsEl = florGetDocumentFullscreenElement();
    if (fsEl === el) {
        florCallNativeFullscreenActive = true;
        el.classList.add('fullscreen');
        el.style.left = '';
        el.style.top = '';
        el.style.transform = '';
        el.style.width = '';
        el.style.height = '';
    } else if (florCallNativeFullscreenActive) {
        florCallNativeFullscreenActive = false;
        el.classList.remove('fullscreen');
        el.style.left = '';
        el.style.top = '';
        el.style.transform = '';
        el.style.width = '';
        el.style.height = '';
    }
    florUpdateCallFullscreenButton();
}

async function florToggleCallFullscreen() {
    const el = document.getElementById('callInterface');
    if (!el || el.classList.contains('hidden')) return;

    const fsEl = florGetDocumentFullscreenElement();

    if (fsEl === el) {
        if (document.exitFullscreen) await document.exitFullscreen().catch(() => {});
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen().catch(() => {});
        florUpdateCallFullscreenButton();
        return;
    }

    if (el.classList.contains('fullscreen')) {
        el.classList.remove('fullscreen');
        el.style.left = '';
        el.style.top = '';
        el.style.transform = '';
        el.style.width = '';
        el.style.height = '';
        florUpdateCallFullscreenButton();
        return;
    }

    el.style.left = '';
    el.style.top = '';
    el.style.transform = '';
    el.style.width = '';
    el.style.height = '';

    try {
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
        else throw new Error('no fullscreen api');
    } catch (_) {
        el.classList.add('fullscreen');
    }
    florUpdateCallFullscreenButton();
}

/** На телефоне видеозвонок сразу в полноэкранном режиме — иначе вёрстка «прижата» к верху и обрезана чёлкой */
function florEnterCallFullscreenForMobileVideo() {
    try {
        if (typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 769px)').matches) {
            return;
        }
        const el = document.getElementById('callInterface');
        if (!el || el.classList.contains('hidden')) return;
        const d = window.currentCallDetails;
        if (!d || d.type !== 'video') return;
        if (el.classList.contains('fullscreen') || florGetDocumentFullscreenElement() === el) return;
        void florToggleCallFullscreen();
    } catch (_) {}
}

function leaveVoiceChannel(force = false, opts) {
    opts = opts || {};
    if (!inCall) return;

    if (force) {
        florResetCallRingAndJoinSfx();
        if (!opts.silent) {
            florPlayCallSfx('leave');
        }
        florStopLocalVoiceActivityMonitor();
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
        window.currentCallDetails = null;
        florSyncDmVideoCallLayout();
    }

    florExitCallFullscreenIfNeeded();

    const callInterface = document.getElementById('callInterface');
    callInterface.classList.add('hidden');

    if (force) {
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = null;
        isVideoEnabled = true;
        isAudioEnabled = true;
        updateCallButtons();
        updateLocalCallParticipantUI();
    }
}

function initializeCallControls() {
    const closeCallBtn = document.getElementById('closeCallBtn');
    const callFullscreenBtn = document.getElementById('callFullscreenBtn');
    const toggleVideoBtn = document.getElementById('toggleVideoBtn');
    const toggleAudioBtn = document.getElementById('toggleAudioBtn');
    const toggleScreenBtn = document.getElementById('toggleScreenBtn');

    document.addEventListener('fullscreenchange', florOnCallFullscreenChange);
    document.addEventListener('webkitfullscreenchange', florOnCallFullscreenChange);

    callFullscreenBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        void florToggleCallFullscreen();
    });
    callFullscreenBtn?.addEventListener('mousedown', (e) => e.stopPropagation());
    closeCallBtn?.addEventListener('mousedown', (e) => e.stopPropagation());

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
        void toggleVideo();
    });
    
    toggleAudioBtn.addEventListener('click', () => {
        toggleAudio();
    });
    
    toggleScreenBtn.addEventListener('click', () => {
        toggleScreenShare();
    });
}

async function toggleVideo() {
    if (!localStream) return;

    const nextOn = !isVideoEnabled;
    if (nextOn) {
        let vt = localStream.getVideoTracks()[0];
        if (!vt) {
            try {
                const vs = await florGetUserMediaReliable({
                    video: florVideoCaptureConstraints(),
                    audio: false
                });
                vt = vs.getVideoTracks()[0];
                localStream.addTrack(vt);
                Object.values(peerConnections).forEach((pc) => {
                    try {
                        pc.addTrack(vt, localStream);
                    } catch (_) {}
                });
            } catch (e) {
                console.error(e);
                alert(florMediaAccessHint());
                return;
            }
        }
        if (vt) vt.enabled = true;
        isVideoEnabled = true;
    } else {
        localStream.getVideoTracks().forEach((track) => {
            track.enabled = false;
        });
        isVideoEnabled = false;
    }

    Object.keys(peerConnections).forEach((socketId) => {
        if (socket && socket.connected) {
            socket.emit('video-toggle', {
                to: socketId,
                enabled: isVideoEnabled
            });
        }
    });

    updateCallButtons();
    updateLocalCallParticipantUI();
    florBroadcastVoiceSelfState();
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
    florBroadcastVoiceSelfState();
    florRestartLocalVoiceActivityMonitor();
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
        const sharing = screenStream !== null;
        toggleScreenBtn.classList.toggle('active', sharing);
        toggleScreenBtn.classList.toggle('screen-active', sharing);
    }
}

function initializeDraggableCallWindow() {
   const callInterface = document.getElementById('callInterface');
   const callHeader = callInterface.querySelector('.call-header');
   let isDragging = false;
   let offsetX, offsetY;

   callHeader.addEventListener('mousedown', (e) => {
       if (e.target.closest('button')) return;
       if (callInterface.classList.contains('fullscreen')) return;
       if (florGetDocumentFullscreenElement() === callInterface) return;
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

async function florDecryptDmLine(cipher, peerId) {
    if (!window.florE2ee) return cipher;
    const tryDecrypt = () => florE2ee.decryptDmPayload(cipher, peerId);
    let t = await tryDecrypt();
    if (typeof t === 'string' && t.startsWith('🔒')) {
        await florRefreshUserKeyCache();
        t = await tryDecrypt();
    }
    if (typeof t === 'string' && t.startsWith('🔒')) {
        await florRefreshUserKeyCache();
        await new Promise((r) => setTimeout(r, 200));
        t = await tryDecrypt();
    }
    return t;
}

async function florRetryPendingE2eeDecrypt() {
    if (!window.florE2ee || typeof florE2ee.isActive !== 'function' || !florE2ee.isActive()) return;
    if (!token || !currentUser) return;
    const box = document.getElementById('messagesContainer');
    if (!box || florE2eeRetryByMessageId.size === 0) return;

    await florRefreshUserKeyCache();

    for (const [msgId, entry] of [...florE2eeRetryByMessageId.entries()]) {
        const el = box.querySelector(`[data-message-id="${msgId}"]`);
        if (!el) {
            florE2eeRetryByMessageId.delete(msgId);
            continue;
        }
        let plain = '';
        try {
            if (entry.kind === 'channel') {
                florClearStoredChannelKey(entry.channelId);
                if (currentServerRecord) {
                    try {
                        await florE2ee.redistributeMissingWraps(
                            entry.channelId,
                            currentServerRecord.id,
                            florApi,
                            token,
                            currentUser.id,
                            florFetchMembersForE2ee
                        );
                    } catch (_) {}
                }
                plain = await florDecryptChannelMessage(entry.channelId, entry.raw);
            } else {
                plain = await florDecryptDmLine(entry.raw, entry.peerId);
            }
        } catch (_) {
            continue;
        }
        if (typeof plain === 'string' && plain.length && !plain.startsWith('🔒')) {
            const textEl = el.querySelector('.message-text');
            if (textEl) {
                textEl.innerHTML = '';
                textEl.appendChild(florMessageTextToFragment(plain));
                textEl.classList.toggle('message-text--attachment-only', florMessageIsAttachmentOnlyText(plain));
            }
            florE2eeRetryByMessageId.delete(msgId);
        }
    }
}

function florRegisterE2eeRetryIfFailed(message, msgCtx, numericId) {
    if (!message || !message.florPendingCipher) return;
    if (typeof message.text !== 'string' || !message.text.startsWith('🔒')) return;
    const id = Number(numericId);
    if (!Number.isFinite(id)) return;
    if (msgCtx === 'channel') {
        const ch =
            message.channelId != null
                ? Number(message.channelId)
                : currentTextChannelId != null
                  ? Number(currentTextChannelId)
                  : NaN;
        if (Number.isFinite(ch)) {
            florE2eeRetryByMessageId.set(id, { kind: 'channel', channelId: ch, raw: message.florPendingCipher });
        }
    } else if (msgCtx === 'dm') {
        const sid = message.senderId != null ? Number(message.senderId) : message.userId != null ? Number(message.userId) : NaN;
        const rid = message.receiverId != null ? Number(message.receiverId) : NaN;
        let peerId = NaN;
        if (currentUser) {
            const me = Number(currentUser.id);
            if (sid === me && Number.isFinite(rid)) peerId = rid;
            else if (Number.isFinite(sid)) peerId = sid;
        }
        if (!Number.isFinite(peerId) && currentDMUserId != null) {
            peerId = Number(currentDMUserId);
        }
        if (Number.isFinite(peerId)) {
            florE2eeRetryByMessageId.set(id, { kind: 'dm', peerId, raw: message.florPendingCipher });
        }
    }
}

async function loadDMHistory(userId) {
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.innerHTML = '';

    try {
        await florRefreshUserKeyCache();
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
                const pending = window.florE2ee && florE2ee.isE2eePayload(txt) ? txt : null;
                if (window.florE2ee) {
                    txt = await florDecryptDmLine(txt, peerId);
                }
                addMessageToUI({
                    id: message.id,
                    senderId: message.sender_id,
                    userId: message.sender_id,
                    author: message.username,
                    avatar: message.avatar || message.username.charAt(0).toUpperCase(),
                    text: txt,
                    timestamp: message.created_at,
                    reactions: message.reactions,
                    read: message.read,
                    receiverId: message.receiver_id,
                    florPendingCipher: pending
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
    void florMarkDmConversationRead(userId);
    florSyncGlobalChatSearchFromHeader();
    void florRetryPendingE2eeDecrypt();
}

florDevLog('FLOR MESSENGER initialized successfully!');
if (currentUser) {
   florDevLog('Logged in as:', currentUser.username);
}

function florPopulateDmStoriesStrip(friends) {
    const strip = document.getElementById('florDmStoriesStrip');
    if (!strip) return;
    strip.innerHTML = '';
    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.className = 'flor-dm-story flor-dm-story--search';
    searchBtn.setAttribute('aria-label', 'Поиск в личных сообщениях');
    searchBtn.title = 'Поиск';
    searchBtn.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>';
    searchBtn.addEventListener('click', () => {
        const inp = document.getElementById('dmSearchInput');
        if (inp) {
            inp.focus();
            inp.select?.();
        }
    });
    strip.appendChild(searchBtn);
    (friends || []).slice(0, 16).forEach((f) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'flor-dm-story';
        b.title = f.username;
        const av = document.createElement('div');
        av.className = 'friend-avatar flor-dm-story__av';
        florFillAvatarEl(av, f.avatar, f.username);
        b.appendChild(av);
        b.addEventListener('click', () => startDM(f.id, f.username, f.avatar));
        strip.appendChild(b);
    });
}

async function populateDMList(friends) {
    const dmList = document.getElementById('dmList');
    dmList.innerHTML = '';

    let inboxByPeer = await florFetchDmInboxMap();
    const peerIdsFromFriends = friends
        .map((f) => Number(f.id))
        .filter((id) => Number.isFinite(id));
    const missingPeerIds = peerIdsFromFriends.filter((id) => !inboxByPeer.has(id));
    if (missingPeerIds.length) {
        const fallbacks = await Promise.all(missingPeerIds.map((id) => florDmSummaryFromPeerFallback(id)));
        for (const fb of fallbacks) {
            if (fb && !inboxByPeer.has(fb.peerId)) {
                inboxByPeer.set(fb.peerId, fb);
            }
        }
    }
    if (friends.length === 0) {
        const emptyDM = document.createElement('div');
        emptyDM.className = 'flor-dm-empty-state';
        emptyDM.setAttribute('role', 'status');
        emptyDM.innerHTML = `
           <div class="flor-dm-empty-state__icon" aria-hidden="true">
               <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
           </div>
           <div class="flor-dm-empty-state__title">Пока нет переписок</div>
           <p class="flor-dm-empty-state__hint">Добавьте друга во вкладке «Добавить» — и начните личную беседу.</p>
       `;
        dmList.appendChild(emptyDM);
        return;
    }

    for (const friend of friends) {
        const peerId = Number(friend.id);
        const conv = inboxByPeer.get(peerId);
        let previewLine = 'Нет сообщений';
        let showUnread = false;
        let unreadCount = 0;
        let timeStr = '';
        if (conv && Number(conv.unreadCount) > 0) {
            showUnread = true;
            unreadCount = Number(conv.unreadCount) || 0;
        }
        if (conv && conv.lastMessage) {
            timeStr = florFormatDmTime(conv.lastMessage.created_at);
            const plain = await florDmPreviewPlaintext(peerId, conv.lastMessage.content);
            const tr = florTruncateDmPreview(florHumanizeDmPreviewLine(plain));
            if (tr) {
                const isOwn = Number(conv.lastMessage.sender_id) === Number(currentUser.id);
                previewLine = isOwn ? `Вы: ${tr}` : tr;
            } else {
                previewLine = 'Сообщение';
            }
        }

        const dmItem = document.createElement('div');
        dmItem.className = 'channel flor-dm-row';
        dmItem.setAttribute('data-dm-id', String(friend.id));
        const av = document.createElement('div');
        av.className = 'friend-avatar flor-click-profile';
        florFillAvatarEl(av, friend.avatar, friend.username);
        av.addEventListener('click', (e) => {
            e.stopPropagation();
            openFlorUserProfile(friend.id);
        });
        const main = document.createElement('div');
        main.className = 'flor-dm-row__main';
        const rowTop = document.createElement('div');
        rowTop.className = 'flor-dm-row__top';
        const nameSp = document.createElement('span');
        nameSp.className = 'flor-dm-row__name';
        nameSp.textContent = friend.username;
        const timeSp = document.createElement('span');
        timeSp.className = 'flor-dm-row__time';
        timeSp.textContent = timeStr;
        rowTop.appendChild(nameSp);
        rowTop.appendChild(timeSp);

        const rowBottom = document.createElement('div');
        rowBottom.className = 'flor-dm-row__bottom';
        const prev = document.createElement('div');
        prev.className = 'flor-dm-row__preview';
        prev.textContent = previewLine;
        const unreadDot = document.createElement('span');
        unreadDot.className = 'flor-dm-row__unread';
        unreadDot.setAttribute('aria-label', 'Непрочитанные сообщения');
        unreadDot.hidden = !showUnread;
        unreadDot.setAttribute('aria-hidden', showUnread ? 'false' : 'true');
        if (showUnread) {
            unreadDot.classList.add('flor-dm-row__unread--badge');
            unreadDot.textContent = unreadCount > 99 ? '99+' : String(Math.max(1, unreadCount));
        }
        rowBottom.appendChild(prev);
        rowBottom.appendChild(unreadDot);

        main.appendChild(rowTop);
        main.appendChild(rowBottom);
        dmItem.appendChild(av);
        dmItem.appendChild(main);
        dmItem.addEventListener('click', () => {
            startDM(friend.id, friend.username, friend.avatar);
        });
        dmList.appendChild(dmItem);
    }
}

// WebRTC Functions
/** Opus: ограничиваем битрейт под чистую речь (меньше артефактов и «шороха» на плохих сетях, чем дефолтный свист). */
async function florApplyRtcOpusVoiceTuning(pc) {
    if (!pc || typeof pc.getSenders !== 'function') return;
    try {
        const senders = pc.getSenders();
        for (const s of senders) {
            const tr = s.track;
            if (!tr || tr.kind !== 'audio') continue;
            const p = s.getParameters();
            if (!p.encodings || p.encodings.length === 0) continue;
            const next = { ...p };
            next.encodings = p.encodings.map((e, i) =>
                i === 0 ? { ...e, maxBitrate: 128000 } : { ...e }
            );
            await s.setParameters(next);
        }
    } catch (e) {
        florDevLog('florApplyRtcOpusVoiceTuning', e);
    }
}

function createPeerConnection(remoteSocketId, isInitiator) {
    florDevLog(`Creating peer connection with ${remoteSocketId}, initiator: ${isInitiator}`);

    const existing = peerConnections[remoteSocketId];
    if (existing) {
        const dead =
            existing.signalingState === 'closed' ||
            existing.connectionState === 'closed' ||
            existing.iceConnectionState === 'closed' ||
            existing.iceConnectionState === 'failed';
        if (!dead) {
            florDevLog('Peer connection already exists');
            return existing;
        }
        try {
            existing.close();
        } catch (_) {}
        delete peerConnections[remoteSocketId];
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

    // Handle incoming remote stream (аватар по умолчанию, видео только при живой камере)
    pc.ontrack = (event) => {
        florDevLog('Received remote track:', event.track.kind);
        if (
            window.currentCallDetails &&
            !window.currentCallDetails.isInitiator &&
            !florRemoteJoinSfxDone.has(remoteSocketId) &&
            (event.track.kind === 'audio' || event.track.kind === 'video')
        ) {
            florRemoteJoinSfxDone.add(remoteSocketId);
            florPlayCallSfx('join');
        }
        const remoteParticipants = document.getElementById('remoteParticipants');
        if (!remoteParticipants) return;

        let participantDiv = document.getElementById(`participant-${remoteSocketId}`);
        let remoteVideo = document.getElementById(`remote-${remoteSocketId}`);
        let avEl = null;
        const meta = florVoicePeerMeta[remoteSocketId] || {};

        if (!participantDiv) {
            participantDiv = document.createElement('div');
            participantDiv.className = 'participant';
            participantDiv.id = `participant-${remoteSocketId}`;

            avEl = document.createElement('div');
            avEl.className = 'flor-call-tile-avatar';
            florFillAvatarEl(avEl, meta.avatar, meta.username || 'Участник');

            remoteVideo = document.createElement('video');
            remoteVideo.id = `remote-${remoteSocketId}`;
            remoteVideo.className = 'flor-call-tile-video hidden';
            remoteVideo.autoplay = true;
            remoteVideo.muted = false;
            remoteVideo.playsInline = true;
            remoteVideo.setAttribute('playsinline', '');
            remoteVideo.setAttribute('webkit-playsinline', '');

            const participantName = document.createElement('div');
            participantName.className = 'participant-name';
            participantName.textContent = meta.username || 'Участник';

            participantDiv.appendChild(avEl);
            participantDiv.appendChild(remoteVideo);
            participantDiv.appendChild(participantName);
            remoteParticipants.appendChild(participantDiv);
            if (meta.userId != null) participantDiv.setAttribute('data-user-id', String(meta.userId));
        } else {
            avEl = participantDiv.querySelector('.flor-call-tile-avatar');
            remoteVideo = document.getElementById(`remote-${remoteSocketId}`);
        }

        if (event.streams && event.streams[0] && remoteVideo) {
            remoteVideo.muted = false;
            remoteVideo.srcObject = event.streams[0];
            florTryPlayMediaElement(remoteVideo);
            florApplyRemoteParticipantAudio(remoteSocketId);
            document.addEventListener(
                'pointerdown',
                () => florTryPlayMediaElement(remoteVideo),
                { capture: true, once: true }
            );
        }

        const syncVideoVisibility = () => {
            if (!remoteVideo || !remoteVideo.srcObject) return;
            const vt = remoteVideo.srcObject.getVideoTracks()[0];
            const showVid = vt && vt.enabled && vt.readyState === 'live';
            if (showVid) {
                remoteVideo.classList.remove('hidden');
                if (avEl) avEl.classList.add('hidden');
            } else {
                remoteVideo.classList.add('hidden');
                if (avEl) avEl.classList.remove('hidden');
            }
        };

        if (event.track.kind === 'video') {
            event.track.addEventListener('unmute', syncVideoVisibility);
            event.track.addEventListener('mute', syncVideoVisibility);
            event.track.addEventListener('ended', syncVideoVisibility);
            syncVideoVisibility();
        }
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
            return florApplyRtcOpusVoiceTuning(pc);
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