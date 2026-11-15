/* Split the Bill — the split lives on the device (localStorage); only a scanned photo goes to /api/scan. */
const $ = (s) => document.querySelector(s);
const KEY = 'splitbill.v1', NAMES = 'splitbill.names';
const STEPS = ['Bill', 'Split', 'Result'];
const COLORS = ['#0f766e', '#c2410c', '#6d28d9', '#be185d', '#1d4ed8', '#4d7c0f', '#b45309', '#475569'];

const view = $('#view'), nextBtn = $('#next'), backBtn = $('#back'), sheet = $('#sheet'), personSheet = $('#personSheet');
let S = load();
let editingId = null, editingPerson = null;
let delFor = null;               // person whose tile badge is showing delete instead of rename
let adding = false;               // the add-person panel on the Split step is open

/* ---------- state ---------- */
function guessCur() {
  const r = (navigator.language || '').split('-')[1];
  return { IN: '₹', US: '$', GB: '£', CA: '$', AU: '$', JP: '¥' }[r] ||
    (['DE', 'FR', 'ES', 'IT', 'NL', 'IE', 'PT', 'AT', 'BE', 'FI'].includes(r) ? '€' : '₹');
}
function fresh() { return { v: 3, step: 0, items: [], people: [], sel: [], multi: false, total: null, note: null, cur: guessCur() }; }
function load() {
  try {
    const old = JSON.parse(localStorage.getItem(KEY));
    // v1 had a separate People step: Bill, People, Assign, Result.
    if (old && !old.v) old.step = [0, 1, 1, 2][old.step] || 0;
    const s = Object.assign(fresh(), old, { v: 3 });
    // The selection used to be one person's id, or 'all'.
    if (!Array.isArray(s.sel)) { s.multi = s.sel === 'all'; s.sel = s.sel === 'all' ? s.people.map((p) => p.id) : s.sel ? [s.sel] : []; }
    return s;
  } catch { return fresh(); }
}
function loadNames() { try { return JSON.parse(localStorage.getItem(NAMES)) || []; } catch { return []; } }
function rememberName(name) {
  const list = [name, ...loadNames().filter((n) => n.toLowerCase() !== name.toLowerCase())].slice(0, 12);
  try { localStorage.setItem(NAMES, JSON.stringify(list)); } catch {}
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------- money ---------- */
const cents = (n) => Math.round((Number(n) || 0) * 100);
const fmt = (c) => S.cur + (c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Split `amount` cents by weights so the parts always add up exactly. */
function allocate(amount, weights) {
  const W = weights.reduce((a, b) => a + b, 0);
  if (!W) return weights.map(() => 0);
  const sign = amount < 0 ? -1 : 1, abs = Math.abs(amount);
  const raw = weights.map((w) => (abs * w) / W);
  const out = raw.map(Math.floor);
  let left = abs - out.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left-- > 0) out[i]++; });
  return out.map((v) => v * sign);
}

const subtotal = () => S.items.reduce((a, i) => a + cents(i.total), 0);
const billTotal = () => (S.total != null ? cents(S.total) : subtotal());
const sharersOf = (shares) => S.people.filter((p) => shares[p.id] > 0);
const sharers = (item) => sharersOf(item.shares);

/* A quantity item (2 to 24 of something) is split into one slot per unit, kept in `parts`.
   Each slot has its own sharers, so one unit can go to one person and the next be shared.
   Splits saved before slots existed are carried over the first time the item is read. */
const canCount = (it) => Number.isInteger(it.qty) && it.qty > 1 && it.qty <= 24;
function slots(it) {
  if (!canCount(it) || it.whole) return null;        // `whole`: shared as one item, by price not by unit
  if (!it.parts || it.parts.length !== it.qty) {
    const ids = Object.keys(it.shares || {}).filter((id) => it.shares[id] > 0);
    // Counts that add up to the quantity ("Asha had 2, Ravi 1") become one slot each; anything else was an equal split.
    const owners = ids.reduce((a, id) => a + it.shares[id], 0) === it.qty ? ids.flatMap((id) => Array(it.shares[id]).fill(id)) : null;
    it.parts = Array.from({ length: it.qty }, (_, k) => (owners ? { [owners[k]]: 1 } : Object.fromEntries(ids.map((id) => [id, 1]))));
    it.shares = {}; it.uneven = false; delete it.lump;
  }
  return it.parts;
}
/* What gets split. Slots held by the same people are split together as one amount,
   so six rotis between three people come to the same total for each of them. */
function pieces(it) {
  const parts = slots(it);
  if (!parts) return [{ shares: it.shares, amt: cents(it.total), n: 1 }];
  const amts = allocate(cents(it.total), parts.map(() => 1)), groups = new Map();
  parts.forEach((shares, k) => {
    const key = sharersOf(shares).map((p) => p.id).join();
    const g = groups.get(key) || { shares, amt: 0, n: 0 };
    g.amt += amts[k]; g.n++;
    groups.set(key, g);
  });
  return [...groups.values()];
}
const finished = (it) => pieces(it).every((pc) => sharersOf(pc.shares).length);
const unassigned = () => S.items.filter((i) => !finished(i));
const everyone = () => Object.fromEntries(S.people.map((x) => [x.id, 1]));
/* The rail selection: one person, or several picked together (`S.multi`). */
const pickedAll = () => S.people.length > 1 && S.sel.length === S.people.length;
const hasPicked = (shares) => S.sel.length > 0 && S.sel.every((id) => shares[id] > 0);
const isEveryone = (shares) => S.people.length > 0 && sharersOf(shares).length === S.people.length;

