'use strict';
// Fetches new messages from every connected account on a timer.
const { LOOKBACK_DAYS } = require('./config');
const store = require('./db');
const oauth = require('./oauth');
const { api } = require('./util');
const { byId } = require('./connectors');

/** Everything a connector needs to talk to its service on behalf of one account. */
function makeCtx(connector, creds, account) {
  const ctx = {
    connector,
    creds,
    account,
    cursor: account ? JSON.parse(account.cursor || '{}') : {},
    since: account && account.last_sync ? account.last_sync - 10 * 60000 : Date.now() - LOOKBACK_DAYS * 86400000,
    async token() {
      if (connector.auth.type !== 'oauth') return creds.token;
      return oauth.fresh(connector, creds, () => account && store.updateAccount(account.id, { credentials: store.seal(creds) }));
    },
    async get(url, opts = {}) { return api(url, { ...opts, token: await ctx.token() }); },
    async post(url, json, opts = {}) { return api(url, { method: 'POST', json, ...opts, token: await ctx.token() }); },
  };
  return ctx;
}

async function syncAccount(account) {
  const connector = byId[account.connector];
  if (!connector || !connector.sync) return 0;
  let creds;
  try { creds = store.open(account.credentials); } catch { creds = null; }
  if (!creds) { store.updateAccount(account.id, { last_error: 'Saved login could not be read. Please reconnect.' }); return 0; }
  if (creds.demo || creds.import) return 0;
  const ctx = makeCtx(connector, creds, account);
  const started = Date.now();
  try {
    const fresh = store.saveMessages(account, await connector.sync(ctx));
    store.updateAccount(account.id, { last_sync: started, last_error: null, cursor: JSON.stringify(ctx.cursor) });
    return fresh;
  } catch (e) {
    store.updateAccount(account.id, { last_error: String(e.message || e).slice(0, 400) });
    return 0;
  }
}

const status = { running: false, lastRun: 0, lastAdded: 0 };

async function syncAll() {
  if (status.running) return status;
  status.running = true;
  let added = 0;
  try {
    for (const account of store.listAccounts()) added += await syncAccount(account);
  } finally {
    status.running = false;
    status.lastRun = Date.now();
    status.lastAdded = added;
  }
  return status;
}

module.exports = { makeCtx, syncAccount, syncAll, status };
