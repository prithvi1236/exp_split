/* Split the Bill — a bill lives on this device (localStorage) until its host shares it.
   A shared bill lives in a room on the server (api/room) and every phone in it is kept in step.
   A scanned photo goes to /api/scan. */
import * as C from './core.js';
import * as UPI from './upi.js';
const { cents, allocate, canCount, slots } = C;

const $ = (s) => document.querySelector(s);
const KEY = 'splitbill.v1', NAMES = 'splitbill.names', CUR = 'splitbill.cur', ROOM = 'splitbill.room.', MYNAME = 'splitbill.me', MYUPI = 'splitbill.upi';
const STEPS = ['Bill', 'Split', 'Result'];

const view = $('#view'), nextBtn = $('#next'), backBtn = $('#back'), sheet = $('#sheet'), personSheet = $('#personSheet'), meSheet = $('#meSheet'), optSheet = $('#optSheet'), helpSheet = $('#helpSheet'), upiSheet = $('#upiSheet');
let R = loadRoom();               // the shared bill this phone is in, or null when the bill is only on this device
let S = load();
let editingId = null, editingPerson = null;
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
let tipNow = null;                // the tip the Split step is showing, so the header can point at Share

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
/* The host's UPI ID, kept on this phone so every new bill they start can be paid back to it. */
function myUpi() { try { return localStorage.getItem(MYUPI) || ''; } catch { return ''; } }
function setMyUpi(pa) { try { if (pa) localStorage.setItem(MYUPI, pa); else localStorage.removeItem(MYUPI); } catch {} }
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
/* The host's person on the bill. Bills shared before it was recorded only know it on the host's own phone. */
const hostId = () => S.host || (host() ? selfId() : null);
/* Who everyone pays back, by UPI. UPI is rupees only. */
const payee = () => (S.cur === '₹' && S.upi?.pa ? S.upi : null);
const hostName = () => S.people.find((p) => p.id === hostId())?.name || myName();
/* A bill the host starts gets the UPI ID they used last time. */
function carryUpi() {
  const pa = myUpi();
  if (host() && pa && !S.upi && S.cur === '₹' && S.items.length && !(R && !R.base)) act({ t: 'upi', pa, pn: hostName() || pa });
}
/* A guest's way to pay their share: their UPI app opens with the host and the amount filled in. */
function payBox(c) {
  const to = payee();
  if (!to || c <= 0) return '';
  return `<div class="pay"><a class="btn primary block" href="${esc(UPI.link(to, c))}">Pay ${esc(to.pn)} ${fmt(c)} via UPI</a>${UPI.appButtons(to, c)}
    <p class="muted small">To ${esc(to.pa)} · <button class="link" data-act="copy-upi">Copy UPI ID</button></p></div>`;
}
/* `need` is who has a share to agree to: everyone but the host, since finalizing is how the host
   agrees. So "1/2" means one of the other two has confirmed. */
