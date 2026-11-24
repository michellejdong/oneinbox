'use strict';
// AI assistant conversations. None of these services offers a live "read my history" connection,
// so conversations come in from each service's own export file and become searchable here.
const crypto = require('crypto');
const { toMs, htmlToText } = require('../util');

const AI = {
  claude: {
    name: 'Claude', color: '#c96442',
    setup: ['In Claude open Settings → Privacy → "Export data". You receive an email with a download link.', 'Import the downloaded .zip here (no need to unzip it).'],
  },
  chatgpt: {
    name: 'ChatGPT', color: '#10a37f',
    setup: ['In ChatGPT open Settings → Data controls → "Export data". You receive an email with a download link.', 'Import the downloaded .zip here (no need to unzip it).'],
  },
  gemini: {
    name: 'Gemini', color: '#4285f4',
    setup: ['Open takeout.google.com, press "Deselect all", tick "My Activity", and under "All activity data included" keep only "Gemini Apps". Set the format to JSON.', 'Import the downloaded .zip here. Google exports prompts and answers without conversation names, so they are grouped by day.'],
  },
  muse: {
    name: 'Muse', color: '#0064e0',
    setup: ['There is no export from this assistant that this app can read automatically yet.', 'Copy a conversation into a text file with lines starting "You:" and "Muse:", choose "Muse" as the source, and import it. A JSON file shaped like { "title": "…", "messages": [{ "role": "user", "content": "…" }] } also works.'],
  },
  llama: {
    name: 'Llama', color: '#8a6d3b',
    setup: ['If you run Llama through Open WebUI: Settings → Chats → "Export chats", then import the JSON file here.', 'Other tools: import a text transcript ("You:" / "Llama:" lines) or a JSON file shaped like { "title": "…", "messages": [{ "role": "user", "content": "…" }] }, choosing "Llama" as the source.'],
  },
  aiother: {
    name: 'Other AI', color: '#7a7a7a',
    setup: ['Any other assistant: import a text transcript ("You:" / "Assistant:" lines) or a JSON file shaped like { "title": "…", "messages": [{ "role": "user", "content": "…" }] }.'],
  },
};

const connectors = Object.entries(AI).map(([id, def]) => ({
  id, name: def.name, kind: 'ai', color: def.color, canReply: false, auth: { type: 'import' }, setup: def.setup,
}));

const pickSource = (hint, fallback) => (AI[hint] ? hint : fallback);
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 14);

// ---------- ChatGPT: conversations.json ----------
function fromChatGPT(list) {
  return list.map((conv) => {
    const nodes = conv.mapping || {};
    let chain = [];
    const guard = new Set();
    for (let cur = conv.current_node; cur && nodes[cur] && !guard.has(cur); cur = nodes[cur].parent) {
      guard.add(cur);
      chain.push(nodes[cur]);
    }
    chain.reverse();
    if (!chain.length) chain = Object.values(nodes).sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
    const turns = [];
    for (const node of chain) {
      const m = node.message;
      const role = m?.author?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (m.metadata?.is_visually_hidden_from_conversation) continue;
      const c = m.content || {};
      if (c.content_type && !['text', 'multimodal_text', 'code'].includes(c.content_type)) continue;
      const text = Array.isArray(c.parts)
        ? c.parts.map((p) => (typeof p === 'string' ? p : p?.text || (p?.content_type ? `[${p.content_type}]` : ''))).join('\n')
        : c.text || '';
      if (text.trim()) turns.push({ id: m.id || node.id, me: role === 'user', text, ts: toMs(m.create_time) });
    }
    const id = conv.conversation_id || conv.id || hash(conv.title + conv.create_time);
    return { source: 'chatgpt', id, title: conv.title || 'Untitled chat', url: `https://chatgpt.com/c/${id}`, ts: toMs(conv.create_time), turns };
  });
}

