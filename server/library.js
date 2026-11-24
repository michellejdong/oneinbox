'use strict';
// The reading list: saved papers, posts and forms with a category, topic labels, urgency and review status.
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const store = require('./db');
const { BASE_URL } = require('./config');
const { classify, CATEGORIES } = require('./classify');
const { htmlToText, decodeEntities } = require('./util');

const { db } = store;
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    url TEXT UNIQUE,
    title TEXT,
    excerpt TEXT DEFAULT '',
    site TEXT DEFAULT '',
    authors TEXT DEFAULT '',
    category TEXT,
    labels TEXT DEFAULT '[]',
    urgency TEXT DEFAULT 'whenever',
    status TEXT DEFAULT 'todo',
    notes TEXT DEFAULT '',
    added_at INTEGER,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS items_status ON items (status, added_at);
`);

const STATUSES = ['todo', 'doing', 'done'];
const URGENCIES = ['urgent', 'soon', 'whenever'];
const out = (row) => row && { ...row, labels: JSON.parse(row.labels || '[]') };
const cleanLabels = (list) => [...new Set((Array.isArray(list) ? list : []).map((l) => String(l).trim().slice(0, 60)).filter(Boolean))].slice(0, 20);

// ---------- the "Save to OneInbox" browser button ----------
function captureToken() {
  let token = store.kvGet('capture_token');
  if (!token) { token = crypto.randomBytes(18).toString('hex'); store.kvSet('capture_token', token); }
  return token;
}
function tokenMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(captureToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function bookmarklet() {
  const code = `(function(){var d=document,s=String(window.getSelection?window.getSelection():'').slice(0,2000),m=d.querySelector('meta[name="description"],meta[property="og:description"]'),p=new URLSearchParams({t:'${captureToken()}',u:location.href,n:d.title||'',x:s||(m&&m.content||'').slice(0,2000)});window.open('${BASE_URL}/save.html#'+p.toString(),'oneinbox_save','width=480,height=600')})();`;
  return 'javascript:' + encodeURIComponent(code);
}

// ---------- looking up details about a link ----------
const blocked = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15]]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10]]) blocked.addSubnet(addr, bits, 'ipv6');

/** Refuse addresses on this computer or the local network, so a saved link can never be used to poke at private services. */
async function assertPublic(urlString) {
  const u = new URL(urlString);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only web links can be saved.');
  const addresses = await dns.lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true });
  for (const a of addresses) {
    const mapped = a.address.startsWith('::ffff:') ? a.address.slice(7) : null;
    if (blocked.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4') || (mapped && net.isIPv4(mapped) && blocked.check(mapped, 'ipv4'))) {
      throw new Error('That link points to a private address.');
    }
  }
  return u;
}

async function fetchText(urlString, { maxBytes = 700000, accept = 'text/html' } = {}) {
  let current = urlString;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(current);
    const res = await fetch(current, { redirect: 'manual', headers: { Accept: accept, 'User-Agent': 'OneInbox/0.1 (personal reading list)' }, signal: AbortSignal.timeout(12000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { current = new URL(res.headers.get('location'), current).href; continue; }
    if (!res.ok) throw new Error(`The page answered ${res.status}.`);
    if (!/html|xml|text/i.test(res.headers.get('content-type') || '')) return { url: current, text: '' };
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    return { url: current, text: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('Too many redirects.');
}

const ARXIV_ID = /arxiv\.org\/(?:abs|pdf|html)\/((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7})|(?:\d{4}\.\d{4,5}))/i;
const tag = (xml, name) => decodeEntities((xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || '').replace(/\s+/g, ' ').trim();

function parseArxiv(xml, id) {
  const entry = (String(xml).match(/<entry>([\s\S]*?)<\/entry>/) || [])[1];
  if (!entry || !tag(entry, 'title')) return null;
  const primary = (entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/) || [])[1];
  const cats = [...entry.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]);
  return {
    url: `https://arxiv.org/abs/${id}`,
    title: tag(entry, 'title'),
    excerpt: tag(entry, 'summary'),
    authors: [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => decodeEntities(m[1]).trim()).slice(0, 8).join(', '),
    site: 'arXiv',
    arxiv: [...new Set([primary, ...cats].filter(Boolean))],
  };
}
async function arxivDetails(id) {
  const { text } = await fetchText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, { accept: 'application/atom+xml' });
  return parseArxiv(text, id);
}

