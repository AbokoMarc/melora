import { createClient } from '@libsql/client';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Même principe que Roomia : Turso en production (persistant, free tier),
// fichier SQLite local en développement (aucun compte requis).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'melora.db');
const url = process.env.TURSO_DATABASE_URL || `file:${DB_PATH}`;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (url.startsWith('file:')) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const client = createClient({ url, authToken });

function cleanArgs(args) {
  return args.map(a => (a === undefined ? null : a));
}

// Adaptateur reproduisant l'interface synchrone de node:sqlite (db.prepare(sql).get/.all/.run)
// avec des Promises — chaque appel doit être précédé de `await`.
export const db = {
  prepare(sql) {
    return {
      async get(...args) {
        const res = await client.execute({ sql, args: cleanArgs(args) });
        return res.rows[0] ?? undefined;
      },
      async all(...args) {
        const res = await client.execute({ sql, args: cleanArgs(args) });
        return res.rows;
      },
      async run(...args) {
        const res = await client.execute({ sql, args: cleanArgs(args) });
        return {
          lastInsertRowid: res.lastInsertRowid != null ? Number(res.lastInsertRowid) : null,
          changes: res.rowsAffected,
        };
      },
    };
  },
  async exec(sqlMultiStatement) {
    await client.executeMultiple(sqlMultiStatement);
  },
};

await db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar TEXT,
    bio TEXT,
    organization_name TEXT,
    organization_type TEXT, -- entreprise | ecole | association | communaute
    role TEXT NOT NULL DEFAULT 'member', -- member | admin | super_admin
    status TEXT NOT NULL DEFAULT 'active', -- active | suspended
    suspended_reason TEXT,
    suspended_at TEXT,
    suspended_by INTEGER REFERENCES users(id),
    must_change_password INTEGER NOT NULL DEFAULT 0,
    presence_mode TEXT NOT NULL DEFAULT 'online', -- online | away | dnd | offline (préférence manuelle, combinée à la présence live)
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Journal d'accès admin : toute lecture de messages d'autrui par un admin est tracée.
  -- Visible uniquement par le super_admin -- garde-fou anti-abus de la fonction "anti-fraude".
  CREATE TABLE IF NOT EXISTS admin_access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL, -- view_messages | suspend | unsuspend | reset_password | role_change
    target_user_id INTEGER REFERENCES users(id),
    target_conversation_id INTEGER,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'private', -- private | group
    name TEXT,
    avatar TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    member_role TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (conversation_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_message_id TEXT, -- idempotence : évite les doublons en cas de retry réseau
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    sender_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL DEFAULT 'text', -- text | image | video | document | voice
    content TEXT,
    media_url TEXT,
    filename TEXT, -- nom d'origine pour les documents
    view_once INTEGER NOT NULL DEFAULT 0, -- message "vu unique" : masqué après consultation (sauf pour l'admin)
    viewed_once_at TEXT,
    reply_to_id INTEGER REFERENCES messages(id),
    edited_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(conversation_id, sender_id, client_message_id)
  );

  CREATE TABLE IF NOT EXISTS message_reads (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    read_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, user_id)
  );

  -- Distinct de message_reads : "livré" (arrivé sur l'appareil) vs "lu" (vu à l'écran) —
  -- même distinction que la double coche grise/bleue de WhatsApp.
  CREATE TABLE IF NOT EXISTS message_deliveries (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    endpoint TEXT UNIQUE NOT NULL,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Journal des appels (audio/vidéo) : alimente l'onglet "Appels" (tous / manqués), comme WhatsApp.
  CREATE TABLE IF NOT EXISTS call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_id INTEGER NOT NULL REFERENCES users(id),
    callee_id INTEGER NOT NULL REFERENCES users(id),
    mode TEXT NOT NULL, -- audio | video
    status TEXT NOT NULL DEFAULT 'ringing', -- ringing | answered(transitoire) | ended | declined | missed
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    answered_at TEXT,
    ended_at TEXT
  );

  -- Statuts 24h (texte pour l'instant — image/vidéo pas encore branchés, cf. note dans le README).
  CREATE TABLE IF NOT EXISTS statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL DEFAULT 'text', -- text (image/video prévus plus tard)
    content TEXT NOT NULL,
    bg_color TEXT NOT NULL DEFAULT '#d9822b',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS status_views (
    status_id INTEGER NOT NULL REFERENCES statuses(id),
    viewer_id INTEGER NOT NULL REFERENCES users(id),
    viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (status_id, viewer_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_admin_log_admin ON admin_access_log(admin_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_call_logs_users ON call_logs(caller_id, callee_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_statuses_expiry ON statuses(expires_at);
`);

// Migrations additives pour les bases déjà en prod (une base créée avant cet ajout a une
// table `messages` sans ces colonnes — CREATE TABLE IF NOT EXISTS ne la retouche pas).
// Chaque ALTER est isolé et tolérant : "duplicate column" (déjà appliqué) est ignoré sans bruit.
const MIGRATIONS = [
  'ALTER TABLE messages ADD COLUMN filename TEXT',
  'ALTER TABLE messages ADD COLUMN view_once INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE messages ADD COLUMN viewed_once_at TEXT',
];
for (const sql of MIGRATIONS) {
  try { await db.prepare(sql).run(); }
  catch (err) { if (!/duplicate column/i.test(err.message)) console.error('[melora] migration échouée:', sql, err.message); }
}

export default db;
