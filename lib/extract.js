/* Bill extraction: ask a vision model for structured JSON, then verify it with the bill's own arithmetic.
   Shared by the Pages Function (functions/api/scan.js) and the model test script (scripts/bench.mjs). */

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';
// Free vision models can take over two minutes, so the default is generous. Override with MODEL_TIMEOUT_MS.
export const DEFAULT_TIMEOUT = 170000;

const num = { type: 'number' };
const numOrNull = { type: ['number', 'null'] };
const named = (extra) => ({
  type: 'object', additionalProperties: false,
  required: ['name', ...Object.keys(extra)],
  properties: { name: { type: 'string' }, ...extra },
});

export const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['is_bill', 'currency', 'items', 'charges', 'discounts', 'subtotal', 'total'],
  properties: {
    is_bill: { type: 'boolean' },
    currency: { type: ['string', 'null'] },
    items: { type: 'array', items: named({ qty: num, unit_price: numOrNull, line_total: num }) },
    charges: { type: 'array', items: named({ amount: num }) },
    discounts: { type: 'array', items: named({ amount: num }) },
    subtotal: numOrNull,
    total: numOrNull,
  },
};

export const PROMPT = `You are reading a photo of a restaurant or shop bill. Return ONLY a JSON object, no prose, with this shape:
{
  "is_bill": boolean,            // false if the image is not a bill or receipt
  "currency": string | null,     // the currency symbol printed on the bill (e.g. "₹", "$"), else null
  "items": [ { "name": string, "qty": number, "unit_price": number | null, "line_total": number } ],
  "charges": [ { "name": string, "amount": number } ],     // tax, GST, VAT, service charge, tip, delivery, round-off: only amounts ADDED on top of item prices
  "discounts": [ { "name": string, "amount": number } ],   // amounts SUBTRACTED, as positive numbers
  "subtotal": number | null,     // as printed, before charges; null if not printed
  "total": number | null         // the final amount to pay, as printed; null if not printed
}
Rules:
- Copy every number exactly as printed. Never calculate, guess, or fix a number. If something is unreadable, use null.
- One entry per purchased line. "line_total" is the amount for the whole line (qty × unit price), not the unit price.
- "qty" defaults to 1 when not printed. Copy fractional quantities (e.g. 0.1 for goods sold by weight) as printed. "unit_price" is null when the bill shows only one price for the line.
- Taxes that are already included in the item prices are NOT charges; leave them out.
- Do not list payments, change, card details, table or invoice numbers as items.
- Keep item names short and as printed.
- Only transcribe. Do not try to reconcile the totals or explain anything; if the numbers on the bill disagree, copy them anyway.`;

const r2 = (n) => Math.round(n * 100) / 100;
const toNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const list = (v) => (Array.isArray(v) ? v : []);

/* One item, made safe. Returns null if it has no name or no price. */
export function normItem(i) {
  const it = {
    name: String(i?.name ?? '').trim().slice(0, 40),
    qty: toNum(i?.qty) > 0 ? toNum(i.qty) : 1, // can be fractional: weighed goods print 0.1, 0.25, ...
    unit_price: toNum(i?.unit_price),
    line_total: toNum(i?.line_total) ?? 0,
  };
  return it.name && it.line_total > 0 ? it : null;
}

/* Make whatever the model returned safe to work with. */
export function normalize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const amounts = (arr) => list(arr)
    .map((c) => ({ name: String(c?.name ?? '').slice(0, 40), amount: Math.abs(toNum(c?.amount) ?? 0) }))
    .filter((c) => c.amount > 0);
  return {
    is_bill: o.is_bill !== false,
    currency: typeof o.currency === 'string' ? o.currency.trim().slice(0, 3) : null,
    items: list(o.items).map(normItem).filter(Boolean),
    charges: amounts(o.charges),
    discounts: amounts(o.discounts),
    subtotal: toNum(o.subtotal),
    total: toNum(o.total),
  };
}

/* The bill is its own checksum. Returns which parts do not add up. */
export function check(b) {
  const issues = [];
  const flagged = [];
  if (!b.items.length) issues.push({ code: 'no_items', msg: 'No items could be read.' });

  b.items.forEach((it, i) => {
    if (it.unit_price != null && Math.abs(it.qty * it.unit_price - it.line_total) > 0.05) {
      flagged.push(i);
      issues.push({ code: 'item', index: i, msg: `${it.name}: ${it.qty} × ${it.unit_price} does not equal ${it.line_total}.` });
    }
  });

  const sum = r2(b.items.reduce((a, i) => a + i.line_total, 0));
  if (b.subtotal != null && Math.abs(sum - b.subtotal) > 0.05) {
    issues.push({ code: 'subtotal', msg: `Items add up to ${sum}, but the bill's subtotal says ${b.subtotal}.` });
  }

  const extras = r2(b.charges.reduce((a, c) => a + c.amount, 0) - b.discounts.reduce((a, c) => a + c.amount, 0));
  if (b.total == null) {
    issues.push({ code: 'no_total', msg: 'The bill total could not be read.' });
  } else if (b.items.length) {
    const tol = 0.51; // bills are often rounded to the nearest whole unit
    const withExtras = Math.abs(sum + extras - b.total) <= tol;
    const taxInclusive = Math.abs(sum - b.total) <= tol; // prices already include tax
    if (!withExtras && !taxInclusive) {
      issues.push({ code: 'total', msg: `Items and charges add up to ${r2(sum + extras)}, but the bill total says ${b.total}.` });
    }
  }
  return { ok: issues.length === 0, issues, flagged };
}