function pageDetails(html) {
  const meta = (names) => {
    for (const name of names) {
      const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i')) ||
                html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i'));
      if (m && m[1].trim()) return decodeEntities(m[1]).trim();
    }
    return '';
  };
  const authors = [...html.matchAll(/<meta[^>]+name=["']citation_author["'][^>]*content=["']([^"']*)["']/gi)].map((m) => decodeEntities(m[1]).trim());
  return {
    title: meta(['citation_title', 'og:title', 'twitter:title']) || htmlToText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''),
    excerpt: meta(['citation_abstract', 'og:description', 'description', 'twitter:description']),
    site: meta(['og:site_name', 'citation_journal_title']),
    authors: authors.slice(0, 8).join(', ') || meta(['author']),
    hasCitation: /<meta[^>]+name=["']citation_title["']/i.test(html),
    isArticle: /<meta[^>]+property=["']og:type["'][^>]*content=["']article["']/i.test(html) || /<article[\s>]/i.test(html),
  };
}

/**
 * Save a link (or a plain note). "lookup" lets the server open the page to read its title and summary;
 * saves from the browser button already carry those, so only arXiv is contacted for them.
 */
async function add({ url, title, text }, { lookup = false } = {}) {
  let link = String(url || '').trim() || null;
  if (link && !/^https?:\/\//i.test(link)) link = /^[\w-]+(\.[\w-]+)+/.test(link) ? `https://${link}` : null;
  const info = { url: link, title: String(title || '').trim(), excerpt: String(text || '').trim(), site: '', authors: '' };
  if (!link && !info.title && !info.excerpt) throw new Error('Paste a link, or write a title.');

  if (link) {
    try { new URL(link); } catch { throw new Error('That does not look like a link.'); }
    const existing = out(db.prepare('SELECT * FROM items WHERE url = ?').get(link));
    if (existing) return { item: existing, existing: true };
    const arxivId = (link.match(ARXIV_ID) || [])[1];
    if (arxivId) {
      // Every form of an arXiv link (PDF, HTML, any version) is stored as the one abstract page, so it is never saved twice.
      Object.assign(info, { url: `https://arxiv.org/abs/${arxivId}`, site: 'arXiv', hasCitation: true });
      const same = out(db.prepare('SELECT * FROM items WHERE url = ?').get(info.url));
      if (same) return { item: same, existing: true };
    }
    try {
      if (arxivId) {
        const details = await arxivDetails(arxivId);
        if (details) Object.assign(info, details, { excerpt: details.excerpt || info.excerpt });
        else if (!info.title || /^\S+\.pdf$/i.test(info.title)) info.title = `arXiv:${arxivId}`;
      } else if (lookup) {
        const page = await fetchText(link);
        if (page.text) {
          const details = pageDetails(page.text);
          info.title = info.title || details.title;
          info.excerpt = info.excerpt || details.excerpt;
          Object.assign(info, { site: details.site, authors: details.authors, hasCitation: details.hasCitation, isArticle: details.isArticle });
        }
      }
    } catch {
      // Offline or the site refused: keep whatever we already know; the item is still saved.
      if (arxivId && !info.title) info.title = `arXiv:${arxivId}`;
    }
    const again = out(db.prepare('SELECT * FROM items WHERE url = ?').get(info.url));
    if (again) return { item: again, existing: true };
    if (!info.site) info.site = new URL(info.url).hostname.replace(/^www\./, '');
    if (!info.title) info.title = decodeURIComponent(new URL(info.url).pathname.split('/').filter(Boolean).pop() || info.site);
  }
  if (!info.title) info.title = info.excerpt.split('\n')[0].slice(0, 90);

  const sorted = classify(info);
  const now = Date.now();
  const r = db.prepare(`INSERT INTO items (url, title, excerpt, site, authors, category, labels, urgency, status, added_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)`)
    .run(info.url, info.title.slice(0, 400), info.excerpt.slice(0, 6000), info.site.slice(0, 120), info.authors.slice(0, 400),
      sorted.category, JSON.stringify(sorted.labels), sorted.urgency, now, now);
  return { item: get(r.lastInsertRowid), existing: false };
}

const get = (id) => out(db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id)));

function update(id, changes) {
  const item = get(id);
  if (!item) return null;
  const next = {};
  if (changes.status !== undefined && STATUSES.includes(changes.status)) next.status = changes.status;
  if (changes.urgency !== undefined && URGENCIES.includes(changes.urgency)) next.urgency = changes.urgency;
  if (typeof changes.category === 'string' && changes.category.trim()) next.category = changes.category.trim().slice(0, 80);
  if (typeof changes.title === 'string' && changes.title.trim()) next.title = changes.title.trim().slice(0, 400);
  if (typeof changes.notes === 'string') next.notes = changes.notes.slice(0, 20000);
  if (changes.labels !== undefined) next.labels = JSON.stringify(cleanLabels(changes.labels));
  const keys = Object.keys(next);
  if (keys.length) {
    db.prepare(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => next[k]), Date.now(), item.id);
  }
  return get(id);
}

const remove = (id) => db.prepare('DELETE FROM items WHERE id = ?').run(Number(id)).changes > 0;

function list({ status, category, urgency, label, q } = {}) {
  const where = [];
  const args = [];
  if (status === 'open') where.push("status != 'done'");
  else if (STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
  if (category) { where.push('category = ?'); args.push(category); }
  if (URGENCIES.includes(urgency)) { where.push('urgency = ?'); args.push(urgency); }
  const like = (s) => `%${String(s).replace(/[\\%_]/g, '\\$&')}%`;
  if (label) { where.push("labels LIKE ? ESCAPE '\\'"); args.push(like(JSON.stringify(String(label)))); }
  if (q) {
    where.push("(title LIKE ? ESCAPE '\\' OR excerpt LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR labels LIKE ? ESCAPE '\\' OR authors LIKE ? ESCAPE '\\')");
    args.push(...Array(5).fill(like(q)));
  }
  const rows = db.prepare(`
    SELECT id, url, title, site, authors, category, labels, urgency, status, added_at, substr(excerpt, 1, 200) AS excerpt
    FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE urgency WHEN 'urgent' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END, added_at DESC LIMIT 500`).all(...args);
  return rows.map(out);
}

function facets() {
  const all = db.prepare('SELECT category, labels, status FROM items').all();
  const categories = {};
  const labels = {};
  const statuses = { todo: 0, doing: 0, done: 0 };
  for (const row of all) {
    statuses[row.status] = (statuses[row.status] || 0) + 1;
    categories[row.category] = (categories[row.category] || 0) + 1;
    for (const l of JSON.parse(row.labels || '[]')) labels[l] = (labels[l] || 0) + 1;
  }
  return {
    statuses,
    categories: [...new Set([...CATEGORIES, ...Object.keys(categories)])].map((name) => ({ name, count: categories[name] || 0 })),
    labels: Object.entries(labels).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
  };
}

module.exports = { add, get, update, remove, list, facets, bookmarklet, tokenMatches, parseArxiv, pageDetails, assertPublic, STATUSES, URGENCIES };
