'use strict';
const { api } = require('../util');

const D = 'https://discord.com/api/v10';
const MAX_CHANNELS = 40;
const call = (ctx, path, opts = {}) => api(`${D}${path}`, { ...opts, headers: { Authorization: `Bot ${ctx.creds.token}` } });
const snowflake = (ms) => String((BigInt(Math.max(ms, 1420070400000)) - 1420070400000n) << 22n);

module.exports = {
  id: 'discord',
  name: 'Discord',
  kind: 'chat',
  color: '#5865f2',
  canReply: true,
  replyNote: 'Replies are posted by your bot, not from your personal account.',
  auth: {
    type: 'token',
    fields: [{ key: 'token', label: 'Bot token', secret: true }],
  },
  setup: [
    'Open discord.com/developers/applications → New Application → Bot. Press "Reset Token" and copy it. Turn on "Message Content Intent".',
    'Under OAuth2 → URL Generator tick "bot", then View Channels, Read Message History and Send Messages. Open the generated link to add the bot to a server you manage.',
    'Paste the bot token below. Discord only allows bots to read servers they were added to; personal direct messages are not available to any third-party app.',
  ],

  async identify(ctx) {
    const me = await call(ctx, '/users/@me');
    return { identity: me.id, label: `${me.username} (bot)`, extra: { bot_id: me.id } };
  },

  async sync(ctx) {
    const last = (ctx.cursor.last = ctx.cursor.last || {});
    const guilds = await call(ctx, '/users/@me/guilds');
    const out = [];
    let budget = MAX_CHANNELS;
    for (const guild of guilds) {
      if (budget <= 0) break;
      const channels = (await call(ctx, `/guilds/${guild.id}/channels`).catch(() => [])).filter((c) => c.type === 0 || c.type === 5);
      for (const ch of channels) {
        if (budget-- <= 0) break;
        const after = last[ch.id] || snowflake(ctx.since);
        const msgs = await call(ctx, `/channels/${ch.id}/messages?limit=50&after=${after}`).catch(() => []);
        for (const m of msgs) {
          const text = m.content || (m.attachments?.length ? '[attachment]' : m.embeds?.length ? '[embed]' : '');
          if (!text) continue;
          out.push({
            ext_id: m.id,
            thread: ch.id,
            thread_title: `${guild.name} › #${ch.name}`,
            sender: m.author?.global_name || m.author?.username || 'Unknown',
            sender_addr: m.author?.id || '',
            is_me: m.author?.id === ctx.creds.bot_id,
            unread: false,
            body: text,
            ts: Date.parse(m.timestamp),
            url: `https://discord.com/channels/${guild.id}/${ch.id}/${m.id}`,
          });
          if (!last[ch.id] || BigInt(m.id) > BigInt(last[ch.id])) last[ch.id] = m.id;
        }
      }
    }
    return out;
  },

  async send(ctx, { threadExt, messages, text }) {
    const m = await call(ctx, `/channels/${threadExt}/messages`, { method: 'POST', json: { content: text.slice(0, 2000) } });
    const prev = messages[messages.length - 1];
    return {
      ext_id: m.id, thread: threadExt, thread_title: prev.thread_title, sender: 'You (bot)', sender_addr: ctx.creds.bot_id,
      is_me: true, body: m.content, ts: Date.parse(m.timestamp) || Date.now(), url: prev.url,
    };
  },
};
