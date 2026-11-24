'use strict';
// The whole interface. Used unchanged by the desktop window and by the website.

const $ = (sel) => document.querySelector(sel);

/** Build a DOM element. Text is always inserted as text, never as HTML. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'color') el.style.setProperty('--c', v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, { method = 'GET', body, file } = {}) {
  const res = await fetch(path, {
    method,
    headers: file ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: file || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Please sign in.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `That did not work (${res.status}).`);
  return data;
}

const S = {
  state: null, mode: 'inbox', filter: 'all', unread: false, q: '', open: null, view: 'welcome', openCards: new Set(),
  lib: { status: 'open', category: '', urgency: '', label: '', item: null, facets: null },
};
const KINDS = [['email', 'Email'], ['chat', 'Chat'], ['ai', 'AI assistants']];
const source = (id) => S.state.sources.find((s) => s.id === id) || { id, name: id, color: '#888', accounts: [] };
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

let toastTimer;
function toast(message, bad) {
  const el = $('#toast');
  el.textContent = message;
  el.className = bad ? 'show bad' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, bad ? 7000 : 3500);
}
const guard = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { toast(e.message, true); } };

// ---------- dates ----------
const sameDay = (a, b) => a.toDateString() === b.toDateString();
function shortWhen(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (now - d < 6 * 86400000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, new Date(now - 86400000))) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function ago(ts) {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ---------- sidebar ----------
function renderNav() {
  const nav = $('#nav');
  const sources = S.state.sources;
  const item = (id, label, { color, count, dim, heading } = {}) => h('button', {
    class: `nav-item${S.mode === 'inbox' && S.filter === id && S.view !== 'digest' ? ' active' : ''}${dim ? ' dim' : ''}${heading ? ' heading' : ''}`,
    onclick: () => setFilter(id),
  }, color ? h('span', { class: 'dot', color }) : null, h('span', { class: 'nav-label' }, label), count ? h('span', { class: 'badge' }, count) : null);

  const totalUnread = sources.reduce((n, s) => n + s.unread, 0);
  nav.replaceChildren(
    item('all', 'All messages', { count: totalUnread }),
    h('button', { class: `nav-item${S.view === 'digest' ? ' active' : ''}`, onclick: guard(openDigest) }, h('span', { class: 'nav-label' }, 'Daily digest')),
    h('button', { class: `nav-item${S.mode === 'library' && S.view !== 'digest' ? ' active' : ''}`, onclick: guard(openLibrary) },
      h('span', { class: 'nav-label' }, 'Reading list'), S.state.reading.open ? h('span', { class: 'badge' }, S.state.reading.open) : null),
    ...KINDS.flatMap(([kind, label]) => [
      item(kind, label, { heading: true }),
      ...sources.filter((s) => s.kind === kind).map((s) => item(s.id, s.name, { color: s.color, count: s.unread, dim: !s.accounts.length })),
    ]),
  );
  const st = S.state.sync;
  $('#sync-status').textContent = st.running ? 'Checking…' : `Last checked ${ago(st.lastRun)}`;
}

function setFilter(id) {
  const wasLibrary = S.mode === 'library';
  S.mode = 'inbox';
  S.filter = id;
  S.view = S.open && !wasLibrary ? 'thread' : 'welcome';
  document.body.dataset.view = 'list';
  renderNav();
  guard(loadList)();
  if (S.view === 'welcome') { S.open = null; renderWelcome(); }
}

// ---------- conversation list ----------
function renderBanner() {
  const box = $('#banner');
  const broken = S.state.sources.filter((s) => s.accounts.some((a) => a.last_error));
  const parts = [];
  if (S.state.app.sample && S.mode === 'inbox') {
    parts.push(h('div', { class: 'banner' }, 'These are sample conversations. ',
      h('button', { class: 'link', onclick: () => openConnections() }, 'Connect your accounts'), ' to see your own.'));
  }
  if (broken.length) {
    parts.push(h('div', { class: 'banner warn' }, `${broken.map((s) => s.name).join(', ')} need${broken.length === 1 ? 's' : ''} attention. `,
      h('button', { class: 'link', onclick: () => openConnections(broken[0].id) }, 'See details')));
  }
  box.replaceChildren(...parts);
}

function highlight(snippet) {
  // The server marks hits with \u0001…\u0002; everything else stays plain text.
  return String(snippet).split(/(\u0001[^\u0002]*\u0002)/).map((part) =>
    part.startsWith('\u0001') ? h('mark', {}, part.slice(1, -1)) : part);
}

function row({ id, src, title, time, sub, unread, count }) {
  return h('button', { class: `row${unread ? ' unread' : ''}${S.open === id ? ' active' : ''}`, role: 'listitem', onclick: guard(() => openThread(id)) },
    h('span', { class: 'dot', color: src.color, title: src.name }),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-top' }, h('span', { class: 'row-title' }, title || '(untitled)'), h('span', { class: 'row-time' }, time)),
      h('span', { class: 'row-sub' }, h('span', { class: 'row-src' }, src.name), ' · ', sub),
      count > 1 ? h('span', { class: 'row-count' }, `${count} messages`) : null,
    ));
}

async function loadList() {
  const box = $('#threads');
  document.body.dataset.mode = S.mode;
  renderBanner();
  $('#search').placeholder = S.mode === 'library' ? 'Search the reading list' : 'Search every message';
  if (S.mode === 'library') return loadLibrary();
  $('#tools').replaceChildren();
  if (S.q) {
    const { hits } = await api(`/api/search?q=${encodeURIComponent(S.q)}&filter=${encodeURIComponent(S.filter)}`);
    if (!hits.length) return box.replaceChildren(h('div', { class: 'empty' }, `Nothing found for “${S.q}”.`));
    return box.replaceChildren(
      h('div', { class: 'list-note' }, `${hits.length} matching message${hits.length === 1 ? '' : 's'}`),
      ...hits.map((hit) => row({
        id: hit.thread_id, src: source(hit.source), title: hit.title, time: shortWhen(hit.ts),
        sub: [`${hit.is_me ? 'You' : hit.sender}: `, highlight(hit.snippet)],
      })));
  }
  const { threads } = await api(`/api/threads?filter=${encodeURIComponent(S.filter)}${S.unread ? '&unread=1' : ''}`);
  if (!threads.length) {
    const src = S.state.sources.find((s) => s.id === S.filter);
    const needsSetup = src && !src.accounts.length;
    return box.replaceChildren(h('div', { class: 'empty' },
      needsSetup ? `${src.name} is not connected yet.` : S.unread ? 'No unread conversations.' : 'No conversations here yet.',
      needsSetup ? h('div', {}, h('button', { class: 'btn primary', onclick: () => openConnections(src.id) }, `Set up ${src.name}`)) : null));
  }
  box.replaceChildren(...threads.map((t) => row({
    id: t.thread_id, src: source(t.source), title: t.title, time: shortWhen(t.ts), unread: t.unread > 0, count: t.count,
    sub: `${t.last_is_me ? 'You' : t.sender}: ${t.snippet.replace(/\s+/g, ' ')}`,
  })));
}

// ---------- reading pane ----------
function renderWelcome() {
  S.view = 'welcome';
  $('#pane').replaceChildren(h('div', { class: 'welcome' },
    h('h1', {}, 'Everything in one place'),
    h('p', {}, 'Pick a conversation on the left, search across every app, or read today\'s digest.'),
    h('div', { class: 'welcome-actions' },
      h('button', { class: 'btn primary', onclick: guard(openDigest) }, 'Open daily digest'),
      h('button', { class: 'btn', onclick: () => openConnections() }, 'Connections'))));
}

function bubble(m) {
  const long = m.body.length > 1400;
  const body = h('div', { class: `bubble-body${long ? ' clipped' : ''}` }, m.body);
  return h('div', { class: `bubble${m.is_me ? ' me' : ''}` },
    h('div', { class: 'bubble-meta' }, h('strong', {}, m.is_me ? 'You' : m.sender || 'Unknown'), ' ', h('span', {}, clock(m.ts))),
    body,
    long ? h('button', { class: 'link', onclick: (e) => { body.classList.toggle('clipped'); e.target.textContent = body.classList.contains('clipped') ? 'Show all' : 'Show less'; } }, 'Show all') : null);
}

async function openThread(id, keepDraft) {
  const draft = keepDraft ? $('#reply-text')?.value : '';
  const { thread, messages } = await api(`/api/thread?id=${encodeURIComponent(id)}`);
  S.open = id;
  S.view = 'thread';
  document.body.dataset.view = 'pane';
  const src = source(thread.source);
  const url = safeUrl(thread.url);

  const stream = h('div', { class: 'stream' });
  let lastDay = '';
  for (const m of messages) {
    const day = dayLabel(m.ts);
    if (day !== lastDay) { stream.append(h('div', { class: 'day' }, day)); lastDay = day; }
    stream.append(bubble(m));
  }

  let composer;
  if (thread.canReply) {
    const text = h('textarea', { id: 'reply-text', rows: '3', placeholder: `Reply in ${src.name}…`, 'aria-label': 'Your reply' });
    text.value = draft || '';
    const sendIt = guard(async () => {
      const value = text.value.trim();
      if (!value) return;
      button.disabled = true;
      try {
        await api('/api/reply', { method: 'POST', body: { thread_id: id, text: value } });
        text.value = '';
        await openThread(id);
        await refresh();
        toast(thread.sample ? 'Added to the sample conversation (nothing was sent).' : `Sent with ${src.name}.`);
      } finally { button.disabled = false; }
    });
    const button = h('button', { class: 'btn primary', onclick: sendIt }, 'Send');
    text.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendIt(); });
    composer = h('div', { class: 'composer' }, text,
      h('div', { class: 'composer-foot' },
        h('span', { class: 'hint' }, thread.sample ? 'Sample conversation: replies stay on this computer.' : thread.replyNote || `Sends from ${thread.account}. ⌘/Ctrl + Enter to send.`),
        button));
  } else {
    composer = h('div', { class: 'composer readonly' }, 'This conversation was imported, so it is read-only here.',
      url ? [' ', h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, `Continue it in ${src.name} ↗`)] : null);
  }

  $('#pane').replaceChildren(
    h('header', { class: 'pane-head' },
      h('button', { class: 'icon-btn only-narrow', 'aria-label': 'Back to conversations', onclick: () => { document.body.dataset.view = 'list'; } }, '←'),
      h('div', { class: 'pane-title' },
        h('h1', {}, thread.title || '(untitled)'),
        h('div', { class: 'pane-sub' }, h('span', { class: 'dot', color: src.color }), `${src.name} · ${thread.account}`)),
      url ? h('a', { class: 'btn ghost', href: url, target: '_blank', rel: 'noopener noreferrer' }, `Open in ${src.name} ↗`) : null),
    stream, composer);
  stream.scrollTop = stream.scrollHeight;
  document.querySelectorAll('#threads .row').forEach((r) => r.classList.remove('active'));
  if (!keepDraft) refresh();
}

// ---------- reading list ----------
const STATUS = [['todo', 'Not started', true], ['doing', 'In progress', true], ['done', 'Done', true]];
const URGENCY = [['urgent', 'Urgent'], ['soon', 'Soon'], ['whenever', 'Whenever']];

/** A row of buttons where exactly one is selected. */
function choice(options, current, onPick, label) {
  return h('div', { class: 'choice', role: 'group', 'aria-label': label },
    options.map(([value, text, glyph]) => h('button', {
      class: `choice-btn${value === current ? ' on' : ''} v-${value}`, 'aria-pressed': String(value === current), onclick: () => onPick(value),
    }, glyph ? h('span', { class: `glyph g-${value}`, 'aria-hidden': 'true' }) : null, text)));
}

