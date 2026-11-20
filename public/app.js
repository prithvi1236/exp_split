/* Split the Bill — a bill lives on this device (localStorage) until its host shares it.
   A shared bill lives in a room on the server (api/room) and every phone in it is kept in step.
   A scanned photo goes to /api/scan. */
import * as C from './core.js';
const { cents, allocate, canCount, slots } = C;

const $ = (s) => document.querySelector(s);
const KEY = 'splitbill.v1', NAMES = 'splitbill.names', CUR = 'splitbill.cur', ROOM = 'splitbill.room.', MYNAME = 'splitbill.me';
const STEPS = ['Bill', 'Split', 'Result'];

const view = $('#view'), nextBtn = $('#next'), backBtn = $('#back'), sheet = $('#sheet'), personSheet = $('#personSheet'), meSheet = $('#meSheet');
let R = loadRoom();               // the shared bill this phone is in, or null when the bill is only on this device
let S = load();
let editingId = null, editingPerson = null;
let delFor = null;               // person whose tile badge is showing delete instead of rename
let adding = false;               // the add-person panel on the Split step is open
const openIds = new Set();        // quantity items whose units are unfolded on this phone
/* Which items the Split list shows on this phone: 'left' (nobody yet), 'mine' (the picked people's),
   'all', or null to choose for itself. Items tapped while filtered stay put (`keep`) until the
   filter or the picked people change, so a row never vanishes under a finger. */
let filter = null, showDone = false, keepKey = '';
const keep = new Set();
/* Item search, on this phone only. It is offered once the bill's items no longer fit on one screen,
   and stays offered for that bill (`searchable`) so the button does not come and go. */
let searching = false, query = '', searchable = false;

/* ---------- state ---------- */
function guessCur() {
  const r = (navigator.language || '').split('-')[1];
  return { IN: '₹', US: '$', GB: '£', CA: '$', AU: '$', JP: '¥' }[r] ||
    (['DE', 'FR', 'ES', 'IT', 'NL', 'IE', 'PT', 'AT', 'BE', 'FI'].includes(r) ? '€' : '₹');
}
function fresh() { return { v: 3, step: 0, items: [], people: [], sel: [], multi: false, me: null, total: null, note: null, cur: guessCur(), locked: false }; }
function load() {
  if (R) return Object.assign(fresh(), R.ui);        // the bill itself comes from the room: see rebase()
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
/* The room comes from the invite link (?r=code), or is the one this phone was last in. */
function loadRoom() {
  let id = null, r = null;
  try { id = new URLSearchParams(location.search).get('r') || localStorage.getItem(CUR); } catch {}
  if (!id || !C.ID.test(id)) return null;
  try { r = JSON.parse(localStorage.getItem(ROOM + id)); } catch {}
  try { localStorage.setItem(CUR, id); } catch {}
  if (new URLSearchParams(location.search).get('r') !== id) history.replaceState(null, '', '?r=' + id);
  // key: only the host has one. token: this phone's secret. me: the person this phone joined as.
  // base: the bill as the server last sent it. pending: changes made here that the server has not confirmed yet.
  return Object.assign({ id, key: null, token: secret(), me: null, ver: 0, base: null, pending: [], ui: {} }, r);
}
/* The name this phone's owner goes by. Asked for once, on the first screen, and kept for every bill. */
function myName() { try { return localStorage.getItem(MYNAME) || ''; } catch { return ''; } }
function setMyName(name) { try { localStorage.setItem(MYNAME, name); } catch {} }
const selfId = () => (R ? R.me : S.me);          // this phone's owner as a person on the bill, if they are on it
/* A bill that starts on this phone has its owner on it from the start. */
function ensureSelf() {
  const name = myName();
  if (R || !name || S.me != null) return;
  const same = S.people.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (same) { S.me = same.id; return; }
  if (S.items.length || S.people.length) return;   // a bill begun before there was a name: leave it as it is
  const id = uid();
  act({ t: 'person-add', p: id, name });
  S.me = id; S.sel = [id];
}
function loadNames() { try { return JSON.parse(localStorage.getItem(NAMES)) || []; } catch { return []; } }
function rememberName(name) {
  const list = [name, ...loadNames().filter((n) => n.toLowerCase() !== name.toLowerCase())].slice(0, 12);
  try { localStorage.setItem(NAMES, JSON.stringify(list)); } catch {}
}
function save() {
  try {
    if (R) { R.ui = { step: S.step, sel: S.sel, multi: S.multi }; localStorage.setItem(ROOM + R.id, JSON.stringify(R)); }
    else localStorage.setItem(KEY, JSON.stringify(S));
  } catch {}
}
let uidN = 0;
function uid() { return Date.now().toString(36) + (uidN++ % 1296).toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6); }
function secret() { return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''); }

/* Every change to the bill goes through here, as an op (see core.js). On a shared bill the op is
   applied here straight away, so the tap feels instant, and queued for the server. */
function act(op) {
  op.o = uid();
  const out = C.apply(S, op);
  if (R) { R.pending.push(op); flush(); }
  return out;
}
const host = () => !R || !!R.key;                                       // may edit the bill and pick for anyone
const me = () => (R && !R.key && S.people.find((p) => p.id === R.me)) || null;   // on a guest's phone: who they are