function compute() {
  const per = S.people.map((p) => ({ p, base: 0, extra: 0, lines: [] }));
  const idx = Object.fromEntries(S.people.map((p, i) => [p.id, i]));
  for (const it of S.items) for (const pc of pieces(it)) {
    const who = sharersOf(pc.shares);
    const w = who.map((p) => pc.shares[p.id]);
    const W = w.reduce((a, b) => a + b, 0);
    allocate(pc.amt, w).forEach((amt, k) => {
      const row = per[idx[who[k].id]];
      row.base += amt;
      row.lines.push({ name: it.name + (pc.n > 1 ? ` ×${pc.n}` : ''), amt, frac: who.length > 1 ? `${w[k]}/${W}` : '' });
    });
  }
  const extra = billTotal() - subtotal();
  allocate(extra, per.map((r) => r.base)).forEach((e, i) => { per[i].extra = e; });
  per.forEach((r) => { r.total = r.base + r.extra; });
  return { per, extra, total: billTotal() };
}

/* ---------- navigation ---------- */
function blocker(step) {
  if (step >= 1 && !S.items.length && !scanning) return 'Add at least one item';
  if (step >= 2 && S.people.length < 2) return 'Add at least 2 people';
  if (step >= 2 && scanning) return 'Still reading your bill…';
  if (step >= 2 && unassigned().length) {
    const n = unassigned().length;
    return `${n} item${n > 1 ? 's' : ''} left to assign`;
  }
  return '';
}
function go(step) {
  if (step > S.step && blocker(step)) return;
  S.step = step;
  render();
  view.scrollTop = 0;
}

/* ---------- views ---------- */
function liveItems() {
  if (!scanning) return '';
  return `<div class="card live">
    <div class="row sub">${scanning.items.length ? 'Found so far (you can edit once reading is done)' : 'Looking for items…'}</div>
    ${scanning.items.map((i) => `<div class="row">
      <span class="grow"><div class="name">${esc(i.name)}</div>
      ${i.qty !== 1 ? `<div class="sub">${i.qty} × ${fmt(Math.round(cents(i.total) / i.qty))}</div>` : ''}</span>
      <span class="amt">${fmt(cents(i.total))}</span></div>`).join('')}
  </div>`;
}

function billView() {
  if (!S.items.length && scanning) {
    return `<p class="lead">Reading your bill. No need to wait here: go ahead and add people on the next step.</p>${liveItems()}`;
  }
  if (!S.items.length) {
    return `<div class="empty">
      <div class="art">🧾</div>
      <h2>Start with your bill</h2>
      <p>Take a photo and we'll read the items for you.</p>
      <button class="btn primary block" data-act="scan">📷 Scan a bill</button>
      <button class="btn ghost block" data-act="add-item">Type items instead</button>
    </div>`;
  }
  const sub = subtotal(), extra = billTotal() - sub;
  return `<p class="lead">Check the items match your bill. Tap one to edit.</p>
    ${S.note ? `<div class="banner"><span class="grow">⚠️ ${esc(S.note)}</span><button class="x" data-act="dismiss-note" aria-label="Dismiss">×</button></div>` : ''}
    <div class="card">
      ${S.items.map((i) => `<button class="row ${i.flag ? 'flag' : ''}" data-act="edit-item" data-id="${i.id}">
        <span class="grow"><div class="name">${esc(i.name)}</div>
        ${i.flag ? '<div class="sub warn">Check this price</div>' : ''}
        ${i.qty !== 1 ? `<div class="sub">${i.qty} × ${fmt(Math.round(cents(i.total) / i.qty))}</div>` : ''}</span>
        <span class="amt">${fmt(cents(i.total))}</span></button>`).join('')}
      <button class="row add" data-act="add-item">+ Add item</button>
      ${scanning ? '' : '<button class="row add" data-act="scan">📷 Scan another bill</button>'}
    </div>
    ${liveItems()}
    <div class="card totals">
      <div class="row"><span class="grow">Items subtotal</span><span class="amt">${fmt(sub)}</span></div>
      <label class="row"><span class="grow">Bill total<div class="sub">as printed, with tax and tip</div></span>
        <input id="total" type="number" inputmode="decimal" step="0.01" min="0"
          placeholder="${(sub / 100).toFixed(2)}" value="${S.total != null ? S.total : ''}"></label>
      ${extra ? `<div class="row"><span class="grow">${extra > 0 ? 'Tax, tip and charges' : 'Discount'}<div class="sub">shared in proportion to what each person had</div></span>
        <span class="amt">${extra > 0 ? '+' : '−'}${fmt(Math.abs(extra))}</span></div>` : ''}
      <label class="row"><span class="grow">Currency</span>
        <select id="cur">${['₹', '$', '€', '£', '¥', ''].map((c) => `<option value="${c}" ${c === S.cur ? 'selected' : ''}>${c || 'None'}</option>`).join('')}</select></label>
    </div>`;
}

const PENCIL = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
const av = (p, cls = '') => `<span class="dot ${cls}" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span>`;