async function openLibrary() {
  S.mode = 'library';
  S.view = 'library';
  S.open = null;
  document.body.dataset.view = 'list';
  renderNav();
  await loadList();
  if (S.lib.item) await openItem(S.lib.item).catch(() => renderLibraryWelcome());
  else renderLibraryWelcome();
}

function renderLibraryTools() {
  const tools = $('#tools');
  if (!$('#lib-add')) {
    const link = h('input', { type: 'text', placeholder: 'Paste a link to save…', 'aria-label': 'Link to save', autocomplete: 'off' });
    const add = guard(async () => {
      if (!link.value.trim()) return;
      button.disabled = true;
      try {
        const r = await api('/api/items', { method: 'POST', body: { url: link.value.trim() } });
        link.value = '';
        await refresh();
        await openItem(r.item.id);
        toast(r.existing ? 'Already in your reading list.' : `Saved under ${r.item.category}.`);
      } finally { button.disabled = false; }
    });
    const button = h('button', { class: 'btn primary', onclick: add }, 'Save');
    link.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    tools.replaceChildren(h('div', { id: 'lib-add', class: 'tool-row' }, link, button), h('div', { id: 'lib-filters' }));
  }
  const f = S.lib.facets;
  const L = S.lib;
  const pick = (key) => (e) => { L[key] = e.target.value; guard(loadList)(); };
  const select = (key, all, options) => h('select', { 'aria-label': all, onchange: pick(key) },
    h('option', { value: '' }, all),
    options.map(([value, text]) => h('option', { value, selected: L[key] === value }, text)));
  const tabs = [['open', `To review ${f.statuses.todo + f.statuses.doing}`], ['doing', `In progress ${f.statuses.doing}`], ['done', `Done ${f.statuses.done}`], ['all', 'All']];
  $('#lib-filters').replaceChildren(
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([value, text]) => h('button', {
      class: `tab${L.status === value ? ' on' : ''}`, role: 'tab', 'aria-selected': String(L.status === value),
      onclick: () => { L.status = value; guard(loadList)(); },
    }, text))),
    h('div', { class: 'tool-row' },
      select('category', 'All categories', f.categories.filter((c) => c.count).map((c) => [c.name, `${c.name} (${c.count})`])),
      select('urgency', 'Any urgency', URGENCY.map(([v, t]) => [v, t])),
      select('label', 'Any label', f.labels.map((l) => [l.name, `${l.name} (${l.count})`]))));
}

