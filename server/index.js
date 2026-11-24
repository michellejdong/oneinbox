'use strict';
// The web server: serves the interface and the JSON API used by both the desktop window and the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const store = require('./db');
const { connectors, byId, idsOfKind } = require('./connectors');
const oauth = require('./oauth');
const sync = require('./sync');
const digest = require('./digest');
const importer = require('./importer');
const demo = require('./connectors/demo');
const whatsapp = require('./connectors/whatsapp');
const library = require('./library');

const WEB_DIR = path.join(config.ROOT, 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const ALLOWED_HOSTS = new Set([`localhost:${config.PORT}`, `127.0.0.1:${config.PORT}`, new URL(config.BASE_URL).host]);
const ALLOWED_ORIGINS = new Set([`http://localhost:${config.PORT}`, `http://127.0.0.1:${config.PORT}`, new URL(config.BASE_URL).origin]);
const SECURE_COOKIE = config.BASE_URL.startsWith('https://');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Turns a failure inside a route (a service saying no, no internet, a bad file) into a message the person can read. */
const friendly = (fn) => async (...args) => {
  try { return await fn(...args); } catch (e) {
    if (e instanceof HttpError) throw e;
    const offline = e.name === 'TimeoutError' || (e.name === 'TypeError' && /fetch failed/i.test(e.message));
    throw new HttpError(offline ? 502 : 400, offline ? 'Could not reach that service. Check the internet connection and try again.' : e.message);
  }
};

// ---------- sign-in (only used when APP_PASSWORD is set) ----------
const sign = (value) => crypto.createHmac('sha256', store.SESSION_KEY).update(value).digest('hex');
function sessionCookie() {
  const expires = String(Date.now() + 30 * 86400000);
  return `oi=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${SECURE_COOKIE ? '; Secure' : ''}`;
}
function signedIn(req) {
  if (!config.APP_PASSWORD) return true;
  const m = /(?:^|;\s*)oi=(\d+)\.([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m || Number(m[1]) < Date.now()) return false;
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(sign(m[1])));
}
const attempts = [];
function checkPassword(given) {
  const now = Date.now();
  while (attempts.length && now - attempts[0] > 10 * 60000) attempts.shift();
  if (attempts.length >= 8) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(config.APP_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) { attempts.push(now); throw new HttpError(401, 'Wrong password.'); }
}

// ---------- tiny router ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'That is too large.')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(data);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, message) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/styles.css"><div class="notice"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Back to OneInbox</a></p></div>`;

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  send(res, 200, fs.readFileSync(file), { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  return true;
}

// ---------- helpers used by routes ----------
const threadExt = (threadId, account) => threadId.slice(`${threadId.split(':')[0]}:${account.id}:`.length);

function describeSources() {
  const counts = Object.fromEntries(store.sourceCounts().map((r) => [r.source, r]));
  const accounts = store.listAccounts();
  const fill = (s) => String(s).replaceAll('{BASE}', config.BASE_URL);
  return connectors.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    color: c.color,
    canReply: Boolean(c.canReply),
    replyNote: c.replyNote || null,
    authType: c.auth.type,
    authOptional: Boolean(c.auth.optional),
    importable: c.auth.type === 'import' || Boolean(c.importable),
    configured: c.auth.type === 'oauth' ? oauth.isConfigured(c) : true,
    keys: c.auth.type === 'oauth' ? [...c.auth.keys, ...(c.auth.optionalKeys || [])] : [],
    fields: c.auth.type === 'token' ? c.auth.fields.map((f) => ({ key: f.key, label: f.label, secret: Boolean(f.secret), optional: Boolean(f.optional) })) : [],
    setup: (c.setup || []).map(fill),
    accounts: accounts.filter((a) => a.connector === c.id).map((a) => ({
      id: a.id, label: a.label, sample: a.identity === 'sample', imported: a.identity === 'import',
      last_sync: a.last_sync, last_error: a.last_error,
    })),
    threads: counts[c.id]?.threads || 0,
    unread: counts[c.id]?.unread || 0,
  }));
}

function sourcesFor(filter) {
  if (!filter || filter === 'all') return null;
  if (['email', 'chat', 'ai'].includes(filter)) return idsOfKind(filter);
  if (byId[filter]) return [filter];
  throw new HttpError(400, 'Unknown filter.');
}

