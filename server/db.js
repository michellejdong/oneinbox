'use strict';
// Storage: one SQLite file holding accounts, messages (with full-text search), digests and settings.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR } = require('./config');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(DATA_DIR, 'oneinbox.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    connector TEXT NOT NULL,
    identity TEXT NOT NULL,
    label TEXT,
    credentials TEXT,
    cursor TEXT DEFAULT '{}',
    last_sync INTEGER,
    last_error TEXT,
    created_at INTEGER,
    UNIQUE (connector, identity)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    thread_title TEXT,
    sender TEXT,
    sender_addr TEXT,
    is_me INTEGER DEFAULT 0,
    body TEXT,
    ts INTEGER NOT NULL,
    url TEXT,
    unread INTEGER DEFAULT 0,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, ts);
  CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
  CREATE INDEX IF NOT EXISTS messages_source ON messages (source, ts);
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    body, sender, thread_title, content='messages', content_rowid='rowid', tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, body, sender, thread_title) VALUES (new.rowid, new.body, new.sender, new.thread_title);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, body, sender, thread_title) VALUES ('delete', old.rowid, old.body, old.sender, old.thread_title);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, body, sender, thread_title) VALUES ('delete', old.rowid, old.body, old.sender, old.thread_title);
    INSERT INTO messages_fts (rowid, body, sender, thread_title) VALUES (new.rowid, new.body, new.sender, new.thread_title);
  END;
  CREATE TABLE IF NOT EXISTS digests (
    id INTEGER PRIMARY KEY,
    created_at INTEGER,
    hours INTEGER,
    engine TEXT,
    body TEXT
  );
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`);

// ---------- encryption for saved logins and secrets ----------
function masterKey() {
  if (process.env.APP_SECRET) return crypto.scryptSync(process.env.APP_SECRET, 'oneinbox', 32);
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600 });
  return fs.readFileSync(file);
}
const KEY = masterKey();
const SESSION_KEY = crypto.createHmac('sha256', KEY).update('session').digest();

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return 'v1.' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}
function open(sealed) {
  if (!sealed) return {};
  const buf = Buffer.from(String(sealed).replace(/^v1\./, ''), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
}

// ---------- key/value and settings ----------
const kvGet = (key) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
const kvSet = (key, value) =>
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

// Settings the owner can change from the Connections screen. "secret" ones are never sent back to the browser.
const SETTINGS = {
  GOOGLE_CLIENT_ID: {}, GOOGLE_CLIENT_SECRET: { secret: true },
  MICROSOFT_CLIENT_ID: {}, MICROSOFT_CLIENT_SECRET: { secret: true }, MICROSOFT_TENANT: {},
  ZOOM_CLIENT_ID: {}, ZOOM_CLIENT_SECRET: { secret: true },
  ANTHROPIC_API_KEY: { secret: true }, DIGEST_MODEL: {},
  OLLAMA_URL: {}, OLLAMA_MODEL: {},
  DIGEST_HOUR: {}, MY_NAMES: {},
};
let settingsCache = null;
function settings() {
  if (!settingsCache) {
    const raw = kvGet('settings');
    settingsCache = raw ? open(raw) : {};
  }
  return settingsCache;
}
/** A setting saved in the app wins; otherwise fall back to the environment / .env file. */
function cfg(key, fallback = '') {
  const v = settings()[key];
  if (v !== undefined && v !== '') return v;
  return process.env[key] || fallback;
}
function setSettings(values) {
  const next = { ...settings() };
  for (const [k, v] of Object.entries(values)) {
    if (!SETTINGS[k]) continue;
    if (v === '' || v == null) delete next[k];
    else next[k] = String(v).trim();
  }
  kvSet('settings', seal(next));
  settingsCache = next;
}
function publicSettings() {
  const out = {};
  for (const [k, def] of Object.entries(SETTINGS)) {
    const v = cfg(k);
    out[k] = def.secret ? { set: Boolean(v) } : { set: Boolean(v), value: v };
  }
  return out;
}
const myNames = () => cfg('MY_NAMES').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// ---------- accounts ----------
const listAccounts = () => db.prepare('SELECT * FROM accounts ORDER BY id').all();
const getAccount = (id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(id));
const findAccount = (connector, identity) =>
  db.prepare('SELECT * FROM accounts WHERE connector = ? AND identity = ?').get(connector, identity);

function saveAccount(connector, identity, label, creds) {
  db.prepare(`INSERT INTO accounts (connector, identity, label, credentials, created_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(connector, identity) DO UPDATE SET label = excluded.label, credentials = excluded.credentials, last_error = NULL`)
    .run(connector, identity, label || identity, seal(creds), Date.now());
  return findAccount(connector, identity);
}
function updateAccount(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), Number(id));
}
function deleteAccount(id) {
  db.prepare('DELETE FROM messages WHERE account_id = ?').run(Number(id));
  db.prepare('DELETE FROM accounts WHERE id = ?').run(Number(id));
}

// ---------- messages ----------
const insertMsg = db.prepare(`
  INSERT INTO messages (id, source, account_id, thread_id, thread_title, sender, sender_addr, is_me, body, ts, url, unread, meta)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET thread_title = excluded.thread_title, sender = excluded.sender, body = excluded.body,
    ts = excluded.ts, url = excluded.url, meta = excluded.meta, unread = MIN(messages.unread, excluded.unread)`);
const existsMsg = db.prepare('SELECT 1 AS x FROM messages WHERE id = ?');

/**
 * Save messages produced by a connector. Each one looks like:
 * { ext_id, thread, thread_title, sender, sender_addr, is_me, body, ts, url, unread, meta, source? }
 * Returns how many were new.
 */
function saveMessages(account, msgs) {
  if (!msgs || !msgs.length) return 0;
  let fresh = 0;
  db.exec('BEGIN');
  try {
    for (const m of msgs) {
      if (!m || m.ext_id == null || !m.ts) continue;
      const source = m.source || account.connector;
      const id = `${source}:${account.id}:${m.ext_id}`;
      if (!existsMsg.get(id)) fresh++;
      insertMsg.run(
        id, source, account.id, `${source}:${account.id}:${m.thread ?? m.ext_id}`,
        String(m.thread_title || '').slice(0, 300), String(m.sender || '').slice(0, 200), String(m.sender_addr || '').slice(0, 300),
        m.is_me ? 1 : 0, String(m.body || '').slice(0, 100000), Math.round(m.ts), m.url || null, m.unread ? 1 : 0,
        m.meta ? JSON.stringify(m.meta) : null,
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return fresh;
}

function listThreads({ sources, unread, before, limit = 60 } = {}) {
  const where = [];
  const args = [];
  if (sources && sources.length) {
    where.push(`source IN (${sources.map(() => '?').join(',')})`);
    args.push(...sources);
  }
  const having = [];
  if (unread) having.push('SUM(unread) > 0');
  if (before) { having.push('MAX(ts) < ?'); args.push(Number(before)); }
  return db.prepare(`
    SELECT thread_id, source, account_id, thread_title AS title, sender, is_me AS last_is_me,
           substr(body, 1, 220) AS snippet, MAX(ts) AS ts, COUNT(*) AS count, SUM(unread) AS unread
    FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY thread_id ${having.length ? 'HAVING ' + having.join(' AND ') : ''}
    ORDER BY ts DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 60, 200));
}

