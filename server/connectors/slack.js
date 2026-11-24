'use strict';
const { api } = require('../util');

const PER_SYNC = 40; // conversations checked per sync, to stay inside Slack's rate limits

async function slack(token, method, params = {}) {
  const r = await api(`https://slack.com/api/${method}`, { method: 'POST', token, form: params });
  if (!r.ok) throw new Error(`Slack said "${r.error}" for ${method}.`);
  return r;
}

async function userName(ctx, id) {
  const cache = (ctx.cursor.users = ctx.cursor.users || {});
  if (!id) return 'Unknown';
  if (cache[id]) return cache[id];
  if ((ctx._lookups = (ctx._lookups || 0) + 1) > 40) return id;
  try {
    const r = await slack(ctx.creds.token, 'users.info', { user: id });
    cache[id] = r.user.profile?.display_name || r.user.real_name || r.user.name || id;
  } catch { cache[id] = id; }
  return cache[id];
}

function tidy(text, users) {
  return String(text || '')
    .replace(/<@([A-Z0-9]+)>/g, (_, id) => '@' + (users[id] || id))
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

module.exports = {
  id: 'slack',
  name: 'Slack',
  kind: 'chat',
  color: '#611f69',
  canReply: true,
  auth: {
    type: 'token',
    fields: [{ key: 'token', label: 'User OAuth Token (starts with xoxp-)', secret: true }],
  },
  setup: [
    'Open api.slack.com/apps → Create New App → From scratch, and pick your workspace.',
    'Under "OAuth & Permissions" add these User Token Scopes: channels:history, groups:history, im:history, mpim:history, channels:read, groups:read, im:read, mpim:read, users:read, chat:write.',
    'Press "Install to Workspace" (a workspace admin may need to approve it), then copy the "User OAuth Token" and paste it below.',
  ],

  async identify(ctx) {
    const r = await slack(ctx.creds.token, 'auth.test');
    return { identity: `${r.user}@${r.team}`, label: `${r.user} · ${r.team}`, extra: { user_id: r.user_id, team_url: r.url } };
  },

  async sync(ctx) {
    const token = ctx.creds.token;
    const convs = [];
    let cursor = '';
    do {
      const r = await slack(token, 'users.conversations', {
        types: 'public_channel,private_channel,mpim,im', exclude_archived: 'true', limit: '200', ...(cursor ? { cursor } : {}),
      });
      convs.push(...r.channels);
      cursor = r.response_metadata?.next_cursor || '';
    } while (cursor && convs.length < 800);

    // Direct messages every time; channels in rotation so large workspaces stay within limits.
    const dms = convs.filter((c) => c.is_im || c.is_mpim);
    const channels = convs.filter((c) => !c.is_im && !c.is_mpim);
    const room = Math.max(0, PER_SYNC - Math.min(dms.length, 20));
    const offset = channels.length ? (ctx.cursor.offset || 0) % channels.length : 0;
    const picked = [...dms.slice(0, 20), ...channels.slice(offset, offset + room), ...channels.slice(0, Math.max(0, offset + room - channels.length))];
    ctx.cursor.offset = channels.length ? (offset + room) % channels.length : 0;
    const seen = (ctx.cursor.seen = ctx.cursor.seen || {});

    const out = [];
    for (const conv of [...new Set(picked)]) {
      const oldest = Math.max(ctx.since - 5 * 60000, seen[conv.id] || 0, Date.now() - 30 * 86400000);
      let hist;
      try {
        hist = await slack(token, 'conversations.history', { channel: conv.id, oldest: String(oldest / 1000), limit: '50' });
      } catch { continue; }
      seen[conv.id] = Date.now() - 60000;
      const title = conv.is_im ? await userName(ctx, conv.user) : conv.is_mpim ? 'Group message' : `#${conv.name}`;
      for (const m of hist.messages || []) {
        if (m.subtype && !['thread_broadcast', 'file_share', 'bot_message'].includes(m.subtype)) continue;
        const name = m.user ? await userName(ctx, m.user) : m.username || 'App';
        for (const id of String(m.text || '').match(/<@([A-Z0-9]+)>/g) || []) await userName(ctx, id.slice(2, -1));
        out.push({
          ext_id: `${conv.id}-${m.ts}`,
          thread: conv.id,
          thread_title: title,
          sender: name,
          sender_addr: m.user || '',
          is_me: m.user === ctx.creds.user_id,
          unread: false,
          body: tidy(m.text, ctx.cursor.users || {}) || (m.files ? '[file]' : ''),
          ts: Math.round(Number(m.ts) * 1000),
          url: ctx.creds.team_url ? `${ctx.creds.team_url}archives/${conv.id}/p${String(m.ts).replace('.', '')}` : null,
        });
      }
    }
    return out;
  },

  async send(ctx, { threadExt, messages, text }) {
    const r = await slack(ctx.creds.token, 'chat.postMessage', { channel: threadExt, text });
    const last = messages[messages.length - 1];
    return {
      ext_id: `${threadExt}-${r.ts}`, thread: threadExt, thread_title: last.thread_title, sender: 'You', sender_addr: ctx.creds.user_id,
      is_me: true, body: text, ts: Math.round(Number(r.ts) * 1000), url: last.url,
    };
  },
};
