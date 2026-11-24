'use strict';
// Small shared helpers: HTTP calls to outside services and text clean-up.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Call a JSON API. Throws a readable error when the service says no. Retries once when rate-limited. */
async function api(url, { method = 'GET', token, headers = {}, json, form, retry = 1 } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (token && !h.Authorization) h.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(30000) });
  if (res.status === 429 && retry > 0) {
    const wait = Math.min(Number(res.headers.get('retry-after')) || 2, 20);
    await sleep(wait * 1000);
    return api(url, { method, token, headers, json, form, retry: retry - 1 });
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }
  if (!res.ok) {
    const err = new Error(`${new URL(url).host} answered ${res.status}: ${text.slice(0, 240)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ''),
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Drop the quoted earlier messages at the bottom of an email reply. */
function stripQuoted(text) {
  const lines = String(text || '').split(/\r?\n/);
  let cut = -1;
  for (let i = 0; i < lines.length && cut < 0; i++) {
    const l = lines[i].trim();
    if (/^On .{6,200} wrote:$/.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^_{10,}$/.test(l)) cut = i;
    else if (/^From: .+/.test(l) && /^(Sent|Date): /m.test(lines.slice(i + 1, i + 4).join('\n'))) cut = i;
  }
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter((l) => !/^\s*>/.test(l));
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out || String(text || '').trim();
}

/** "Dana Okafor <dana@example.org>" → { name, addr } */
function parseAddress(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), addr: m[2].trim() };
  return { name: s, addr: s };
}

/** Run an async function over a list, a few at a time. */
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** Accepts seconds, milliseconds or a date string; returns milliseconds (or 0). */
function toMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (/^\d+(\.\d+)?$/.test(String(v))) return toMs(Number(v));
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

module.exports = { sleep, api, htmlToText, stripQuoted, parseAddress, pool, toMs, decodeEntities };