function getThread(threadId, limit = 400) {
  return db.prepare('SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC')
    .all(threadId, limit);
}
const markRead = (threadId) => db.prepare('UPDATE messages SET unread = 0 WHERE thread_id = ? AND unread = 1').run(threadId);

function search(q, { sources, limit = 80 } = {}) {
  const tokens = String(q || '').match(/[\p{L}\p{N}_]+/gu);
  if (!tokens) return [];
  const match = tokens.slice(0, 12).map((t) => `"${t}"*`).join(' ');
  const args = [match];
  let extra = '';
  if (sources && sources.length) {
    extra = `AND m.source IN (${sources.map(() => '?').join(',')})`;
    args.push(...sources);
  }
  // \u0001 / \u0002 mark the hit so the browser can highlight it without trusting any HTML in the message.
  return db.prepare(`
    SELECT m.id, m.thread_id, m.source, m.thread_title AS title, m.sender, m.ts, m.is_me,
           snippet(messages_fts, 0, char(1), char(2), '…', 18) AS snippet
    FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE messages_fts MATCH ? ${extra} ORDER BY m.ts DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 80, 200));
}

const sourceCounts = () =>
  db.prepare('SELECT source, COUNT(DISTINCT thread_id) AS threads, SUM(unread) AS unread FROM messages GROUP BY source').all();

function messagesSince(since, excludeSources = []) {
  const not = excludeSources.length ? `AND source NOT IN (${excludeSources.map(() => '?').join(',')})` : '';
  return db.prepare(`SELECT * FROM messages WHERE ts >= ? ${not} ORDER BY ts ASC`).all(since, ...excludeSources);
}

// ---------- digests ----------
const saveDigest = (hours, engine, body) =>
  db.prepare('INSERT INTO digests (created_at, hours, engine, body) VALUES (?, ?, ?, ?)').run(Date.now(), hours, engine, body);
const latestDigest = () => db.prepare('SELECT * FROM digests ORDER BY id DESC LIMIT 1').get() || null;

module.exports = {
  db, seal, open, SESSION_KEY, kvGet, kvSet,
  SETTINGS, cfg, setSettings, publicSettings, myNames,
  listAccounts, getAccount, findAccount, saveAccount, updateAccount, deleteAccount,
  saveMessages, listThreads, getThread, markRead, search, sourceCounts, messagesSince,
  saveDigest, latestDigest,
};