/* ---------- money ---------- */
const fmt = (c) => S.cur + (c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const subtotal = () => C.subtotal(S);
const billTotal = () => C.billTotal(S);
const sharersOf = (shares) => C.sharersOf(S, shares);
const sharers = (item) => sharersOf(item.shares);
const pieces = (it) => C.pieces(S, it);
const unassigned = () => S.items.filter((i) => !C.finished(S, i));
const compute = () => C.compute(S);
/* The rail selection: one person, or several picked together (`S.multi`). */
/* Has this person been put on anything yet? A table split nobody chose (`auto`) does not count. */
const hasPicks = (id) => S.items.some((it) => !it.auto && pieces(it).some((pc) => pc.shares[id] > 0));
const pickedAll = () => S.people.length > 1 && S.sel.length === S.people.length;
const hasPicked = (shares) => S.sel.length > 0 && S.sel.every((id) => shares[id] > 0);
const isEveryone = (shares) => C.isEveryone(S, shares);
/* Confirming stores what was agreed to: the person's items and the bill's tax and tip. If either
   changes later, the stored value no longer matches and they are simply asked to confirm again. */
const sig = (row, r) => `${row.base}:${r.extra}`;
function status() {
  const r = compute();
  return { r, ok: new Set(r.per.filter((x) => x.p.ok === sig(x, r)).map((x) => x.p.id)) };
}

/* ---------- navigation ---------- */
function blocker(step) {
  if (S.locked) return '';
  if (!host()) {
    if (step >= 2 && !me()) return 'Pick your name first';
    if (step >= 2 && !compute().per.find((x) => x.p.id === R.me).lines.length) return 'Tap what you had';
    return '';
  }
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
      ${myName() ? `<p class="hi">Hi, ${esc(myName())} · <button class="link" data-act="edit-me">Edit</button></p>`
      : `<form id="meForm" class="mefield"><label>Your name
          <input id="meName" type="text" placeholder="As the group will see it" autocomplete="off" autocapitalize="words" enterkeyhint="done" maxlength="24">
        </label></form>`}
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

const SEARCH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
/* Does an item's name match what was typed? Case and accents are ignored. Each typed word must
   appear in the name, or its letters in order within one word of it starting with the same letter,
   so "nan" finds "Butter Naan" and "pnr" finds "Paneer Tikka". */
const plain = (t) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function found(name, q) {
  const n = plain(name), words = n.split(/[\s\-\/,.()&+]+/).filter(Boolean);
  const inOrder = (t, w) => { let i = 0; for (const c of w) if (c === t[i]) i++; return i === t.length; };
  return plain(q).split(/\s+/).filter(Boolean).every((t) => n.includes(t) || words.some((w) => w[0] === t[0] && inOrder(t, w)));
}
/* Typing narrows the list in place: redrawing would close the phone's keyboard. */
function applySearch() {
  let n = 0;
  view.querySelectorAll('[data-item]').forEach((el) => {
    const it = S.items.find((i) => i.id === el.dataset.item), ok = !!it && found(it.name, query);
    el.hidden = !ok; n += ok;
  });
  const none = $('#noMatch');
  if (none) { none.hidden = n > 0 || !query.trim(); none.querySelector('span').textContent = query.trim(); }
}
function closeSearch() { searching = false; query = ''; }

const PENCIL = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
const av = (p, cls = '') => `<span class="dot ${cls}" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span>`;

/* Person-first: pick someone in the rail, then tap everything they had. */
function assignView() {
  const isHost = host(), self = me();
  // A guest picks for themself ("Self"), or for themself plus whoever shared it with them ("Together").
  if (!isHost) {
    if (!self) { S.sel = []; S.multi = false; }
    else if (!S.multi) S.sel = [self.id];
    else if (!S.sel.includes(self.id)) S.sel = [self.id, ...S.sel];
  }
  S.sel = S.people.filter((p) => S.sel.includes(p.id)).map((p) => p.id);      // drop anyone removed, keep rail order
  if (isHost && !S.sel.length && S.people.length) S.sel = [S.people[0].id];
  if (S.people.length < 2 || S.sel.length < 1) S.multi = false;
  const group = S.people.filter((p) => S.sel.includes(p.id));
  const all = pickedAll(), one = group.length === 1 ? group[0] : null;
  const untouched = isHost && S.people.length > 1 && S.items.length > 0 && S.items.every((i) => pieces(i).every((pc) => !sharersOf(pc.shares).length));
  const open = isHost && (adding || S.people.length < 2);
  const left = isHost ? unassigned().length : 0;      // only the host may split what is left between everyone
  const st = status(), base = Object.fromEntries(st.r.per.map((r) => [r.p.id, r.base]));
  const saved = myName();
  const top = !isHost ? ''
    : R ? `<div class="banner calm"><span class="grow"><b>Shared with the group</b>
        <div class="sub">${S.people.length ? `${st.ok.size} of ${S.people.length} confirmed` : 'Waiting for people to join'}${offline ? ' · reconnecting…' : ''}</div></span>
        <button class="link" data-act="share-bill">Invite</button></div>`
    : S.items.length ? `<div class="banner calm"><span class="grow">Let everyone pick their own items on their phone.</span>
        <button class="link" data-act="share-bill">Share bill</button></div>` : '';
  const joinCard = isHost || self ? '' : `<div class="card pad join">
      <h2>Who are you?</h2>
      ${S.people.length ? `<div class="recent">${S.people.map((p) => `<button class="chip" data-act="join" data-name="${esc(p.name)}">${esc(p.name)}</button>`).join('')}</div>` : ''}
      <form class="addrow" id="joinForm">
        <input id="jName" type="text" placeholder="${S.people.length ? 'Not listed? Type your name' : 'Your name'}" aria-label="Your name" value="${esc(saved)}"
          autocomplete="off" autocapitalize="words" enterkeyhint="go" maxlength="24">
        <button class="btn primary" type="submit">Join</button>
      </form></div>`;
  const marks = S.people.length > 1 && S.items.length > 0 && !S.locked;   // ring the people with nothing picked yet
  const recents = loadNames().filter((n) => !S.people.some((x) => x.name.toLowerCase() === n.toLowerCase()));

  // Which items to show. The host starts on what is left, since that is what blocks the next step.
  const todo = new Set(unassigned().map((i) => i.id));
  const f = filter || (isHost && todo.size ? 'left' : 'all');
  const key = [f, S.multi, ...S.sel].join();
  if (key !== keepKey) { keep.clear(); keepKey = key; }
  const picked = (it) => !it.auto && pieces(it).some((pc) => S.sel.some((id) => pc.shares[id] > 0));
  const mineN = S.items.filter(picked).length;
  const mineLabel = !one ? 'Picked' : one.id === self?.id ? 'Yours' : `${esc(one.name)}'s`;
  const findBar = `<form class="find" id="findForm" role="search">
      ${SEARCH}<input id="iSearch" type="search" placeholder="Find an item" aria-label="Find an item" value="${esc(query)}"
        autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
      <button type="button" class="x" data-act="search-close" aria-label="Close search">×</button></form>`;
  const filterBar = searching && S.items.length ? findBar
    : S.items.length > 1 && S.sel.length ? `<div class="seg filter" role="group" aria-label="Show items">
      <button data-act="filter" data-f="left" aria-pressed="${f === 'left'}">Left <b>${todo.size}</b></button>
      <button data-act="filter" data-f="mine" aria-pressed="${f === 'mine'}"><span class="fname">${mineLabel}</span> <b>${mineN}</b></button>
      <button data-act="filter" data-f="all" aria-pressed="${f === 'all'}">All <b>${S.items.length}</b></button>
      ${searchable ? `<button class="sbtn" data-act="search-open" aria-label="Find an item">${SEARCH}</button>` : ''}
    </div>` : '';
  const stay = (it) => keep.has(it.id);
  // In All, while anything is left, finished items fold away below the ones still needing someone.
  const fold0 = !searching && f === 'all' && todo.size > 0;
  const shown = searching ? S.items : S.items.filter((it) => stay(it) || (f === 'left' ? todo.has(it.id) : f === 'mine' ? picked(it) : !fold0 || todo.has(it.id)));
  const folded = fold0 ? S.items.filter((it) => !shown.includes(it)) : [];
  const fold = folded.length ? `<button class="fold" data-act="show-done" aria-expanded="${showDone}">
      <span class="grow">✓ ${folded.length} item${folded.length > 1 ? 's' : ''} already assigned</span><span class="link">${showDone ? 'Hide' : 'Show'}</span></button>` : '';
  const hid = (it) => (searching && !found(it.name, query) ? 'hidden' : '');
  const misses = searching && query.trim() && !S.items.some((it) => found(it.name, query));
  const empty = searching ? `<div class="card pad none" id="noMatch" ${misses ? '' : 'hidden'}>
        <b>No items match “<span>${esc(query.trim())}</span>”</b>
        <button class="link" data-act="search-clear">Clear search</button></div>`
    : shown.length || !S.items.length || !S.sel.length ? ''
    : f === 'left' ? `<div class="card pad none"><b>Every item has someone ✓</b>
        <button class="link" data-act="filter" data-f="all">Show all items</button></div>`
    : `<div class="card pad none">Nothing picked for ${one ? esc(one.name) : 'them'} yet.
        <button class="link" data-act="filter" data-f="${todo.size ? 'left' : 'all'}">${todo.size ? "Show what's left" : 'Show all items'}</button></div>`;
  return `${top}${joinCard}${(isHost || self) && S.people.length > 1 ? `<div class="seg" role="group" aria-label="Pick for">
      <button data-act="mode" data-m="one" aria-pressed="${!S.multi}">${isHost ? 'One person' : 'Self'}</button>
      <button data-act="mode" data-m="multi" aria-pressed="${S.multi}">Together</button>
    </div>` : ''}
    <div class="rail ${S.multi ? 'multi' : ''}" role="tablist" aria-label="Who are you picking for?" ${S.multi ? 'aria-multiselectable="true"' : ''}>
      ${S.people.map((p) => `<div class="tile">
        <button role="tab" aria-selected="${S.sel.includes(p.id)}" ${isHost || S.multi ? `data-act="sel" data-p="${p.id}"` : 'tabindex="-1"'} style="--c:${p.color}"
          ${marks && !hasPicks(p.id) ? `class="none" aria-description="Nothing picked yet"` : ''}>
          ${av(p)}<span class="rname">${esc(p.name)}</span><span class="rtot">${R && st.ok.has(p.id) ? '✓ ' : ''}${fmt(base[p.id])}</span></button>
        ${S.multi ? `<span class="check" style="--c:${p.color}" aria-hidden="true">${S.sel.includes(p.id) ? '✓' : ''}</span>`
        : !isHost ? '' : delFor === p.id
          ? `<button class="edit del" data-act="del-person" data-p="${p.id}" aria-label="Remove ${esc(p.name)}">${TRASH}</button>`
          : `<button class="edit" data-act="edit-person" data-p="${p.id}" aria-label="Rename ${esc(p.name)}">${PENCIL}</button>`}
      </div>`).join('')}
      ${S.multi ? `<button role="tab" aria-selected="${all}" data-act="sel" data-p="all">
        <span class="dot every">All</span><span class="rname">Everyone</span><span class="rtot">select all</span></button>` : ''}
      ${isHost ? `<button class="adder" aria-expanded="${open}" data-act="add-person">
        <span class="dot every">+</span><span class="rname">Add</span><span class="rtot">person</span></button>` : ''}
    </div>
    ${open ? `<form class="addrow" id="personForm">
      <input id="pName" type="text" placeholder="Name" aria-label="Name" autocomplete="off" autocapitalize="words" enterkeyhint="done" maxlength="24">
      <button class="btn primary" type="submit">Add</button>
    </form>
    ${recents.length ? `<div class="recent"><span class="sub">Add again</span>
      ${recents.map((n) => `<button class="chip" data-act="add-recent" data-name="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : ''}` : ''}
    <p class="lead">${!isHost ? (self && S.multi ? (S.sel.length > 1 ? 'Tap what you and the ticked people shared.' : 'Tick who shared with you, then tap what you shared.')
      : self ? `Tap everything you had, ${esc(self.name)}. <button class="link" data-act="not-me">Not ${esc(self.name)}?</button>` : 'Pick your name to start.')
      : S.people.length < 2 ? (R ? 'Waiting for people to join. You can also add them yourself.' : S.people.length ? 'Add everyone else splitting this bill.' : 'Add everyone splitting this bill.')
      : all ? 'Tap what everyone shared.'
      : one ? `Tap everything ${esc(one.name)} had.`
      : group.length <= 3 ? `Tap what ${esc(group.slice(0, -1).map((p) => p.name).join(', '))} and ${esc(group[group.length - 1].name)} shared.`
      : `Tap what these ${group.length} shared.`}
</p>
    ${untouched ? `<div class="banner calm"><span class="grow">Mostly shared by the whole table?</span>
      <button class="link" data-act="all-equal">Split everything equally</button></div>` : ''}
    ${left && left < S.items.length ? `<div class="banner ${f === 'left' ? '' : 'two'}"><span class="grow">${left} item${left > 1 ? 's' : ''} not finished yet.</span>
      ${f === 'left' ? '' : '<button class="link" data-act="show-left">Show them</button>'}
      <button class="link" data-act="rest-all">Split between everyone</button></div>` : ''}
    ${!isHost && self && todo.size && f !== 'left' ? `<div class="banner calm"><span class="grow">${todo.size} item${todo.size > 1 ? 's' : ''} nobody has picked yet.</span>
      <button class="link" data-act="show-left">Show them</button></div>` : ''}
    ${filterBar}
    ${shown.length ? `<div class="card ${searching ? 'found' : ''}">${shown.map(itemHtml).join('')}</div>` : ''}
    ${empty}
    ${fold}
    ${showDone && folded.length ? `<div class="card">${folded.map(itemHtml).join('')}</div>` : ''}
    ${liveItems()}`;

  function itemHtml(it) {
      const who = sharers(it), total = cents(it.total);
      const tint = one ? one.color : group.length ? 'var(--accent)' : 'var(--line)';
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
        const big = it.qty > 6, show = (!big || openIds.has(it.id)) && !it.auto;   // many units, or an untouched table split, stay folded into counts
        const groups = new Map();
        units.forEach((sh) => {
          const w = sharersOf(sh);
          if (w.length) groups.set(w.map((p) => p.id).join(), { w, n: (groups.get(w.map((p) => p.id).join())?.n || 0) + 1 });
        });
        const summary = [...groups.values()].map(({ w, n }) => `<span class="cnt ${w.length > 1 ? 'grp' : ''}" style="--c:${w[0].color}">${
          w.length > 3 ? `${w.length} people` : esc(w.map((p) => p.name[0].toUpperCase()).join('+'))}${n > 1 ? ` ×${n}` : ''}</span>`).join('');
        const toggle = big ? `<button class="link" data-act="toggle-slots" data-id="${it.id}">${show ? 'Hide each one' : 'Show each one'}</button>` : '';
        const tip = it.auto ? (isHost ? 'Shared by everyone · tap to give it to the picked people only' : 'Shared by everyone · tap if only some of you had it') : show && free < it.qty ? 'Tap a filled slot to share it' : '';
        const asOne = isHost ? `<button class="link" data-act="whole" data-id="${it.id}">Share as one</button>` : '';
        const hints = [tip, asOne, toggle].filter(Boolean).join(' · ');
        return `<div class="item ${on ? 'on' : ''}" data-item="${it.id}" ${hid(it)} style="--c:${tint}">
          ${row({ name: esc(it.name), amt: total, on, tick: all ? '✓' : String(mine), warn: free > 0,
            sub: `${it.qty} ordered · ${free ? `${free} left` : 'all taken'}`, badges: show ? '' : summary })}
          ${show ? `<div class="slots">${units.map((sh, k) => {
            const w = sharersOf(sh);
            return `<button class="slot ${w.length ? '' : 'free'}" aria-pressed="${all ? isEveryone(sh) : hasPicked(sh)}" data-act="pick" data-id="${it.id}" data-k="${k}"
              aria-label="${w.length ? `One ${esc(it.name)}: ${esc(w.map((p) => p.name).join(', '))}` : `One ${esc(it.name)}, free`}" ${S.sel.length ? '' : 'disabled'}>${
              w.length ? w.map((p) => av(p, 'sm')).join('') : '+'}</button>`;
          }).join('')}</div>` : ''}
          ${hints ? `<p class="hint">${hints}</p>` : ''}</div>`;
      }

      const on = !it.auto && (all ? who.length === S.people.length : hasPicked(it.shares));
      const parts = allocate(total, who.map((p) => it.shares[p.id]));
      const sub = [it.qty !== 1 ? `Qty ${it.qty}` : '', who.length < 2 ? '' : !it.uneven ? each(total, who.length) : isHost ? '' : 'Split unevenly'].filter(Boolean).join(' · ');
      const link = !isHost ? '' : [who.length >= 2 ? `<button class="link" data-act="uneven" data-id="${it.id}">Split unevenly</button>` : '',
        it.whole && canCount(it) ? `<button class="link" data-act="by-unit" data-id="${it.id}">Split by unit</button>` : ''].filter(Boolean).join(' · ');
      let extra = link ? `<p class="hint">${link}</p>` : '';
      if (isHost && who.length >= 2 && it.uneven) {
        extra = `<div class="uneven">${who.map((p, k) => `<div class="urow">
            <span class="grow name">${esc(p.name)}</span>
            <span class="stepper"><button data-act="dec" data-id="${it.id}" data-p="${p.id}" aria-label="Less">−</button>
            <span>${it.shares[p.id]}</span>
            <button data-act="inc" data-id="${it.id}" data-p="${p.id}" aria-label="More">+</button></span>
            <span class="amt uamt">${fmt(parts[k])}</span></div>`).join('')}
          <p class="hint flat">Numbers are shares. · <button class="link" data-act="uneven" data-id="${it.id}">Split equally</button></p></div>`;
      }
      return `<div class="item ${on ? 'on' : ''}" data-item="${it.id}" ${hid(it)} style="--c:${tint}">
        ${row({ name: esc(it.name), amt: total, on, warn: !who.length,
          sub: !who.length ? `${sub ? sub + ' · ' : ''}Nobody yet` : it.auto ? `Everyone · ${sub}` : sub,
          badges: it.auto ? '<span class="cnt grp">All</span>' : who.map((p) => av(p, 'sm')).join('') })}${
          it.auto ? `<p class="hint">${isHost ? 'Tap to give it to the picked people only' : 'Tap if only some of you had it'}</p>` : extra}</div>`;
  }
}

/* While items are still unpicked, the main button walks through the people in order. */
function nextPerson() {
  if (!host() || S.step !== 1 || !unassigned().length) return null;
  if (S.multi || S.sel.length !== 1) return null;       // walking person by person only makes sense with one picked
  // The next person, in rail order, who has nothing picked yet; past the end it wraps round to the start.
  const i = S.people.findIndex((p) => p.id === S.sel[0]);
  if (i < 0) return null;
  const order = [...S.people.slice(i + 1), ...S.people.slice(0, i)];
  return order.find((p) => !hasPicks(p.id)) || null;
}

function resultView() {
  const { r, ok } = status();
  const room = !R ? '' : S.locked
    ? `<div class="banner calm"><span class="grow"><b>Final.</b> Nobody can change the split now.</span><button class="link" data-act="unlock">Reopen</button></div>`
    : `<p class="lead">${ok.size} of ${r.per.length} confirmed${offline ? ' · reconnecting…' : ''}. Finalize when you are happy with it.</p>`;
  return `${room}<div class="grand"><div class="muted small">Bill total</div><div class="big">${fmt(r.total)}</div>
      <div class="check">✓ Shares add up to ${fmt(r.per.reduce((a, x) => a + x.total, 0))}</div></div>
    ${r.per.map(({ p, total, lines, extra }) => `<details class="card" data-p="${p.id}">
      <summary class="row">${av(p)}
        <span class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${lines.length} item${lines.length === 1 ? '' : 's'}${!R ? '' : ok.has(p.id) ? ' · confirmed ✓' : S.locked ? '' : ' · not confirmed yet'}</div></span>
        <span class="owes">${fmt(total)}</span><span class="chev">›</span></summary>
      <div class="lines">
        ${lines.map((l) => `<div><span>${esc(l.name)}${l.frac ? ` <span class="muted">(${l.frac})</span>` : ''}</span><span>${fmt(l.amt)}</span></div>`).join('') || '<div class="muted">Nothing</div>'}
        ${extra ? `<div class="muted"><span>${extra > 0 ? 'Tax / tip share' : 'Discount share'}</span><span>${fmt(extra)}</span></div>` : ''}
      </div>
      ${R && !S.locked && !ok.has(p.id) ? `<button class="row add" data-act="ok-for" data-p="${p.id}">Confirm for ${esc(p.name)}</button>` : ''}
      <button class="row add" data-act="share-one" data-id="${p.id}">Send ${esc(p.name)} their share</button></details>`).join('')}
    <div class="pair">
      <button class="btn ghost" data-act="image">Share as image</button>
      <button class="btn ghost" data-act="copy">Copy as text</button>
    </div>`;
}

/* A guest's last step: their own share to check and confirm, and how far everyone else is. */
function myView() {
  const { r, ok } = status(), x = r.per.find((row) => row.p.id === R.me), left = S.locked ? [] : unassigned();
  const names = left.slice(0, 3).map((i) => i.name).join(', ') + (left.length > 3 ? ` and ${left.length - 3} more` : '');
  return `${x ? `<div class="grand"><div class="muted small">Your share, ${esc(x.p.name)}</div><div class="big">${fmt(x.total)}</div>
      <div class="check">${S.locked ? 'Final ✓' : ok.has(x.p.id) ? '✓ Confirmed. You are all done.' : 'Check your items, then confirm below.'}</div></div>
    <div class="card"><div class="lines">
      ${x.lines.map((l) => `<div><span>${esc(l.name)}${l.frac ? ` <span class="muted">(${l.frac})</span>` : ''}</span><span>${fmt(l.amt)}</span></div>`).join('') || '<div class="muted">Nothing</div>'}
      ${x.extra ? `<div class="muted"><span>${x.extra > 0 ? 'Tax / tip share' : 'Discount share'}</span><span>${fmt(x.extra)}</span></div>` : ''}
    </div></div>`
    : `<div class="grand"><div class="muted small">Bill total</div><div class="big">${fmt(r.total)}</div><div class="check">Final ✓</div></div>`}
    ${left.length ? `<div class="banner"><span class="grow">Nobody has picked ${esc(names)} yet.</span><button class="link" data-act="back">Is it yours?</button></div>` : ''}
    <div class="card">${r.per.map(({ p, total }) => `<div class="row">${av(p)}
      <span class="grow"><div class="name">${esc(p.name)}${p.id === R.me ? ' (you)' : ''}</div>
      <div class="sub">${ok.has(p.id) ? 'Confirmed ✓' : S.locked ? '' : 'Not confirmed yet'}</div></span>
      <span class="amt">${fmt(total)}</span></div>`).join('')}</div>`;
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
  ensureSelf();
  save();
  const isHost = host(), first = isHost ? 0 : 1;
  const mine = S.people.find((p) => p.id === selfId())?.name || myName();
  $('#meChip').hidden = !mine;
  $('#meChip').innerHTML = `<span>${esc(mine)}</span>${PENCIL}`;
  $('#reset').textContent = R && !isHost ? 'Leave' : 'New bill';
  if (R && !R.base) {             // a shared bill that has not arrived yet
    $('#steps').innerHTML = '';
    view.innerHTML = `<p class="lead">${offline ? "Can't reach the bill. Check your connection." : 'Opening the bill…'}</p>`;
    $('#scanStrip').hidden = true; $('.bottom').hidden = true; $('#reset').hidden = false;
    return;
  }
  if (S.locked) S.step = 2;
  else { S.step = Math.max(S.step, first); while (S.step > first && blocker(S.step)) S.step--; }
  $('#steps').innerHTML = (isHost ? STEPS : [null, 'Pick yours', 'Your share']).map((s, i) => s &&
    `<button class="${i === S.step ? 'now' : i < S.step ? 'done' : ''}" data-act="step" data-step="${i}" ${S.locked || (i > S.step && blocker(i)) ? 'disabled' : ''}>${i + 1 - first}. ${s}</button>`).filter(Boolean).join('');
  // Whatever is being typed, and whichever cards are open, survive the redraw.
  const typed = ['pName', 'jName', 'meName', 'iSearch'].map((id) => { const el = document.getElementById(id); return el && { id, v: el.value, focus: document.activeElement === el }; }).filter(Boolean);
  const openCards = [...view.querySelectorAll('details[open]')].map((d) => d.dataset.p);
  const railX = $('.rail')?.scrollLeft;
  view.innerHTML = (isHost ? [billView, assignView, resultView] : [null, assignView, myView])[S.step]();
  const rail = $('.rail');
  if (rail) {                     // keep the rail where it was, with the picked person in view
    if (railX != null) rail.scrollLeft = railX;
    const on = rail.querySelector('[aria-selected="true"]'), cur = on?.closest('.tile') || on;
    if (cur) {
      const pad = 8, end = rail.clientWidth - (rail.querySelector('.adder')?.offsetWidth || 0) - pad;
      const l = cur.offsetLeft - rail.scrollLeft;   // the rail is sticky, so it is the offset parent
      if (l < pad) rail.scrollLeft += l - pad;
      else if (l + cur.offsetWidth > end) rail.scrollLeft += l + cur.offsetWidth - end;
    }
  }
  typed.forEach(({ id, v, focus }) => { const el = document.getElementById(id); if (el && (v || focus)) { el.value = v; if (focus) el.focus(); } });
  view.querySelectorAll('details[data-p]').forEach((d) => { d.open = openCards.includes(d.dataset.p); });
  if (rail) view.style.setProperty('--rail-h', `${rail.offsetHeight}px`);   // the open search pins just under the rail
  if (!S.items.length) { searchable = false; closeSearch(); }
  else if (!searchable && S.step === 1) {
    const rows = [...view.querySelectorAll('[data-item]:not([hidden])')];
    const avg = rows.length ? rows.reduce((a, el) => a + el.offsetHeight, 0) / rows.length : 0;
    if (avg * S.items.length > view.clientHeight - (rail?.offsetHeight || 0)) { searchable = true; render(); return; }
  }
  $('#scanStrip').hidden = !scanning;
  scanTick();
  backBtn.hidden = S.step === first || S.locked;
  $('#reset').hidden = !R && !S.items.length && !S.people.some((p) => p.id !== S.me) && !scanning;   // nothing to clear yet
  const block = S.step < 2 ? blocker(S.step + 1) : '';
  const np = nextPerson();
  let label, off = !!block && !np && !jumpable();
  if (S.step === 2) {
    const st = R && !S.locked && !isHost ? status() : null, x = st?.r.per.find((row) => row.p.id === R.me);
    off = !!x && st.ok.has(x.p.id);
    label = !R || S.locked ? 'Share the split' : isHost ? 'Finalize the split' : off ? 'Confirmed ✓' : `Confirm ${fmt(x.total)}`;
  } else if (np) label = `Next: ${np.name}`;
  else if (jumpable()) { const n = unassigned().length; label = n > 1 ? `Show the ${n} items left` : 'Show the item left'; }
  else if (block && (S.step > 0 || S.items.length || scanning)) label = block;
  else label = isHost ? ['Next: who had what?', 'See the split'][S.step] : 'Review my share';
  nextBtn.disabled = off;
  nextBtn.textContent = label;
  nextBtn.hidden = S.step === 0 && !S.items.length && !scanning;
  document.querySelector('.bottom').hidden = nextBtn.hidden && backBtn.hidden;
}

/* ---------- shared bill: keeping every phone in step ---------- */
let flushing = false, pollT = null, retryT = null, offline = false;
let stale = false, pressing = false;
const toldFull = new Set();       // ids of picks that already found every unit taken on this phone

/* What this phone shows is always the server's bill plus this phone's own unconfirmed changes on top. */
function rebase() {
  const d = structuredClone(R.base);
  C.DOC.forEach((k) => { S[k] = d[k]; });
  R.pending.forEach((op) => C.apply(S, op));
  if (R.me && !S.people.some((p) => p.id === R.me)) R.me = null;     // the host removed this person
}
function adopt(d) {
  if (!R || d.ver < R.ver) return;                  // an older answer that arrived late
  R.base = d.doc; R.ver = d.ver;
  if (d.me) R.me = d.me;
  rebase();
  // Only a unit that looked free on this phone and was gone on the server is news.
  if (d.missed?.filter((m) => m.why === 'full' && !toldFull.delete(m.o)).length) toast('Someone just took the last one. Tap a slot to share it.');
  softRender();
}
/* Redraw for a change that came from someone else, but never under a finger or a keyboard. */
function softRender() {
  if (pressing || sheet.open || personSheet.open || meSheet.open || ['total', 'cur', 'iSearch'].includes(document.activeElement?.id)) { stale = true; return; }
  stale = false;
  render();
}
const settle = () => setTimeout(() => { if (stale) softRender(); }, 60);
document.addEventListener('pointerdown', () => { pressing = true; });
['pointerup', 'pointercancel'].forEach((ev) => document.addEventListener(ev, () => { pressing = false; settle(); }));
document.addEventListener('focusout', settle);
[sheet, personSheet, meSheet].forEach((d) => d.addEventListener('close', settle));

/* Sends this phone's changes, oldest first, one request at a time. Each op has an id, so a request
   that is retried after a dropped connection is never applied twice. */
async function flush() {
  if (!R || flushing || !R.pending.length) return;
  flushing = true; clearTimeout(retryT);
  const room = R, batch = R.pending.slice();
  let wait = 0;
  try {
    const res = await fetch(`api/room/${room.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: batch, token: room.token, key: room.key || undefined }),
    });
    if (R !== room) return;
    if (res.status === 404) { gone(); return; }
    if (res.status >= 500 || res.status === 409 || res.status === 429) throw new Error('retry');
    room.pending = room.pending.filter((op) => !batch.includes(op));
    offline = false;
    if (res.ok) adopt(await res.json()); else { rebase(); softRender(); }      // refused for good: drop it and show the truth
  } catch {
    if (R === room) {
      if (!offline) toast('No connection. Your changes are kept and will be sent when you are back.');
      offline = true; wait = 3000;
    }
  } finally { flushing = false; }
  if (R === room && R.pending.length) { if (wait) retryT = setTimeout(flush, wait); else flush(); }
}
/* Asks for other people's changes. Costs one tiny request when nothing changed. */
async function poll() {
  clearTimeout(pollT);
  if (!R) return;
  const room = R;
  if (!document.hidden && !flushing && !R.pending.length) {
    try {
      const res = await fetch(`api/room/${room.id}?v=${room.ver}`, { cache: 'no-store' });
      if (R !== room) return;
      if (res.status === 404) { gone(); return; }
      const was = offline;
      offline = !res.ok;
      // An answer that crossed one of our own changes on the way is skipped: the change's own answer is newer.
      if (res.status === 200 && !flushing && !R.pending.length) adopt(await res.json());
      else if (was !== offline) softRender();
    } catch { if (R === room && !offline) { offline = true; softRender(); } }
  }
  if (R === room) pollT = setTimeout(poll, 2000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); flush(); } });