// ---------- Claude: conversations.json ----------
function fromClaude(list) {
  return list.map((conv) => ({
    source: 'claude',
    id: conv.uuid || hash(conv.name + conv.created_at),
    title: conv.name || 'Untitled chat',
    url: conv.uuid ? `https://claude.ai/chat/${conv.uuid}` : null,
    ts: toMs(conv.created_at),
    turns: (conv.chat_messages || []).map((m) => ({
      id: m.uuid,
      me: m.sender === 'human',
      text: m.text || (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n'),
      ts: toMs(m.created_at),
    })),
  }));
}

// ---------- Gemini: Google Takeout "My Activity" ----------
const isGeminiItem = (i) => i && i.time && (/gemini|bard/i.test(i.header || '') || (i.products || []).some((p) => /gemini|bard/i.test(p)));
function fromGemini(list) {
  const days = new Map();
  for (const item of list.filter(isGeminiItem).sort((a, b) => toMs(a.time) - toMs(b.time))) {
    const t = toMs(item.time);
    const prompt = String(item.title || '').replace(/^(Prompted|Asked|Said)\s+/i, '').trim();
    if (!t || !prompt) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    if (!days.has(day)) days.set(day, { source: 'gemini', id: `day-${day}`, title: `${day} · ${prompt.slice(0, 60)}`, url: 'https://gemini.google.com/app', ts: t, turns: [] });
    const conv = days.get(day);
    conv.turns.push({ id: `${t}-q`, me: true, text: prompt, ts: t });
    const answer = htmlToText((item.safeHtmlItem || []).map((h) => h.html || '').join('\n'));
    if (answer) conv.turns.push({ id: `${t}-a`, me: false, text: answer, ts: t + 1 });
  }
  return [...days.values()];
}

// ---------- Open WebUI (a common way to run Llama locally) ----------
function fromOpenWebUI(list, hint) {
  return list.map((c) => {
    const chat = c.chat || {};
    const raw = Array.isArray(chat.messages) && chat.messages.length ? chat.messages : Object.values(chat.history?.messages || {});
    return {
      source: pickSource(hint, 'llama'),
      id: c.id || hash(JSON.stringify(raw).slice(0, 400)),
      title: c.title || chat.title || 'Untitled chat',
      url: null,
      ts: toMs(c.created_at) || toMs(chat.timestamp),
      turns: raw.map((m) => ({
        id: m.id, me: m.role === 'user', ts: toMs(m.timestamp),
        text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      })).filter((t) => t.text),
    };
  });
}

// ---------- generic JSON: { title, messages: [{ role, content, timestamp }] } ----------
const ME_ROLES = new Set(['user', 'human', 'me', 'you']);
function fromGeneric(list, hint) {
  return list.filter((c) => c && Array.isArray(c.messages)).map((c) => ({
    source: pickSource(String(c.source || '').toLowerCase(), pickSource(hint, 'aiother')),
    id: String(c.id || c.uuid || hash((c.title || c.name || '') + JSON.stringify(c.messages).slice(0, 400))),
    title: c.title || c.name || 'Untitled chat',
    url: typeof c.url === 'string' && /^https?:\/\//.test(c.url) ? c.url : null,
    ts: toMs(c.created_at || c.timestamp || c.ts),
    turns: c.messages.map((m, i) => ({
      id: m.id ?? i,
      me: ME_ROLES.has(String(m.role || m.sender || m.author || '').toLowerCase()),
      text: [m.content, m.text, m.body].find((v) => typeof v === 'string') || '',
      ts: toMs(m.timestamp || m.created_at || m.ts || m.time),
    })),
  }));
}

/** Recognise a parsed JSON export and return conversations, or null when the shape is unknown. */
function parseJson(data, hint) {
  if (Array.isArray(data)) {
    if (!data.length) return [];
    if (data.some((c) => c && c.mapping)) return fromChatGPT(data);
    if (data.some((c) => c && c.chat_messages)) return fromClaude(data);
    if (data.some(isGeminiItem)) return fromGemini(data);
    if (data.some((c) => c && c.chat && (c.chat.messages || c.chat.history))) return fromOpenWebUI(data, hint);
    if (data.some((c) => c && Array.isArray(c.messages))) return fromGeneric(data, hint);
    if (data.every((m) => m && (m.role || m.sender) && (m.content || m.text))) return fromGeneric([{ messages: data }], hint);
    return null;
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.conversations)) return parseJson(data.conversations, hint);
    if (data.mapping) return fromChatGPT([data]);
    if (data.chat_messages) return fromClaude([data]);
    if (Array.isArray(data.messages)) return fromGeneric([data], hint);
  }
  return null;
}

// ---------- plain-text transcript: "You: …" / "Claude: …" ----------
const SPEAKERS = { you: null, me: null, user: null, human: null, assistant: 'aiother', ai: 'aiother', bot: 'aiother',
  claude: 'claude', chatgpt: 'chatgpt', gpt: 'chatgpt', gemini: 'gemini', 'meta ai': 'muse', muse: 'muse', llama: 'llama' };
const SPEAKER_LINE = new RegExp(`^(${Object.keys(SPEAKERS).join('|')})\\s*:\\s*(.*)$`, 'i');

function parseTranscript(text, fileName, hint) {
  const turns = [];
  let guessed = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(SPEAKER_LINE);
    if (m) {
      const who = SPEAKERS[m[1].toLowerCase()];
      if (who && who !== 'aiother') guessed = guessed || who;
      turns.push({ me: who === null, text: m[2] });
    } else if (turns.length) turns[turns.length - 1].text += '\n' + line;
  }
  if (turns.length < 2) return null;
  const title = String(fileName || 'Transcript').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || 'Transcript';
  return [{
    source: pickSource(hint, guessed || 'aiother'), id: 'txt-' + hash(text), title, url: null, ts: Date.now(),
    turns: turns.map((t, i) => ({ id: i, me: t.me, text: t.text.trim(), ts: 0 })),
  }];
}

/** Turn recognised conversations into rows for the message store. */
function toMessages(conversations) {
  const out = [];
  for (const conv of conversations || []) {
    const name = AI[conv.source]?.name || 'Assistant';
    const base = conv.ts || Date.now();
    conv.turns.filter((t) => t.text && t.text.trim()).forEach((t, i) => out.push({
      source: conv.source, ext_id: `${conv.id}:${t.id ?? i}`, thread: conv.id, thread_title: conv.title,
      sender: t.me ? 'You' : name, sender_addr: '', is_me: t.me, unread: false, body: t.text, ts: t.ts || base + i * 1000, url: conv.url,
    }));
  }
  return out;
}

module.exports = { AI, connectors, parseJson, parseTranscript, toMessages };
