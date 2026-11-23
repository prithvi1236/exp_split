/* The bill itself: its maths, and every change to it as a small "op".
   The app and the room function (functions/api/room) both run this file, so a change made on
   one phone is replayed the same way on the server and on everyone else's phone.

   A bill D is { items, people, total, cur, note, locked, host, upi }. */
import { VPA } from './upi.js';
export const COLORS = ['#0f766e', '#c2410c', '#6d28d9', '#be185d', '#1d4ed8', '#4d7c0f', '#b45309', '#475569'];
export const CURS = ['₹', '$', '€', '£', '¥', ''];
/* `host` is the person id of whoever shared the bill (null if they are not on it). It is set once, when
   the bill is shared, so every phone knows whose share needs no confirming: the host agrees by finalizing.
   `upi` is { pa, pn }: the UPI ID and name everyone pays their share back to, or null. */
export const DOC = ['items', 'people', 'total', 'cur', 'note', 'locked', 'host', 'upi'];

/* ---------- money ---------- */
export const cents = (n) => Math.round((Number(n) || 0) * 100);

/* Split `amount` cents by weights so the parts always add up exactly. */
export function allocate(amount, weights) {
  const W = weights.reduce((a, b) => a + b, 0);
  if (!W) return weights.map(() => 0);
  const sign = amount < 0 ? -1 : 1, abs = Math.abs(amount);
  const raw = weights.map((w) => (abs * w) / W);
  const out = raw.map(Math.floor);
  let left = abs - out.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left-- > 0) out[i]++; });
  return out.map((v) => v * sign);
}

export const subtotal = (D) => D.items.reduce((a, i) => a + cents(i.total), 0);
export const billTotal = (D) => (D.total != null ? cents(D.total) : subtotal(D));
export const sharersOf = (D, shares) => D.people.filter((p) => shares[p.id] > 0);
export const everyone = (D) => Object.fromEntries(D.people.map((x) => [x.id, 1]));
export const isEveryone = (D, shares) => D.people.length > 0 && sharersOf(D, shares).length === D.people.length;

/* A quantity item (2 to 24 of something) is split into one slot per unit, kept in `parts`.
   Each slot has its own sharers, so one unit can go to one person and the next be shared.
   Splits saved before slots existed are carried over the first time the item is read. */
