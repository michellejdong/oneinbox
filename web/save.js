'use strict';
// The small window opened by the "Save to OneInbox" browser button.
(async function () {
  const box = document.getElementById('save');
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const show = (...nodes) => { box.replaceChildren(brand(), ...nodes); };
  const brand = () => { const b = el('div', 'brand'); b.append(el('span', 'logo'), 'OneInbox'); return b; };
  const call = async (path, method, body) => {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Sign in to OneInbox first, then click the save button again.');
    if (!res.ok) throw new Error(data.error || 'Could not save this page.');
    return data;
  };

  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
  if (!p.get('u')) return show(el('p', 'error', 'Nothing to save. Use the "Save to OneInbox" button from a page you want to keep.'));

  let closeTimer;
  try {
    const { item, existing } = await call('/api/items/capture', 'POST', { token: p.get('t'), url: p.get('u'), title: p.get('n'), text: p.get('x') });
    const render = (current) => {
      const urgency = el('div', 'choice');
      for (const [value, label] of [['urgent', 'Urgent'], ['soon', 'Soon'], ['whenever', 'Whenever']]) {
        const b = el('button', `choice-btn v-${value}${current.urgency === value ? ' on' : ''}`, label);
        b.addEventListener('click', async () => { clearTimeout(closeTimer); render((await call(`/api/items/${item.id}`, 'PATCH', { urgency: value })).item); });
        urgency.append(b);
      }
      const chips = el('div', 'chips');
      for (const l of current.labels) chips.append(el('span', 'chip', l));
      const close = el('button', 'btn primary', 'Done');
      close.addEventListener('click', () => window.close());
      show(
        el('h1', '', existing ? 'Already in your reading list' : 'Saved to your reading list'),
        el('p', 'saved-title', current.title),
        el('p', 'hint', 'Filed under'), el('p', 'pill ok', current.category),
        current.labels.length ? chips : '',
        el('p', 'hint', 'How urgent is it?'), urgency,
        close);
    };
    render(item);
    closeTimer = setTimeout(() => window.close(), 9000);
    document.addEventListener('pointermove', () => clearTimeout(closeTimer), { once: true });
  } catch (e) {
    show(el('p', 'error', e.message));
  }
})();
