/**
 * Проверка: регистрация → сервер → канал → POST сообщение.
 * Запуск: сначала `npm start`, затем `node scripts/smoke-api.js`
 * Или: FLOR_TEST_URL=http://127.0.0.1:3000 node scripts/smoke-api.js
 */
const base = (process.env.FLOR_TEST_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

async function req(path, opts = {}) {
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    const r = await fetch(url, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            ...(opts.headers || {})
        }
    });
    let body = {};
    try {
        body = await r.json();
    } catch (_) {}
    return { ok: r.ok, status: r.status, body };
}

function firstTextChannelId(tree) {
    const cats = tree && tree.categories;
    if (!Array.isArray(cats)) return null;
    for (const cat of cats) {
        const chs = cat.channels || [];
        for (const c of chs) {
            const t = String(c.type == null ? '' : c.type).trim().toLowerCase();
            if (t === 'text' && c.id != null) return Number(c.id);
        }
    }
    return null;
}

async function main() {
    const email = `smoke_${Date.now()}@flor.test`;
    const password = 'smokepass12';
    const username = `u${Date.now()}`;

    let r = await req('/api/register', {
        method: 'POST',
        body: JSON.stringify({ username, email, password })
    });
    if (!r.ok) {
        console.error('register', r.status, r.body);
        process.exit(1);
    }
    const token = r.body.token;
    if (!token) {
        console.error('no token');
        process.exit(1);
    }

    const auth = { Authorization: `Bearer ${token}` };

    r = await req('/api/servers', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: `Smoke ${Date.now()}` })
    });
    if (!r.ok) {
        console.error('create server', r.status, r.body);
        process.exit(1);
    }
    const serverId = r.body.id;

    r = await req(`/api/servers/${serverId}/channels`, {
        headers: auth
    });
    if (!r.ok) {
        console.error('channels', r.status, r.body);
        process.exit(1);
    }
    const chId = firstTextChannelId(r.body);
    if (chId == null || !Number.isFinite(chId)) {
        console.error('no text channel in tree', JSON.stringify(r.body).slice(0, 500));
        process.exit(1);
    }

    r = await req('/api/messages', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ channelId: chId, text: 'smoke test message' })
    });
    if (!r.ok) {
        console.error('post message', r.status, r.body);
        process.exit(1);
    }

    console.log('OK: сообщение в группе (один участник) отправлено, id=', r.body.message && r.body.message.id);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