export const canCount = (it) => Number.isInteger(it.qty) && it.qty > 1 && it.qty <= 24;
export function slots(it) {
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
export function pieces(D, it) {
  const parts = slots(it);
  if (!parts) return [{ shares: it.shares, amt: cents(it.total), n: 1 }];
  const amts = allocate(cents(it.total), parts.map(() => 1)), groups = new Map();
  parts.forEach((shares, k) => {
    const key = sharersOf(D, shares).map((p) => p.id).join();
    const g = groups.get(key) || { shares, amt: 0, n: 0 };
    g.amt += amts[k]; g.n++;
    groups.set(key, g);
  });
  return [...groups.values()];
}
export const finished = (D, it) => pieces(D, it).every((pc) => sharersOf(D, pc.shares).length);

export function compute(D) {
  const per = D.people.map((p) => ({ p, base: 0, extra: 0, lines: [] }));
  const idx = Object.fromEntries(D.people.map((p, i) => [p.id, i]));
  for (const it of D.items) for (const pc of pieces(D, it)) {
    const who = sharersOf(D, pc.shares);
    const w = who.map((p) => pc.shares[p.id]);
    const W = w.reduce((a, b) => a + b, 0);
    allocate(pc.amt, w).forEach((amt, k) => {
      const row = per[idx[who[k].id]];
      row.base += amt;
      row.lines.push({ name: it.name + (pc.n > 1 ? ` ×${pc.n}` : ''), amt, frac: who.length > 1 ? `${w[k]}/${W}` : '' });
    });
  }
  // Tax and tip follow what each person had. Items nobody has taken yet keep their part of it,
  // so a person's share does not move while the others are still picking.
  const sub = subtotal(D), extra = billTotal(D) - sub;
  const open = sub - per.reduce((a, r) => a + r.base, 0);
  allocate(extra, [...per.map((r) => r.base), open]).slice(0, per.length).forEach((e, i) => { per[i].extra = e; });
  per.forEach((r) => { r.total = r.base + r.extra; });
  return { per, extra, total: billTotal(D) };
}

/* ---------- ops ----------
   apply() changes D in place. Ops say what the person meant ("put me on this", "take one more"),
   not what the result should be, so two people's taps arriving in either order both land.
   `out.miss` is set when an op could do nothing (the last unit was just taken); `out.me` on a join. */
export function apply(D, op, out = {}) {
  // The UPI ID can still change once the split is final: paying back happens after that.
  if (D.locked && op.t !== 'lock' && op.t !== 'upi') { out.miss = 'locked'; return out; }
  const it = op.id != null ? D.items.find((i) => i.id === op.id) : null;
  const who = op.p != null ? D.people.find((x) => x.id === op.p) : null;
  const dup = (name, but) => D.people.find((x) => x.id !== but && x.name.toLowerCase() === name.toLowerCase());
  if (it && ['uneven', 'whole', 'by-unit', 'weight'].includes(op.t)) delete it.auto;

  switch (op.t) {
    case 'items-add': {
      const first = !D.items.length;
      D.items.push(...op.items.filter((i) => !D.items.some((x) => x.id === i.id)).map((i) => ({ shares: {}, ...i })));
      if (first && op.cur != null) D.cur = op.cur;
      if (first && op.total != null && cents(op.total) !== subtotal(D)) D.total = op.total;
      if ('note' in op) D.note = op.note;
      break;
    }
    case 'item-set':
      if (!it) break;
      // A changed quantity makes the old claims meaningless, so start that item over.
      if (it.qty !== op.data.qty) { it.shares = {}; delete it.parts; delete it.auto; it.uneven = it.whole = false; }
      Object.assign(it, op.data, { flag: false });
      break;
    case 'item-del': D.items = D.items.filter((i) => i.id !== op.id); break;
    case 'total': D.total = op.v; break;
    case 'cur': D.cur = op.v; break;
    case 'note': D.note = null; break;

    case 'join': case 'person-add': {
      const same = dup(op.name);
      if (same) { if (op.t === 'join') out.me = same.id; else out.miss = 'dup'; break; }   // joining under a listed name takes that seat
      if (who) break;
      const used = D.people.map((x) => x.color);
      D.people.push({ id: op.p, name: op.name, color: COLORS.find((c) => !used.includes(c)) || COLORS[D.people.length % COLORS.length] });
      // Anything still on the untouched table split includes the newcomer.
      D.items.forEach((i) => { if (i.auto) (i.parts || [i.shares]).forEach((sh) => { sh[op.p] = 1; }); });
      if (op.t === 'join') out.me = op.p;
      break;
    }
    case 'person-name':
      if (!who) break;
      if (dup(op.name, op.p)) { out.miss = 'dup'; break; }
      who.name = op.name;
      break;
    case 'person-del':
      D.people = D.people.filter((x) => x.id !== op.p);
      if (D.host === op.p) D.host = null;
      D.items.forEach((i) => {
        delete i.shares[op.p];
        i.parts?.forEach((sh) => { delete sh[op.p]; });
        if (sharersOf(D, i.shares).length < 2) i.uneven = false;
      });
      break;

    case 'rest-all':
      D.items.filter((i) => !finished(D, i)).forEach((i) => {
        const units = slots(i);
        if (units) i.parts = units.map((sh) => (sharersOf(D, sh).length ? sh : everyone(D)));   // claimed slots stay as they are
        else i.shares = everyone(D);
      });
      break;
    case 'all-equal':                         // start from the usual case; the exceptions are then claimed one by one
      D.items.forEach((i) => {
        const units = slots(i);
        if (units) i.parts = units.map(() => everyone(D)); else i.shares = everyone(D);
        i.uneven = false; i.auto = true;
      });
      break;
    case 'whole': {                           // share the whole item equally, by price, between whoever is on it
      if (!it) break;
      const ids = new Set((it.parts || []).flatMap((sh) => sharersOf(D, sh).map((x) => x.id)));
      sharersOf(D, it.shares).forEach((x) => ids.add(x.id));
      op.add.forEach((x) => { if (D.people.some((q) => q.id === x)) ids.add(x); });
      it.whole = true; delete it.parts;
      it.shares = Object.fromEntries([...ids].map((x) => [x, 1]));
      break;
    }
    case 'by-unit': if (it) { it.whole = it.uneven = false; it.shares = {}; delete it.parts; } break;
    case 'uneven':
      if (!it) break;
      it.uneven = op.on;
      if (!op.on) sharersOf(D, it.shares).forEach((x) => { it.shares[x.id] = 1; });
      break;
    case 'weight': if (it && it.shares[op.p] > 0) it.shares[op.p] = Math.min(99, Math.max(1, it.shares[op.p] + op.d)); break;

    case 'pick': {
      if (!it) break;
      const sel = op.sel.filter((x) => D.people.some((q) => q.id === x));
      if (!sel.length) break;
      let units = slots(it);
      // An item still on the untouched table split is handed to the picked people, not toggled.
      if (it.auto) {
        delete it.auto;
        if (!op.all) { it.shares = {}; if (units) units = it.parts = units.map(() => ({})); }
      }
      const free = (sh) => !sharersOf(D, sh).length;
      const k = units && op.k != null && op.k < units.length ? op.k : null;
      if (units && k == null) {               // the row of a quantity item: one more unit, whichever is free by now
        if (op.all) { it.parts = units.map(() => (op.on ? everyone(D) : {})); break; }
        const sh = units.find(free);
        if (sh) sel.forEach((x) => { sh[x] = 1; }); else out.miss = 'full';
        break;
      }
      let sh = units ? units[k] : it.shares;
      if (units && op.free && !op.all && !free(sh)) {   // it was free when tapped and someone got there first: take another
        sh = units.find(free);
        if (!sh) { out.miss = 'full'; break; }
      }
      if (op.all) {
        Object.keys(sh).forEach((key) => { delete sh[key]; });
        if (op.on) Object.assign(sh, everyone(D));
      } else if (op.on) sel.forEach((x) => { sh[x] = sh[x] || 1; });
      else sel.forEach((x) => { delete sh[x]; });
      if (!units && sharersOf(D, it.shares).length < 2) it.uneven = false;
      break;
    }

    case 'confirm': if (who) who.ok = op.sig; break;   // holds the share they agreed to; it lapses by itself if the share changes
    case 'lock': D.locked = op.on; break;
    case 'upi': D.upi = op.pa ? { pa: op.pa, pn: op.pn } : null; break;
  }
  return out;
}

/* ---------- checks for ops arriving from the network ---------- */
export const ID = /^[a-z0-9]{6,24}$/;
const str = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const money = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= 1e9 ? Math.round(n * 100) / 100 : null;
};
function cleanItem(i) {
  const name = str(i?.name, 80), total = money(i?.total);
  if (!i || !ID.test(i.id) || !name || total == null) return null;
  const qty = Number(i.qty) > 0 && Number(i.qty) <= 1e6 ? Number(i.qty) : 1;
  return { id: i.id, name, qty, unit: money(i.unit), total, flag: !!i.flag };
}
const cleanShares = (sh) => {
  const o = {};
  if (sh && typeof sh === 'object') for (const [k, v] of Object.entries(sh).slice(0, 60)) if (ID.test(k) && v > 0) o[k] = Math.min(99, Math.floor(v)) || 1;
  return o;
};
const ids = (a) => (Array.isArray(a) ? a.filter((x) => ID.test(x)).slice(0, 60) : []);