function status() {
  const r = compute(), ok = new Set(r.per.filter((x) => x.p.ok === sig(x, r)).map((x) => x.p.id));
  const need = r.per.filter((x) => x.p.id !== hostId()).map((x) => x.p.id);
  return { r, ok, need, done: need.filter((id) => ok.has(id)).length };
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

/* ---------- bill meter ----------
   How much of the bill has someone, drawn as the bottom edge of the people row in each person's
   colour, plus one quiet line with the shortcuts for what is left. */
function meterBar(r) {
  const sub = subtotal();
  if (S.people.length < 2 || !S.items.length || S.locked || sub <= 0) return '';
  let at = 0;
  const stops = r.per.filter((x) => x.base > 0).map((x) => {
    const from = at; at = Math.min(100, at + (x.base / sub) * 100);
    return `${x.p.color} ${from.toFixed(2)}% ${at.toFixed(2)}%`;
  });
  return `--meter:linear-gradient(to right, ${[...stops, `var(--line) ${at.toFixed(2)}% 100%`].join(', ')})`;
}
function leftLine(r, isHost, self, untouched) {
  const n = unassigned().length;
  if (S.people.length < 2 || !n || S.locked || scanning || (!isHost && !self)) return '';
  const open = subtotal() - r.per.reduce((a, x) => a + x.base, 0);
  const inButton = isHost && !nextPerson() && jumpable();     // the main button already starts the round
  return `<div class="leftline"><span class="grow">${isHost ? `<b>${fmt(open)}</b> unclaimed` : `${n} item${n > 1 ? 's' : ''} nobody has yet`}</span>
      ${inButton ? '' : `<button class="link" data-act="round">${isHost ? '⚡ Quick round' : 'Help finish'}</button>`}
      ${isHost && !untouched ? '<button class="link" data-act="rest-all">Share the rest</button>' : ''}</div>`;
}

/* ---------- quick round ----------
   What is left, one big card at a time. The host says who had it; a guest says "Mine" or "Not mine". Skipped cards come back at the end. */
const roundSheet = $('#roundSheet');
let round = null;                 // { skip, n0, t0, cur, sel, busy, msg }
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function roundQueue() {
  return unassigned().filter((it) => !round.skip.has(it.id));
}
function openRound() {
  round = { skip: new Set(), t0: Date.now(), cur: null, sel: [], busy: false, msg: '' };
  round.n0 = roundQueue().length;
  if (!round.n0) { round = null; return; }
  drawRound();
  roundSheet.showModal();
}
function confetti() {
  const cols = S.people.map((p) => p.color);
  return `<div class="confetti" aria-hidden="true">${Array.from({ length: 18 }, (_, i) =>
    `<i style="--x:${(i * 37) % 100}%;--d:${(i % 6) * 0.07}s;--r:${(i * 53) % 360}deg;--c:${cols[i % cols.length]}"></i>`).join('')}</div>`;
}
function drawRound() {
  if (!round) return;
  const box = $('#round'), isHost = host(), q = roundQueue(), it = q[0];
  const n0 = Math.max(round.n0, q.length), done = n0 - q.length;
  const head = (title) => `<div class="rhead"><b class="grow">${title}</b>${it ? `<span class="muted small">${done + 1} of ${n0}</span>` : ''}
      <button class="x" data-act="close-sheet" aria-label="Close">×</button></div>
    <div class="rbar"><span style="width:${n0 ? (done / n0) * 100 : 100}%"></span></div>`;
  if (!it) {
    const left = unassigned(), skipped = left.filter((i) => round.skip.has(i.id)).length;
    const secs = Math.round((Date.now() - round.t0) / 1000), took = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
    let body;
    if (!left.length) {
      body = `${confetti()}<div class="rend"><div class="big">🎉</div><h2>Every item has someone</h2>
        <p class="muted">${done} item${done === 1 ? '' : 's'} sorted in ${took}.</p></div>
        <div class="sheet-actions"><button class="btn primary block" data-act="r-finish">${isHost ? 'See the split' : 'Review my share'}</button></div>`;
    } else if (!isHost) {
      body = `<div class="rend"><div class="big">👍</div><h2>That's all from you</h2>
        <p class="muted">${left.length} item${left.length > 1 ? 's' : ''} still need someone. ${esc(hostName() || 'The host')} can sort ${left.length > 1 ? 'them' : 'it'} out.</p></div>
        <div class="sheet-actions"><button class="btn ghost" data-act="r-again">Look again</button><button class="btn primary" data-act="close-sheet">Done</button></div>`;
    } else {
      body = `<div class="rend"><div class="big">🤔</div><h2>${skipped} skipped</h2>
        <p class="muted">Go through ${skipped > 1 ? 'them' : 'it'} once more, or share ${skipped > 1 ? 'them' : 'it'} between everyone.</p></div>
        <div class="sheet-actions"><button class="btn ghost" data-act="r-again">Go again</button><button class="btn primary" data-act="r-everyone-rest">Everyone shares ${skipped > 1 ? 'them' : 'it'}</button></div>`;
    }
    box.innerHTML = head('Quick round') + body;
    return;
  }
  const isNew = round.cur !== it.id;
  if (isNew) { round.cur = it.id; round.sel = []; }
  const units = slots(it), free = units ? units.filter((sh) => !sharersOf(sh).length).length : 0;
  const who = [...new Set(units ? units.flatMap((sh) => sharersOf(sh)) : sharers(it))];
  const facts = [units ? `${it.qty} ordered · ${free} left` : it.qty !== 1 ? `Qty ${it.qty}` : '', who.length ? `${esc(who.map((p) => p.name).join(', '))} had some` : ''].filter(Boolean).join(' · ');
  const card = `<div class="rcard ${isNew ? 'in' : ''}" style="--c:${round.sel.length === 1 ? S.people.find((p) => p.id === round.sel[0])?.color : 'var(--accent)'}">
      <div class="rkind" aria-hidden="true">🧾</div>
      <div class="rname">${esc(it.name)}</div>
      <div class="ramt">${fmt(cents(it.total))}</div>
      ${facts ? `<div class="muted small">${facts}</div>` : ''}
    </div>
    <p class="rmsg" role="status">${round.msg}</p>`;
  let controls;
  if (isHost) {
    const all = round.sel.length === S.people.length;
    const label = !round.sel.length ? 'Tap who had it'
      : all ? 'Everyone shares it'
      : round.sel.length === 1 ? `Give to ${esc(S.people.find((p) => p.id === round.sel[0]).name)}`
      : `Split between ${round.sel.length}`;
    controls = `<p class="rq">${units && who.length ? `Who had the other ${free}?` : 'Who had it?'}</p>
      <div class="rpeople">
        <button class="chip" data-act="r-sel" data-p="all" aria-pressed="${all}">Everyone</button>
        ${S.people.map((p) => `<button class="chip" data-act="r-sel" data-p="${p.id}" style="--c:${p.color}" aria-pressed="${round.sel.includes(p.id)}">${esc(p.name)}</button>`).join('')}
      </div>
      <div class="sheet-actions"><button class="btn ghost" data-act="r-skip">Skip</button>
        <button class="btn primary rgo" data-act="r-give" ${round.sel.length ? '' : 'disabled'}>${label}</button></div>`;
  } else {
    controls = `<p class="rq">Did you have ${units ? 'one of these' : 'this'}?</p>
      <div class="sheet-actions"><button class="btn ghost rgo" data-act="r-skip">Not mine</button>
        <button class="btn primary rgo" data-act="r-mine">${units ? 'One is mine' : 'Mine'}</button></div>`;
  }
  box.innerHTML = head('Quick round') + card + controls;
}
/* The card flies off (right when given, left when skipped) and the next one comes in. */
function nextCard(msg, dir = 'r') {
  round.msg = msg; round.busy = true;
  $('#round .rcard')?.classList.add(dir === 'l' ? 'flyl' : 'fly');
  render();
  setTimeout(() => { if (!round) return; round.busy = false; drawRound(); }, calm() ? 0 : 220);
}
/* Hand every unit nobody has yet, or the whole item, to these people. Units someone already has stay theirs. */
function giveTo(it, sel) {
  const units = slots(it), n = units ? units.filter((sh) => !sharersOf(sh).length).length : 1;
  for (let k = 0; k < n; k++) act({ t: 'pick', id: it.id, k: null, sel: sel.slice(), all: false, on: true, free: false });
}
function roundAct(name, el) {
  const q = roundQueue(), it = q[0];
  switch (name) {
    case 'r-sel': {
      const p = el.dataset.p;
      if (p === 'all') round.sel = round.sel.length === S.people.length ? [] : S.people.map((x) => x.id);
      else round.sel = round.sel.includes(p) ? round.sel.filter((x) => x !== p) : S.people.filter((x) => x.id === p || round.sel.includes(x.id)).map((x) => x.id);
      round.msg = '';
      return drawRound();
    }
    case 'r-give': {
      if (!it || !round.sel.length) return;
      const names = round.sel.length === S.people.length ? 'everyone' : S.people.filter((p) => round.sel.includes(p.id)).map((p) => p.name).join(', ');
      giveTo(it, round.sel);
      return nextCard(`✓ ${esc(it.name)} → ${esc(names)}`);
    }
    case 'r-skip':
      if (!it) return;
      round.skip.add(it.id);
      return nextCard('', 'l');
    case 'r-mine': {
      const mine = me()?.id;
      if (!it || !mine) return;
      const op = { t: 'pick', id: it.id, k: null, sel: [mine], all: false, on: true, free: false }, out = act(op);
      if (out.miss === 'full') { toldFull.add(op.o); toast('Someone just took the last one.'); }
      if (!slots(it) || C.finished(S, it)) return nextCard(`✓ ${esc(it.name)} is yours`);
      round.skip.add(it.id);                  // one unit taken and more are free: on to the next, it comes back in "Look again"
      return nextCard(`✓ One ${esc(it.name)} is yours`);
    }
    case 'r-again': round.skip.clear(); round.n0 = roundQueue().length; round.t0 = Date.now(); round.msg = ''; return drawRound();
    case 'r-everyone-rest':
      unassigned().forEach((x) => giveTo(x, S.people.map((p) => p.id)));
      round.skip.clear(); round.msg = '';
      render();
      return drawRound();
    case 'r-finish': roundSheet.close(); go(2); return;
  }
}
roundSheet.addEventListener('close', () => { round = null; render(); });

const PENCIL = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const DOTS = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
const SHARE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v13"/><path d="m7 8 5-5 5 5"/><path d="M5 14v6h14v-6"/></svg>';
/* ---------- tips ----------
   The host's Split step teaches one thing at a time, in the line above the list, at the moment it is
   useful. A tip goes away for good on this phone once the person does what it describes (or closes it).
   The ? sheet explains every step on request and can bring the tips back. */
const TIPS = 'splitbill.tips', HELD = 'splitbill.held';      // HELD: the one tip that existed before this list
function learnt() { try { return JSON.parse(localStorage.getItem(TIPS)) || {}; } catch { return {}; } }
function learned(t) {
  if (t === 'held') { try { if (localStorage.getItem(HELD)) return true; } catch {} }
  return !!learnt()[t];
}
function learn(t) {
  if (learned(t)) return;
  try { localStorage.setItem(TIPS, JSON.stringify({ ...learnt(), [t]: 1 })); } catch {}
}
function forgetTips() { try { localStorage.removeItem(TIPS); localStorage.removeItem(HELD); } catch {} }
/* The one tip to show now on the host's Split step, picking for one person: [id, html], or null. */
function hostTip(one) {
  const picks = S.items.some((it) => !it.auto && pieces(it).some((pc) => sharersOf(pc.shares).length));
  const name = esc(one.name);
  if (!learned('pick')) return ['pick', `Tap everything ${name} had. Tap another name to switch person.`];
  if (!picks) return null;
  if (!learned('held')) return ['held', 'Shared something? Hold another name to pick for both together.'];
  if (!R && !learned('share')) return ['share', 'Let everyone pick their own items on their phone. <button class="link" data-act="share-bill">Share the bill</button>'];
  if (!learned('more') && S.items.some((it) => itemOpts(it).length && sharers(it).length >= 2))
    return ['more', 'Not an even split? Tap <b>⋯</b> on an item for more ways to split it.'];
  if (!learned('rename')) return ['rename', `Tap ${name} again to rename or remove them.`];
  return null;
}
/* The less common ways to split an item, shown in its ⋯ sheet: [action, label, what it does]. */
function itemOpts(it) {
  const isHost = host(), units = slots(it), out = [];
  if (units && it.qty > 6 && !it.auto) out.push(['toggle-slots', openIds.has(it.id) ? 'Hide each one' : 'Show each one', `See who has each of the ${it.qty}`]);
  if (!isHost) return out;
  if (units) out.push(['whole', 'Share as one', 'Split the whole price evenly between whoever had any']);
  else {
    if (sharers(it).length >= 2) out.push(['uneven', it.uneven ? 'Split equally' : 'Split unevenly', it.uneven ? 'Everyone on it pays the same' : 'Give someone a bigger share']);
    if (it.whole && canCount(it)) out.push(['by-unit', 'Split by unit', `Pick each of the ${it.qty} separately`]);
  }
  return out;
}
function openOpts(id) {
  const it = S.items.find((i) => i.id === id);
  if (!it) return;
  $('#opts').innerHTML = `<h2>${esc(it.name)}</h2>
    ${itemOpts(it).map(([a, label, sub]) => `<button class="row opt" data-act="${a}" data-id="${it.id}">
      <span class="grow"><div class="name">${label}</div><div class="sub">${sub}</div></span></button>`).join('')}
    <button class="btn ghost" data-act="close-sheet">Cancel</button>`;
  optSheet.showModal();
}
/* The ? sheet: what the current step is for and how to use it, for the host or a guest. */
const HELP = {
  host: [
    ['The bill', [
      'Scan the bill, or type the items. Tap any line to fix its name, quantity or price.',
      'Enter the <b>bill total</b> as printed. Tax, tip and charges are then shared in proportion to what each person had.',
      'You can add people on the next step while the bill is still being read.']],
    ['Who had what', [
      'Tap a name at the top, then tap everything they had. Tap an item again to take it off.',
      'Shared something? Tap it for each person, or <b>hold</b> a second name to pick for several at once. <b>Everyone</b> picks the whole table.',
      'Items with a count, like 3 lassis, show one slot each. Tap a free slot to take one, or a filled slot to share it.',
      '<b>⋯</b> on an item: split it unevenly, share it as one, or split it by unit.',
      'The line under the names fills with each person\'s colour as items get picked. <b>Quick round</b> shows what is left one card at a time. <b>Share the rest</b> splits what is left between everyone.',
      '<b>Share</b> at the top lets everyone pick their own items on their phone. Tap a picked name again to rename or remove them.']],
    ['The split', [
      'Each share includes that person\'s part of tax and tip. Tap a person to see their items.',
      'From there, send them their share, or confirm for someone without a phone.',
      'Once shared, <b>Finalize</b> locks the split when you are happy. <b>Reopen</b> unlocks it.',
      'Share the whole split as a picture or as text for the group chat.']],
  ],
  guest: [
    null,
    ['Pick yours', [
      'Pick your name, then tap everything you had.',
      'Shared something? Tap the other person\'s name too, then tap the item. <b>Done</b> goes back to just you.',
      'Items with a count show one slot each. Tap a free slot to take one, or a filled slot to share it.',
      '<b>Left</b> shows items nobody has picked yet. <b>Help finish</b> shows them one at a time: tap <b>Mine</b> or <b>Not mine</b>.']],
    ['Your share', [
      'Check your items, then confirm your share.',
      'If your items or the tax change later, you will be asked to confirm again.',
      'The host finalizes the split once everyone is happy.']],
  ],
};
function openHelp() {
  const isHost = host(), [title, lines] = HELP[isHost ? 'host' : 'guest'][S.step] || HELP.guest[1];
  $('#help').innerHTML = `<h2>${title}</h2>
    <ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
    <div class="sheet-actions">
      ${isHost ? '<button class="btn ghost tipsback" data-act="tips-again">Show tips again</button>' : ''}
      <button class="btn primary" data-act="close-sheet">Got it</button></div>`;
  helpSheet.showModal();
}
/* Holding a name adds them to (or drops them from) the people being picked for. */
function toggleIn(p, keepId) {
  if (!S.sel.includes(p)) S.sel = [...S.sel, p];
  else if (S.sel.length > 1 && p !== keepId) S.sel = S.sel.filter((x) => x !== p);
  S.multi = S.sel.length > 1;
}
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
  const st = status(), base = Object.fromEntries(st.r.per.map((r) => [r.p.id, r.base]));
  const saved = myName();
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
  // The rail is the only "who for" control: tap picks one person, holding a name (or, on a guest's
  // phone, tapping anyone else) picks several together, and Everyone picks the whole table.
  const canPick = isHost || !!self;
  const solo = canPick && !S.multi && one;
  const done = ' <button class="link" data-act="solo">Done</button>';
  const lead = !isHost ? (!self ? 'Pick your name to start.'
      : S.multi ? (all ? 'Tap what everyone shared.' : `Tap what you and ${esc(group.filter((p) => p.id !== self.id).map((p) => p.name).join(', '))} shared.`) + done
      : `Tap everything you had, ${esc(self.name)}.${S.people.length > 1 ? ' Shared something? Tap their name too.' : ''} <button class="link" data-act="not-me">Not ${esc(self.name)}?</button>`)
    : S.people.length < 2 ? (R ? 'Waiting for people to join. You can also add them yourself.' : S.people.length ? 'Add everyone else splitting this bill.' : 'Add everyone splitting this bill.')
    : all ? 'Tap what everyone shared.' + done
    : S.multi ? (group.length <= 3 ? `Tap what ${esc(group.slice(0, -1).map((p) => p.name).join(', '))} and ${esc(group[group.length - 1].name)} shared.`
      : `Tap what these ${group.length} shared.`) + done
    : '';
  // Otherwise, picking for one person, the host sees the next thing worth learning, if any.
  const tip = isHost && !lead && one && !S.locked && S.items.length ? hostTip(one) : null;
  tipNow = tip?.[0] || null;
  // An untouched bill can start from an equal split. Once picking has begun, the meter shows what is left.
  const bar = !isHost || S.locked || S.people.length < 2 || !S.items.length || !untouched ? ''
    : `<div class="banner calm"><span class="grow">Shared by the whole table?</span>
      <button class="link" data-act="all-equal">Split everything equally</button></div>`;
  const meter = searching ? '' : leftLine(st.r, isHost, self, untouched), bar0 = meterBar(st.r);
  return `${joinCard}
    <div class="rail ${S.multi ? 'multi' : ''} ${bar0 ? 'metered' : ''}" ${bar0 ? `style="${bar0}"` : ''} role="tablist" aria-label="Who are you picking for?" ${S.multi ? 'aria-multiselectable="true"' : ''}>
      ${canPick && S.people.length > 1 ? `<button role="tab" aria-selected="${all}" data-act="sel" data-p="all">
        <span class="dot every">All</span><span class="rname">Everyone</span><span class="rtot">together</span></button>` : ''}
      ${S.people.map((p) => `<div class="tile">
        <button role="tab" aria-selected="${S.sel.includes(p.id)}" ${canPick ? `data-act="sel" data-p="${p.id}"` : 'tabindex="-1"'} style="--c:${p.color}"
          ${marks && !hasPicks(p.id) ? `class="none" aria-description="Nothing picked yet"` : isHost && solo?.id === p.id ? 'aria-description="Tap again to rename or remove"' : ''}>
          ${av(p)}<span class="rname">${esc(p.name)}</span><span class="rtot">${R && st.ok.has(p.id) ? '✓ ' : ''}${fmt(base[p.id])}</span></button>
        ${S.multi ? `<span class="check" style="--c:${p.color}" aria-hidden="true">${S.sel.includes(p.id) ? '✓' : ''}</span>`
        : isHost && solo?.id === p.id ? `<span class="edit" aria-hidden="true">${PENCIL}</span>` : ''}
      </div>`).join('')}

      ${isHost ? `<button class="adder" aria-expanded="${open}" data-act="add-person">
        <span class="dot every">+</span><span class="rname">Add</span><span class="rtot">person</span></button>` : ''}
    </div>
    ${open ? `<form class="addrow" id="personForm">
      <input id="pName" type="text" placeholder="Name" aria-label="Name" autocomplete="off" autocapitalize="words" enterkeyhint="done" maxlength="24">
      <button class="btn primary" type="submit">Add</button>
    </form>
    ${recents.length ? `<div class="recent"><span class="sub">Add again</span>
      ${recents.map((n) => `<button class="chip" data-act="add-recent" data-name="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : ''}` : ''}
    ${lead ? `<p class="lead">${lead}</p>` : ''}
    ${tip ? `<div class="tip" data-tip="${tip[0]}"><span class="grow">${tip[1]}</span>
      <button class="x" data-act="tip-off" data-tip="${tip[0]}" aria-label="Hide this tip">×</button></div>` : ''}
    ${bar}
    ${meter}
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
      // Less common ways to split an item live behind its ⋯ button, not on the row.
      const more = itemOpts(it).length ? `<button class="more" data-act="item-more" data-id="${it.id}" aria-label="More for ${esc(it.name)}">${DOTS}</button>` : '';
      const row = ({ name, sub, warn, badges, amt, on, tick }) => `<div class="head"><button class="row pick" aria-pressed="${on}"
          data-act="pick" data-id="${it.id}" ${S.sel.length ? '' : 'disabled'}>
          <span class="tick" aria-hidden="true">${on ? tick || '✓' : ''}</span>
          <span class="grow"><div class="name">${name}</div>${sub ? `<div class="sub ${warn ? 'warn' : ''}">${sub}</div>` : ''}</span>
          <span class="stack">${badges}</span>
          <span class="amt">${fmt(amt)}</span></button>${more}</div>`;

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
        return `<div class="item ${on ? 'on' : ''}" data-item="${it.id}" ${hid(it)} style="--c:${tint}">
          ${row({ name: esc(it.name), amt: total, on, tick: all ? '✓' : String(mine), warn: free > 0,
            sub: `${it.qty} ordered · ${free ? `${free} left` : 'all taken'}`, badges: show ? '' : summary })}
          ${show ? `<div class="slots">${units.map((sh, k) => {
            const w = sharersOf(sh);
            return `<button class="slot ${w.length ? '' : 'free'}" aria-pressed="${all ? isEveryone(sh) : hasPicked(sh)}" data-act="pick" data-id="${it.id}" data-k="${k}"
              aria-label="${w.length ? `One ${esc(it.name)}: ${esc(w.map((p) => p.name).join(', '))}` : `One ${esc(it.name)}, free`}" ${S.sel.length ? '' : 'disabled'}>${
              w.length ? w.map((p) => av(p, 'sm')).join('') : '+'}</button>`;
          }).join('')}</div>` : ''}</div>`;
      }

      const on = !it.auto && (all ? who.length === S.people.length : hasPicked(it.shares));
      const parts = allocate(total, who.map((p) => it.shares[p.id]));
      const sub = [it.qty !== 1 ? `Qty ${it.qty}` : '', who.length < 2 ? '' : !it.uneven ? each(total, who.length) : isHost ? '' : 'Split unevenly'].filter(Boolean).join(' · ');
      let extra = '';
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
          badges: it.auto ? '<span class="cnt grp">All</span>' : who.map((p) => av(p, 'sm')).join('') })}${it.auto ? '' : extra}</div>`;
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
  const { r, ok, need, done } = status();
  const asks = (id) => need.includes(id);   // the host's own card has nothing to confirm
  const room = !R ? '' : S.locked
    ? `<div class="banner calm"><span class="grow"><b>Final.</b> Nobody can change the split now.</span><button class="link" data-act="unlock">Reopen</button></div>`
    : `<p class="lead">${done} of ${need.length} confirmed${offline ? ' · reconnecting…' : ''}. Finalize when you are happy with it.</p>`;
  const upi = S.cur !== '₹' ? '' : S.upi
    ? `<div class="banner calm"><span class="grow">Everyone pays you back via UPI to <b>${esc(S.upi.pa)}</b></span><button class="link" data-act="edit-upi">Change</button></div>`
    : `<button class="row add upi-add" data-act="edit-upi">Get paid back via UPI: add your UPI ID</button>`;
  return `${room}<div class="grand"><div class="muted small">Bill total</div><div class="big">${fmt(r.total)}</div>
      <div class="check">✓ Shares add up to ${fmt(r.per.reduce((a, x) => a + x.total, 0))}</div></div>
    ${upi}
    ${r.per.map(({ p, total, lines, extra }) => `<details class="card" data-p="${p.id}">
      <summary class="row">${av(p)}
        <span class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${lines.length} item${lines.length === 1 ? '' : 's'}${!R || !asks(p.id) ? '' : ok.has(p.id) ? ' · confirmed ✓' : S.locked ? '' : ' · not confirmed yet'}</div></span>
        <span class="owes">${fmt(total)}</span><span class="chev">›</span></summary>
      <div class="lines">
        ${lines.map((l) => `<div><span>${esc(l.name)}${l.frac ? ` <span class="muted">(${l.frac})</span>` : ''}</span><span>${fmt(l.amt)}</span></div>`).join('') || '<div class="muted">Nothing</div>'}
        ${extra ? `<div class="muted"><span>${extra > 0 ? 'Tax / tip share' : 'Discount share'}</span><span>${fmt(extra)}</span></div>` : ''}
      </div>
      ${R && !S.locked && asks(p.id) && !ok.has(p.id) ? `<button class="row add" data-act="ok-for" data-p="${p.id}">Confirm for ${esc(p.name)}</button>` : ''}
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
      <div class="check">${S.locked ? 'Final ✓' : ok.has(x.p.id) ? (payee() && x.total > 0 ? `✓ Confirmed. Now pay ${esc(payee().pn)} below.` : '✓ Confirmed. You are all done.') : 'Check your items, then confirm below.'}</div></div>
    <div class="card"><div class="lines">
      ${x.lines.map((l) => `<div><span>${esc(l.name)}${l.frac ? ` <span class="muted">(${l.frac})</span>` : ''}</span><span>${fmt(l.amt)}</span></div>`).join('') || '<div class="muted">Nothing</div>'}
      ${x.extra ? `<div class="muted"><span>${x.extra > 0 ? 'Tax / tip share' : 'Discount share'}</span><span>${fmt(x.extra)}</span></div>` : ''}
    </div></div>
    ${S.locked || ok.has(x.p.id) ? payBox(x.total) : payee() && x.total > 0 ? `<p class="muted small center">Once you confirm, you can pay ${esc(payee().pn)} via UPI from here.</p>` : ''}`
    : `<div class="grand"><div class="muted small">Bill total</div><div class="big">${fmt(r.total)}</div><div class="check">Final ✓</div></div>`}
    ${left.length ? `<div class="banner"><span class="grow">Nobody has picked ${esc(names)} yet.</span><button class="link" data-act="back">Is it yours?</button></div>` : ''}
    <div class="card">${r.per.map(({ p, total }) => `<div class="row">${av(p)}
      <span class="grow"><div class="name">${esc(p.name)}${p.id === R.me ? ' (you)' : ''}</div>
      <div class="sub">${p.id === hostId() ? 'Host · finalizes the split' : ok.has(p.id) ? 'Confirmed ✓' : S.locked ? '' : 'Not confirmed yet'}</div></span>
      <span class="amt">${fmt(total)}</span></div>`).join('')}</div>`;
}

function personText(id) {
  const x = compute().per.find((r) => r.p.id === id);
  return [`${x.p.name}, your share of the bill is ${fmt(x.total)}`, '',
    ...x.lines.map((l) => `${l.name}${l.frac ? ` (${l.frac})` : ''}: ${fmt(l.amt)}`),
    ...(x.extra ? [`${x.extra > 0 ? 'Tax / tip share' : 'Discount share'}: ${fmt(x.extra)}`] : []),
    ...(payee() && id !== hostId() && x.total > 0 ? ['', `Pay ${payee().pn} via UPI: ${UPI.pageLink(payee(), x.total)}`] : []),
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
    ...(payee() ? ['', `Pay ${payee().pn} via UPI: ${payee().pa}`] : []),
  ].join('\n');
}

function render() {
  ensureSelf();
  carryUpi();
  save();
  const isHost = host(), first = isHost ? 0 : 1;
  const mine = S.people.find((p) => p.id === selfId())?.name || myName();
  // On the host's Split and Result steps the header offers sharing (and how many have confirmed) in place of
  // the name chip; the host renames themself from their own tile there.
  const shareTop = $('#shareTop'), sharing = isHost && !S.locked && S.step >= 1 && S.items.length > 0 && !(R && !R.base);
  shareTop.hidden = !sharing;
  if (sharing) {
    const { done: n, need } = R ? status() : { done: 0, need: [] };
    shareTop.innerHTML = `${SHARE}<span>${R ? 'Invite' : 'Share'}</span>${R && need.length ? `<b>${offline ? '…' : `${n}/${need.length} ✓`}</b>` : ''}`;
    shareTop.setAttribute('aria-label', !R ? 'Share the bill so everyone picks their own items'
      : offline ? 'Invite more people · reconnecting' : `Invite more people · ${n} of ${need.length} confirmed`);
  }
  $('#meChip').hidden = !mine || sharing;
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
    `<button class="${i === S.step ? 'now' : i < S.step ? 'done' : ''}" data-act="step" data-step="${i}" ${S.locked || (i > S.step && blocker(i)) ? 'disabled' : ''}>${i + 1 - first}. ${s}</button>`).filter(Boolean).join('') + `<button class="help" data-act="help" aria-label="How this works">?</button>`;
  // Whatever is being typed, and whichever cards are open, survive the redraw.
  const typed = ['pName', 'jName', 'meName', 'iSearch'].map((id) => { const el = document.getElementById(id); return el && { id, v: el.value, focus: document.activeElement === el }; }).filter(Boolean);
  const openCards = [...view.querySelectorAll('details[open]')].map((d) => d.dataset.p);
  const railX = $('.rail')?.scrollLeft;
  tipNow = null;
  view.innerHTML = (isHost ? [billView, assignView, resultView] : [null, assignView, myView])[S.step]();
  shareTop.classList.toggle('nudge', tipNow === 'share');   // the Share tip points at the header button
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
  if (roundSheet.open && round && !round.busy) drawRound();       // someone else's picks can finish the card on screen
  if (rail) view.style.setProperty('--rail-h', `${rail.offsetHeight}px`);   // the open search pins just under the rail
  if (!S.items.length) { searchable = false; closeSearch(); }
  else if (!searchable && S.step === 1) {
    const rows = [...view.querySelectorAll('[data-item]:not([hidden])')];
    const avg = rows.length ? rows.reduce((a, el) => a + el.offsetHeight, 0) / rows.length : 0;
    if (avg * S.items.length > view.clientHeight - (rail?.offsetHeight || 0)) { searchable = true; render(); return; }
  }
  flashPings();
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
  } else if (np) { const n = unassigned().length; label = `Next: ${np.name} · ${n} item${n > 1 ? 's' : ''} left`; }
  else if (jumpable()) { const n = unassigned().length; label = `⚡ Quick round · ${n} left`; }
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
  const before = R.base ? snapshot() : null;        // nothing to compare with on the first answer
  R.base = d.doc; R.ver = d.ver;
  if (d.me) R.me = d.me;
  rebase();
  if (before) liveNotes(before, snapshot());
  // Only a unit that looked free on this phone and was gone on the server is news.
  if (d.missed?.filter((m) => m.why === 'full' && !toldFull.delete(m.o)).length) toast('Someone just took the last one. Tap a slot to share it.');
  softRender();
}
/* ---------- live activity ----------
   When the server's bill arrives, it is compared with what this phone showed. This phone's own
   changes are already on screen (they were applied when tapped), so anything new came from someone
   else: a short note says who did what, and the items and people it touched flash in their colour. */
const pings = new Map();          // item id or 'p:'+person id → colour, flashed on the next redraw
function snapshot() {
  const claims = {};
  S.items.forEach((it) => {
    if (it.auto) return;          // the untouched table split is nobody's pick
    const c = {};
    (slots(it) || [it.shares]).forEach((sh) => sharersOf(sh).forEach((p) => { c[p.id] = (c[p.id] || 0) + 1; }));
    claims[it.id] = c;
  });
  return { claims, people: new Set(S.people.map((p) => p.id)), ok: status().ok, locked: S.locked };
}
function liveNotes(a, b) {
  const notes = [], self = selfId(), who = (id) => S.people.find((p) => p.id === id);
  // Newcomers first, then what each person picked or put back, then confirmations.
  S.people.forEach((p) => { if (!a.people.has(p.id) && p.id !== self) { notes.push([p, `${p.name} joined the bill`]); pings.set('p:' + p.id, p.color); } });
  const moves = new Map();        // person id → { got: [[item, n, shared]], back: [item] }
  S.items.forEach((it) => {
    const was = a.claims[it.id] || {}, now = b.claims[it.id] || {};
    new Set([...Object.keys(was), ...Object.keys(now)]).forEach((id) => {
      const d = (now[id] || 0) - (was[id] || 0);
      if (!d || !who(id)) return;
      const m = moves.get(id) || { got: [], back: [] };
      if (d > 0) m.got.push([it, d, Object.keys(now).some((x) => x !== id)]); else m.back.push(it);
      moves.set(id, m);
      if (d > 0 && !pings.has(it.id)) pings.set(it.id, who(id).color);
    });
  });
  moves.forEach(({ got, back }, id) => {
    const p = who(id), me = id === self;
    if (got.length) pings.set('p:' + id, p.color);
    if (got.length > 2) notes.push([p, me ? `You're on ${got.length} more items` : `${p.name} picked ${got.length} items`]);
    else got.forEach(([it, n, shared]) => notes.push([p, me ? `You're on ${it.name}`
      : slots(it) ? `${p.name} took ${n > 1 ? n : 'one'} ${it.name}` : shared ? `${p.name} is sharing ${it.name}` : `${p.name} took ${it.name}`]));
    if (back.length > 2) notes.push([p, me ? `You're off ${back.length} items` : `${p.name} put back ${back.length} items`]);
    else back.forEach((it) => notes.push([p, me ? `You're off ${it.name}` : `${p.name} put back ${it.name}`]));
  });
  b.ok.forEach((id) => { if (!a.ok.has(id) && id !== self && who(id)) notes.push([who(id), `${who(id).name} confirmed ✓`]); });
  if (b.locked && !a.locked && !host()) notes.push([who(hostId()) || null, `${hostName() || 'The host'} finalized the split`]);
  if (notes.length) note(notes[0][0], notes[0][1] + (notes.length > 1 ? ` · +${notes.length - 1} more` : ''));
}
/* One note at a time, just above the bottom bar; a newer one replaces it. A toast (an error, or
   something this phone did) is more important, so no note shows while one is up. */
