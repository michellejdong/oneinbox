'use strict';
const { htmlToText } = require('../util');
const outlook = require('./outlook');

const G = 'https://graph.microsoft.com/v1.0';

function normalize(chat, m, myId, title) {
  if (m.messageType !== 'message' || !m.from) return null;
  const user = m.from.user || m.from.application || {};
  const body = m.body?.contentType === 'html' ? htmlToText(m.body.content) : m.body?.content || '';
  if (!body.trim()) return null;
  return {
    ext_id: m.id,
    thread: chat.id,
    thread_title: title,
    sender: user.displayName || 'Unknown',
    sender_addr: user.id || '',
    is_me: Boolean(myId && user.id === myId),
    unread: false,
    body,
    ts: Date.parse(m.createdDateTime),
    url: chat.webUrl || null,
  };
}

module.exports = {
  id: 'teams',
  name: 'Teams',
  kind: 'chat',
  color: '#5b5fc7',
  canReply: true,
  auth: outlook.microsoftAuth(['Chat.Read', 'ChatMessage.Send']),
  setup: [
    'Use the same Microsoft app registration as Outlook (see the Outlook steps), and add a second "Web" redirect address: {BASE}/oauth/teams/callback',
    'Under "API permissions" add Microsoft Graph delegated permissions: Chat.Read and ChatMessage.Send.',
    'Press Connect and sign in with your work account. Most organizations require an IT admin to approve reading Teams chats; channel posts are not included.',
  ],

  identify: outlook.whoAmI,

  async sync(ctx) {
    const myId = ctx.creds.me?.id;
    const list = await ctx.get(`${G}/me/chats?${new URLSearchParams({
      $top: '50', $expand: 'lastMessagePreview', $orderby: 'lastMessagePreview/createdDateTime desc',
    })}`);
    const out = [];
    for (const chat of (list.value || []).slice(0, 30)) {
      const last = Date.parse(chat.lastMessagePreview?.createdDateTime || '') || 0;
      if (last && last < ctx.since) continue;
      const data = await ctx.get(`${G}/me/chats/${encodeURIComponent(chat.id)}/messages?$top=50`);
      const msgs = data.value || [];
      const other = msgs.find((m) => m.from?.user && m.from.user.id !== myId)?.from.user.displayName;
      const title = chat.topic || other || (chat.chatType === 'oneOnOne' ? 'Direct chat' : 'Group chat');
      for (const m of msgs) {
        const n = normalize(chat, m, myId, title);
        if (n && n.ts >= ctx.since) out.push(n);
      }
    }
    return out;
  },

  async send(ctx, { threadExt, messages, text }) {
    const sent = await ctx.post(`${G}/chats/${encodeURIComponent(threadExt)}/messages`, { body: { content: text } });
    const last = messages[messages.length - 1];
    return {
      ext_id: sent.id, thread: threadExt, thread_title: last.thread_title, sender: 'You', sender_addr: ctx.creds.me?.id || '',
      is_me: true, body: text, ts: Date.parse(sent.createdDateTime) || Date.now(), url: last.url,
    };
  },
};