/* A whole bill, as sent when the host first shares it. */
export function cleanDoc(d) {
  if (!d || !Array.isArray(d.items) || !Array.isArray(d.people)) return null;
  const items = d.items.slice(0, 300).map((i) => {
    const it = cleanItem(i);
    if (!it) return null;
    it.shares = cleanShares(i.shares);
    if (Array.isArray(i.parts) && canCount(it) && i.parts.length === it.qty) it.parts = i.parts.map(cleanShares);
    for (const f of ['uneven', 'whole', 'auto']) if (i[f]) it[f] = true;
    return it;
  }).filter(Boolean);
  const people = d.people.slice(0, 40)
    .map((p) => (p && ID.test(p.id) && str(p.name, 24) ? { id: p.id, name: str(p.name, 24), color: COLORS.includes(p.color) ? p.color : COLORS[0] } : null))
    .filter(Boolean);
  const host = people.some((p) => p.id === d.host) ? d.host : null;
  const upi = d.upi && VPA.test(d.upi.pa) ? { pa: d.upi.pa, pn: str(d.upi.pn, 40) } : null;
  return { items, people, total: money(d.total) > 0 ? money(d.total) : null, cur: CURS.includes(d.cur) ? d.cur : '', note: d.note ? str(d.note, 300) : null, locked: false, host, upi };
}