let noteT;
function note(p, text) {
  if (!$('#toast').hidden) return;
  const feed = $('#live');
  feed.innerHTML = `<div class="note">${p ? av(p, 'sm') : ''}<span>${esc(text)}</span></div>`;
  clearTimeout(noteT);
  noteT = setTimeout(() => { feed.firstElementChild?.classList.add('out'); noteT = setTimeout(() => { feed.innerHTML = ''; }, 300); }, 3500);
}
/* Flash what the last notes were about, once, on the redraw that shows it. */
function flashPings() {
  pings.forEach((c, key) => {
    const el = key.startsWith('p:') ? $(`.rail [data-p="${key.slice(2)}"]`) : view.querySelector(`[data-item="${key}"]`);
    if (el) { el.style.setProperty('--pc', c); el.classList.add('ping'); }
  });
  pings.clear();
}

/* Redraw for a change that came from someone else, but never under a finger or a keyboard. */
function softRender() {
  if (pressing || sheet.open || personSheet.open || meSheet.open || optSheet.open || helpSheet.open || upiSheet.open || ['total', 'cur', 'iSearch'].includes(document.activeElement?.id)) { stale = true; return; }
  stale = false;
  render();
}
const settle = () => setTimeout(() => { if (stale) softRender(); }, 60);
document.addEventListener('pointerdown', () => { pressing = true; });
['pointerup', 'pointercancel'].forEach((ev) => document.addEventListener(ev, () => { pressing = false; settle(); }));
document.addEventListener('focusout', settle);
[sheet, personSheet, meSheet, optSheet, helpSheet, upiSheet].forEach((d) => d.addEventListener('close', settle));

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
      body: JSON.stringify({ doc: { ...Object.fromEntries(C.DOC.map((k) => [k, S[k]])), host: mine } }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { toast(d.message || "Couldn't share the bill. Try again."); return; }
    if (mine) { S.sel = [mine]; S.multi = false; }
    learn('share');
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
  if (S.step <= 1 && !/^(INPUT|SELECT)$/.test(document.activeElement?.tagName || '') && !sheet.open && !personSheet.open && !meSheet.open && !upiSheet.open) render();
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
  'rest-all', 'all-equal', 'whole', 'by-unit', 'uneven', 'inc', 'dec', 'share-bill', 'ok-for', 'unlock', 'edit-upi', 'del-upi',
  'r-sel', 'r-give', 'r-everyone-rest'];