addEventListener('online', () => { poll(); flush(); });

function exitRoom(forget) {
  try { localStorage.removeItem(CUR); if (forget) localStorage.removeItem(ROOM + R.id); } catch {}
  clearTimeout(pollT); clearTimeout(retryT);
  history.replaceState(null, '', location.pathname);
  R = null; S = load(); adding = false;
  render();
}
function gone() { exitRoom(true); toast('That shared bill is no longer available.'); }

function inviteLink() { return `${location.origin}${location.pathname}?r=${R.id}`; }
async function invite() {
  const url = inviteLink();
  // A phone gets its share sheet; a laptop (mouse or trackpad) gets the link on the clipboard.
  const laptop = matchMedia('(pointer: fine)').matches;
  try {
    if (laptop || !navigator.share) throw new Error('no share sheet');
    await navigator.share({ title: 'Split the Bill', text: 'Pick what you had on our bill', url });
  } catch (e) {
    if (e.name === 'AbortError') return;
    try { await navigator.clipboard.writeText(url); toast('Link copied. Send it to the group.'); }
    catch {
      // Clipboard access can be refused once the tap is no longer fresh: fall back to the old copy command.
      const box = Object.assign(document.createElement('textarea'), { value: url });
      document.body.append(box); box.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      box.remove();
      toast(ok ? 'Link copied. Send it to the group.' : 'Bill shared. Click Invite to copy the link.');
    }
  }
}
/* The host puts the bill in a room. From here on this phone is just one more member of it, with the host's key. */
async function shareBill() {
  if (R) return invite();
  if (scanning) { toast('Still reading your bill…'); return; }
  // The host is on the bill too: add them under their name before it goes out.
  const name = myName();
  if (!name) { openMe(); return; }
  let mine = S.people.find((x) => x.id === S.me)?.id || null;
  if (S.me == null) {               // a bill begun before there was a name
    const same = S.people.find((x) => x.name.toLowerCase() === name.toLowerCase());
    mine = same ? same.id : uid();
    if (!same) act({ t: 'person-add', p: mine, name });
  }                                 // otherwise the host took themself off this bill, and stays off it
  try {
    const res = await fetch('api/room', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: Object.fromEntries(C.DOC.map((k) => [k, S[k]])) }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { toast(d.message || "Couldn't share the bill. Try again."); return; }
    if (mine) { S.sel = [mine]; S.multi = false; }
    R = { id: d.id, key: d.key, token: secret(), me: mine, ver: d.ver, base: d.doc, pending: [], ui: {} };
    try { localStorage.setItem(CUR, R.id); localStorage.removeItem(KEY); } catch {}
    history.replaceState(null, '', '?r=' + R.id);
    rebase(); render(); poll();
    invite();
  } catch { toast(navigator.onLine ? "Couldn't share the bill. Try again." : 'Sharing needs internet.'); }
}