function threadCanReply(connector, account) {
  if (!connector || !connector.canReply || !account) return false;
  return account.identity !== 'import';
}

// ---------- routes: session ----------
route('GET', '/api/session', () => ({ protected: Boolean(config.APP_PASSWORD) }), { open: true });
route('POST', '/api/login', (req, res, { body }) => {
  if (!config.APP_PASSWORD) return { ok: true };
  checkPassword(body.password);
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie() });
}, { open: true });
route('POST', '/api/logout', (req, res) => {
  send(res, 200, { ok: true }, { 'Set-Cookie': 'oi=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
});

// ---------- routes: reading ----------
route('GET', '/api/state', () => ({
  app: { version: config.VERSION, protected: Boolean(config.APP_PASSWORD), baseUrl: config.BASE_URL, sample: demo.present(), importFolder: importer.IMPORT_DIR },
  sources: describeSources(),
  settings: store.publicSettings(),
  digestEngine: digest.engine(),
  sync: sync.status,
  reading: { open: (({ todo, doing }) => todo + doing)(library.facets().statuses), bookmarklet: library.bookmarklet() },
}));

route('GET', '/api/threads', (req, res, { query }) => ({
  threads: store.listThreads({ sources: sourcesFor(query.filter), unread: query.unread === '1', before: query.before, limit: query.limit }),
}));

route('GET', '/api/thread', (req, res, { query }) => {
  const messages = store.getThread(String(query.id || ''));
  if (!messages.length) throw new HttpError(404, 'Conversation not found.');
  store.markRead(query.id);
  const first = messages[0];
  const account = store.getAccount(first.account_id);
  const connector = byId[first.source];
  return {
    thread: {
      id: query.id, source: first.source, title: messages[messages.length - 1].thread_title, account: account?.label || '',
      url: [...messages].reverse().find((m) => m.url)?.url || null,
      canReply: threadCanReply(connector, account),
      sample: account?.identity === 'sample',
      replyNote: connector?.replyNote || null,
    },
    messages: messages.map((m) => ({ id: m.id, sender: m.sender, is_me: m.is_me, body: m.body, ts: m.ts, url: m.url })),
  };
});

route('GET', '/api/search', (req, res, { query }) => ({ hits: store.search(query.q, { sources: sourcesFor(query.filter) }) }));

// ---------- routes: acting ----------
route('POST', '/api/reply', friendly(async (req, res, { body }) => {
  const text = String(body.text || '').trim();
  if (!text) throw new HttpError(400, 'Write a message first.');
  if (text.length > 20000) throw new HttpError(400, 'That message is too long.');
  const messages = store.getThread(String(body.thread_id || ''));
  if (!messages.length) throw new HttpError(404, 'Conversation not found.');
  const last = messages[messages.length - 1];
  const account = store.getAccount(last.account_id);
  const connector = byId[last.source];
  if (!threadCanReply(connector, account)) throw new HttpError(400, 'This conversation is read-only.');
  const creds = store.open(account.credentials);
  const ext = threadExt(last.thread_id, account);
  if (creds.demo) {
    store.saveMessages(account, [{ ext_id: `local-${Date.now()}`, thread: ext, thread_title: last.thread_title, sender: 'You', is_me: true, body: text, ts: Date.now() }]);
    return { ok: true, sample: true };
  }
  const ctx = sync.makeCtx(connector, creds, account);
  const sent = await connector.send(ctx, { threadExt: ext, messages, text });
  if (sent) store.saveMessages(account, [sent]);
  else {
    await new Promise((r) => setTimeout(r, 1500));
    await sync.syncAccount(store.getAccount(account.id));
  }
  return { ok: true };
}));

route('POST', '/api/sync', async () => {
  const imports = importer.scanDropFolder();
  const status = await sync.syncAll();
  return { ...status, imports };
});

route('GET', '/api/digest', () => ({ digest: store.latestDigest(), engine: digest.engine() }));
route('POST', '/api/digest', async (req, res, { body }) => ({ digest: await digest.generate(body.hours), engine: digest.engine() }));

// ---------- routes: reading list ----------
const itemOr404 = (item) => { if (!item) throw new HttpError(404, 'That item is no longer in the reading list.'); return { item }; };
route('GET', '/api/items', (req, res, { query }) => ({ items: library.list(query), facets: library.facets() }));
route('POST', '/api/items', friendly((req, res, { body }) => library.add(body, { lookup: true })));
route('POST', '/api/items/capture', friendly((req, res, { body }) => {
  if (!library.tokenMatches(body.token)) throw new HttpError(403, 'This save button is out of date. Get a fresh one from the Reading list.');
  return library.add(body);
}));
route('GET', '/api/items/:id', (req, res, { params }) => itemOr404(library.get(params.id)));
route('PATCH', '/api/items/:id', (req, res, { params, body }) => itemOr404(library.update(params.id, body)));
route('DELETE', '/api/items/:id', (req, res, { params }) => {
  if (!library.remove(params.id)) throw new HttpError(404, 'That item is no longer in the reading list.');
  return { ok: true };
});

// ---------- routes: connections ----------
route('POST', '/api/settings', (req, res, { body }) => {
  store.setSettings(body || {});
  return { settings: store.publicSettings() };
});

route('POST', '/api/accounts/token', friendly(async (req, res, { body }) => {
  const connector = byId[body.connector];
  if (!connector || connector.auth.type !== 'token') throw new HttpError(400, 'This source does not use a token.');
  const creds = {};
  for (const f of connector.auth.fields) {
    const v = String(body.values?.[f.key] || '').trim();
    if (!v && !f.optional) throw new HttpError(400, `"${f.label}" is needed.`);
    if (v) creds[f.key] = v;
  }
  const who = await connector.identify(sync.makeCtx(connector, creds, null));
  Object.assign(creds, who.extra || {});
  const account = store.saveAccount(connector.id, who.identity, who.label, creds);
  sync.syncAccount(account).catch(() => {});
  return { ok: true, label: who.label };
}));

route('DELETE', '/api/accounts/:id', (req, res, { params }) => {
  if (!store.getAccount(params.id)) throw new HttpError(404, 'Account not found.');
  store.deleteAccount(params.id);
  return { ok: true };
});

route('GET', '/oauth/:id/start', (req, res, { params }) => {
  const connector = byId[params.id];
  if (!connector || connector.auth.type !== 'oauth') throw new HttpError(404, 'Unknown source.');
  if (!oauth.isConfigured(connector)) return send(res, 400, page('Not ready yet', `${connector.name} needs its client ID and secret first. Add them under Connections.`));
  res.writeHead(302, { Location: oauth.startUrl(connector), 'Cache-Control': 'no-store' });
  res.end();
});

route('GET', '/oauth/:id/callback', async (req, res, { params, query }) => {
  const connector = byId[params.id];
  if (!connector || connector.auth.type !== 'oauth') throw new HttpError(404, 'Unknown source.');
  if (query.error) return send(res, 400, page('Not connected', `${connector.name} sign-in was cancelled or refused (${query.error_description || query.error}).`));
  try {
    const creds = await oauth.finish(connector, String(query.code || ''), String(query.state || ''));
    const who = await connector.identify(sync.makeCtx(connector, creds, null));
    Object.assign(creds, who.extra || {});
    const account = store.saveAccount(connector.id, who.identity, who.label, creds);
    sync.syncAccount(account).catch(() => {});
    send(res, 200, page(`${connector.name} connected`, `Signed in as ${who.label}. Messages are being fetched now. You can close this tab and return to OneInbox.`));
  } catch (e) {
    send(res, 400, page('Not connected', e.message));
  }
});

route('POST', '/api/import', friendly(async (req, res, { query }) => {
  const name = path.basename(String(query.name || 'import')).slice(0, 200);
  const tmpDir = path.join(config.DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, crypto.randomBytes(8).toString('hex'));
  const limit = 2 * 1024 * 1024 * 1024;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'That file is too large.')); req.destroy(); } });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  });
  try {
    const hint = query.source === 'whatsapp' || byId[query.source]?.kind === 'ai' ? query.source : 'auto';
    return importer.importFile(tmp, name, { hint, me: query.me });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}), { rawBody: true });

