/* Split the Bill — the split lives on the device (localStorage); only a scanned photo goes to /api/scan. */
const $ = (s) => document.querySelector(s);
const KEY = 'splitbill.v1', NAMES = 'splitbill.names';
const STEPS = ['Bill', 'People', 'Assign', 'Result'];
const COLORS = ['#0f766e', '#c2410c', '#6d28d9', '#be185d', '#1d4ed8', '#4d7c0f', '#b45309', '#475569'];

const view = $('#view'), nextBtn = $('#next'), backBtn = $('#back'), sheet = $('#sheet');
let S = load();
let editingId = null;

/* ---------- state ---------- */
function guessCur() {
  const r = (navigator.language || '').split('-')[1];
  return { IN: '₹', US: '$', GB: '£', CA: '$', AU: '$', JP: '¥' }[r] ||
    (['DE', 'FR', 'ES', 'IT', 'NL', 'IE', 'PT', 'AT', 'BE', 'FI'].includes(r) ? '€' : '₹');
}
function fresh() { return { step: 0, items: [], people: [], sel: null, total: null, note: null, cur: guessCur() }; }
function load() {
  try { return Object.assign(fresh(), JSON.parse(localStorage.getItem(KEY))); } catch { return fresh(); }
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
const sharers = (item) => S.people.filter((p) => item.shares[p.id] > 0);
const unassigned = () => S.items.filter((i) => !sharers(i).length);

function compute() {
  const per = S.people.map((p) => ({ p, base: 0, extra: 0, lines: [] }));
  const idx = Object.fromEntries(S.people.map((p, i) => [p.id, i]));
  for (const it of S.items) {
    const who = sharers(it);
    const w = who.map((p) => it.shares[p.id]);
    const W = w.reduce((a, b) => a + b, 0);
    allocate(cents(it.total), w).forEach((amt, k) => {
      const row = per[idx[who[k].id]];
      row.base += amt;
      row.lines.push({ name: it.name, amt, frac: who.length > 1 ? `${w[k]}/${W}` : '' });
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
  if (step >= 3 && unassigned().length) {
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
    return `<p class="lead">Reading your bill. No need to wait here: go ahead and add people.</p>${liveItems()}`;
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

const av = (p, cls = '') => `<span class="dot ${cls}" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span>`;

function peopleView() {
  const recents = loadNames().filter((n) => !S.people.some((x) => x.name.toLowerCase() === n.toLowerCase()));
  return `<p class="lead">Who is splitting this bill?</p>
    <form class="addrow" id="personForm">
      <input id="pName" type="text" placeholder="Name" autocomplete="off" autocapitalize="words" enterkeyhint="done" maxlength="24">
      <button class="btn primary" type="submit">Add</button>
    </form>
    ${recents.length ? `<div class="recent"><span class="sub">Add again</span>
      ${recents.map((n) => `<button class="chip" data-act="add-recent" data-name="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : ''}
    ${S.people.length ? `<div class="card">${S.people.map((p) => `<div class="row">
      ${av(p)}
      <span class="grow name">${esc(p.name)}</span>
      <button class="x" data-act="del-person" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></div>`).join('')}</div>` : ''}`;
}

/* Person-first: pick someone in the rail, then tap everything they had. */
function assignView() {
  if (S.sel !== 'all' && !S.people.some((p) => p.id === S.sel)) S.sel = S.people[0].id;
  const all = S.sel === 'all', me = S.people.find((p) => p.id === S.sel);
  const left = unassigned().length;
  const base = Object.fromEntries(compute().per.map((r) => [r.p.id, r.base]));
  return `<div class="rail" role="tablist" aria-label="Who are you picking for?">
      ${S.people.map((p) => `<button role="tab" aria-selected="${p.id === S.sel}" data-act="sel" data-p="${p.id}" style="--c:${p.color}">
        ${av(p)}<span class="rname">${esc(p.name)}</span><span class="rtot">${fmt(base[p.id])}</span></button>`).join('')}
      <button role="tab" aria-selected="${all}" data-act="sel" data-p="all">
        <span class="dot every">All</span><span class="rname">Everyone</span><span class="rtot">shared</span></button>
    </div>
    <p class="lead">${all ? 'Tap what everyone shared.' : `Tap everything ${esc(me.name)} had.`}</p>
    ${left && left < S.items.length ? `<div class="banner"><span class="grow">${left} item${left > 1 ? 's' : ''} not picked yet.</span>
      <button class="link" data-act="rest-all">Split between everyone</button></div>` : ''}
    <div class="card">${S.items.map((it) => {
      const who = sharers(it), total = cents(it.total);
      const on = all ? who.length === S.people.length : it.shares[S.sel] > 0;
      const parts = allocate(total, who.map((p) => it.shares[p.id]));
      const sub = [it.qty !== 1 ? `Qty ${it.qty}` : '',
        who.length >= 2 && !it.uneven ? `${parts.some((x) => x !== parts[0]) ? 'about ' : ''}${fmt(parts[parts.length - 1])} each` : ''].filter(Boolean).join(' · ');
      let extra = '';
      if (who.length >= 2 && !it.uneven) {
        extra = `<p class="hint"><button class="link" data-act="uneven" data-id="${it.id}">Split unevenly</button></p>`;
      } else if (who.length >= 2) {
        extra = `<div class="uneven">${who.map((p, k) => `<div class="urow">
            <span class="grow name">${esc(p.name)}</span>
            <span class="stepper"><button data-act="dec" data-id="${it.id}" data-p="${p.id}" aria-label="Less">−</button>
            <span>${it.shares[p.id]}</span>
            <button data-act="inc" data-id="${it.id}" data-p="${p.id}" aria-label="More">+</button></span>
            <span class="amt uamt">${fmt(parts[k])}</span></div>`).join('')}
          <p class="hint flat">Numbers are shares${it.qty > 1 ? ` (e.g. how many of the ${it.qty} each had)` : ''}. · <button class="link" data-act="uneven" data-id="${it.id}">Split equally</button></p></div>`;
      }
      return `<div class="item ${on ? 'on' : ''}" style="--c:${all ? 'var(--accent)' : me.color}">
        <button class="row pick" aria-pressed="${on}" data-act="pick" data-id="${it.id}">
          <span class="tick" aria-hidden="true">${on ? '✓' : ''}</span>
          <span class="grow"><div class="name">${esc(it.name)}</div>
            ${who.length ? (sub ? `<div class="sub">${sub}</div>` : '') : `<div class="sub warn">${sub ? sub + ' · ' : ''}Nobody yet</div>`}</span>
          <span class="stack">${who.map((p) => av(p, 'sm')).join('')}</span>
          <span class="amt">${fmt(total)}</span>
        </button>${extra}</div>`;
    }).join('')}</div>`;
}

/* While items are still unpicked, the main button walks through the people in order. */
function nextPerson() {
  if (S.step !== 2 || !unassigned().length) return null;
  const i = S.people.findIndex((p) => p.id === S.sel);
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
  view.innerHTML = [billView, peopleView, assignView, resultView][S.step]();
  if ($('#pName') && typed) { $('#pName').value = typed; if (hadFocus) $('#pName').focus(); }
  $('#scanStrip').hidden = !scanning;
  scanTick();
  backBtn.hidden = S.step === 0;
  $('#reset').hidden = !S.items.length && !S.people.length && !scanning;
  const block = blocker(S.step + 1);
  const np = nextPerson();
  nextBtn.disabled = S.step < 3 && !!block && !np;
  nextBtn.textContent = S.step === 3 ? 'Share the split'
    : np ? `Next: ${np.name}`
    : block && (S.step > 0 || S.items.length || scanning) ? block
    : ['Next: add people', 'Next: who had what?', 'See the split'][S.step];
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

function scanTick() {
  if (!scanning) return;
  const s = Math.floor((Date.now() - scanning.t0) / 1000), n = scanning.items.length;
  $('#scanMsg').textContent = `${scanning.phase}… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${n ? ` · ${n} item${n > 1 ? 's' : ''} so far` : ''}`;
}
/* Refresh the live list, but never while the user is typing in a field. */
function scanLive() {
  scanTick();
  if (S.step === 0 && !/^(INPUT|SELECT)$/.test(document.activeElement?.tagName || '') && !sheet.open) render();
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
    let data = await callScan(image, 'cheap', onItem);
    if (!data.verified) {
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
    S.note = data.verified ? null : (data.issues[0] || "The numbers don't add up.") + ' Please check against your bill.';
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
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3500);
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
  const it = S.items.find((i) => i.id === id);
  switch (act) {
    case 'scan': if (scanning) { toast('Still reading the last bill'); return; } $('#file').click(); return;
    case 'add-item': openSheet(); return;
    case 'edit-item': openSheet(id); return;
    case 'close-sheet': sheet.close(); return;
    case 'dismiss-note': S.note = null; break;
    case 'cancel-scan': scanCancelled = true; scanCtl?.abort(); return;
    case 'delete-item': S.items = S.items.filter((i) => i.id !== editingId); sheet.close(); break;
    case 'del-person':
      S.people = S.people.filter((x) => x.id !== id);
      S.items.forEach((i) => { delete i.shares[id]; });
      break;
    case 'rest-all': unassigned().forEach((i) => S.people.forEach((x) => { i.shares[x.id] = 1; })); break;
    case 'uneven':
      it.uneven = !it.uneven;
      if (!it.uneven) sharers(it).forEach((x) => { it.shares[x.id] = 1; });
      break;
    case 'inc': it.shares[p]++; break;
    case 'dec': if (it.shares[p] > 1) it.shares[p]--; break;
    case 'step': go(Number(el.dataset.step)); return;
    case 'back': go(S.step - 1); return;
    case 'next':
      if (nextPerson()) { S.sel = nextPerson().id; view.scrollTop = 0; break; }
      if (S.step < 3) return go(S.step + 1);
      shareOut(shareText());
      return;
    case 'share-one': shareOut(personText(id)); return;
    case 'image': shareImage(); return;
    case 'sel': S.sel = p; break;
    case 'add-recent': addPerson(el.dataset.name); break;
    case 'pick':
      if (S.sel === 'all') {
        const full = sharers(it).length === S.people.length;
        it.shares = {};
        if (!full) S.people.forEach((x) => { it.shares[x.id] = 1; });
      } else if (it.shares[S.sel] > 0) delete it.shares[S.sel]; else it.shares[S.sel] = 1;
      if (sharers(it).length < 2) it.uneven = false;
      break;
    case 'copy': copy(shareText()); return;
    case 'reset':
      if (confirm('Start a new bill? This clears the current one.')) { if (scanning) { scanCancelled = true; scanCtl?.abort(); } S = fresh(); }
      break;
    default: return;
  }
  render();
});

function addPerson(name) {
  if (S.people.some((x) => x.name.toLowerCase() === name.toLowerCase())) { toast(`${name} is already added`); return false; }
  const used = S.people.map((x) => x.color);
  S.people.push({ id: uid(), name, color: COLORS.find((c) => !used.includes(c)) || COLORS[S.people.length % COLORS.length] });
  rememberName(name);
  return true;
}

document.addEventListener('submit', (e) => {
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

sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
