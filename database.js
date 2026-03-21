const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'discord_clone.db');
const db = new sqlite3.Database(dbPath);

// Initialize database tables
function initializeDatabase() {
    db.serialize(() => {
        // Users table
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                avatar TEXT,
                status TEXT DEFAULT 'Online',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Servers table
        db.run(`
            CREATE TABLE IF NOT EXISTS servers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                icon TEXT,
                owner_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_id) REFERENCES users(id)
            )
        `);

        // Channel categories (сервер → категории → каналы)
        db.run(`
            CREATE TABLE IF NOT EXISTS channel_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                FOREIGN KEY (server_id) REFERENCES servers(id)
            )
        `);

        // Channels table
        db.run(`
            CREATE TABLE IF NOT EXISTS channels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                server_id INTEGER,
                category_id INTEGER,
                position INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (server_id) REFERENCES servers(id),
                FOREIGN KEY (category_id) REFERENCES channel_categories(id)
            )
        `);

        // Messages table
        db.run(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                user_id INTEGER,
                channel_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (channel_id) REFERENCES channels(id)
            )
        `);

        // Direct messages table
        db.run(`
            CREATE TABLE IF NOT EXISTS direct_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                sender_id INTEGER,
                receiver_id INTEGER,
                read BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (sender_id) REFERENCES users(id),
                FOREIGN KEY (receiver_id) REFERENCES users(id)
            )
        `);

        // File uploads table
        db.run(`
            CREATE TABLE IF NOT EXISTS file_uploads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                filetype TEXT,
                filesize INTEGER,
                user_id INTEGER,
                channel_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (channel_id) REFERENCES channels(id)
            )
        `);

        // Reactions table
        db.run(`
            CREATE TABLE IF NOT EXISTS reactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                emoji TEXT NOT NULL,
                message_id INTEGER,
                user_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (message_id) REFERENCES messages(id),
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(message_id, user_id, emoji)
            )
        `);

        // Server members table
        db.run(`
            CREATE TABLE IF NOT EXISTS server_members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id INTEGER,
                user_id INTEGER,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (server_id) REFERENCES servers(id),
                FOREIGN KEY (user_id) REFERENCES users(id),
                UNIQUE(server_id, user_id)
            )
        `);

        // Friends table
        db.run(`
            CREATE TABLE IF NOT EXISTS friends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                friend_id INTEGER,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (friend_id) REFERENCES users(id),
                UNIQUE(user_id, friend_id)
            )
        `);

        console.log('Database initialized successfully');
    });
}

// User operations
const userDB = {
    create: (username, email, hashedPassword) => {
        return new Promise((resolve, reject) => {
            const sql = 'INSERT INTO users (username, email, password) VALUES (?, ?, ?)';
            db.run(sql, [username, email, hashedPassword], function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, username, email });
            });
        });
    },

    findByEmail: (email) => {
        return new Promise((resolve, reject) => {
            const sql = 'SELECT * FROM users WHERE email = ?';
            db.get(sql, [email], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    },

    findByUsername: (username) => {
        const t = String(username || '').trim();
        return new Promise((resolve, reject) => {
            const sql =
                'SELECT id, username, email, avatar, status FROM users WHERE LOWER(username) = LOWER(?)';
            db.get(sql, [t], (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });
    },

    findById: (id) => {
        return new Promise((resolve, reject) => {
            const sql = 'SELECT id, username, email, avatar, status FROM users WHERE id = ?';
            db.get(sql, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    },

    updateStatus: (id, status) => {
        return new Promise((resolve, reject) => {
            const sql = 'UPDATE users SET status = ? WHERE id = ?';
            db.run(sql, [status, id], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    },

    updateAvatar: (id, avatar) => {
        return new Promise((resolve, reject) => {
            const sql = 'UPDATE users SET avatar = ? WHERE id = ?';
            db.run(sql, [avatar, id], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    },

    getAll: () => {
        return new Promise((resolve, reject) => {
            const sql = 'SELECT id, username, email, avatar, status, identity_public_jwk FROM users';
            db.all(sql, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },

    setIdentityPublicJwk: (userId, jwkJson) => {
        const s = typeof jwkJson === 'string' ? jwkJson : JSON.stringify(jwkJson);
        return new Promise((resolve, reject) => {
            db.run('UPDATE users SET identity_public_jwk = ? WHERE id = ?', [s, userId], function (err) {
                if (err) reject(err);
                else resolve({ changes: this.changes });
            });
        });
    },

    getIdentityPublicJwk: (userId) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT identity_public_jwk FROM users WHERE id = ?', [userId], (err, row) => {
                if (err) reject(err);
                else resolve(row && row.identity_public_jwk ? row.identity_public_jwk : null);
            });
        });
    },

    findWithPasswordById: (id) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });
    },

    updatePassword: (id, hashedPassword) => {
        return new Promise((resolve, reject) => {
            db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, id], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
};

// Message operations
const messageDB = {
    create: (content, userId, channelId) => {
        return new Promise((resolve, reject) => {
            const sql = 'INSERT INTO messages (content, user_id, channel_id) VALUES (?, ?, ?)';
            db.run(sql, [content, userId, channelId], function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, content, userId, channelId });
            });
        });
    },

    getByChannel: (channelId, limit = 50) => {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT m.*, u.username, u.avatar 
                FROM messages m 
                JOIN users u ON m.user_id = u.id 
                WHERE m.channel_id = ? 
                ORDER BY m.created_at DESC 
                LIMIT ?
            `;
            db.all(sql, [channelId, limit], (err, rows) => {
                if (err) reject(err);
                else resolve(rows.reverse());
            });
        });
    },

    getChannelIdForMessage: (messageId) => {
        return new Promise((resolve, reject) => {
            const sql = 'SELECT channel_id FROM messages WHERE id = ?';
            db.get(sql, [messageId], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.channel_id : null);
            });
        });
    }
};

