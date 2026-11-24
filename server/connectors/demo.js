'use strict';
// Sample conversations so the app has something to show before any real account is connected.
const store = require('../db');

const MIN = 60000;

// [connector, account label, thread title, [[sender or null for "me", minutes ago, text, unread?], …]]
const SAMPLE = [
  ['gmail', 'sample@example.com', 'Receipts for the workshop trip', [
    ['Priya Nair', 190, 'Hi — could you send me the receipts from the workshop trip by Thursday? Finance closes the month on Friday and I would like to get your reimbursement into this cycle.\n\nThanks,\nPriya', true],
  ]],
  ['gmail', 'sample@example.com', 'Your parcel is out for delivery', [
    ['Parcel Updates', 1300, 'Your parcel is out for delivery today between 1 pm and 5 pm. No signature is required.'],
  ]],
  ['outlook', 'sample@example.org', 'Seminar schedule — draft for review', [
    [null, 1500, 'Here is the list of speakers who have confirmed so far. Two are still pending.'],
    ['Tomás Rivera', 310, 'Thanks. Attached is the draft schedule for next term. Can you confirm the Tuesday 2 pm slot works for your group before I send it round?', true],
  ]],
  ['outlook', 'sample@example.org', 'Building access on Saturday', [
    ['Facilities', 2900, 'The east entrance will be closed this Saturday for maintenance. Please use the main entrance.'],
  ]],
  ['slack', 'sample · Example Team', '#project-atlas', [
    ['Morgan Lee', 260, 'Can someone review the analysis notebook before standup tomorrow?'],
    [null, 250, 'I can take a look this afternoon.'],
    ['Dana Okafor', 95, 'Thanks! Also, the cluster quota request needs your sign-off — the form is pinned in this channel.'],
  ]],
  ['slack', 'sample · Example Team', 'Dana Okafor', [
    ['Dana Okafor', 42, 'Do you have 10 minutes after lunch to talk through the figures?', true],
  ]],
  ['teams', 'sample@example.org', 'Budget planning', [
    ['Lee Chen', 480, 'I have uploaded the Q1 numbers to the shared folder.'],
    ['Lee Chen', 478, 'I need your comments by Friday so we can lock the plan on Monday.', true],
  ]],
  ['discord', 'sample-bot (bot)', 'Reading Group › #general', [
    ['Sam', 700, 'Next week\'s paper is posted in #papers. It is a short one.'],
    ['Robin', 640, 'Great, I will lead the discussion if nobody else wants to.'],
  ]],
  ['whatsapp', 'Imported', 'Family', [
    ['Mum', 150, 'Dinner on Sunday at 6?'],
    ['Alex', 140, 'I will bring dessert.'],
    ['Mum', 35, 'Perfect. Can you pick up bread on the way?', true],
  ]],
  ['zoom', 'sample@example.org', 'Jordan Kim', [
    ['Jordan Kim', 20, 'Running five minutes late to the 2 pm call — please start without me.', true],
  ]],
  ['claude', 'Imported', 'Outline for a two-page project summary', [
    [null, 3000, 'Help me outline a two-page summary of our project for a general audience.'],
    ['Claude', 2999, 'Here is a four-part structure that fits two pages:\n\n1. The question — one paragraph on what you set out to learn and why it matters.\n2. The approach — how you went about it, in plain language.\n3. What you found — the two or three results a reader should remember.\n4. What comes next — open questions and the next milestone.'],
  ]],
  ['chatgpt', 'Imported', 'Script to rename a folder of files', [
    [null, 4400, 'Write a short script that renames every file in a folder to include today\'s date.'],
    ['ChatGPT', 4399, 'Here is a small Python script that adds the date to the start of each file name, and skips files that already have it.'],
  ]],
  ['gemini', 'Imported', 'Comparing two ways to run a weekly meeting', [
    [null, 5800, 'Compare a stand-up format with a written-updates format for a weekly team meeting.'],
    ['Gemini', 5799, 'Stand-ups are quick and surface blockers early, but they favour whoever speaks first. Written updates are easier to skim and to search later, but they need someone to read them.'],
  ]],
  ['llama', 'Imported', 'Local model test: summarise meeting notes', [
    [null, 7200, 'Summarise these meeting notes in three bullet points.'],
    ['Llama', 7199, '• The pilot starts on the 1st.\n• Two people will share the on-call rota.\n• The budget review moves to next month.'],
  ]],
];

function load() {
  const now = Date.now();
  let n = 0;
  for (const [connector, label, title, rows] of SAMPLE) {
    const account = store.findAccount(connector, 'sample') || store.saveAccount(connector, 'sample', `${label} (sample)`, { demo: true });
    const thread = 'sample-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    n += store.saveMessages(account, rows.map(([sender, ago, body, unread], i) => ({
      ext_id: `${thread}-${i}`, thread, thread_title: title, sender: sender || 'You', sender_addr: '', is_me: !sender,
      unread: Boolean(unread), body, ts: now - ago * MIN, url: null,
    })));
    store.updateAccount(account.id, { last_sync: now });
  }
  return n;
}

function clear() {
  for (const a of store.listAccounts()) if (a.identity === 'sample') store.deleteAccount(a.id);
}

const present = () => store.listAccounts().some((a) => a.identity === 'sample');

module.exports = { load, clear, present };
