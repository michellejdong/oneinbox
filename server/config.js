'use strict';
// Start-up configuration. Reads optional ".env" files; everything has a safe default.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));
const DATA_DIR = path.resolve(process.env.ONEINBOX_DATA || path.join(ROOT, 'data'));
loadDotEnv(path.join(DATA_DIR, '.env'));

const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || '127.0.0.1';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

module.exports = {
  ROOT,
  DATA_DIR,
  PORT,
  HOST,
  BASE_URL,
  APP_PASSWORD: process.env.APP_PASSWORD || '',
  SYNC_MINUTES: Math.max(1, Number(process.env.SYNC_MINUTES || 5)),
  LOOKBACK_DAYS: Math.max(1, Number(process.env.LOOKBACK_DAYS || 14)),
  VERSION: require('../package.json').version,
  isLoopback: ['127.0.0.1', 'localhost', '::1'].includes(HOST),
};