function join(name) {
  name = name.trim().slice(0, 24);
  if (!name) return;
  R.me = act({ t: 'join', p: uid(), name }).me;
  setMyName(name);
  render();
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
  if (S.items.some((i) => i.id === editingId)) act({ t: 'item-set', id: editingId, data: { name, qty, unit, total: data.total } });
  else act({ t: 'items-add', items: [{ id: uid(), ...data }] });
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
  if (S.step <= 1 && !/^(INPUT|SELECT)$/.test(document.activeElement?.tagName || '') && !sheet.open && !personSheet.open && !meSheet.open) render();
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
    act({
      t: 'items-add',
      items: data.items.map((i) => ({ id: uid(), name: i.name, qty: i.qty, unit: i.unit, total: i.total, flag: !!i.flag })),
      cur: ['₹', '$', '€', '£', '¥'].includes(data.currency) ? data.currency : null, total: data.total,
      note: data.source === 'ocr' ? 'Read on this device with basic OCR, so names and prices may be off. Please check against your bill.' : data.verified ? null : (data.issues[0] || "The numbers don't add up.") + ' Please check against your bill.',
    });
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
const HOST_ONLY = ['scan', 'add-item', 'edit-item', 'delete-item', 'dismiss-note', 'del-person', 'edit-person', 'add-person', 'add-recent',
  'rest-all', 'all-equal', 'whole', 'by-unit', 'uneven', 'inc', 'dec', 'share-bill', 'ok-for', 'unlock'];

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act: name, id, p } = el.dataset;
  if (!host() && HOST_ONLY.includes(name)) return;
  if (!['sel', 'del-person', 'edit-person', 'close-sheet'].includes(name)) delFor = null;
  const it = S.items.find((i) => i.id === id);
  if (['scan', 'add-item'].includes(name) && !myName()) { if (!takeName()) return; render(); }
  switch (name) {
    case 'edit-me': openMe(); return;
    case 'scan': if (scanning) { toast('Still reading the last bill'); return; } $('#file').click(); return;
    case 'add-item': openSheet(); return;
    case 'edit-item': openSheet(id); return;
    case 'close-sheet': el.closest('dialog').close(); return;
    case 'dismiss-note': act({ t: 'note' }); break;
    case 'cancel-scan': scanCancelled = true; scanCtl?.abort(); return;
    case 'delete-item': act({ t: 'item-del', id: editingId }); sheet.close(); break;
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
    case 'rest-all': act({ t: 'rest-all' }); break;
    case 'filter': filter = el.dataset.f; break;
    case 'search-open':
      searching = true; render();
      $('#iSearch')?.focus();
      return;
    case 'search-close': closeSearch(); break;
    case 'search-clear': query = ''; $('#iSearch').value = ''; applySearch(); $('#iSearch').focus(); return;
    case 'show-done': showDone = !showDone; break;
    case 'show-left': showLeft(); return;
    case 'toggle-slots': if (!openIds.delete(id)) openIds.add(id); break;
    case 'all-equal':
      act({ t: 'all-equal' });
      toast('Everything is shared equally. Now tap what only some people had.');
      break;
    case 'mode':                              // One person ↔ Together; leaving Together keeps the first picked
      S.multi = el.dataset.m === 'multi'; delFor = null; adding = false;
      if (!S.multi) S.sel = S.sel.slice(0, 1);
      break;
    case 'whole':                             // from the "all taken" toast, whoever ran out of slots joins too
      act({ t: 'whole', id, add: el.closest('#toast') ? S.sel.slice() : [] });
      openIds.delete(id);
      $('#toast').hidden = true;
      break;
    case 'by-unit': act({ t: 'by-unit', id }); break;
    case 'uneven': if (it) act({ t: 'uneven', id, on: !it.uneven }); break;
    case 'inc': act({ t: 'weight', id, p, d: 1 }); break;
    case 'dec': act({ t: 'weight', id, p, d: -1 }); break;
    case 'step': go(Number(el.dataset.step)); return;
    case 'back': go(S.step - 1); return;
    case 'next':
      if (nextPerson()) { S.sel = [nextPerson().id]; view.scrollTop = 0; break; }
      if (jumpable()) { showLeft(); return; }
      if (S.step < 2) return go(S.step + 1);
      if (!R || S.locked) { shareOut(shareText()); return; }
      if (host()) {                           // finalize: from here nobody can change the split
        const { r, ok } = status(), waiting = r.per.filter((x) => !ok.has(x.p.id)).map((x) => x.p.name);
        if (waiting.length && !confirm(`${waiting.join(', ')} ${waiting.length > 1 ? 'have' : 'has'} not confirmed yet. Finalize anyway?`)) return;
        act({ t: 'lock', on: true });
        toast('Final. Everyone can see their share now.');
      } else confirmShare(R.me);
      break;
    case 'ok-for': confirmShare(p); break;
    case 'unlock': act({ t: 'lock', on: false }); break;
    case 'share-bill': shareBill(); return;
    case 'join': join(el.dataset.name); return;
    case 'not-me': R.me = null; break;
    case 'share-one': shareOut(personText(id)); return;
    case 'image': shareImage(); return;
    case 'sel':
      adding = false;
      if (p === 'all') { S.sel = S.people.map((x) => x.id); S.multi = true; delFor = null; break; }
      if (!host() && !S.multi) return;        // in Self, a guest's rail is only for looking
      if (S.multi) {                          // picking several: each tap adds or drops a person, never the last one (or a guest's own name)
        delFor = null;
        if (!S.sel.includes(p)) S.sel = [...S.sel, p];
        else if (S.sel.length > 1 && p !== me()?.id) S.sel = S.sel.filter((x) => x !== p);
        break;
      }
      // Tapping the active person again swaps their rename badge for delete, and back.
      if (S.sel[0] === p) delFor = delFor === p ? null : p;
      else { S.sel = [p]; delFor = null; }
      break;
    case 'add-recent': addPerson(el.dataset.name); break;
    case 'pick': {
      adding = false;
      if (!it || !S.sel.length) return;
      keep.add(id);                           // it stays on screen even if it no longer matches the filter
      // The op says what this tap means given what was on screen: put the picked people on, or take them off.
      const all = host() && pickedAll(), units = slots(it), k = units && el.dataset.k != null ? Number(el.dataset.k) : null;
      const sh = units ? (k != null ? units[k] : null) : it.shares;
      const shown = !it.auto && (sh ? (all ? isEveryone(sh) : hasPicked(sh)) : all && units.every(isEveryone));
      const op = { t: 'pick', id, k, sel: S.sel.slice(), all, on: !shown, free: !!sh && !sharersOf(sh).length };
      const out = act(op);
      if (out.miss === 'full') {
        toldFull.add(op.o);                   // already said so here: the server's answer need not say it again

        if (it.qty > 6) openIds.add(id);
        if (host()) toast(`All ${it.qty} are taken. Tap a slot to share it.`, { label: 'Share equally', act: 'whole', id });
        else toast(`All ${it.qty} are taken. Tap one to share it.`);
      }
      break;
    }
    case 'reset':
      if (R) {
        if (!confirm(host() ? 'Start a new bill? The shared one stays open for everyone else.' : 'Leave this bill?')) return;
        if (scanning) { scanCancelled = true; scanCtl?.abort(); }
        exitRoom(false);
        return;
      }
      if (confirm('Start a new bill? This clears the current one.')) { if (scanning) { scanCancelled = true; scanCtl?.abort(); } S = fresh(); adding = false; }
      break;
    default: return;
  }
  render();
});