async function loadLibrary() {
  const L = S.lib;
  const q = new URLSearchParams({ status: L.status, category: L.category, urgency: L.urgency, label: L.label, q: S.q });
  const { items, facets } = await api(`/api/items?${q}`);
  L.facets = facets;
  renderLibraryTools();
  const box = $('#threads');
  if (!items.length) {
    const total = facets.statuses.todo + facets.statuses.doing + facets.statuses.done;
    return box.replaceChildren(h('div', { class: 'empty' }, total ? 'Nothing matches these filters.' : 'Nothing saved yet. Paste a link above, or use the Save button in your browser.'));
  }
  const groups = new Map();
  for (const item of items) (groups.get(item.category) || groups.set(item.category, []).get(item.category)).push(item);
  const statusName = Object.fromEntries(STATUS.map(([v, t]) => [v, t]));
  box.replaceChildren(...[...groups].flatMap(([category, list]) => [
    h('div', { class: 'list-note' }, `${category} · ${list.length}`),
    ...list.map((item) => h('button', { class: `row item s-${item.status}${L.item === item.id ? ' active' : ''}`, role: 'listitem', onclick: guard(() => openItem(item.id)) },
      h('span', { class: `status-glyph s-${item.status}`, title: statusName[item.status], role: 'img', 'aria-label': statusName[item.status] }),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-top' }, h('span', { class: 'row-title' }, item.title), h('span', { class: 'row-time' }, shortWhen(item.added_at))),
        h('span', { class: 'row-sub' }, [item.site, ...item.labels].filter(Boolean).join(' · ') || statusName[item.status]),
        item.urgency !== 'whenever' ? h('span', { class: `pill u-${item.urgency}` }, item.urgency === 'urgent' ? 'Urgent' : 'Soon') : null))),
  ]));
}

