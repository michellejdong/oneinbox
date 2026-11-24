'use strict';
// WhatsApp, two ways:
//  1. Import a chat exported from the phone app (works for any personal account, read-only).
//  2. Live send/receive for a WhatsApp Business number through Meta's Cloud API (needs the hosted website for webhooks).
const crypto = require('crypto');
const { api } = require('../util');
const { cfg } = require('../db');

const graph = () => `https://graph.facebook.com/${cfg('WHATSAPP_GRAPH_VERSION', 'v23.0')}`;

// ---------- exported chats ----------
const DATE = String.raw`\[?(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?\s?m\.?)?)\]?`;
const LINE = new RegExp(`^${DATE}(?:\\s-)?\\s([^:]{1,80}?):\\s([\\s\\S]*)$`, 'i');
const DATE_ONLY = new RegExp(`^${DATE}`, 'i');
const tidyLine = (l) => l.replace(/[‎‏‪-‮]/g, '').replace(/[  ]/g, ' ');

function looksLikeExport(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim()).slice(0, 25).map(tidyLine);
  const hits = lines.filter((l) => LINE.test(l)).length;
  return hits >= 2 || (lines.length > 0 && hits === lines.length);
}

function toTime(d, t, order) {
  const raw = d.split(/[-/.]/);
  const n = raw.map(Number);
  let y, mo, da;
  if (raw[0].length === 4) [y, mo, da] = n;
  else if (order === 'dmy') [da, mo, y] = n;
  else [mo, da, y] = n;
  if (y < 100) y += 2000;
  const m = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?/i);
  let hh = Number(m[1]);
  if (m[4]) {
    const pm = m[4].toLowerCase() === 'p';
    if (pm && hh < 12) hh += 12;
    if (!pm && hh === 12) hh = 0;
  }
  return new Date(y, mo - 1, da, hh, Number(m[2]), Number(m[3] || 0)).getTime();
}

function parseExport(text, fileName, myNames = []) {
  const rows = [];
  for (const rawLine of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = tidyLine(rawLine);
    const m = line.match(LINE);
    if (m) rows.push({ d: m[1], t: m[2], sender: m[3].trim(), body: m[4] });
    else if (DATE_ONLY.test(line)) continue; // system notice such as "Messages are end-to-end encrypted"
    else if (rows.length) rows[rows.length - 1].body += '\n' + line;
  }
  // Work out whether dates are day-first or month-first.
  let order = 'mdy';
  for (const r of rows) {
    const p = r.d.split(/[-/.]/).map(Number);
    if (String(r.d.split(/[-/.]/)[0]).length === 4) break;
    if (p[0] > 12) { order = 'dmy'; break; }
    if (p[1] > 12) { order = 'mdy'; break; }
  }
  const people = [...new Set(rows.map((r) => r.sender))];
  const others = people.filter((p) => !myNames.includes(p.toLowerCase()));
  const named = String(fileName || '').match(/WhatsApp Chat (?:with|-)\s*(.+?)(?:\.txt|\.zip)?$/i);
  const title = named ? named[1].trim() : others.slice(0, 3).join(', ') || 'WhatsApp chat';
  const thread = 'export-' + crypto.createHash('sha1').update(title.toLowerCase()).digest('hex').slice(0, 12);
  const seen = new Map();
  const messages = rows.map((r) => {
    const ts = toTime(r.d, r.t, order);
    const key = `${ts}-${crypto.createHash('sha1').update(r.sender + '\n' + r.body).digest('hex').slice(0, 10)}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return {
      source: 'whatsapp', ext_id: n > 1 ? `${key}-${n}` : key, thread, thread_title: title, sender: r.sender, sender_addr: '',
      is_me: myNames.includes(r.sender.toLowerCase()), unread: false, body: r.body.trim(), ts, url: null,
    };
  }).filter((m) => Number.isFinite(m.ts) && m.body && !/^Messages and calls are end-to-end encrypted/i.test(m.body));
  return { title, messages };
}

// ---------- live Cloud API ----------
function parseWebhook(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value;
      if (!v || !Array.isArray(v.messages)) continue;
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      out.push({
        phoneNumberId: v.metadata?.phone_number_id,
        messages: v.messages.map((m) => ({
          ext_id: m.id,
          thread: m.from,
          thread_title: names[m.from] || `+${m.from}`,
          sender: names[m.from] || `+${m.from}`,
          sender_addr: m.from,
          is_me: false,
          unread: true,
          body: m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || `[${m.type}]`,
          ts: Number(m.timestamp) * 1000,
          url: `https://wa.me/${m.from}`,
        })),
      });
    }
  }
  return out;
}

function validSignature(rawBody, signature, appSecret) {
  if (!appSecret) return true;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  id: 'whatsapp',
  name: 'WhatsApp',
  kind: 'chat',
  color: '#1fa855',
  canReply: true,
  importable: true,
  auth: {
    type: 'token',
    optional: true,
    fields: [
      { key: 'phone_number_id', label: 'Phone number ID' },
      { key: 'token', label: 'Permanent access token', secret: true },
      { key: 'verify_token', label: 'Webhook verify token (any phrase you choose)', secret: true },
      { key: 'app_secret', label: 'App secret (recommended; confirms webhooks really come from Meta)', secret: true, optional: true },
    ],
  },
  setup: [
    'Personal WhatsApp: on your phone open a chat → ⋯ / contact name → "Export chat" → "Without media", then use "Import a file" here. WhatsApp offers no live connection for personal accounts.',
    'WhatsApp Business only: in developers.facebook.com create an app with the WhatsApp product, copy the phone number ID and a permanent access token, and paste them below.',
    'For live incoming messages, host this app as a website and set the webhook in Meta to {BASE}/webhooks/whatsapp with the same verify token. You can only reply within 24 hours of a customer\'s last message.',
  ],
  looksLikeExport,
  parseExport,
  parseWebhook,
  validSignature,

  async identify(ctx) {
    const c = ctx.creds;
    if (!c.phone_number_id || !c.token || !c.verify_token) throw new Error('Phone number ID, access token and verify token are all needed.');
    const info = await api(`${graph()}/${encodeURIComponent(c.phone_number_id)}?fields=display_phone_number,verified_name`, { token: c.token });
    return { identity: String(c.phone_number_id), label: `${info.verified_name || 'Business'} ${info.display_phone_number || ''}`.trim() };
  },

  async sync() {
    return []; // messages arrive through the webhook
  },

  async send(ctx, { threadExt, messages, text }) {
    if (ctx.account.identity === 'import') throw new Error('Imported WhatsApp chats are read-only.');
    const r = await api(`${graph()}/${encodeURIComponent(ctx.creds.phone_number_id)}/messages`, {
      method: 'POST', token: ctx.creds.token,
      json: { messaging_product: 'whatsapp', to: threadExt, type: 'text', text: { body: text } },
    });
    const prev = messages[messages.length - 1];
    return {
      ext_id: r.messages?.[0]?.id || `local-${Date.now()}`, thread: threadExt, thread_title: prev.thread_title, sender: 'You',
      sender_addr: '', is_me: true, body: text, ts: Date.now(), url: prev.url,
    };
  },
};