/* Person-first: pick someone in the rail, then tap everything they had. */
function assignView() {
  S.sel = S.people.filter((p) => S.sel.includes(p.id)).map((p) => p.id);      // drop anyone removed, keep rail order
  if (!S.sel.length && S.people.length) S.sel = [S.people[0].id];
  if (S.people.length < 2 || S.sel.length < 1) S.multi = false;
  const group = S.people.filter((p) => S.sel.includes(p.id));
  const all = pickedAll(), me = group.length === 1 ? group[0] : null;
  const untouched = S.people.length > 1 && S.items.length > 0 && S.items.every((i) => pieces(i).every((pc) => !sharersOf(pc.shares).length));
  const open = adding || !S.people.length;
  const left = unassigned().length;
  const base = Object.fromEntries(compute().per.map((r) => [r.p.id, r.base]));
  const recents = loadNames().filter((n) => !S.people.some((x) => x.name.toLowerCase() === n.toLowerCase()));
  return `${S.people.length > 1 ? `<div class="seg" role="group" aria-label="Pick for">
      <button data-act="mode" data-m="one" aria-pressed="${!S.multi}">One person</button>
      <button data-act="mode" data-m="multi" aria-pressed="${S.multi}">Together</button>
    </div>` : ''}
    <div class="rail ${S.multi ? 'multi' : ''}" role="tablist" aria-label="Who are you picking for?" ${S.multi ? 'aria-multiselectable="true"' : ''}>
      ${S.people.map((p) => `<div class="tile">
        <button role="tab" aria-selected="${S.sel.includes(p.id)}" data-act="sel" data-p="${p.id}" style="--c:${p.color}">
          ${av(p)}<span class="rname">${esc(p.name)}</span><span class="rtot">${fmt(base[p.id])}</span></button>
        ${S.multi ? `<span class="check" style="--c:${p.color}" aria-hidden="true">${S.sel.includes(p.id) ? '✓' : ''}</span>`
        : delFor === p.id
          ? `<button class="edit del" data-act="del-person" data-p="${p.id}" aria-label="Remove ${esc(p.name)}">${TRASH}</button>`
          : `<button class="edit" data-act="edit-person" data-p="${p.id}" aria-label="Rename ${esc(p.name)}">${PENCIL}</button>`}
      </div>`).join('')}
      ${S.multi ? `<button role="tab" aria-selected="${all}" data-act="sel" data-p="all">
        <span class="dot every">All</span><span class="rname">Everyone</span><span class="rtot">select all</span></button>` : ''}
      <button class="adder" aria-expanded="${open}" data-act="add-person">
        <span class="dot every">+</span><span class="rname">Add</span><span class="rtot">person</span></button>
    </div>
    ${open ? `<form class="addrow" id="personForm">
      <input id="pName" type="text" placeholder="Name" aria-label="Name" autocomplete="off" autocapitalize="words" enterkeyhint="done" maxlength="24">
      <button class="btn primary" type="submit">Add</button>
    </form>
    ${recents.length ? `<div class="recent"><span class="sub">Add again</span>
      ${recents.map((n) => `<button class="chip" data-act="add-recent" data-name="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : ''}` : ''}
    <p class="lead">${!S.people.length ? 'Add everyone splitting this bill.'
      : all ? 'Tap what everyone shared.'
      : me ? `Tap everything ${esc(me.name)} had.`
      : group.length <= 3 ? `Tap what ${esc(group.slice(0, -1).map((p) => p.name).join(', '))} and ${esc(group[group.length - 1].name)} shared.`
      : `Tap what these ${group.length} shared.`}
</p>
    ${untouched ? `<div class="banner calm"><span class="grow">Mostly shared by the whole table?</span>
      <button class="link" data-act="all-equal">Split everything equally</button></div>` : ''}
    ${left && left < S.items.length ? `<div class="banner"><span class="grow">${left} item${left > 1 ? 's' : ''} not finished yet.</span>
      <button class="link" data-act="rest-all">Split between everyone</button></div>` : ''}
    ${S.items.length ? `<div class="card">${S.items.map((it) => {
      const who = sharers(it), total = cents(it.total);
      const tint = me ? me.color : group.length ? 'var(--accent)' : 'var(--line)';
      const each = (amt, n) => { const e = allocate(amt, Array(n).fill(1)); return `${e[0] !== e[n - 1] ? 'about ' : ''}${fmt(e[n - 1])} each`; };
      const row = ({ name, sub, warn, badges, amt, on, tick }) => `<button class="row pick" aria-pressed="${on}"
          data-act="pick" data-id="${it.id}" ${S.sel.length ? '' : 'disabled'}>
          <span class="tick" aria-hidden="true">${on ? tick || '✓' : ''}</span>
          <span class="grow"><div class="name">${name}</div>${sub ? `<div class="sub ${warn ? 'warn' : ''}">${sub}</div>` : ''}</span>
          <span class="stack">${badges}</span>
          <span class="amt">${fmt(amt)}</span></button>`;

      const units = slots(it);
      if (units) {
        const free = units.filter((sh) => !sharersOf(sh).length).length;
        const mine = all ? 0 : units.filter(hasPicked).length;
        const on = !it.auto && (all ? units.every(isEveryone) : mine > 0);   // an untouched table split is not this person's pick
        const big = it.qty > 6, show = (!big || it.open) && !it.auto;   // many units, or an untouched table split, stay folded into counts
        const groups = new Map();
        units.forEach((sh) => {
          const w = sharersOf(sh);
          if (w.length) groups.set(w.map((p) => p.id).join(), { w, n: (groups.get(w.map((p) => p.id).join())?.n || 0) + 1 });
        });
        const summary = [...groups.values()].map(({ w, n }) => `<span class="cnt ${w.length > 1 ? 'grp' : ''}" style="--c:${w[0].color}">${
          w.length > 3 ? `${w.length} people` : esc(w.map((p) => p.name[0].toUpperCase()).join('+'))}${n > 1 ? ` ×${n}` : ''}</span>`).join('');
        const toggle = big ? `<button class="link" data-act="toggle-slots" data-id="${it.id}">${show ? 'Hide each one' : 'Show each one'}</button>` : '';
        const tip = it.auto ? 'Shared by everyone · tap to give it to the picked people only' : show && free < it.qty ? 'Tap a filled slot to share it' : '';
        const asOne = `<button class="link" data-act="whole" data-id="${it.id}">Share as one</button>`;
        return `<div class="item ${on ? 'on' : ''}" style="--c:${tint}">
          ${row({ name: esc(it.name), amt: total, on, tick: all ? '✓' : String(mine), warn: free > 0,
            sub: `${it.qty} ordered · ${free ? `${free} left` : 'all taken'}`, badges: show ? '' : summary })}
          ${show ? `<div class="slots">${units.map((sh, k) => {
            const w = sharersOf(sh);
            return `<button class="slot ${w.length ? '' : 'free'}" aria-pressed="${all ? isEveryone(sh) : hasPicked(sh)}" data-act="pick" data-id="${it.id}" data-k="${k}"
              aria-label="${w.length ? `One ${esc(it.name)}: ${esc(w.map((p) => p.name).join(', '))}` : `One ${esc(it.name)}, free`}" ${S.sel.length ? '' : 'disabled'}>${
              w.length ? w.map((p) => av(p, 'sm')).join('') : '+'}</button>`;
          }).join('')}</div>` : ''}
          <p class="hint">${[tip, asOne, toggle].filter(Boolean).join(' · ')}</p></div>`;
      }

      const on = !it.auto && (all ? who.length === S.people.length : hasPicked(it.shares));
      const parts = allocate(total, who.map((p) => it.shares[p.id]));
      const sub = [it.qty !== 1 ? `Qty ${it.qty}` : '', who.length >= 2 && !it.uneven ? each(total, who.length) : ''].filter(Boolean).join(' · ');
      const link = [who.length >= 2 ? `<button class="link" data-act="uneven" data-id="${it.id}">Split unevenly</button>` : '',
        it.whole && canCount(it) ? `<button class="link" data-act="by-unit" data-id="${it.id}">Split by unit</button>` : ''].filter(Boolean).join(' · ');
      let extra = link ? `<p class="hint">${link}</p>` : '';
      if (who.length >= 2 && it.uneven) {
        extra = `<div class="uneven">${who.map((p, k) => `<div class="urow">
            <span class="grow name">${esc(p.name)}</span>
            <span class="stepper"><button data-act="dec" data-id="${it.id}" data-p="${p.id}" aria-label="Less">−</button>
            <span>${it.shares[p.id]}</span>
            <button data-act="inc" data-id="${it.id}" data-p="${p.id}" aria-label="More">+</button></span>
            <span class="amt uamt">${fmt(parts[k])}</span></div>`).join('')}
          <p class="hint flat">Numbers are shares. · <button class="link" data-act="uneven" data-id="${it.id}">Split equally</button></p></div>`;
      }
      return `<div class="item ${on ? 'on' : ''}" style="--c:${tint}">
        ${row({ name: esc(it.name), amt: total, on, warn: !who.length,
          sub: !who.length ? `${sub ? sub + ' · ' : ''}Nobody yet` : it.auto ? `Everyone · ${sub}` : sub,
          badges: it.auto ? '<span class="cnt grp">All</span>' : who.map((p) => av(p, 'sm')).join('') })}${
          it.auto ? '<p class="hint">Tap to give it to the picked people only</p>' : extra}</div>`;
    }).join('')}</div>` : ''}
    ${liveItems()}`;
}

/* While items are still unpicked, the main button walks through the people in order. */
function nextPerson() {
  if (S.step !== 1 || !unassigned().length) return null;
  if (S.multi || S.sel.length !== 1) return null;       // walking person by person only makes sense with one picked
  const i = S.people.findIndex((p) => p.id === S.sel[0]);
  return i >= 0 && i < S.people.length - 1 ? S.people[i + 1] : null;
}

function resultView() {
  const r = compute();
  return `<div class="grand"><div class="muted small">Bill total</div><div class="big">${fmt(r.total)}</div>
      <div class="check">✓ Shares add up to ${fmt(r.per.reduce((a, x) => a + x.total, 0))}</div></div>
    ${r.per.map(({ p, total, lines, extra }) => `<details class="card">
      <summary class="row">${av(p)}
        <span class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${lines.length} item${lines.length === 1 ? '' : 's'}</div></span>
        <span class="owes">${fmt(total)}</span><span class="chev">›</span></summary>
      <div class="lines">
        ${lines.map((l) => `<div><span>${esc(l.name)}${l.frac ? ` <span class="muted">(${l.frac})</span>` : ''}</span><span>${fmt(l.amt)}</span></div>`).join('') || '<div class="muted">Nothing</div>'}
        ${extra ? `<div class="muted"><span>${extra > 0 ? 'Tax / tip share' : 'Discount share'}</span><span>${fmt(extra)}</span></div>` : ''}
      </div>
      <button class="row add" data-act="share-one" data-id="${p.id}">Send ${esc(p.name)} their share</button></details>`).join('')}
    <div class="pair">
      <button class="btn ghost" data-act="image">Share as image</button>
      <button class="btn ghost" data-act="copy">Copy as text</button>
    </div>`;
}

function personText(id) {
  const x = compute().per.find((r) => r.p.id === id);
  return [`${x.p.name}, your share of the bill is ${fmt(x.total)}`, '',
    ...x.lines.map((l) => `${l.name}${l.frac ? ` (${l.frac})` : ''}: ${fmt(l.amt)}`),
    ...(x.extra ? [`${x.extra > 0 ? 'Tax / tip share' : 'Discount share'}: ${fmt(x.extra)}`] : []),
  ].join('\n');
}

async function shareOut(text) {
  if (navigator.share) { try { await navigator.share({ text }); } catch {} } else copy(text);
}

/* Draws the split as a picture for group chats. */
async function shareImage() {
  const r = compute(), W = 1080, pad = 80, rowH = 120, H = 420 + r.per.length * rowH + 60;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'), font = (w, px) => `${w} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#6b7480'; g.font = font(500, 40); g.fillText('Bill total', pad, 130);
  g.fillStyle = '#14181c'; g.font = font(700, 112); g.fillText(fmt(r.total), pad, 250);
  g.fillStyle = '#e4e7eb'; g.fillRect(pad, 310, W - pad * 2, 3);
  r.per.forEach(({ p, total }, i) => {
    const y = 420 + i * rowH;
    g.fillStyle = p.color; g.beginPath(); g.arc(pad + 40, y - 16, 40, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff'; g.font = font(700, 36); g.textAlign = 'center'; g.fillText(p.name[0].toUpperCase(), pad + 40, y - 3);
    g.fillStyle = '#14181c'; g.font = font(600, 48); g.textAlign = 'left'; g.fillText(p.name, pad + 110, y);
    g.font = font(700, 52); g.textAlign = 'right'; g.fillText(fmt(total), W - pad, y);
    g.textAlign = 'left';
  });
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  if (!blob) { toast("Couldn't make the image on this device"); return; }
  const file = new File([blob], 'bill-split.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch {} return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Image saved');
}

function shareText() {
  const r = compute();
  return ['Bill split — total ' + fmt(r.total), '',
    ...r.per.map((x) => `${x.p.name}: ${fmt(x.total)}`), '',
    ...r.per.map((x) => `${x.p.name} — ${x.lines.map((l) => l.name + (l.frac ? ` (${l.frac})` : '')).join(', ') || 'nothing'}`),
  ].join('\n');
}

function render() {
  save();
  if (blocker(S.step)) { while (S.step > 0 && blocker(S.step)) S.step--; }
  $('#steps').innerHTML = STEPS.map((s, i) =>
    `<button class="${i === S.step ? 'now' : i < S.step ? 'done' : ''}" data-act="step" data-step="${i}" ${i > S.step && blocker(i) ? 'disabled' : ''}>${i + 1}. ${s}</button>`).join('');
  const pn = $('#pName'), typed = pn ? pn.value : '', hadFocus = pn && document.activeElement === pn;
  const railX = $('.rail')?.scrollLeft;
  view.innerHTML = [billView, assignView, resultView][S.step]();
  const rail = $('.rail');
  if (rail) {                     // keep the rail where it was, with the picked person in view
    if (railX != null) rail.scrollLeft = railX;
    const on = rail.querySelector('[aria-selected="true"]'), cur = on?.closest('.tile') || on;
    if (cur) {
      const pad = 8, end = rail.clientWidth - rail.querySelector('.adder').offsetWidth - pad;
      const l = cur.offsetLeft - rail.scrollLeft;   // the rail is sticky, so it is the offset parent
      if (l < pad) rail.scrollLeft += l - pad;
      else if (l + cur.offsetWidth > end) rail.scrollLeft += l + cur.offsetWidth - end;
    }
  }
  if ($('#pName') && typed) { $('#pName').value = typed; if (hadFocus) $('#pName').focus(); }
  $('#scanStrip').hidden = !scanning;
  scanTick();
  backBtn.hidden = S.step === 0;
  $('#reset').hidden = !S.items.length && !S.people.length && !scanning;
  const block = blocker(S.step + 1);
  const np = nextPerson();
  nextBtn.disabled = S.step < 2 && !!block && !np;
  nextBtn.textContent = S.step === 2 ? 'Share the split'
    : np ? `Next: ${np.name}`
    : block && (S.step > 0 || S.items.length || scanning) ? block
    : ['Next: who had what?', 'See the split'][S.step];
  nextBtn.hidden = S.step === 0 && !S.items.length && !scanning;
  document.querySelector('.bottom').hidden = nextBtn.hidden && backBtn.hidden;
}

/* ---------- item sheet ---------- */
function openSheet(id) {
  editingId = id || null;
  const it = S.items.find((i) => i.id === id);
  $('#sheetTitle').textContent = it ? 'Edit item' : 'Add item';
  $('#fName').value = it ? it.name : '';
  $('#fQty').value = it ? it.qty : 1;
  $('#fUnit').value = it && it.unit != null ? it.unit : '';
  $('#fTotal').value = it ? it.total : '';
  $('#fDelete').hidden = !it;
  $('#fErr').hidden = true;
  sheet.showModal();
  if (!it) $('#fName').focus();
}
function syncPrice() {
  const q = Number($('#fQty').value) || 1, u = $('#fUnit').value;
  if (u !== '') $('#fTotal').value = (q * Number(u)).toFixed(2);
}
$('#fQty').addEventListener('input', syncPrice);
$('#fUnit').addEventListener('input', syncPrice);
$('#fTotal').addEventListener('input', () => { $('#fUnit').value = ''; });
$('#itemForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#fName').value.trim(), total = Number($('#fTotal').value);
  const qty = Number($('#fQty').value) > 0 ? Number($('#fQty').value) : 1;
  const err = !name ? 'Give the item a name.' : !(total > 0) ? 'Enter the price.' : '';
  if (err) { $('#fErr').textContent = err; $('#fErr').hidden = false; return; }
  const unit = $('#fUnit').value === '' ? null : Number($('#fUnit').value);
  const data = { name, qty, unit, total: Math.round(total * 100) / 100, flag: false };
  const it = S.items.find((i) => i.id === editingId);
  // A changed quantity makes the old claims meaningless, so start that item over.
  if (it && it.qty !== qty) { it.shares = {}; delete it.parts; it.uneven = it.whole = false; }
  if (it) Object.assign(it, data); else S.items.push({ id: uid(), shares: {}, ...data });
  sheet.close();
  render();
});

