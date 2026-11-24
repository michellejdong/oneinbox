'use strict';
// Reads an export file (zip, JSON or text), recognises what it is, and stores the conversations.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const store = require('./db');
const zip = require('./zip');
const ai = require('./connectors/aichats');
const whatsapp = require('./connectors/whatsapp');

const IMPORT_DIR = path.join(DATA_DIR, 'imports');

function importText(name, text, opts, result) {
  const body = String(text).replace(/^﻿/, '');
  const trimmed = body.trimStart();
  if (trimmed[0] === '[' || trimmed[0] === '{') {
    let data;
    try { data = JSON.parse(body); } catch { result.notes.push(`${name}: not valid JSON, skipped.`); return; }
    const convs = ai.parseJson(data, opts.hint);
    if (!convs) { result.notes.push(`${name}: not a format this app recognises yet.`); return; }
    result.rows.push(...ai.toMessages(convs));
    return;
  }
  if (opts.hint === 'whatsapp' || (opts.hint === 'auto' && whatsapp.looksLikeExport(body))) {
    const names = [...store.myNames(), ...String(opts.me || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)];
    const parsed = whatsapp.parseExport(body, opts.displayName || name, names).messages;
    if (!parsed.length) result.notes.push(`${name}: no WhatsApp messages found in this file.`);
    result.rows.push(...parsed);
    return;
  }
  const convs = ai.parseTranscript(body, name, opts.hint);
  if (convs) result.rows.push(...ai.toMessages(convs));
  else result.notes.push(`${name}: could not tell what kind of conversation this is. Pick a source and try again.`);
}

function importZip(filePath, zipName, opts, result) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const entries = zip.listEntries(fd).filter((e) => !e.name.endsWith('/') && !e.name.startsWith('__MACOSX/'));
    let used = 0;
    for (const entry of entries) {
      const base = path.basename(entry.name);
      const isJson = /\.json$/i.test(base) && /conversation|activity|chat|message/i.test(base);
      const isText = /\.txt$/i.test(base);
      if (!isJson && !isText) continue;
      let text;
      try { text = zip.readEntry(fd, entry).toString('utf8'); } catch (e) { result.notes.push(e.message); continue; }
      if (isText && opts.hint === 'auto' && !whatsapp.looksLikeExport(text)) continue;
      importText(base, text, { ...opts, displayName: /^_chat\.txt$/i.test(base) ? zipName : base }, result);
      used++;
    }
    if (!used) result.notes.push(`${zipName}: no conversations found inside this zip.`);
  } finally {
    fs.closeSync(fd);
  }
}

/** Import one file from disk. Returns a summary: { added, total, bySource, notes }. */
function importFile(filePath, name, opts = {}) {
  const options = { hint: opts.hint || 'auto', me: opts.me || '' };
  const result = { rows: [], notes: [] };
  const fd = fs.openSync(filePath, 'r');
  const magic = Buffer.alloc(4);
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (magic.readUInt32LE(0) === 0x04034b50) importZip(filePath, name, options, result);
  else importText(name, fs.readFileSync(filePath, 'utf8'), { ...options, displayName: name }, result);

  const bySource = {};
  let added = 0;
  for (const row of result.rows) (bySource[row.source] = bySource[row.source] || []).push(row);
  const summary = {};
  for (const [source, rows] of Object.entries(bySource)) {
    const account = store.findAccount(source, 'import') || store.saveAccount(source, 'import', 'Imported', { import: true });
    const fresh = store.saveMessages(account, rows);
    store.updateAccount(account.id, { last_sync: Date.now() });
    added += fresh;
    summary[source] = { messages: rows.length, added: fresh, conversations: new Set(rows.map((r) => r.thread)).size };
  }
  return { added, total: result.rows.length, bySource: summary, notes: result.notes };
}

/** Anything dropped into data/imports is imported, then moved to data/imports/done. */
function scanDropFolder() {
  fs.mkdirSync(path.join(IMPORT_DIR, 'done'), { recursive: true });
  const results = [];
  for (const name of fs.readdirSync(IMPORT_DIR)) {
    const full = path.join(IMPORT_DIR, name);
    if (name.startsWith('.') || !fs.statSync(full).isFile()) continue;
    try {
      results.push({ name, ...importFile(full, name) });
    } catch (e) {
      results.push({ name, added: 0, notes: [e.message] });
    }
    fs.renameSync(full, path.join(IMPORT_DIR, 'done', `${Date.now()}-${name}`));
  }
  return results;
}

module.exports = { importFile, scanDropFolder, IMPORT_DIR };
