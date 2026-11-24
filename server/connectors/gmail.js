'use strict';
const { htmlToText, stripQuoted, parseAddress, pool } = require('../util');

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function findPart(part, mime) {
  if (!part) return '';
  if (part.mimeType === mime && part.body && part.body.data) return b64url(part.body.data);
  for (const child of part.parts || []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return '';
}
const header = (msg, name) =>
  (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
const clean = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();
const encodeHeader = (v) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`);

function normalize(msg) {
  const from = parseAddress(header(msg, 'From'));
  const subject = header(msg, 'Subject') || '(no subject)';
  const labels = msg.labelIds || [];
  const text = findPart(msg.payload, 'text/plain') || htmlToText(findPart(msg.payload, 'text/html')) || msg.snippet || '';
  return {
    ext_id: msg.id,
    thread: msg.threadId,
    thread_title: subject,
    sender: from.name,
    sender_addr: from.addr,
    is_me: labels.includes('SENT'),
    unread: labels.includes('UNREAD'),
    body: stripQuoted(text),
    ts: Number(msg.internalDate),
    url: `https://mail.google.com/mail/u/0/#all/${msg.threadId}`,
    meta: {
      subject,
      from: header(msg, 'From'),
      to: header(msg, 'To'),
      replyTo: header(msg, 'Reply-To'),
      messageId: header(msg, 'Message-ID'),
      references: header(msg, 'References'),
    },
  };
}

module.exports = {
  id: 'gmail',
  name: 'Gmail',
  kind: 'email',
  color: '#d93025',
  canReply: true,
  auth: {
    type: 'oauth',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
    extraParams: { access_type: 'offline', prompt: 'consent' },
    keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  },
  setup: [
    'Open console.cloud.google.com, create a project, and enable the "Gmail API".',
    'Under "OAuth consent screen", choose External, add your own address as a test user, then set the publishing status to "In production" (otherwise Google signs you out every 7 days).',
    'Under "Credentials", create an "OAuth client ID" of type "Web application" with this redirect address: {BASE}/oauth/gmail/callback',
    'Paste the client ID and client secret below, save, then press Connect.',
  ],

  async identify(ctx) {
    const p = await ctx.get(`${BASE}/profile`);
    return { identity: p.emailAddress, label: p.emailAddress };
  },

  async sync(ctx) {
    const q = `after:${Math.floor(ctx.since / 1000)} -in:chats`;
    const ids = [];
    let pageToken = '';
    do {
      const page = await ctx.get(`${BASE}/messages?${new URLSearchParams({ q, maxResults: '100', ...(pageToken ? { pageToken } : {}) })}`);
      ids.push(...(page.messages || []).map((m) => m.id));
      pageToken = page.nextPageToken || '';
    } while (pageToken && ids.length < 300);
    const full = await pool(ids, 5, (id) => ctx.get(`${BASE}/messages/${id}?format=full`).catch(() => null));
    return full.filter(Boolean).map(normalize);
  },

  async send(ctx, { threadExt, messages, text }) {
    const target = [...messages].reverse().find((m) => !m.is_me) || messages[messages.length - 1];
    const meta = JSON.parse(target.meta || '{}');
    const to = target.is_me ? meta.to : meta.replyTo || meta.from;
    if (!to) throw new Error('Could not work out who to reply to.');
    const subject = /^re:/i.test(meta.subject || '') ? meta.subject : `Re: ${meta.subject || ''}`;
    const lines = [
      `To: ${clean(to)}`,
      `Subject: ${encodeHeader(clean(subject))}`,
      meta.messageId ? `In-Reply-To: ${clean(meta.messageId)}` : null,
      meta.messageId ? `References: ${clean(`${meta.references || ''} ${meta.messageId}`)}` : null,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    ].filter((l) => l !== null);
    const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
    const sent = await ctx.post(`${BASE}/messages/send`, { raw, threadId: threadExt });
    return {
      ext_id: sent.id, thread: threadExt, thread_title: meta.subject, sender: 'You', sender_addr: ctx.account.identity,
      is_me: true, body: text, ts: Date.now(), url: target.url, meta: { ...meta, from: ctx.account.identity, to },
    };
  },
};
