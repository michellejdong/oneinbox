'use strict';
// Zoom Team Chat. Meeting chat is not available through Zoom's API unless it was saved with a cloud recording.
const { toMs } = require('../util');

const Z = 'https://api.zoom.us/v2';

module.exports = {
  id: 'zoom',
  name: 'Zoom',
  kind: 'chat',
  color: '#0b5cff',
  canReply: true,
  auth: {
    type: 'oauth',
    authorizeUrl: 'https://zoom.us/oauth/authorize',
    tokenUrl: 'https://zoom.us/oauth/token',
    basicAuth: true,
    keys: ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'],
  },
  setup: [
    'Open marketplace.zoom.us → Develop → Build App → General App, and choose "User-managed".',
    'Set the OAuth redirect address to: {BASE}/oauth/zoom/callback',
    'Add these scopes: user:read:user, team_chat:read:list_user_sessions, team_chat:read:list_user_messages, team_chat:write:user_message.',
    'Paste the client ID and client secret below, save, then press Connect. This covers Zoom Team Chat; in-meeting chat is not offered by Zoom\'s API.',
  ],

  async identify(ctx) {
    const me = await ctx.get(`${Z}/users/me`);
    return { identity: me.email, label: me.email, extra: { me: { id: me.id, email: me.email } } };
  },

  async sync(ctx) {
    const mine = (ctx.creds.me?.email || '').toLowerCase();
    const sessions = (await ctx.get(`${Z}/chat/users/me/sessions?page_size=50`)).sessions || [];
    const from = new Date(ctx.since).toISOString().replace(/\.\d+Z$/, 'Z');
    const to = new Date(Date.now() + 60000).toISOString().replace(/\.\d+Z$/, 'Z');
    const out = [];
    for (const s of sessions.slice(0, 25)) {
      const last = toMs(s.last_message_sent_time);
      if (last && last < ctx.since) continue;
      const channel = s.channel_id;
      const contact = s.peer_contact_email || s.peer_contact_user_id;
      if (!channel && !contact) continue;
      const target = channel ? { to_channel: channel } : { to_contact: contact };
      const thread = channel ? `c:${channel}` : `u:${contact}`;
      const data = await ctx.get(`${Z}/chat/users/me/messages?${new URLSearchParams({ ...target, from, to, page_size: '50' })}`).catch(() => null);
      for (const m of data?.messages || []) {
        if (!m.message) continue;
        out.push({
          ext_id: m.id,
          thread,
          thread_title: s.name || s.peer_contact_name || contact || 'Zoom chat',
          sender: m.sender_display_name || m.sender || 'Unknown',
          sender_addr: m.sender || '',
          is_me: (m.sender || '').toLowerCase() === mine,
          unread: false,
          body: m.message,
          ts: toMs(m.timestamp) || toMs(m.date_time),
          url: null,
        });
      }
    }
    return out;
  },

  async send(ctx, { threadExt, messages, text }) {
    const id = threadExt.slice(2);
    const target = threadExt.startsWith('c:') ? { to_channel: id } : { to_contact: id };
    const sent = await ctx.post(`${Z}/chat/users/me/messages`, { message: text, ...target });
    const prev = messages[messages.length - 1];
    return {
      ext_id: sent.id || `local-${Date.now()}`, thread: threadExt, thread_title: prev.thread_title, sender: 'You',
      sender_addr: ctx.creds.me?.email || '', is_me: true, body: text, ts: Date.now(), url: null,
    };
  },
};