/* One op: returns a copy holding only the fields apply() reads, or null if it is not usable. */
export function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(raw.o)) return null;
  const o = { o: raw.o, t: raw.t }, id = ID.test(raw.id) ? raw.id : null, p = ID.test(raw.p) ? raw.p : null;
  switch (raw.t) {
    case 'items-add': {
      const items = Array.isArray(raw.items) ? raw.items.slice(0, 100).map(cleanItem).filter(Boolean) : [];
      if (!items.length) return null;
      Object.assign(o, { items, cur: CURS.includes(raw.cur) ? raw.cur : null, total: money(raw.total) });
      if ('note' in raw) o.note = raw.note ? str(raw.note, 300) : null;
      return o;
    }
    case 'item-set': {
      const d = cleanItem({ ...raw.data, id });
      return d ? { ...o, id, data: { name: d.name, qty: d.qty, unit: d.unit, total: d.total } } : null;
    }
    case 'item-del': case 'by-unit': return id ? { ...o, id } : null;
    case 'total': return { ...o, v: money(raw.v) > 0 ? money(raw.v) : null };
    case 'cur': return CURS.includes(raw.v) ? { ...o, v: raw.v } : null;
    case 'note': case 'rest-all': case 'all-equal': return o;
    case 'join': case 'person-add': case 'person-name': { const name = str(raw.name, 24); return p && name ? { ...o, p, name } : null; }
    case 'person-del': return p ? { ...o, p } : null;
    case 'whole': return id ? { ...o, id, add: ids(raw.add) } : null;
    case 'uneven': return id ? { ...o, id, on: !!raw.on } : null;
    case 'weight': return id && p ? { ...o, id, p, d: raw.d > 0 ? 1 : -1 } : null;
    case 'pick': {
      const sel = ids(raw.sel), k = Number.isInteger(raw.k) && raw.k >= 0 && raw.k < 24 ? raw.k : null;
      return id && sel.length ? { ...o, id, k, sel, all: !!raw.all, on: !!raw.on, free: !!raw.free } : null;
    }
    case 'confirm': return p && /^-?\d{1,12}:-?\d{1,12}$/.test(raw.sig) ? { ...o, p, sig: raw.sig } : null;
    case 'lock': return { ...o, on: !!raw.on };
    case 'upi': {                               // no UPI ID clears it
      if (!raw.pa) return o;
      return VPA.test(raw.pa) ? { ...o, pa: raw.pa, pn: str(raw.pn, 40) } : null;
    }
  }
  return null;
}

/* The host may do anything. Everyone else may join, and change only picks they are part of, their name and their confirmation. */
export function allowed(op, { host, me }) {
  if (host) return true;
  if (op.t === 'join') return true;
  if (!me) return false;
  if (op.t === 'pick') return !op.all && op.sel.includes(me);        // their own pick, or one they share with others
  return (op.t === 'confirm' || op.t === 'person-name') && op.p === me;
}
