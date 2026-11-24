'use strict';
// "Sign in with …" flow shared by Gmail, Outlook, Teams and Zoom.
const crypto = require('crypto');
const { BASE_URL } = require('./config');
const { cfg } = require('./db');
const { api } = require('./util');

const pending = new Map(); // state → { id, at }

const resolve = (v) => (typeof v === 'function' ? v() : v);
const redirectUri = (connector) => `${BASE_URL}/oauth/${connector.id}/callback`;
const clientId = (c) => cfg(c.auth.keys[0]);
const clientSecret = (c) => cfg(c.auth.keys[1]);
const isConfigured = (c) => Boolean(clientId(c) && clientSecret(c));

function startUrl(connector) {
  if (!isConfigured(connector)) throw new Error(`${connector.name} needs its client ID and secret first.`);
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60000) pending.delete(k);
  const state = crypto.randomBytes(18).toString('hex');
  pending.set(state, { id: connector.id, at: Date.now() });
  const a = connector.auth;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(connector),
    redirect_uri: redirectUri(connector),
    state,
    ...(a.scopes ? { scope: a.scopes.join(' ') } : {}),
    ...(a.extraParams || {}),
  });
  return `${resolve(a.authorizeUrl)}?${params}`;
}

async function exchange(connector, params) {
  const a = connector.auth;
  const form = { ...params };
  const headers = {};
  if (a.basicAuth) {
    headers.Authorization = 'Basic ' + Buffer.from(`${clientId(connector)}:${clientSecret(connector)}`).toString('base64');
  } else {
    form.client_id = clientId(connector);
    form.client_secret = clientSecret(connector);
  }
  const t = await api(resolve(a.tokenUrl), { method: 'POST', form, headers });
  if (!t.access_token) throw new Error(`${connector.name} did not return an access token.`);
  return t;
}

async function finish(connector, code, state) {
  const p = pending.get(state);
  if (!p || p.id !== connector.id) throw new Error('This sign-in link expired. Please start again from Connections.');
  pending.delete(state);
  const t = await exchange(connector, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(connector) });
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000,
  };
}

/** Returns a working access token, renewing it when it is about to expire. */
async function fresh(connector, creds, persist) {
  if (creds.expires_at && creds.expires_at - 60000 > Date.now()) return creds.access_token;
  if (!creds.refresh_token) throw new Error(`${connector.name} sign-in has expired. Reconnect it from Connections.`);
  const t = await exchange(connector, { grant_type: 'refresh_token', refresh_token: creds.refresh_token });
  creds.access_token = t.access_token;
  if (t.refresh_token) creds.refresh_token = t.refresh_token;
  creds.expires_at = Date.now() + (Number(t.expires_in) || 3600) * 1000;
  if (persist) persist();
  return creds.access_token;
}

module.exports = { startUrl, finish, fresh, isConfigured, redirectUri };