route('POST', '/api/sample/load', () => ({ added: demo.load() }));
route('POST', '/api/sample/clear', () => { demo.clear(); return { ok: true }; });

// ---------- routes: WhatsApp Business webhook (called by Meta, so no sign-in cookie) ----------
function whatsappAccounts() {
  return store.listAccounts().filter((a) => a.connector === 'whatsapp' && !['import', 'sample'].includes(a.identity))
    .map((a) => ({ account: a, creds: store.open(a.credentials) }));
}
route('GET', '/webhooks/whatsapp', (req, res, { query }) => {
  const token = String(query['hub.verify_token'] || '');
  const ok = query['hub.mode'] === 'subscribe' && token && whatsappAccounts().some(({ creds }) => creds.verify_token === token);
  if (!ok) throw new HttpError(403, 'Verification failed.');
  send(res, 200, String(query['hub.challenge'] || ''), { 'Content-Type': 'text/plain' });
}, { open: true });
route('POST', '/webhooks/whatsapp', async (req, res) => {
  const raw = await readBody(req, 2 * 1024 * 1024);
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Bad payload.'); }
  const known = whatsappAccounts();
  for (const batch of whatsapp.parseWebhook(payload)) {
    const match = known.find(({ account }) => account.identity === String(batch.phoneNumberId));
    if (!match) continue;
    if (!whatsapp.validSignature(raw, req.headers['x-hub-signature-256'], match.creds.app_secret)) throw new HttpError(403, 'Bad signature.');
    store.saveMessages(match.account, batch.messages);
  }
  return { ok: true };
}, { open: true, rawBody: true });