function renderLibraryWelcome() {
  const app = S.state.app;
  const save = h('a', { class: 'btn primary bookmarklet', href: S.state.reading.bookmarklet, title: 'Drag me to your bookmarks bar',
    onclick: (e) => { e.preventDefault(); toast('Drag this button up to your bookmarks bar, then click it on any page you want to keep.'); } }, 'Save to OneInbox');
  $('#pane').replaceChildren(h('div', { class: 'welcome' },
    h('h1', {}, 'Reading list'),
    h('p', {}, 'Keep papers, posts and forms in one place. Each one is filed automatically, and you track whether you have started, are part-way, or are done.'),
    h('div', { class: 'how' },
      h('h3', {}, 'Save with one click'),
      h('ol', {},
        h('li', {}, 'Show your browser\'s bookmarks bar (⌘ Shift B in Chrome, Safari and Edge).'),
        h('li', {}, 'Drag this button onto it: ', save),
        h('li', {}, 'On any paper, post or form, click it. Text you have highlighted on the page is kept as the summary.')),
      h('p', { class: 'hint' }, `If you are in the desktop app, open ${app.baseUrl} in your browser to drag the button. `,
        h('button', { class: 'link', onclick: guard(async () => { await navigator.clipboard.writeText(S.state.reading.bookmarklet); toast('Copied. Create a new bookmark and paste this as its address.'); }) }, 'Or copy it as a bookmark address.')),
      h('p', { class: 'hint' }, 'You can also paste any link into the box at the top of the list.'))));
}

