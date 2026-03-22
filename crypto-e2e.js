/**
 * E2EE: сообщения на сервере только в виде AES-GCM конверта (сервер не знает ключ).
 * ЛС: общий ключ из ECDH P-256 между участниками.
 * Каналы: общий симметричный ключ канала, на сервере — обёртки ECDH для каждого участника.
 */
(function () {
    const PRIV_STORAGE = 'florE2ee_identity_private_jwk_v1';
    const CH_KEY_PREFIX = 'florE2ee_ch_';

    /** Без HTTPS (и не localhost) Chrome/Firefox не дают Web Crypto → ключи E2EE невозможны */
    function isWebCryptoE2eeAvailable() {
        try {
            if (typeof crypto === 'undefined' || !crypto.subtle) return false;
            if (typeof window !== 'undefined' && window.isSecureContext === false) return false;
            return true;
        } catch (_) {
            return false;
        }
    }

    function bytesToB64(bytes) {
        let bin = '';
        bytes.forEach((b) => {
            bin += String.fromCharCode(b);
        });
        return btoa(bin);
    }

    function b64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function isE2eePayload(s) {
        if (typeof s !== 'string') return false;
        const t = s.trim();
        if (!t.startsWith('{')) return false;
        try {
            const o = JSON.parse(t);
            if (!o) return false;
            const v = Number(o.florE2ee);
            if (v === 1 && o.iv && o.ct) return true;
            if (v === 2 && o.iv && o.ct && Array.isArray(o.wraps) && o.wraps.length > 0) return true;
            return false;
        } catch (_) {
            return false;
        }
    }

    async function importPublicJwk(jwk) {
        return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    }

    async function importPrivateJwk(jwk) {
        return crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveKey', 'deriveBits']
        );
    }

    async function deriveAesGcm256(privateKey, publicKey) {
        return crypto.subtle.deriveKey(
            { name: 'ECDH', public: publicKey },
            privateKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async function aesGcmEncryptUtf8(aesKey, text) {
        const enc = new TextEncoder();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(text))
        );
        return { iv: bytesToB64(iv), ct: bytesToB64(ct) };
    }

    async function aesGcmDecryptUtf8(aesKey, ivB64, ctB64) {
        const iv = b64ToBytes(ivB64);
        const ct = b64ToBytes(ctB64);
        const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
        return new TextDecoder().decode(buf);
    }

    async function encryptRawKeyWithAes(aesKey, raw32) {
        const b64 = bytesToB64(raw32);
        const { iv, ct } = await aesGcmEncryptUtf8(aesKey, b64);
        return JSON.stringify({ florWrap: 1, iv, ct });
    }

    async function decryptRawKeyWithAes(aesKey, wrapStr) {
        const o = JSON.parse(wrapStr);
        if (!o || Number(o.florWrap) !== 1) throw new Error('BAD_WRAP');
        const b64 = await aesGcmDecryptUtf8(aesKey, o.iv, o.ct);
        return b64ToBytes(b64);
    }

    async function getOrCreateIdentityPrivateJwk() {
        const raw = localStorage.getItem(PRIV_STORAGE);
        if (raw) {
            try {
                return JSON.parse(raw);
            } catch (_) {}
        }
        const pair = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveKey', 'deriveBits']
        );
        const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
        localStorage.setItem(PRIV_STORAGE, JSON.stringify(privJwk));
        return privJwk;
    }

    async function publicJwkFromPrivateJwk(privJwk) {
        const { d, dp, dq, qi, p, q, ...pub } = privJwk;
        void d;
        void dp;
        void dq;
        void qi;
        void p;
        void q;
        pub.key_ops = [];
        return pub;
    }

    let cachedGetPeerJwks = null;

    async function getMyPrivateCryptoKey() {
        const privJwk = await getOrCreateIdentityPrivateJwk();
        return importPrivateJwk(privJwk);
    }

    async function uploadPublicKey(florApi, token) {
        const privJwk = await getOrCreateIdentityPrivateJwk();
        const pubJwk = await publicJwkFromPrivateJwk(privJwk);
        const r = await fetch(florApi('/api/user/identity-key'), {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ publicJwk: pubJwk })
        });
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.error || 'identity-key failed');
        }
    }

    async function encryptDmPlaintextImpl(peerId, text, getPeerJwks) {
        if (typeof getPeerJwks !== 'function') {
            throw new Error('Внутренняя ошибка: нет резолвера ключей собеседника');
        }
        const peerJwks = await getPeerJwks(peerId);
        const list = Array.isArray(peerJwks) ? peerJwks.filter(Boolean) : peerJwks ? [peerJwks] : [];
        if (!list.length) {
            throw new Error(
                'Нет ключа шифрования у собеседника. ' +
                    'Если сайт открыт по http:// без SSL, браузер не создаёт ключи — подключите HTTPS (Nginx + Let\'s Encrypt). ' +
                    'Если уже HTTPS — пусть собеседник откроет мессенджер и нажмёт Ctrl+F5.'
            );
        }
        const myPriv = await getMyPrivateCryptoKey();
        const sessionRaw = crypto.getRandomValues(new Uint8Array(32));
        const sessionKey = await crypto.subtle.importKey('raw', sessionRaw, 'AES-GCM', false, ['encrypt']);
        const enc = new TextEncoder();
        const ivMsg = crypto.getRandomValues(new Uint8Array(12));
        const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivMsg }, sessionKey, enc.encode(text));
        const wraps = [];
        for (const pj of list) {
            const peerPub = await importPublicJwk(pj);
            const aes = await deriveAesGcm256(myPriv, peerPub);
            wraps.push(await encryptRawKeyWithAes(aes, sessionRaw));
        }
        return JSON.stringify({
            florE2ee: 2,
            iv: bytesToB64(ivMsg),
            ct: bytesToB64(new Uint8Array(ctBuf)),
            wraps
        });
    }

    async function decryptDmPayloadImpl(cipherJson, peerId, getPeerJwks) {
        if (!isE2eePayload(cipherJson)) return cipherJson;
        if (typeof getPeerJwks !== 'function') {
            return '🔒 Не удалось расшифровать';
        }
        const peerJwksRaw = await getPeerJwks(peerId);
        const peerJwks = Array.isArray(peerJwksRaw) ? peerJwksRaw.filter(Boolean) : peerJwksRaw ? [peerJwksRaw] : [];
        if (!peerJwks.length) return '🔒 Не удалось расшифровать (нет ключа собеседника)';
        const myPriv = await getMyPrivateCryptoKey();
        let o;
        try {
            o = JSON.parse(cipherJson.trim());
        } catch (_) {
            return '🔒 Не удалось расшифровать сообщение';
        }
        const ver = Number(o.florE2ee);
        try {
            if (ver === 2 && o.iv && o.ct && Array.isArray(o.wraps)) {
                for (const wrapStr of o.wraps) {
                    if (typeof wrapStr !== 'string') continue;
                    for (const jwk of peerJwks) {
                        try {
                            const peerPub = await importPublicJwk(jwk);
                            const aes = await deriveAesGcm256(myPriv, peerPub);
                            const rawK = await decryptRawKeyWithAes(aes, wrapStr);
                            if (rawK.length !== 32) continue;
                            const sk = await crypto.subtle.importKey('raw', rawK, 'AES-GCM', false, ['decrypt']);
                            const buf = await crypto.subtle.decrypt(
                                { name: 'AES-GCM', iv: b64ToBytes(o.iv) },
                                sk,
                                b64ToBytes(o.ct)
                            );
                            return new TextDecoder().decode(buf);
                        } catch (_) {
                            /* пробуем следующий ключ / обёртку */
                        }
                    }
                }
                return '🔒 Не удалось расшифровать сообщение';
            }
            if (ver === 1 && o.iv && o.ct) {
                for (const jwk of peerJwks) {
                    try {
                        const peerPub = await importPublicJwk(jwk);
                        const aes = await deriveAesGcm256(myPriv, peerPub);
                        return await aesGcmDecryptUtf8(aes, o.iv, o.ct);
                    } catch (_) {
                        /* другой публичный ключ собеседника (другое устройство) */
                    }
                }
            }
        } catch (_) {
            return '🔒 Не удалось расшифровать сообщение';
        }
        return '🔒 Не удалось расшифровать сообщение';
    }

    async function encryptWithChannelKey(rawKey32, text) {
        const aesKey = await crypto.subtle.importKey('raw', rawKey32, 'AES-GCM', false, ['encrypt', 'decrypt']);
        const { iv, ct } = await aesGcmEncryptUtf8(aesKey, text);
        return JSON.stringify({ florE2ee: 1, iv, ct });
    }

    async function decryptWithChannelKey(rawKey32, cipherJson) {
        if (!isE2eePayload(cipherJson)) return cipherJson;
        const aesKey = await crypto.subtle.importKey('raw', rawKey32, 'AES-GCM', false, ['encrypt', 'decrypt']);
        try {
            const o = JSON.parse(cipherJson.trim());
            return await aesGcmDecryptUtf8(aesKey, o.iv, o.ct);
        } catch (_) {
            return '🔒 Не удалось расшифровать';
        }
    }

    async function ensureChannelKey(channelId, serverId, florApi, token, userId, fetchMembersJson) {
        const cacheKey = CH_KEY_PREFIX + channelId;
        const existing = sessionStorage.getItem(cacheKey);
        if (existing) return b64ToBytes(existing);

        const headers = { Authorization: `Bearer ${token}` };
        const wrapRes = await fetch(florApi(`/api/channels/${channelId}/e2e-wrap`), { headers });
        if (wrapRes.ok) {
            const j = await wrapRes.json();
            const fromId = j.fromUserId;
            const peerList = await cachedGetPeerJwks(fromId);
            const peerJwk = Array.isArray(peerList) ? peerList[0] : peerList;
            if (!peerJwk) {
                throw new Error('Нет публичного ключа того, кто выдал ключ канала. Обновите список участников.');
            }
            const myPriv = await getMyPrivateCryptoKey();
            const aes = await deriveAesGcm256(myPriv, await importPublicJwk(peerJwk));
            const raw = await decryptRawKeyWithAes(aes, j.wrap);
            if (raw.length !== 32) throw new Error('BAD_CHANNEL_KEY');
            sessionStorage.setItem(cacheKey, bytesToB64(raw));
            return raw;
        }

        if (wrapRes.status !== 404) {
            const err = await wrapRes.json().catch(() => ({}));
            throw new Error(err.error || 'Ошибка доступа к ключу канала');
        }

        const cov = await fetch(florApi(`/api/channels/${channelId}/e2e-wrap-recipients`), { headers });
        if (cov.ok) {
            const { userIds = [] } = await cov.json();
            if (userIds.length > 0) {
                throw new Error(
                    'Ключ канала ещё не передан вам. Пусть участник, у которого уже работал этот канал, откроет его снова — ключ подтянется автоматически.'
                );
            }
        }

        const members = await fetchMembersJson(serverId);
        const keyRaw = crypto.getRandomValues(new Uint8Array(32));
        const myPriv = await getMyPrivateCryptoKey();
        const wraps = [];
        for (const m of members) {
            if (m.id === userId) continue;
            if (!m.identityPublicJwk) continue;
            const pub = await importPublicJwk(m.identityPublicJwk);
            const aes = await deriveAesGcm256(myPriv, pub);
            const wrap = await encryptRawKeyWithAes(aes, keyRaw);
            wraps.push({ userId: m.id, wrap });
        }
        if (wraps.length > 0) {
            const post = await fetch(florApi(`/api/channels/${channelId}/e2e-wraps`), {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ wraps })
            });
            if (!post.ok) {
                const err = await post.json().catch(() => ({}));
                throw new Error(err.error || 'Не удалось опубликовать ключи канала');
            }
        }
        sessionStorage.setItem(cacheKey, bytesToB64(keyRaw));
        return keyRaw;
    }

    async function redistributeMissingWraps(channelId, serverId, florApi, token, userId, fetchMembersJson) {
        const cacheKey = CH_KEY_PREFIX + channelId;
        const b64 = sessionStorage.getItem(cacheKey);
        if (!b64) return;
        const keyRaw = b64ToBytes(b64);
        const headers = { Authorization: `Bearer ${token}` };
        const r = await fetch(florApi(`/api/channels/${channelId}/e2e-wrap-recipients`), { headers });
        if (!r.ok) return;
        const { userIds = [] } = await r.json();
        const wrapped = new Set(userIds);
        const members = await fetchMembersJson(serverId);
        const myPriv = await getMyPrivateCryptoKey();
        const wraps = [];
        for (const m of members) {
            if (m.id === userId) continue;
            if (wrapped.has(m.id)) continue;
            if (!m.identityPublicJwk) continue;
            const pub = await importPublicJwk(m.identityPublicJwk);
            const aes = await deriveAesGcm256(myPriv, pub);
            wraps.push({ userId: m.id, wrap: await encryptRawKeyWithAes(aes, keyRaw) });
        }
        if (!wraps.length) return;
        await fetch(florApi(`/api/channels/${channelId}/e2e-wraps`), {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ wraps })
        });
    }

    if (!isWebCryptoE2eeAvailable()) {
        window.florE2ee = {
            isE2eePayload,
            isActive() {
                return false;
            },
            httpsHint:
                'Шифрование в браузере доступно только по HTTPS (или localhost). Подключите сертификат на сервере — сообщения по HTTP идут без E2EE.',
            async init(_florApi, _token, getPeerJwksFn) {
                if (typeof getPeerJwksFn === 'function') cachedGetPeerJwks = getPeerJwksFn;
            },
            setPeerKeyResolver(fn) {
                cachedGetPeerJwks = fn;
            },
            async encryptDmPlaintext(_peerId, text) {
                return text;
            },
            async decryptDmPayload(cipherJson) {
                return isE2eePayload(cipherJson)
                    ? '🔒 Сообщение зашифровано. Откройте мессенджер по HTTPS (SSL), чтобы прочитать.'
                    : cipherJson;
            },
            async ensureChannelKey() {
                return null;
            },
            async redistributeMissingWraps() {},
            async encryptWithChannelKey(_raw, text) {
                return text;
            },
            async decryptWithChannelKey(_raw, cipherJson) {
                return isE2eePayload(cipherJson)
                    ? '🔒 Зашифровано. Нужен HTTPS.'
                    : cipherJson;
            }
        };
        return;
    }

    window.florE2ee = {
        isE2eePayload,
        isActive() {
            return true;
        },
        httpsHint: '',
        async init(florApi, token, getPeerJwksFn) {
            cachedGetPeerJwks = getPeerJwksFn;
            await uploadPublicKey(florApi, token);
        },
        setPeerKeyResolver(fn) {
            cachedGetPeerJwks = fn;
        },
        encryptDmPlaintext(peerId, text) {
            return encryptDmPlaintextImpl(peerId, text, cachedGetPeerJwks);
        },
        decryptDmPayload(cipherJson, peerId) {
            return decryptDmPayloadImpl(cipherJson, peerId, cachedGetPeerJwks);
        },
        ensureChannelKey,
        redistributeMissingWraps,
        encryptWithChannelKey,
        decryptWithChannelKey
    };
})();