function parseJson(text) {
  const s = String(text ?? '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  if (a >= 0 && z > a) return JSON.parse(s.slice(a, z + 1));
  throw new Error('Model did not return JSON');
}

/* Feed it the answer text piece by piece; it calls onItem(rawItem) each time one object
   inside the "items" array is complete, long before the whole JSON has arrived. */
export function itemScanner(onItem) {
  let buf = '', pos = 0, inArr = false, done = false, depth = 0, inStr = false, esc = false, start = -1;
  return (chunk) => {
    if (done) return;
    buf += chunk;
    if (!inArr) {
      const m = /"items"\s*:\s*\[/.exec(buf);
      if (!m) return;
      pos = m.index + m[0].length; inArr = true;
    }
    for (; pos < buf.length; pos++) {
      const ch = buf[pos];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') { if (depth++ === 0) start = pos; }
      else if (ch === '}') {
        if (--depth === 0 && start >= 0) { try { onItem(JSON.parse(buf.slice(start, pos + 1))); } catch {} start = -1; }
      } else if (ch === ']' && depth === 0) { done = true; return; }
    }
  };
}

/* One model call. `image` is a data URL. Returns { bill, usage, ms, firstItemMs }.
   `reasoning` is 'off' (fast, default) or an effort level: 'low', 'medium', 'high'.
   With `onItem`, the answer is streamed and onItem(item, index) fires as each item is read. */
export async function callModel({ apiKey, model, image, baseUrl = DEFAULT_BASE, timeoutMs = DEFAULT_TIMEOUT, onItem, reasoning = 'off' }) {
  const t0 = Date.now();
  const stream = typeof onItem === 'function';
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Split the Bill' },
    body: JSON.stringify({
      model,
      stream,
      temperature: 0,
      // Thinking is the slow part: measured on one bill, 'off' gave the first item at 2 s (7 s total),
      // 'low' at 35 s (44 s total). So the first read runs with it off; the double-check turns it on.
      // Thinking counts against max_tokens (at 4000 one model thought the whole budget away), so leave room.
      max_tokens: 16000,
      reasoning: reasoning === 'off' ? { enabled: false } : { effort: reasoning },
      usage: { include: true },
      response_format: { type: 'json_schema', json_schema: { name: 'bill', strict: true, schema: SCHEMA } },
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: image } }] }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`OpenRouter ${res.status} for ${model}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  let content = '', usage = null, finish, firstItemMs = null;
  if (!stream) {
    const data = await res.json();
    if (data.error) throw new Error(`OpenRouter error for ${model}: ${data.error.message || 'unknown'}`);
    content = data.choices?.[0]?.message?.content ?? '';
    finish = data.choices?.[0]?.finish_reason;
    usage = data.usage || null;
  } else {
    let n = 0;
    const scan = itemScanner((raw) => {
      const it = normItem(raw);
      if (!it) return;
      if (firstItemMs == null) firstItemMs = Date.now() - t0;
      onItem(it, n++);
    });
    // Server-sent events: lines of `data: {json}`; comment lines (": OPENROUTER PROCESSING") are keepalives.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let sse = '';
    const handle = (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let ev;
      try { ev = JSON.parse(payload); } catch { return; }
      if (ev.error) throw new Error(`OpenRouter error for ${model}: ${ev.error.message || 'unknown'}`);
      const ch = ev.choices?.[0];
      const piece = ch?.delta?.content;
      if (piece) { content += piece; scan(piece); }
      if (ch?.finish_reason) finish = ch.finish_reason;
      if (ev.usage) usage = ev.usage;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      sse += dec.decode(value, { stream: true });
      let nl;
      while ((nl = sse.indexOf('\n')) >= 0) { const line = sse.slice(0, nl).trim(); sse = sse.slice(nl + 1); handle(line); }
    }
    handle(sse.trim());
  }

  if (!String(content).trim()) {
    throw new Error(finish === 'length'
      ? `${model} ran out of tokens before answering (it spent them all on reasoning)`
      : `${model} returned an empty answer (finish: ${finish ?? 'unknown'})`);
  }
  const bill = normalize(parseJson(content));
  return { bill, usage, ms: Date.now() - t0, firstItemMs };
}

/* Cheap model first; escalate to the strong model only if the numbers do not add up. */
export async function extract({ apiKey, image, cheap, strong, baseUrl, timeoutMs, cheapReasoning = 'off', strongReasoning = 'low' }) {
  const attempts = [];
  for (const model of [cheap, strong].filter((m, i, a) => m && a.indexOf(m) === i)) {
    try {
      const { bill } = await callModel({ apiKey, model, image, baseUrl, timeoutMs, reasoning: model === cheap ? cheapReasoning : strongReasoning });
      if (!bill.is_bill) return { notBill: true, model };
      const result = { model, bill, ...check(bill) };
      attempts.push(result);
      if (result.ok) break;
    } catch (error) {
      attempts.push({ model, error });
    }
  }
  const good = attempts.filter((a) => a.bill);
  if (!good.length) throw attempts[attempts.length - 1].error;
  // A passing attempt wins; otherwise the one with the fewest problems, preferring the later (stronger) model.
  const best = good.reduce((a, b) => (b.issues.length <= a.issues.length ? b : a));
  return { ...best, escalated: attempts.length > 1 };
}

/* Run exactly one model and check it. Lets the app make one request per model,
   so a slow model never keeps a single request open for several minutes. */
export async function single({ apiKey, image, model, baseUrl, timeoutMs, onItem, reasoning }) {
  const { bill } = await callModel({ apiKey, model, image, baseUrl, timeoutMs, onItem, reasoning });
  if (!bill.is_bill) return { notBill: true, model };
  return { model, bill, ...check(bill), escalated: false };
}
