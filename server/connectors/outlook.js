'use strict';
const { cfg } = require('../db');
const { htmlToText, stripQuoted } = require('../util');

const G = 'https://graph.microsoft.com/v1.0';
const tenant = () => cfg('MICROSOFT_TENANT', 'common');

const microsoftAuth = (scopes) => ({
  type: 'oauth',
  authorizeUrl: () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`,
  tokenUrl: () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`,
  scopes: ['offline_access', 'User.Read', ...scopes],
  keys: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
  optionalKeys: ['MICROSOFT_TENANT'],
});

async function whoAmI(ctx) {
  const me = await ctx.get(`${G}/me?$select=id,displayName,mail,userPrincipalName`);
  const email = me.mail || me.userPrincipalName;
  return { identity: email, label: email, extra: { me: { id: me.id, email, name: me.displayName } } };
}

module.exports = {
  id: 'outlook',
  name: 'Outlook',
  kind: 'email',
  color: '#0f6cbd',
  canReply: true,
  auth: microsoftAuth(['Mail.Read', 'Mail.Send']),
  setup: [
    'Open entra.microsoft.com → App registrations → New registration. For account types choose "any organizational directory and personal Microsoft accounts".',
    'Add a "Web" redirect address: {BASE}/oauth/outlook/callback',
    'Under "Certificates & secrets" create a client secret. Under "API permissions" add Microsoft Graph delegated permissions: Mail.Read, Mail.Send, offline_access, User.Read.',
    'Paste the Application (client) ID and the secret value below, save, then press Connect. A work account may need your IT team to approve the app first.',
  ],
  microsoftAuth,
  whoAmI,

  identify: whoAmI,

  async sync(ctx) {
    const params = new URLSearchParams({
      $top: '50',
      $orderby: 'receivedDateTime desc',
      $filter: `receivedDateTime ge ${new Date(ctx.since).toISOString()}`,
      $select: 'id,conversationId,subject,from,toRecipients,receivedDateTime,body,bodyPreview,isRead,isDraft,webLink',
    });
    let url = `${G}/me/messages?${params}`;
    const mine = (ctx.creds.me?.email || ctx.account.identity || '').toLowerCase();
    const out = [];
    for (let page = 0; url && page < 5; page++) {
      const data = await ctx.get(url, { headers: { Prefer: 'outlook.body-content-type="text"' } });
      for (const m of data.value || []) {
        if (m.isDraft) continue;
        const from = m.from?.emailAddress || {};
        const isMe = (from.address || '').toLowerCase() === mine;
        const text = m.body?.contentType === 'html' ? htmlToText(m.body.content) : m.body?.content || m.bodyPreview || '';
        out.push({
          ext_id: m.id,
          thread: m.conversationId || m.id,
          thread_title: m.subject || '(no subject)',
          sender: from.name || from.address || 'Unknown',
          sender_addr: from.address || '',
          is_me: isMe,
          unread: !isMe && m.isRead === false,
          body: stripQuoted(text),
          ts: Date.parse(m.receivedDateTime),
          url: m.webLink,
        });
      }
      url = data['@odata.nextLink'] || null;
    }
    return out;
  },

  async send(ctx, { messages, text }) {
    const target = [...messages].reverse().find((m) => !m.is_me) || messages[messages.length - 1];
    const extId = target.id.split(':').slice(2).join(':');
    await ctx.post(`${G}/me/messages/${encodeURIComponent(extId)}/reply`, { comment: text });
    return null; // Outlook does not hand back the sent message; the next sync picks it up.
  },
};