// ---------- request handling ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Bad address.'); }
  const query = Object.fromEntries(url.searchParams);
  const isWebhook = pathname.startsWith('/webhooks/');

  // Only answer requests addressed to this app, and refuse changes coming from other websites.
  if (!ALLOWED_HOSTS.has(req.headers.host)) throw new HttpError(403, 'Unexpected address.');
  if (req.method !== 'GET' && !isWebhook) {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) throw new HttpError(403, 'Request came from another site.');
    if (!origin && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new HttpError(403, 'Request came from another site.');
  }

  const match = routes.map((r) => ({ r, m: r.method === req.method && r.re.exec(pathname) })).find((x) => x.m);
  if (!match) {
    const publicFile = ['/login.html', '/login.js', '/styles.css'].includes(pathname);
    if (req.method === 'GET' && !signedIn(req) && !publicFile) {
      if (pathname.startsWith('/api/')) throw new HttpError(401, 'Please sign in.');
      res.writeHead(302, { Location: '/login.html' });
      return res.end();
    }
    if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
    throw new HttpError(404, 'Not found.');
  }
  const { r, m } = match;
  if (!r.opts.open && !signedIn(req)) {
    if (pathname.startsWith('/oauth/')) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
    throw new HttpError(401, 'Please sign in.');
  }
  const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
  let body = {};
  if (!r.opts.rawBody && req.method !== 'GET') {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Send JSON.');
    const raw = await readBody(req, 1024 * 1024);
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new HttpError(400, 'Bad JSON.'); }
    if (!body || typeof body !== 'object') body = {};
  }
  const result = await r.handler(req, res, { params, query, body });
  if (result !== undefined && !res.writableEnded) send(res, 200, result);
}

async function start() {
  if (!config.isLoopback && !config.APP_PASSWORD) {
    throw new Error('Refusing to start: HOST is reachable from other machines but APP_PASSWORD is not set. Set APP_PASSWORD (and APP_SECRET) first.');
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e.status || 500;
      if (status === 500) console.error('[error]', e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong on the server.' : e.message });
      else res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.PORT, config.HOST, () => {
      // First run: show sample conversations so the app is not empty.
      if (!store.kvGet('first_run_done')) {
        if (!store.listAccounts().length) demo.load();
        store.kvSet('first_run_done', '1');
      }
      const tick = async () => {
        try { importer.scanDropFolder(); } catch (e) { console.error('[import]', e.message); }
        await sync.syncAll().catch((e) => console.error('[sync]', e.message));
      };
      setTimeout(tick, 2000).unref();
      setInterval(tick, config.SYNC_MINUTES * 60000).unref();
      setInterval(() => digest.maybeScheduled(), 60000).unref();
      console.log(`OneInbox is running at ${config.BASE_URL}${config.APP_PASSWORD ? ' (password protected)' : ''}`);
      resolve({ server, port: config.PORT, url: `http://127.0.0.1:${config.PORT}` });
    });
  });
}

if (require.main === module) {
  start().catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${config.PORT} is already in use — OneInbox may already be running.` : e.message);
    process.exit(1);
  });
}

module.exports = { start };
