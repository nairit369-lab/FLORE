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

    /** Плоский список JWK (в т.ч. из вложенных массивов — иначе importKey получает массив и падает) */
    function flattenPeerIdentityJwksPayload(raw) {
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

    function identityJwksFromMemberRow(m) {
        if (!m) return [];
        if (Array.isArray(m.identityPublicJwks) && m.identityPublicJwks.length) {
            return flattenPeerIdentityJwksPayload(m.identityPublicJwks);
        }
        if (m.identityPublicJwk) return flattenPeerIdentityJwksPayload([m.identityPublicJwk]);
        return [];
    }

    function normalizeDmCipherInput(cipherJson) {
        if (typeof cipherJson === 'string') return cipherJson;
        if (cipherJson && typeof cipherJson === 'object' && cipherJson.florE2ee != null) {
            try {
                return JSON.stringify(cipherJson);
            } catch (_) {}
        }
        return cipherJson;
    }

    function normalizeWrapEntry(w) {
        if (typeof w === 'string') return w;
        if (w && typeof w === 'object') {
            try {
                return JSON.stringify(w);
            } catch (_) {}
        }
        return null;
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
    /** id текущего пользователя — для ЛС: обёртки на все свои устройства и расшифровка с учётом ключей обеих сторон */
    let cachedLocalUserId = null;

    function jwkXYFingerprint(jwk) {
        if (!jwk || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return '';
        return `${jwk.x}|${jwk.y}`;
    }

    function dedupeJwks(list) {
        const seen = new Set();
        const out = [];
        for (const j of list) {
            const fp = jwkXYFingerprint(j);
            if (!fp || seen.has(fp)) continue;
            seen.add(fp);
            out.push(j);
        }
        return out;
    }

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
        let peerJwksRaw;
        try {
            peerJwksRaw = await getPeerJwks(peerId);
        } catch (e) {
            throw new Error('Не удалось загрузить ключи собеседника для шифрования');
        }
        const list = dedupeJwks(
            flattenPeerIdentityJwksPayload(
                Array.isArray(peerJwksRaw) ? peerJwksRaw : peerJwksRaw ? [peerJwksRaw] : []
            )
        );
        if (!list.length) {
            throw new Error(
                'Нет ключа шифрования у собеседника. ' +
                    'Если сайт открыт по http:// без SSL, браузер не создаёт ключи — подключите HTTPS (Nginx + Let\'s Encrypt). ' +
                    'Если уже HTTPS — пусть собеседник откроет мессенджер и нажмёт Ctrl+F5.'
            );
        }
        const myPriv = await getMyPrivateCryptoKey();
        const privJwk = await getOrCreateIdentityPrivateJwk();
        const myPubJwk = await publicJwkFromPrivateJwk(privJwk);
        const selfFp = jwkXYFingerprint(myPubJwk);

        /** Обёртки для всех устройств собеседника + всех ваших других устройств (читать «свои» отправленные с ПК на телефоне) */
        const wrapTargets = dedupeJwks([...list]);
        if (cachedLocalUserId != null && Number.isFinite(Number(cachedLocalUserId))) {
            try {
                const mineRaw = await getPeerJwks(Number(cachedLocalUserId));
                const mine = dedupeJwks(
                    flattenPeerIdentityJwksPayload(
                        Array.isArray(mineRaw) ? mineRaw : mineRaw ? [mineRaw] : []
                    )
                );
                for (const j of mine) {
                    if (jwkXYFingerprint(j) === selfFp) continue;
                    wrapTargets.push(j);
                }
            } catch (_) {}
        }

        const sessionRaw = crypto.getRandomValues(new Uint8Array(32));
        const sessionKey = await crypto.subtle.importKey('raw', sessionRaw, 'AES-GCM', false, ['encrypt']);
        const enc = new TextEncoder();
        const ivMsg = crypto.getRandomValues(new Uint8Array(12));
        const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivMsg }, sessionKey, enc.encode(text));
        const wraps = [];
        for (const pj of wrapTargets) {
            try {
                const peerPub = await importPublicJwk(pj);
                const aes = await deriveAesGcm256(myPriv, peerPub);
                wraps.push(await encryptRawKeyWithAes(aes, sessionRaw));
            } catch (_) {}
        }
        if (!wraps.length) {
            throw new Error('Не удалось сформировать обёртки ключа сообщения');
        }
        return JSON.stringify({
            florE2ee: 2,
            iv: bytesToB64(ivMsg),
            ct: bytesToB64(new Uint8Array(ctBuf)),
            wraps
        });
    }

    async function decryptDmPayloadImpl(cipherJson, peerId, getPeerJwks) {
        const cipherStr = normalizeDmCipherInput(cipherJson);
        if (typeof cipherStr !== 'string' || !isE2eePayload(cipherStr)) return cipherJson;
        if (typeof getPeerJwks !== 'function') {
            return '🔒 Не удалось расшифровать';
        }
        let peerJwksRaw;
        try {
            peerJwksRaw = await getPeerJwks(peerId);
        } catch (_) {
            return '🔒 Не удалось расшифровать';
        }
        let peerJwks = flattenPeerIdentityJwksPayload(
            Array.isArray(peerJwksRaw) ? peerJwksRaw : peerJwksRaw ? [peerJwksRaw] : []
        );
        if (cachedLocalUserId != null && Number.isFinite(Number(cachedLocalUserId))) {
            try {
                const selfRaw = await getPeerJwks(Number(cachedLocalUserId));
                const selfList = flattenPeerIdentityJwksPayload(
                    Array.isArray(selfRaw) ? selfRaw : selfRaw ? [selfRaw] : []
                );
                peerJwks = dedupeJwks([...peerJwks, ...selfList]);
            } catch (_) {}
        } else {
            peerJwks = dedupeJwks(peerJwks);
        }
        if (!peerJwks.length) return '🔒 Не удалось расшифровать (нет ключа собеседника)';
        const myPriv = await getMyPrivateCryptoKey();
        let o;
        try {
            o = JSON.parse(cipherStr.trim());
        } catch (_) {
            return '🔒 Не удалось расшифровать сообщение';
        }
        const ver = Number(o.florE2ee);
        try {
            if (ver === 2 && o.iv && o.ct && Array.isArray(o.wraps)) {
                const wrapStrs = [];
                for (const w of o.wraps) {
                    const ws = normalizeWrapEntry(w);
                    if (ws) wrapStrs.push(ws);
                }
                if (!wrapStrs.length) {
                    return '🔒 Не удалось расшифровать сообщение';
                }
                for (const wrapStr of wrapStrs) {
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
        const s = normalizeDmCipherInput(cipherJson);
        if (typeof s !== 'string' || !isE2eePayload(s)) return cipherJson;
        const aesKey = await crypto.subtle.importKey('raw', rawKey32, 'AES-GCM', false, ['encrypt', 'decrypt']);
        try {
            const o = JSON.parse(s.trim());
            return await aesGcmDecryptUtf8(aesKey, o.iv, o.ct);
        } catch (_) {
            return '🔒 Не удалось расшифровать';
        }
    }

    /** Синхронно с server.js parseChannelKeyWrapEntries */
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

    async function ensureChannelKey(channelId, serverId, florApi, token, userId, fetchMembersJson) {
        const cacheKey = CH_KEY_PREFIX + channelId;
        const existing = sessionStorage.getItem(cacheKey);
        if (existing) return b64ToBytes(existing);

        const headers = { Authorization: `Bearer ${token}` };
        const wrapRes = await fetch(florApi(`/api/channels/${channelId}/e2e-wrap`), { headers });
        if (wrapRes.ok) {
            const j = await wrapRes.json();
            const entries = parseChannelKeyWrapEntries(
                typeof j.wrap === 'string' ? j.wrap : '',
                j.fromUserId != null ? j.fromUserId : null
            );
            if (!entries.length) {
                throw new Error('Некорректная обёртка ключа канала. Обновите страницу.');
            }
            const myPriv = await getMyPrivateCryptoKey();
            let raw = null;
            let lastErr = null;
            for (const { fromUserId, wrapStr } of entries) {
                let peerList = [];
                try {
                    const rawList = await cachedGetPeerJwks(fromUserId);
                    peerList = flattenPeerIdentityJwksPayload(
                        Array.isArray(rawList) ? rawList : rawList ? [rawList] : []
                    );
                } catch (_) {
                    peerList = [];
                }
                if (!peerList.length) continue;
                for (const peerJwk of peerList) {
                    try {
                        const aes = await deriveAesGcm256(myPriv, await importPublicJwk(peerJwk));
                        const r = await decryptRawKeyWithAes(aes, wrapStr);
                        if (r.length === 32) {
                            raw = r;
                            break;
                        }
                    } catch (e) {
                        lastErr = e;
                    }
                }
                if (raw) break;
            }
            if (!raw) {
                throw new Error(
                    lastErr && lastErr.message
                        ? `Не удалось развернуть ключ канала: ${lastErr.message}`
                        : 'Не удалось развернуть ключ канала (попробуйте обновить страницу).'
                );
            }
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
            const jwks = identityJwksFromMemberRow(m);
            if (!jwks.length) continue;
            for (const pubJwk of jwks) {
                try {
                    const pub = await importPublicJwk(pubJwk);
                    const aes = await deriveAesGcm256(myPriv, pub);
                    const wrap = await encryptRawKeyWithAes(aes, keyRaw);
                    wraps.push({ userId: m.id, wrap });
                } catch (_) {}
            }
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
        const members = await fetchMembersJson(serverId);
        const myPriv = await getMyPrivateCryptoKey();
        const wraps = [];
        for (const m of members) {
            if (m.id === userId) continue;
            const jwks = identityJwksFromMemberRow(m);
            if (!jwks.length) continue;
            for (const pubJwk of jwks) {
                try {
                    const pub = await importPublicJwk(pubJwk);
                    const aes = await deriveAesGcm256(myPriv, pub);
                    wraps.push({ userId: m.id, wrap: await encryptRawKeyWithAes(aes, keyRaw) });
                } catch (_) {}
            }
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
            async init(_florApi, _token, getPeerJwksFn, localUserId) {
                if (typeof getPeerJwksFn === 'function') cachedGetPeerJwks = getPeerJwksFn;
                cachedLocalUserId =
                    localUserId != null && Number.isFinite(Number(localUserId)) ? Number(localUserId) : null;
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
        async init(florApi, token, getPeerJwksFn, localUserId) {
            cachedGetPeerJwks = getPeerJwksFn;
            cachedLocalUserId =
                localUserId != null && Number.isFinite(Number(localUserId)) ? Number(localUserId) : null;
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
