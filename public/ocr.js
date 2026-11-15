/* Offline / fallback reading: Tesseract.js runs OCR in the browser, then a rough parser turns the text into items.
   Used when /api/scan is unreachable or fails. Loaded only when needed. Its files live in public/tess/ and the
   service worker downloads them in the background on the first online visit, so no earlier scan is needed. */
const BASE = new URL('tess/', document.baseURI).href;   // Tesseract.js, its wasm core and English data are served from the app itself

const loadScript = (src) => new Promise((ok, no) => {
  if (window.Tesseract) return ok();
  const s = document.createElement('script');
  s.src = src; s.crossOrigin = 'anonymous'; s.onload = ok; s.onerror = () => no(new Error('Could not load the offline reader'));
  document.head.append(s);
});

export async function ocrImage(image, onProgress) {
  await loadScript(BASE + 'tesseract.min.js');
  const worker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: BASE + 'worker.min.js', corePath: BASE, langPath: BASE,
    logger: (m) => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress); },
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' }); // one block: keeps name and price on a line
    const { data } = await worker.recognize(image);
    return data.text || '';
  } finally { await worker.terminate(); }
}

const NUM = /\d{1,3}(?:,\d{3})*\.\d{1,2}|\d+\.\d{1,2}/g;
const TOTAL = /\b(grand\s*total|total\s*(?:amount|due|payable)?|amount\s*(?:due|payable)|net\s*(?:amount|payable)|balance\s*due|bill\s*amount)\b/i;
const SUBTOTAL = /\b(sub\s*-?\s*total|items?\s*total)\b/i;
const DISCOUNT = /\b(discount|coupon|promo|offer|savings?)\b/i;
const CHARGE = /\b(tax|gst|cgst|sgst|igst|vat|service|s\.?charge|tip|gratuity|delivery|packing|packaging|round\s*-?\s*off|rounding|cess)\b/i;
const SKIP = /\b(invoice|bill\s*no|receipt|order|table|date|time|phone|tel|gstin|cashier|server|thank|visit|card|cash|change|paid|payment|upi|tendered|qty|rate|amount|item|description|particulars)\b/i;
const money = (s) => Number(s.replace(/,/g, ''));
const r2 = (n) => Math.round(n * 100) / 100;

/* Returns the same shape /api/scan sends: { items:[{name,qty,unit,total,flag}], total, currency, verified, issues }. */
export function parseBillText(text) {
  const items = [], charges = [], discounts = [];
  let subtotal = null, total = null;
  const currency = /[₹$€£]/.exec(text)?.[0] ?? null;

  for (let line of String(text).split(/\r?\n/)) {
    line = line.replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const nums = line.match(NUM);
    if (!nums) continue;
    const last = money(nums[nums.length - 1]);
    if (!(last > 0)) continue;
    const label = line.replace(/[₹$€£]/g, '').replace(NUM, '').replace(/[:=*#@]+/g, ' ').replace(/\s+/g, ' ').trim();

    if (SUBTOTAL.test(label)) subtotal = last;
    else if (DISCOUNT.test(label)) discounts.push(last);
    else if (CHARGE.test(label)) charges.push(last);
    else if (TOTAL.test(label)) total = last;
    else if (!SKIP.test(label)) {
      const q = /^(\d{1,2})\s*(?:x|X|×)?\s+(.*\S)$/.exec(label);   // "2 Burger 5.00 10.00": qty 2, unit 5, line 10
      const name = (q ? q[2] : label).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9)]+$/g, '').slice(0, 40);
      if (!/[A-Za-z]/.test(name)) continue;
      items.push({ name, qty: q ? Number(q[1]) : 1, unit: nums.length > 1 ? money(nums[nums.length - 2]) : null, total: last, flag: false });
    }
  }

  // The bill is its own checksum, same idea as the server check.
  const issues = [];
  items.forEach((it) => {
    if (it.unit != null && Math.abs(it.qty * it.unit - it.total) > 0.05) { it.flag = true; issues.push(`${it.name}: ${it.qty} × ${it.unit} does not equal ${it.total}.`); }
  });
  const sum = r2(items.reduce((a, i) => a + i.total, 0));
  if (subtotal != null && Math.abs(sum - subtotal) > 0.05) issues.push(`Items add up to ${sum}, but the bill's subtotal says ${subtotal}.`);
  const extras = r2(charges.reduce((a, c) => a + c, 0) - discounts.reduce((a, c) => a + c, 0));
  if (total == null) issues.push('The bill total could not be read.');
  else if (items.length && Math.abs(sum + extras - total) > 0.51 && Math.abs(sum - total) > 0.51) issues.push(`Items and charges add up to ${r2(sum + extras)}, but the bill total says ${total}.`);
  return { items, total, currency, verified: !issues.length && items.length > 0, issues, source: 'ocr' };
}