/* ---------- scanning (vision model via /api/scan) ---------- */
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}
const SCAN_TIMEOUT_MS = 200000;   // per model; free models have taken ~140 s
let scanning = null;              // { phase, t0, items: [] } while a bill is being read in the background
let scanCtl = null, scanCancelled = false;

/* Reads the function's stream of JSON lines: item events as they arrive, then the final result. */
async function callScan(image, tier, onItem) {
  scanCtl = new AbortController();
  const timer = setTimeout(() => scanCtl.abort('timeout'), SCAN_TIMEOUT_MS);
  try {
    const res = await fetch('api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, tier }), signal: scanCtl.signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || 'scan failed'), { user: data.message });
    }
    let final = null, buf = '';
    const line = (text) => {
      if (!text.trim()) return;                    // keepalive
      let ev;
      try { ev = JSON.parse(text); } catch { return; }
      if (ev.type === 'item') onItem(ev.item, ev.index); else final = ev;
    };
    const reader = res.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { line(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    line(buf);
    if (!final || final.error || !final.items) throw Object.assign(new Error(final?.error || 'scan failed'), { user: final?.message });
    return final;
  } finally { clearTimeout(timer); }
}

/* Fallback reader: Tesseract.js on the device (works offline once its files are cached). */
async function offlineScan(image) {
  scanning.phase = 'Reading on this device'; scanning.t0 = Date.now(); scanLive();
  const { ocrImage, parseBillText } = await import('./ocr.js');
  return parseBillText(await ocrImage(image));
}

function scanTick() {
  if (!scanning) return;
  const s = Math.floor((Date.now() - scanning.t0) / 1000), n = scanning.items.length;
  $('#scanMsg').textContent = `${scanning.phase}… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${n ? ` · ${n} item${n > 1 ? 's' : ''} so far` : ''}`;
}
/* Refresh the live list, but never while the user is typing in a field. */
function scanLive() {
  scanTick();
  if (S.step <= 1 && !/^(INPUT|SELECT)$/.test(document.activeElement?.tagName || '') && !sheet.open && !personSheet.open) render();
}

async function scan(file) {
  if (scanning) return;
  scanning = { phase: 'Reading your bill', t0: Date.now(), items: [] };
  scanCancelled = false;
  let lock = null;
  const timer = setInterval(scanTick, 1000);
  render();
  try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  const onItem = (item, index) => {
    if (index === 0) scanning.items = [];          // a second reading replaces the first
    scanning.items.push(item);
    scanLive();
  };
  try {
    const image = await shrink(file);
    let data;
    try {
      if (!navigator.onLine) throw Object.assign(new Error('offline'), { fallback: true });
      data = await callScan(image, 'cheap', onItem);
    } catch (e) {
      if (scanCancelled || e.message === 'not_bill' || e.message === 'too_large') throw e;
      data = await offlineScan(image);             // OpenRouter or the network is down: read it on the device
    }
    if (!data.verified && data.source !== 'ocr') {
      scanning.phase = 'Double-checking the numbers'; scanning.t0 = Date.now(); scanLive();
      try {
        const second = await callScan(image, 'strong', onItem);
        if (second.verified || second.issues.length <= data.issues.length) data = second;
      } catch (e) { if (scanCancelled) throw e; /* keep the first reading and let the user check it */ }
    }
    if (!data.items.length) { toast("Couldn't find any items. Try a sharper photo, or type them in."); return; }
    const first = !S.items.length;
    S.items.push(...data.items.map((i) => ({ id: uid(), shares: {}, name: i.name, qty: i.qty, unit: i.unit, total: i.total, flag: !!i.flag })));
    if (first && ['₹', '$', '€', '£', '¥'].includes(data.currency)) S.cur = data.currency;
    if (first && data.total != null && cents(data.total) !== subtotal()) S.total = data.total;
    S.note = data.source === 'ocr' ? 'Read on this device with basic OCR, so names and prices may be off. Please check against your bill.' : data.verified ? null : (data.issues[0] || "The numbers don't add up.") + ' Please check against your bill.';
    const n = data.items.length;
    toast(data.verified ? `Bill read: ${n} item${n > 1 ? 's' : ''}, totals match ✓` : `Bill read: ${n} item${n > 1 ? 's' : ''} — please check them`);
  } catch (e) {
    console.error(e);
    toast(scanCancelled ? 'Scan cancelled.'
      : e.name === 'AbortError' ? 'That took too long. Try again, or type the items in.'
      : e.user ? e.user
      : navigator.onLine ? "Couldn't read that bill. Try again, or type the items in." : 'Scanning needs internet. Type the items in for now.');
  } finally {
    clearInterval(timer); try { lock?.release(); } catch {}
    scanning = null; scanCtl = null;
    render();
  }
}
$('#file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) scan(f); });

/* ---------- misc ---------- */
let toastT;
function toast(text, action) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label; b.dataset.act = action.act; b.dataset.id = action.id;
    t.append(b);
  }
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, action ? 7000 : 3500);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied — paste it in your group chat'); }
  catch { toast("Couldn't copy on this device"); }
}