document.addEventListener('click', async (e) => {
  if (held) { held = false; return; }       // the click that ends a hold on a name is not a tap
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act: name, id, p } = el.dataset;
  if (!host() && HOST_ONLY.includes(name)) return;
  if (optSheet.open && el.closest('#optSheet')) optSheet.close();  if (name === 'sel' && host() && p !== 'all' && (e.shiftKey || e.metaKey || e.ctrlKey)) { hold(p); return; }   // keyboard and mouse stand-in for holding
  const it = S.items.find((i) => i.id === id);
  if (['scan', 'add-item'].includes(name) && !myName()) { if (!takeName()) return; render(); }
  if (name.startsWith('r-') && round) { roundAct(name, el); return; }
  switch (name) {
    case 'round': openRound(); return;
    case 'edit-me': openMe(); return;
    case 'scan': if (scanning) { toast('Still reading the last bill'); return; } $('#file').click(); return;
    case 'add-item': openSheet(); return;
    case 'edit-item': openSheet(id); return;
    case 'close-sheet': el.closest('dialog').close(); return;
    case 'dismiss-note': act({ t: 'note' }); break;
    case 'cancel-scan': scanCancelled = true; scanCtl?.abort(); return;
    case 'delete-item': act({ t: 'item-del', id: editingId }); sheet.close(); break;
    case 'del-person': {                      // from the person sheet
      const who = S.people.find((x) => x.id === editingPerson);
      if (!who) return;
      if (hasPicks(who.id) && !confirm(`Remove ${who.name}? Their picks will be cleared.`)) return;
      personSheet.close();
      removePerson(who.id);
      break;
    }
    case 'item-more': learn('more'); render(); openOpts(id); return;   // redraw so the tip about ⋯ goes
    case 'tip-off': learn(el.dataset.tip); break;
    case 'help': openHelp(); return;
    case 'tips-again': forgetTips(); helpSheet.close(); toast('Tips will show again as you go.'); break;
    case 'solo':                              // leave picking together, back to one person
      S.sel = host() ? S.sel.slice(0, 1) : [me()?.id].filter(Boolean); S.multi = false;
      break;
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
      if (jumpable()) { openRound(); return; }
      if (S.step < 2) return go(S.step + 1);
      if (!R || S.locked) { shareOut(shareText()); return; }
      if (host()) {                           // finalize: from here nobody can change the split
        const { r, ok, need } = status(), waiting = r.per.filter((x) => need.includes(x.p.id) && !ok.has(x.p.id)).map((x) => x.p.name);
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
    case 'edit-upi': openUpi(); return;
    case 'del-upi': act({ t: 'upi' }); setMyUpi(''); upiSheet.close(); break;
    case 'copy-upi': if (payee()) { try { await navigator.clipboard.writeText(payee().pa); toast('UPI ID copied'); } catch { toast(payee().pa); } } return;
    case 'image': shareImage(); return;
    case 'sel': {
      adding = false;
      const mine = host() ? null : me()?.id;
      if (!host() && !mine) return;
      if (p === 'all') { S.sel = S.people.map((x) => x.id); S.multi = true; break; }
      // Picking several: each tap adds or drops a person, never the last one (or a guest's own name).
      // A guest starts picking with someone just by tapping them; the host holds a name instead.
      if (S.multi || (mine && p !== mine)) { toggleIn(p, mine); break; }
      if (mine) return;                       // a guest tapping their own name: already picked
      if (S.sel[0] === p) { learn('rename'); render(); openPerson(p); return; }   // the host taps the picked person again: rename or remove
      S.sel = [p];
      break;
    }
    case 'add-recent': addPerson(el.dataset.name); break;
    case 'pick': {
      if (host()) learn('pick');
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

function openUpi() {
  $('#uId').value = S.upi?.pa || myUpi();
  $('#uErr').hidden = true;
  $('#uDel').hidden = !S.upi;
  upiSheet.showModal();
  $('#uId').focus();
}

function openPerson(id) {
  const who = S.people.find((x) => x.id === id);
  if (!who) return;
  editingPerson = id;
  $('#eName').value = who.name;
  $('#eErr').hidden = true;
  $('#eDel').textContent = `Remove ${who.name}`;
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
  if (e.target.id === 'upiEdit') {
    e.preventDefault();
    const pa = $('#uId').value.trim().replace(/\s+/g, '');
    if (!UPI.VPA.test(pa)) { $('#uErr').textContent = 'Enter a UPI ID like name@bank.'; $('#uErr').hidden = false; return; }
    act({ t: 'upi', pa, pn: hostName() || pa });
    setMyUpi(pa);
    upiSheet.close();
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

/* Holding a name on the rail (host): pick them together with whoever is already picked. */
let holdT = null, held = false, holdAt = null;
function hold(p) {
  toggleIn(p, null);
  adding = false;
  learn('held');
  render();
}
document.addEventListener('pointerdown', (e) => {
  held = false;
  clearTimeout(holdT);
  const el = e.target.closest('.rail [data-act="sel"]');
  if (!el || !host() || el.dataset.p === 'all') return;
  holdAt = [e.clientX, e.clientY];
  holdT = setTimeout(() => { held = true; navigator.vibrate?.(15); hold(el.dataset.p); }, 450);
});
document.addEventListener('pointermove', (e) => {
  if (holdAt && Math.hypot(e.clientX - holdAt[0], e.clientY - holdAt[1]) > 10) clearTimeout(holdT);   // scrolling the rail
});
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, () => { clearTimeout(holdT); holdAt = null; }));
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.rail')) e.preventDefault(); });

[sheet, personSheet, meSheet, optSheet, helpSheet, upiSheet, roundSheet].forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

if (R?.base) rebase();
render();
if (R) { poll(); flush(); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