/* Blocked only by unfinished items: the main button and the banner take the host straight to them. */
const jumpable = () => host() && !S.locked && S.step === 1 && !scanning && S.people.length >= 2 && unassigned().length > 0;
function showLeft() {
  filter = 'left';
  render();
  const first = view.querySelector('[data-item]');
  // Centred, so the sticky rail does not cover it.
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function confirmShare(pid) {
  const r = compute(), x = r.per.find((row) => row.p.id === pid);
  if (x) act({ t: 'confirm', p: pid, sig: sig(x, r) });
}

function addPerson(name) {
  if (S.people.some((x) => x.name.toLowerCase() === name.toLowerCase())) { toast(`${name} is already added`); return false; }
  const id = uid();
  act({ t: 'person-add', p: id, name });
  S.sel = [id]; S.multi = false;
  adding = true;                  // stay open so several people can be added in a row
  rememberName(name);
  return true;
}

function removePerson(id) {
  const gone = S.people.find((x) => x.id === id);
  act({ t: 'person-del', p: id });
  delFor = null;
  if (gone) toast(`Removed ${gone.name}`);
}

/* The first screen asks for the name before a bill can be started. */
function takeName() {
  const el = $('#meName');
  if (!el) { openMe(); return false; }
  const name = el.value.trim().slice(0, 24);
  if (!name) { toast('Enter your name first'); el.focus(); return false; }
  setMyName(name);
  return true;
}
function openMe() {
  $('#mName').value = S.people.find((x) => x.id === selfId())?.name || myName();
  $('#mErr').hidden = true;
  meSheet.showModal();
  $('#mName').focus();
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
    act({ t: 'person-name', p: editingPerson, name });
    if (editingPerson === selfId()) setMyName(name);
    rememberName(name);
    personSheet.close();
    render();
    return;
  }
  if (e.target.id === 'meForm') {
    e.preventDefault();
    if (takeName()) render();
    return;
  }
  if (e.target.id === 'meEdit') {
    e.preventDefault();
    const name = $('#mName').value.trim().slice(0, 24), id = selfId();
    const onBill = S.people.some((x) => x.id === id);
    const err = !name ? 'Enter a name.'
      : onBill && S.people.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase()) ? `${name} is already added.` : '';
    if (err) { $('#mErr').textContent = err; $('#mErr').hidden = false; return; }
    if (onBill) act({ t: 'person-name', p: id, name });      // the group sees the new name too
    setMyName(name);
    meSheet.close();
    render();
    return;
  }
  if (e.target.id === 'findForm') { e.preventDefault(); $('#iSearch')?.blur(); return; }
  if (e.target.id === 'joinForm') {
    e.preventDefault();
    join($('#jName').value);
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

document.addEventListener('input', (e) => { if (e.target.id === 'iSearch') { query = e.target.value; applySearch(); } });
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'iSearch' && e.key === 'Escape') { closeSearch(); render(); }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'total') {
    const v = e.target.value.trim();
    act({ t: 'total', v: v === '' || !(Number(v) > 0) ? null : Math.round(Number(v) * 100) / 100 });
    render();
  } else if (e.target.id === 'cur') { act({ t: 'cur', v: e.target.value }); render(); }
});

[sheet, personSheet, meSheet].forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

if (R?.base) rebase();
render();
if (R) { poll(); flush(); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