/* ---------- events ---------- */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id, p } = el.dataset;
  if (!['sel', 'del-person', 'edit-person', 'close-sheet'].includes(act)) delFor = null;
  const it = S.items.find((i) => i.id === id);
  if (it && ['uneven', 'whole', 'by-unit', 'inc', 'dec'].includes(act)) delete it.auto;
  switch (act) {
    case 'scan': if (scanning) { toast('Still reading the last bill'); return; } $('#file').click(); return;
    case 'add-item': openSheet(); return;
    case 'edit-item': openSheet(id); return;
    case 'close-sheet': el.closest('dialog').close(); return;
    case 'dismiss-note': S.note = null; break;
    case 'cancel-scan': scanCancelled = true; scanCtl?.abort(); return;
    case 'delete-item': S.items = S.items.filter((i) => i.id !== editingId); sheet.close(); break;
    case 'del-person':
      if (delFor !== p) return;               // only the armed tile's badge removes
      if (personSheet.open) personSheet.close();
      removePerson(p);
      break;
    case 'edit-person':               // select them, arm delete on their badge, and open rename
      S.sel = [p]; S.multi = false; delFor = p; adding = false;
      render();
      openPerson(p);
      return;
    case 'add-person':
      adding = !adding; render();
      if (adding) $('#pName')?.focus();
      return;
    case 'rest-all':
      unassigned().forEach((i) => {
        const units = slots(i);
        if (units) i.parts = units.map((sh) => (sharersOf(sh).length ? sh : everyone()));   // claimed slots stay as they are
        else i.shares = everyone();
      });
      break;
    case 'toggle-slots': it.open = !it.open; break;
    case 'all-equal':                         // start from the usual case; the exceptions are then claimed one by one
      S.items.forEach((i) => {
        const units = slots(i);
        if (units) i.parts = units.map(() => everyone()); else i.shares = everyone();
        i.uneven = false; i.auto = true;
      });
      toast('Everything is shared equally. Now tap what only some people had.');
      break;
    case 'mode':                              // One person ↔ Together; leaving Together keeps the first picked
      S.multi = el.dataset.m === 'multi'; delFor = null; adding = false;
      if (!S.multi) S.sel = S.sel.slice(0, 1);
      break;
    case 'whole': {                           // share the whole item equally, by price, between whoever is on it
      const ids = new Set((it.parts || []).flatMap((sh) => sharersOf(sh).map((x) => x.id)));
      if (el.closest('#toast')) S.sel.forEach((x) => ids.add(x));   // whoever ran out of slots joins too
      it.whole = true; it.open = false; delete it.parts;
      it.shares = Object.fromEntries([...ids].map((x) => [x, 1]));
      $('#toast').hidden = true;
      break;
    }
    case 'by-unit': it.whole = it.uneven = false; it.shares = {}; delete it.parts; break;
    case 'uneven':
      it.uneven = !it.uneven;
      if (!it.uneven) sharers(it).forEach((x) => { it.shares[x.id] = 1; });
      break;
    case 'inc': it.shares[p]++; break;
    case 'dec': if (it.shares[p] > 1) it.shares[p]--; break;
    case 'step': go(Number(el.dataset.step)); return;
    case 'back': go(S.step - 1); return;
    case 'next':
      if (nextPerson()) { S.sel = [nextPerson().id]; view.scrollTop = 0; break; }
      if (S.step < 2) return go(S.step + 1);
      shareOut(shareText());
      return;
    case 'share-one': shareOut(personText(id)); return;
    case 'image': shareImage(); return;
    case 'sel':
      adding = false;
      if (p === 'all') { S.sel = S.people.map((x) => x.id); S.multi = true; delFor = null; break; }
      if (S.multi) {                          // picking several: each tap adds or drops a person, never the last one
        delFor = null;
        if (!S.sel.includes(p)) S.sel = [...S.sel, p];
        else if (S.sel.length > 1) S.sel = S.sel.filter((x) => x !== p);
        break;
      }
      // Tapping the active person again swaps their rename badge for delete, and back.
      if (S.sel[0] === p) delFor = delFor === p ? null : p;
      else { S.sel = [p]; delFor = null; }
      break;
    case 'add-recent': addPerson(el.dataset.name); break;
    case 'pick': {
      adding = false;
      const all = pickedAll();
      let units = slots(it);
      const k = el.dataset.k;
      // An item still on the untouched table split is handed to the picked people, not toggled.
      if (it.auto) {
        delete it.auto;
        if (!all) { it.shares = {}; if (units) units = it.parts = units.map(() => ({})); }
      }
      const put = (sh) => S.sel.forEach((x) => { sh[x] = sh[x] || 1; });
      if (units && k == null) {               // the row of a quantity item: take the next free slot
        if (all) { const full = units.every(isEveryone); it.parts = units.map(() => (full ? {} : everyone())); break; }
        const free = units.find((sh) => !sharersOf(sh).length);
        if (free) put(free);
        else {
          if (it.qty > 6) it.open = true;
          toast(`All ${it.qty} are taken. Tap a slot to share it.`, { label: 'Share equally', act: 'whole', id: it.id });
        }
        break;
      }
      const sh = units ? units[k] : it.shares;
      if (all) {
        const full = isEveryone(sh);
        Object.keys(sh).forEach((key) => { delete sh[key]; });
        if (!full) Object.assign(sh, everyone());
      } else if (hasPicked(sh)) S.sel.forEach((x) => { delete sh[x]; });
      else put(sh);
      if (!units && sharers(it).length < 2) it.uneven = false;
      break;
    }
    case 'reset':
      if (confirm('Start a new bill? This clears the current one.')) { if (scanning) { scanCancelled = true; scanCtl?.abort(); } S = fresh(); adding = false; }
      break;
    default: return;
  }
  render();
});