// Категории каналов на сервере
const categoryDB = {
    create: (serverId, name, sortOrder = 0) => {
        return new Promise((resolve, reject) => {
            const sql = 'INSERT INTO channel_categories (server_id, name, sort_order) VALUES (?, ?, ?)';
            db.run(sql, [serverId, name, sortOrder], function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, server_id: serverId, name, sort_order: sortOrder });
            });
        });
    },

    listByServer: (serverId) => {
        return new Promise((resolve, reject) => {
            const sql =
                'SELECT id, server_id, name, sort_order FROM channel_categories WHERE server_id = ? ORDER BY sort_order ASC, id ASC';
            db.all(sql, [serverId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }
};

// Channel operations
const channelDB = {
    create: (name, type, serverId, categoryId = null, position = 0) => {
        return new Promise((resolve, reject) => {
            const sql =
                'INSERT INTO channels (name, type, server_id, category_id, position) VALUES (?, ?, ?, ?, ?)';
            db.run(sql, [name, type, serverId, categoryId, position], function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, name, type, serverId, category_id: categoryId, position });
            });
        });
    },

    getById: (id) => {
        return new Promise((resolve, reject) => {
            const sql = 'SELECT id, name, type, server_id, category_id, position FROM channels WHERE id = ?';
            db.get(sql, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });
    },

    getByServerId: (serverId) => {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT id, name, type, server_id, category_id, position
                FROM channels
                WHERE server_id = ?
                ORDER BY (category_id IS NULL), category_id, position, id
            `;
            db.all(sql, [serverId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    },

    /** Проверка уникальности имени канала на сервере (без учёта регистра ASCII) */
    nameExistsOnServer: (serverId, name) => {
        const n = String(name || '').trim();
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM channels WHERE server_id = ? AND LOWER(name) = LOWER(?)',
                [serverId, n],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(!!row);
                }
            );
        });
    },

    nextPosition: (serverId, categoryId) => {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ? AND category_id = ?',
                [serverId, categoryId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row && row.p != null ? row.p : 0);
                }
            );
        });
    }
};

// Direct message operations
const dmDB = {
    create: (content, senderId, receiverId) => {
        return new Promise((resolve, reject) => {
            const sql = 'INSERT INTO direct_messages (content, sender_id, receiver_id) VALUES (?, ?, ?)';
            db.run(sql, [content, senderId, receiverId], function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, content, senderId, receiverId });
            });
        });
    },

    getConversation: (userId1, userId2, limit = 50) => {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT dm.*, u.username, u.avatar 
                FROM direct_messages dm 
                JOIN users u ON dm.sender_id = u.id 
                WHERE (dm.sender_id = ? AND dm.receiver_id = ?) 
                   OR (dm.sender_id = ? AND dm.receiver_id = ?)
                ORDER BY dm.created_at DESC 
                LIMIT ?
            `;
            db.all(sql, [userId1, userId2, userId2, userId1, limit], (err, rows) => {
                if (err) reject(err);
                else resolve(rows.reverse());
            });
        });
    },

    markAsRead: (messageId) => {
        return new Promise((resolve, reject) => {
            const sql = 'UPDATE direct_messages SET read = 1 WHERE id = ?';
            db.run(sql, [messageId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
};

/** Обёртки ключа канала (E2EE): сервер хранит только opaque blob */
const channelKeyWrapDB = {
    upsert: (channelId, targetUserId, fromUserId, wrap) => {
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT OR REPLACE INTO channel_key_wraps (channel_id, user_id, from_user_id, wrap)
                VALUES (?, ?, ?, ?)
            `;
            db.run(sql, [channelId, targetUserId, fromUserId, wrap], function (err) {
                if (err) reject(err);
                else resolve({ changes: this.changes });
            });
        });
    },

    getForUser: (channelId, userId) => {
        return new Promise((resolve, reject) => {
            const sql =
                'SELECT wrap, from_user_id FROM channel_key_wraps WHERE channel_id = ? AND user_id = ?';
            db.get(sql, [channelId, userId], (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });
    },

    listWrappedUserIds: (channelId) => {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT user_id FROM channel_key_wraps WHERE channel_id = ?',
                [channelId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve((rows || []).map((r) => r.user_id));
                }
            );
        });
    }
};

// File operations
const fileDB = {
    create: (filename, filepath, filetype, filesize, userId, channelId) => {
        return new Promise((resolve, reject) => {
            const sql = 'INSERT INTO file_uploads (filename, filepath, filetype, filesize, user_id, channel_id) VALUES (?, ?, ?, ?, ?, ?)';
            db.run(sql, [filename, filepath, filetype, filesize, userId, channelId], function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, filename, filepath });
            });
        });
    },

    getByChannel: (channelId) => {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT f.*, u.username 
                FROM file_uploads f 
                JOIN users u ON f.user_id = u.id 
                WHERE f.channel_id = ? 
                ORDER BY f.created_at DESC
            `;
            db.all(sql, [channelId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }
};

// Reaction operations
const reactionDB = {
    add: (emoji, messageId, userId) => {
        return new Promise((resolve, reject) => {
            const sql = 'INSERT OR IGNORE INTO reactions (emoji, message_id, user_id) VALUES (?, ?, ?)';
            db.run(sql, [emoji, messageId, userId], function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, emoji, messageId, userId });
            });
        });
    },

    remove: (emoji, messageId, userId) => {
        return new Promise((resolve, reject) => {
            const sql = 'DELETE FROM reactions WHERE emoji = ? AND message_id = ? AND user_id = ?';
            db.run(sql, [emoji, messageId, userId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    },

    getByMessage: (messageId) => {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT r.emoji, COUNT(*) as count, GROUP_CONCAT(u.username) as users
                FROM reactions r
                JOIN users u ON r.user_id = u.id
                WHERE r.message_id = ?
                GROUP BY r.emoji
            `;
            db.all(sql, [messageId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }
};

// Friend operations
const friendDB = {
    sendRequest: (userId, friendId) => {
        return new Promise((resolve, reject) => {
            const sql = 'INSERT OR IGNORE INTO friends (user_id, friend_id, status) VALUES (?, ?, "pending")';
            db.run(sql, [userId, friendId], function(err) {
                if (err) reject(err);
                else resolve({ changes: this.changes });
            });
        });
    },

    acceptRequest: (userId, friendId) => {
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                // Update the request status
                const sql1 = 'UPDATE friends SET status = "accepted" WHERE user_id = ? AND friend_id = ?';
                db.run(sql1, [friendId, userId], (err) => {
                    if (err) return reject(err);
                });

                // Create reverse relationship
                const sql2 = 'INSERT OR IGNORE INTO friends (user_id, friend_id, status) VALUES (?, ?, "accepted")';
                db.run(sql2, [userId, friendId], function(err) {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
    },

    rejectRequest: (userId, friendId) => {
        return new Promise((resolve, reject) => {
            const sql = 'DELETE FROM friends WHERE user_id = ? AND friend_id = ?';
            db.run(sql, [friendId, userId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    },

    removeFriend: (userId, friendId) => {
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                const sql1 = 'DELETE FROM friends WHERE user_id = ? AND friend_id = ?';
                const sql2 = 'DELETE FROM friends WHERE user_id = ? AND friend_id = ?';
                
                db.run(sql1, [userId, friendId], (err) => {
                    if (err) return reject(err);
                });
                
                db.run(sql2, [friendId, userId], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
    },

    getFriends: (userId) => {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT u.id, u.username, u.email, u.avatar, u.status, f.status as friendship_status
                FROM friends f
                JOIN users u ON f.friend_id = u.id
                WHERE f.user_id = ? AND f.status = 'accepted'
            `;
            db.all(sql, [userId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },

    getPendingRequests: (userId) => {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT u.id, u.username, u.email, u.avatar, u.status
                FROM friends f
                JOIN users u ON f.user_id = u.id
                WHERE f.friend_id = ? AND f.status = 'pending'
            `;
            db.all(sql, [userId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },

    checkFriendship: (userId, friendId) => {
        return new Promise((resolve, reject) => {
            const sql = 'SELECT * FROM friends WHERE user_id = ? AND friend_id = ? AND status = "accepted"';
            db.get(sql, [userId, friendId], (err, row) => {
                if (err) reject(err);
                else resolve(!!row);
            });
        });
    }
};

// Server operations
const serverDB = {
    create: (name, ownerId) => {
        return new Promise((resolve, reject) => {
            const icon = name.charAt(0).toUpperCase();
            const sql = 'INSERT INTO servers (name, icon, owner_id) VALUES (?, ?, ?)';
            db.run(sql, [name, icon, ownerId], function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, name, icon, owner_id: ownerId });
            });
        });
    },

    getUserServers: (userId) => {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT s.* FROM servers s
                JOIN server_members sm ON s.id = sm.server_id
                WHERE sm.user_id = ?
                ORDER BY s.created_at ASC
            `;
            db.all(sql, [userId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },

    addMember: (serverId, userId) => {
        return new Promise((resolve, reject) => {
            const sql = 'INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)';
            db.run(sql, [serverId, userId], function(err) {
                if (err) reject(err);
                else resolve({ changes: this.changes });
            });
        });
    },

    getMembers: (serverId) => {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT u.id, u.username, u.avatar, u.status, u.identity_public_jwk
                FROM users u
                JOIN server_members sm ON u.id = sm.user_id
                WHERE sm.server_id = ?
            `;
            db.all(sql, [serverId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },

    isMember: (serverId, userId) => {
        return new Promise((resolve, reject) => {
            const sql = 'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?';
            db.get(sql, [serverId, userId], (err, row) => {
                if (err) reject(err);
                else resolve(!!row);
            });
        });
    },

    getById: (serverId) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM servers WHERE id = ?', [serverId], (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });
    },

    update: (serverId, fields) => {
        const parts = [];
        const vals = [];
        if (fields.name !== undefined && fields.name !== null) {
            parts.push('name = ?');
            vals.push(String(fields.name).trim());
        }
        if (fields.icon !== undefined && fields.icon !== null) {
            parts.push('icon = ?');
            vals.push(String(fields.icon).trim().slice(0, 16));
        }
        if (parts.length === 0) {
            return Promise.resolve();
        }
        vals.push(serverId);
        return new Promise((resolve, reject) => {
            db.run(`UPDATE servers SET ${parts.join(', ')} WHERE id = ?`, vals, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
};

/** Колонка identity_public_jwk и таблица обёрток ключей каналов (E2EE) */
function ensureE2eeSchema() {
    return new Promise((resolve, reject) => {
        db.all('PRAGMA table_info(users)', [], (err, cols) => {
            if (err) return reject(err);
            const names = new Set((cols || []).map((c) => c.name));
            const createWraps = () => {
                db.run(
                    `CREATE TABLE IF NOT EXISTS channel_key_wraps (
                        channel_id INTEGER NOT NULL,
                        user_id INTEGER NOT NULL,
                        from_user_id INTEGER NOT NULL,
                        wrap TEXT NOT NULL,
                        PRIMARY KEY (channel_id, user_id),
                        FOREIGN KEY (channel_id) REFERENCES channels(id),
                        FOREIGN KEY (user_id) REFERENCES users(id),
                        FOREIGN KEY (from_user_id) REFERENCES users(id)
                    )`,
                    (e2) => {
                        if (e2) return reject(e2);
                        resolve();
                    }
                );
            };
            if (names.has('identity_public_jwk')) return createWraps();
            db.run('ALTER TABLE users ADD COLUMN identity_public_jwk TEXT', (e) => {
                if (e) return reject(e);
                createWraps();
            });
        });
    });
}

/** Создать таблицу категорий и колонки каналов на старых БД */
function ensureChannelSchema() {
    return new Promise((resolve, reject) => {
        db.run(
            `CREATE TABLE IF NOT EXISTS channel_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                FOREIGN KEY (server_id) REFERENCES servers(id)
            )`,
            (err) => {
                if (err) return reject(err);
                db.all('PRAGMA table_info(channels)', [], (e2, cols) => {
                    if (e2) return reject(e2);
                    const names = new Set((cols || []).map((c) => c.name));
                    const addPosition = () => {
                        db.all('PRAGMA table_info(channels)', [], (e4, cols2) => {
                            if (e4) return reject(e4);
                            const n2 = new Set((cols2 || []).map((c) => c.name));
                            if (n2.has('position')) return resolve();
                            db.run('ALTER TABLE channels ADD COLUMN position INTEGER DEFAULT 0', (e5) => {
                                if (e5) return reject(e5);
                                resolve();
                            });
                        });
                    };
                    if (names.has('category_id')) {
                        return addPosition();
                    }
                    db.run('ALTER TABLE channels ADD COLUMN category_id INTEGER', (e3) => {
                        if (e3) return reject(e3);
                        addPosition();
                    });
                });
            }
        );
    });
}

/** Категории с вложенными каналами для UI */
async function getChannelTree(serverId) {
    const categories = await categoryDB.listByServer(serverId);
    const all = await channelDB.getByServerId(serverId);
    const assignedIds = new Set();
    const blocks = categories.map((cat) => {
        const chs = all.filter((ch) => ch.category_id === cat.id);
        chs.forEach((c) => assignedIds.add(c.id));
        return {
            id: cat.id,
            name: cat.name,
            sort_order: cat.sort_order,
            channels: chs
        };
    });
    const orphan = all.filter((ch) => !assignedIds.has(ch.id));
    if (orphan.length > 0) {
        blocks.push({
            id: null,
            name: 'Прочее',
            sort_order: 1000,
            channels: orphan
        });
    }
    return { categories: blocks };
}

/** Категории по умолчанию, голосовые каналы в БД, привязка старых каналов */
function migrateChannelHierarchy() {
    return new Promise((resolve, reject) => {
        db.all('SELECT id FROM servers', [], (err, servers) => {
            if (err) return reject(err);
            if (!servers || servers.length === 0) return resolve();

            (async () => {
                try {
                    for (const srv of servers) {
                        let cats = await categoryDB.listByServer(srv.id);
                        if (cats.length === 0) {
                            await categoryDB.create(srv.id, 'Текстовые каналы', 0);
                            await categoryDB.create(srv.id, 'Голосовые каналы', 1);
                            cats = await categoryDB.listByServer(srv.id);
                        }
                        const textCat = cats.find((c) => /текст/i.test(c.name)) || cats[0];
                        const voiceCat = cats.find((c) => /голос/i.test(c.name)) || cats[cats.length - 1];

                        let channels = await channelDB.getByServerId(srv.id);
                        let tPos = 0;
                        let vPos = 0;
                        for (const ch of channels) {
                            if (ch.category_id != null) continue;
                            const catId = ch.type === 'voice' ? voiceCat.id : textCat.id;
                            const pos = ch.type === 'voice' ? vPos++ : tPos++;
                            await new Promise((res, rej) => {
                                db.run(
                                    'UPDATE channels SET category_id = ?, position = ? WHERE id = ?',
                                    [catId, pos, ch.id],
                                    (e) => (e ? rej(e) : res())
                                );
                            });
                        }

                        channels = await channelDB.getByServerId(srv.id);
                        const hasVoice = channels.some((c) => c.type === 'voice');
                        if (!hasVoice) {
                            await channelDB.create('voice-1', 'voice', srv.id, voiceCat.id, 0);
                            await channelDB.create('voice-2', 'voice', srv.id, voiceCat.id, 1);
                        }
                    }
                    resolve();
                } catch (e) {
                    reject(e);
                }
            })();
        });
    });
}

/** Добавить текстовые каналы general/random серверам, у которых их ещё нет */
function migrateChannelsForEmptyServers() {
    return new Promise((resolve, reject) => {
        db.all('SELECT id FROM servers', [], (err, servers) => {
            if (err) return reject(err);
            if (!servers || servers.length === 0) return resolve();

            let remaining = servers.length;
            const doneOne = () => {
                remaining -= 1;
                if (remaining <= 0) resolve();
            };

            servers.forEach((srv) => {
                db.get(
                    'SELECT COUNT(1) AS c FROM channels WHERE server_id = ?',
                    [srv.id],
                    (e, row) => {
                        if (e) {
                            console.error('migrateChannels:', e);
                            return doneOne();
                        }
                        if (row && row.c === 0) {
                            db.serialize(() => {
                                db.run(
                                    'INSERT INTO channels (name, type, server_id) VALUES (?, ?, ?)',
                                    ['general', 'text', srv.id]
                                );
                                db.run(
                                    'INSERT INTO channels (name, type, server_id) VALUES (?, ?, ?)',
                                    ['random', 'text', srv.id]
                                );
                            });
                        }
                        doneOne();
                    }
                );
            });
        });
    });
}

module.exports = {
    db,
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
};