async function openItem(id) {
  const { item } = await api(`/api/items/${id}`);
  S.lib.item = item.id;
  S.view = 'library';
  document.body.dataset.view = 'pane';
  const change = guard(async (changes) => {
    await api(`/api/items/${id}`, { method: 'PATCH', body: changes });
    await refresh();
    await openItem(id);
  });
  const url = safeUrl(item.url);
  const f = S.lib.facets || { categories: [], labels: [] };

  const category = h('input', { type: 'text', list: 'all-categories', value: item.category, 'aria-label': 'Category' });
  category.addEventListener('change', () => change({ category: category.value }));
  const newLabel = h('input', { type: 'text', list: 'all-labels', placeholder: 'Add a label…', 'aria-label': 'Add a label' });
  const addLabel = () => { const v = newLabel.value.trim(); if (v) change({ labels: [...item.labels, v] }); };
  newLabel.addEventListener('keydown', (e) => { if (e.key === 'Enter') addLabel(); });
  newLabel.addEventListener('change', addLabel);
  const notes = h('textarea', { rows: '5', placeholder: 'Your notes…', 'aria-label': 'Notes' });
  notes.value = item.notes || '';
  notes.addEventListener('change', guard(async () => { await api(`/api/items/${id}`, { method: 'PATCH', body: { notes: notes.value } }); toast('Notes saved.'); }));

  $('#pane').replaceChildren(
    h('header', { class: 'pane-head' },
      h('button', { class: 'icon-btn only-narrow', 'aria-label': 'Back to the list', onclick: () => { document.body.dataset.view = 'list'; } }, '←'),
      h('div', { class: 'pane-title' }, h('h1', {}, item.title),
        h('div', { class: 'pane-sub' }, [item.site, item.authors, `saved ${shortWhen(item.added_at)}`].filter(Boolean).join(' · '))),
      url ? h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener noreferrer', onclick: () => { if (item.status === 'todo') change({ status: 'doing' }); } }, 'Open ↗') : null),
    h('div', { class: 'stream item-view' },
      h('section', { class: 'prop' }, h('h4', {}, 'Review'), choice(STATUS, item.status, (v) => change({ status: v }), 'Review status')),
      h('section', { class: 'prop' }, h('h4', {}, 'Urgency'), choice(URGENCY, item.urgency, (v) => change({ urgency: v }), 'Urgency')),
      h('section', { class: 'prop' }, h('h4', {}, 'Category'), category,
        h('datalist', { id: 'all-categories' }, f.categories.map((c) => h('option', { value: c.name })))),
      h('section', { class: 'prop' }, h('h4', {}, 'Labels'),
        h('div', { class: 'chips' },
          item.labels.map((l) => h('span', { class: 'chip' }, l, h('button', { 'aria-label': `Remove label ${l}`, onclick: () => change({ labels: item.labels.filter((x) => x !== l) }) }, '×'))),
          newLabel, h('datalist', { id: 'all-labels' }, f.labels.filter((l) => !item.labels.includes(l.name)).map((l) => h('option', { value: l.name }))))),
      item.excerpt ? h('section', { class: 'prop' }, h('h4', {}, 'Summary'), h('p', { class: 'excerpt' }, item.excerpt)) : null,
      h('section', { class: 'prop' }, h('h4', {}, 'Notes'), notes),
      h('div', { class: 'inline spread' },
        h('button', { class: 'link', onclick: () => { const t = prompt('Title', item.title); if (t && t.trim()) change({ title: t }); } }, 'Rename'),
        h('button', { class: 'link danger', onclick: guard(async () => {
          if (!confirm('Remove this from your reading list?')) return;
          await api(`/api/items/${id}`, { method: 'DELETE' });
          S.lib.item = null;
          await refresh();
          renderLibraryWelcome();
        }) }, 'Remove from reading list'))));
  document.querySelectorAll('#threads .row.item').forEach((r) => r.classList.remove('active'));
}

// ---------- digest ----------
function markdown(text) {
  const root = h('div', { class: 'md' });
  const inline = (s) => s.split(/(\*\*[^*]+\*\*)/).map((p) => (p.startsWith('**') && p.endsWith('**') && p.length > 4 ? h('strong', {}, p.slice(2, -2)) : p));
  let list = null;
  for (const line of String(text).split('\n')) {
    if (/^#{1,4}\s/.test(line)) { list = null; root.append(h('h3', {}, inline(line.replace(/^#+\s/, '')))); }
    else if (/^\s*[-*•]\s+/.test(line)) { if (!list) { list = h('ul'); root.append(list); } list.append(h('li', {}, inline(line.replace(/^\s*[-*•]\s+/, '')))); }
    else if (/^_.*_$/.test(line.trim())) { list = null; root.append(h('p', { class: 'hint' }, line.trim().slice(1, -1))); }
    else if (line.trim()) { list = null; root.append(h('p', {}, inline(line))); }
    else list = null;
  }
  return root;
}

const ENGINES = { claude: 'Written by Claude', ollama: 'Written by your local model', 'built-in': 'Built-in summary' };

async function openDigest() {
  S.view = 'digest';
  S.open = null;
  S.lib.item = null;
  document.body.dataset.view = 'pane';
  renderNav();
  const { digest, engine } = await api('/api/digest');
  renderDigest(digest, engine);
}

function renderDigest(digest, engine) {
  const hours = h('select', { 'aria-label': 'Period' },
    h('option', { value: '24' }, 'Last 24 hours'), h('option', { value: '48' }, 'Last 2 days'), h('option', { value: '168' }, 'Last 7 days'));
  const button = h('button', { class: 'btn primary', onclick: guard(async () => {
    button.disabled = true;
    button.textContent = 'Writing…';
    try {
      const r = await api('/api/digest', { method: 'POST', body: { hours: Number(hours.value) } });
      renderDigest(r.digest, r.engine);
    } finally { button.disabled = false; button.textContent = 'Write a new digest'; }
  }) }, 'Write a new digest');

  $('#pane').replaceChildren(
    h('header', { class: 'pane-head' },
      h('button', { class: 'icon-btn only-narrow', 'aria-label': 'Back to conversations', onclick: () => { document.body.dataset.view = 'list'; } }, '←'),
      h('div', { class: 'pane-title' }, h('h1', {}, 'Daily digest'),
        h('div', { class: 'pane-sub' }, digest ? `${ENGINES[digest.engine] || digest.engine} · ${new Date(digest.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'No digest yet')),
      hours, button),
    h('div', { class: 'stream digest' },
      digest ? markdown(digest.body) : h('p', { class: 'hint' }, 'Press “Write a new digest” to summarise what arrived recently.'),
      engine === 'built-in' ? h('p', { class: 'hint boxed' }, 'This is the built-in summary. For a written digest, add a Claude API key or a local Llama model under ',
        h('button', { class: 'link', onclick: () => openConnections('general') }, 'Connections → Digest and general'), '.') : null));
}

// ---------- connections ----------
function statusOf(s) {
  if (s.accounts.some((a) => a.last_error)) return ['Needs attention', 'warn'];
  if (s.accounts.some((a) => !a.sample)) return [s.accounts.every((a) => a.imported || a.sample) ? 'Imported' : 'Connected', 'ok'];
  if (s.accounts.length) return ['Sample only', 'muted'];
  return ['Not connected', 'muted'];
}

function field(label, attrs) {
  const input = h('input', { type: attrs.secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', ...attrs, secret: null });
  return { input, el: h('label', { class: 'field' }, h('span', {}, label), input) };
}

function importBlock(s) {
  const files = h('input', { type: 'file', multiple: true, accept: '.zip,.json,.txt,.md' });
  const me = s.id === 'whatsapp' ? field('Your name exactly as it appears in the chat (so your side shows as “You”)', { placeholder: 'e.g. Michelle' }) : null;
  const button = h('button', { class: 'btn', onclick: guard(async () => {
    if (!files.files.length) return toast('Choose a file first.', true);
    button.disabled = true;
    try {
      let added = 0;
      const notes = [];
      for (const f of files.files) {
        const q = new URLSearchParams({ name: f.name, source: s.id, me: me ? me.input.value : '' });
        const r = await api(`/api/import?${q}`, { method: 'POST', file: f });
        added += r.added;
        notes.push(...r.notes);
        for (const [id, info] of Object.entries(r.bySource)) notes.unshift(`${source(id).name}: ${info.conversations} conversation${info.conversations === 1 ? '' : 's'}, ${info.added} new message${info.added === 1 ? '' : 's'}.`);
      }
      files.value = '';
      await refresh(true);
      toast(notes.join(' ') || `Imported ${added} new messages.`, !added && notes.length > 0);
    } finally { button.disabled = false; }
  }) }, 'Import');
  return h('div', { class: 'conn-block' }, h('h4', {}, 'Import a file'), me?.el, h('div', { class: 'inline' }, files, button));
}

function sourceCard(s) {
  const [label, tone] = statusOf(s);
  const body = [];

  for (const a of s.accounts) {
    body.push(h('div', { class: 'account' },
      h('div', {}, h('strong', {}, a.label), h('div', { class: a.last_error ? 'error' : 'hint' }, a.last_error || (a.sample ? 'Sample data' : `Updated ${ago(a.last_sync)}`))),
      h('button', { class: 'btn ghost', onclick: guard(async () => {
        if (!confirm(`Remove ${s.name} (${a.label}) and its messages from OneInbox? Nothing is deleted in ${s.name} itself.`)) return;
        await api(`/api/accounts/${a.id}`, { method: 'DELETE' });
        await refresh(true);
      }) }, 'Remove')));
  }

  if (s.setup.length) body.push(h('div', { class: 'conn-block' }, h('h4', {}, 'How to set it up'), h('ol', {}, s.setup.map((step) => h('li', {}, step)))));

  if (s.authType === 'oauth') {
    const inputs = s.keys.map((key) => {
      const info = S.state.settings[key] || {};
      const secret = !('value' in info);
      const label = key.endsWith('_CLIENT_ID') ? 'Client ID' : key.endsWith('_CLIENT_SECRET') ? 'Client secret' : 'Tenant ID (optional — only if your organization\'s app is single-tenant)';
      return { key, ...field(label, { secret, placeholder: info.set ? (secret ? 'Saved — leave empty to keep' : '') : '', value: secret ? null : info.value || null }) };
    });
    const save = h('button', { class: 'btn', onclick: guard(async () => {
      const values = {};
      for (const i of inputs) if (i.input.value.trim()) values[i.key] = i.input.value.trim();
      await api('/api/settings', { method: 'POST', body: values });
      await refresh(true);
      toast('Saved.');
    }) }, 'Save');
    body.push(h('div', { class: 'conn-block' }, h('h4', {}, 'App credentials'), inputs.map((i) => i.el),
      h('div', { class: 'inline' }, save,
        s.configured
          ? h('a', { class: 'btn primary', href: `/oauth/${s.id}/start`, target: '_blank', rel: 'noopener' }, s.accounts.some((a) => !a.sample) ? 'Connect another account' : `Connect ${s.name}`)
          : h('span', { class: 'hint' }, 'Save the client ID and secret to enable Connect.'))));
  }

  if (s.authType === 'token') {
    const inputs = s.fields.map((f) => ({ key: f.key, ...field(f.label + (f.optional ? ' (optional)' : ''), { secret: f.secret }) }));
    const connect = h('button', { class: 'btn primary', onclick: guard(async () => {
      connect.disabled = true;
      try {
        const r = await api('/api/accounts/token', { method: 'POST', body: { connector: s.id, values: Object.fromEntries(inputs.map((i) => [i.key, i.input.value])) } });
        await refresh(true);
        toast(`${s.name} connected as ${r.label}.`);
      } finally { connect.disabled = false; }
    }) }, `Connect ${s.name}`);
    body.push(h('div', { class: 'conn-block' }, h('h4', {}, s.authOptional ? 'Live connection (Business accounts)' : 'Connect'), inputs.map((i) => i.el), connect));
  }

  if (s.importable) body.push(importBlock(s));

  return h('details', { class: 'conn', id: `conn-${s.id}`, open: S.openCards.has(s.id), ontoggle: (e) => (e.target.open ? S.openCards.add(s.id) : S.openCards.delete(s.id)) },
    h('summary', {}, h('span', { class: 'dot', color: s.color }), h('span', { class: 'conn-name' }, s.name), h('span', { class: `pill ${tone}` }, label)),
    h('div', { class: 'conn-body' }, body));
}

function generalCard() {
  const defs = [
    ['MY_NAMES', 'Your name(s), separated by commas — used to spot messages that mention you', {}],
    ['DIGEST_HOUR', 'Write the digest automatically at this hour each day (0–23; leave empty for manual only)', { inputmode: 'numeric' }],
    ['ANTHROPIC_API_KEY', 'Claude API key — lets Claude write the digest', { secret: true }],
    ['DIGEST_MODEL', 'Claude model for the digest (optional)', { placeholder: 'claude-haiku-4-5' }],
    ['OLLAMA_URL', 'Local model address (Ollama) — keeps the digest entirely on this computer', { placeholder: 'http://localhost:11434' }],
    ['OLLAMA_MODEL', 'Local model name', { placeholder: 'llama3.2' }],
  ];
  const inputs = defs.map(([key, label, attrs]) => {
    const info = S.state.settings[key] || {};
    return { key, secret: attrs.secret, ...field(label, { ...attrs, value: attrs.secret ? null : info.value || null, placeholder: attrs.secret && info.set ? 'Saved — leave empty to keep' : attrs.placeholder }) };
  });
  const save = h('button', { class: 'btn primary', onclick: guard(async () => {
    const values = {};
    for (const i of inputs) if (!i.secret || i.input.value.trim()) values[i.key] = i.input.value.trim();
    await api('/api/settings', { method: 'POST', body: values });
    await refresh(true);
    toast('Saved.');
  }) }, 'Save');
  return h('details', { class: 'conn', id: 'conn-general', open: S.openCards.has('general'), ontoggle: (e) => (e.target.open ? S.openCards.add('general') : S.openCards.delete('general')) },
    h('summary', {}, h('span', { class: 'conn-name' }, 'Digest and general'), h('span', { class: 'pill muted' }, ENGINES[S.state.digestEngine])),
    h('div', { class: 'conn-body' },
      h('p', { class: 'hint' }, 'With a Claude API key, the text of recent messages is sent to Anthropic to write the digest. A local model, or the built-in summary, keeps everything on this computer.'),
      inputs.map((i) => i.el), save));
}

function renderConnections() {
  const app = S.state.app;
  $('#connections-body').replaceChildren(
    h('p', { class: 'hint' }, 'Each source is connected once. Saved logins are encrypted and stay on this computer.'),
    h('div', { class: 'inline spread' },
      h('span', { class: 'hint' }, app.sample ? 'Sample conversations are showing.' : 'Sample conversations are hidden.'),
      h('button', { class: 'btn ghost', onclick: guard(async () => {
        await api(app.sample ? '/api/sample/clear' : '/api/sample/load', { method: 'POST', body: {} });
        if (S.open && S.open.includes(':sample-')) { S.open = null; renderWelcome(); }
        await refresh(true);
      }) }, app.sample ? 'Remove samples' : 'Show samples')),
    ...KINDS.flatMap(([kind, label]) => [h('h3', {}, label), ...S.state.sources.filter((s) => s.kind === kind).map(sourceCard)]),
    h('h3', {}, 'Settings'),
    generalCard(),
    h('p', { class: 'hint' }, `Large export files can also be dropped into the folder “${app.importFolder}”; they are picked up at the next check.`));
}

function openConnections(focusId) {
  if (focusId) S.openCards.add(focusId);
  renderConnections();
  const dialog = $('#connections');
  if (!dialog.open) dialog.showModal();
  if (focusId) document.getElementById(`conn-${focusId}`)?.scrollIntoView({ block: 'start' });
}

// ---------- keeping things fresh ----------
async function refresh(rerenderDialog) {
  S.state = await api('/api/state');
  renderNav();
  renderBanner();
  await loadList();
  const dialog = $('#connections');
  const typing = dialog.contains(document.activeElement) && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (dialog.open && (rerenderDialog || !typing)) renderConnections();
}

async function boot() {
  $('#btn-connections').addEventListener('click', () => openConnections());
  $('#btn-close').addEventListener('click', () => $('#connections').close());
  $('#btn-menu').addEventListener('click', () => { document.body.dataset.view = document.body.dataset.view === 'nav' ? 'list' : 'nav'; });
  $('#btn-sync').addEventListener('click', guard(async () => {
    $('#sync-status').textContent = 'Checking…';
    const r = await api('/api/sync', { method: 'POST', body: {} });
    await refresh();
    toast(r.lastAdded ? `${r.lastAdded} new message${r.lastAdded === 1 ? '' : 's'}.` : 'Nothing new.');
  }));
  $('#only-unread').addEventListener('change', (e) => { S.unread = e.target.checked; guard(loadList)(); });
  let typingTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { S.q = e.target.value.trim(); guard(loadList)(); }, 180);
  });
  document.addEventListener('keydown', (e) => {
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (e.key === '/' && !inField && !$('#connections').open) { e.preventDefault(); $('#search').focus(); }
  });
  window.addEventListener('focus', guard(() => refresh()));
  setInterval(guard(() => { if (!document.hidden && document.activeElement.tagName !== 'SELECT') return refresh(); }), 30000);

  await refresh();
  renderWelcome();
}

boot().catch((e) => toast(e.message, true));