function addPerson(name) {
  if (S.people.some((x) => x.name.toLowerCase() === name.toLowerCase())) { toast(`${name} is already added`); return false; }
  const used = S.people.map((x) => x.color);
  S.people.push({ id: uid(), name, color: COLORS.find((c) => !used.includes(c)) || COLORS[S.people.length % COLORS.length] });
  const id = S.people[S.people.length - 1].id;
  S.sel = [id]; S.multi = false;
  // Anything still on the untouched table split includes the newcomer.
  S.items.forEach((i) => { if (i.auto) (i.parts || [i.shares]).forEach((sh) => { sh[id] = 1; }); });
  adding = true;                  // stay open so several people can be added in a row
  rememberName(name);
  return true;
}

function removePerson(id) {
  const gone = S.people.find((x) => x.id === id);
  S.people = S.people.filter((x) => x.id !== id);
  S.items.forEach((i) => {
    delete i.shares[id];
    i.parts?.forEach((sh) => { delete sh[id]; });
    if (sharers(i).length < 2) i.uneven = false;
  });
  delFor = null;
  if (gone) toast(`Removed ${gone.name}`);
}

function openPerson(id) {
  const who = S.people.find((x) => x.id === id);
  if (!who) return;
  editingPerson = id;
  $('#eName').value = who.name;
  $('#eErr').hidden = true;
  // A copy of their tile goes inside the sheet's layer, exactly over the real one, so it is
  // not dimmed with the rest of the page and its delete badge is a real, tappable button.
  const tile = $(`.rail .edit[data-p="${id}"]`)?.closest('.tile'), lift = $('#lift');
  lift.hidden = !tile;
  if (tile) {
    const r = tile.getBoundingClientRect();
    lift.innerHTML = tile.outerHTML;
    lift.querySelector('[role="tab"]').removeAttribute('data-act');   // only the badge acts in the copy
    Object.assign(lift.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }
  personSheet.showModal();
  $('#eName').focus();
}

document.addEventListener('submit', (e) => {
  if (e.target.id === 'personEdit') {
    e.preventDefault();
    const name = $('#eName').value.trim();
    const err = !name ? 'Enter a name.'
      : S.people.some((x) => x.id !== editingPerson && x.name.toLowerCase() === name.toLowerCase()) ? `${name} is already added.` : '';
    if (err) { $('#eErr').textContent = err; $('#eErr').hidden = false; return; }
    S.people.find((x) => x.id === editingPerson).name = name;
    rememberName(name);
    personSheet.close();
    render();
    return;
  }
  if (e.target.id !== 'personForm') return;
  e.preventDefault();
  const name = $('#pName').value.trim();
  if (!name || !addPerson(name)) return;
  $('#pName').value = '';
  render();
  $('#pName').focus();
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'total') {
    const v = e.target.value.trim();
    S.total = v === '' || !(Number(v) > 0) ? null : Math.round(Number(v) * 100) / 100;
    render();
  } else if (e.target.id === 'cur') { S.cur = e.target.value; render(); }
});

[sheet, personSheet].forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
