/* POST /api/scan  { image: "data:image/jpeg;base64,...", tier?: "cheap" | "strong" }
   Holds the OpenRouter key server-side, reads the bill, and reports whether the numbers add up.

   The response is a stream of JSON lines (NDJSON), so the app can show items as they are read:
     {"type":"item","index":0,"item":{name,qty,unit,total}}   one per item, as soon as the model writes it (tier calls only)
     {"type":"result", verified, items, total, issues, ...}  the checked, final reading
     {"type":"error","error":"...","message":"..."}          a failure after the stream started (HTTP status is already 200)
   Blank lines are keepalives, sent every 10 s so a slow model never leaves the connection idle.

   `tier` runs exactly one model (cheap or strong). The app uses it to make one request per model.
   Without `tier`, both models are tried in turn, and one request can then last twice as long. */
import { extract, single, DEFAULT_TIMEOUT } from '../../lib/extract.js';

const MAX_BODY = 4_500_000;      // characters of JSON (about 3 MB of image)
const PER_MINUTE = 8;            // scans per IP per minute
const HEARTBEAT_MS = 10_000;

// Best-effort limiter: it lives in one worker instance's memory, so it slows casual abuse only.
// For a hard limit, add a Cloudflare rate-limiting rule on /api/scan in the dashboard.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  if (hits.size > 5000) hits.clear();
  hits.set(ip, recent);
  return recent.length > PER_MINUTE;
}

const STREAM_HEADERS = { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (status, error, message) => json({ error, message }, status);

export async function onRequestPost({ request, env, waitUntil }) {
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return fail(403, 'forbidden', 'Wrong origin.');
  if (!env.OPENROUTER_API_KEY) return fail(500, 'not_configured', 'Scanning is not set up yet (missing OPENROUTER_API_KEY).');
  if (limited(request.headers.get('CF-Connecting-IP') || 'local')) return fail(429, 'rate_limited', 'Too many scans. Try again in a minute.');

  const text = await request.text();
  if (text.length > MAX_BODY) return fail(413, 'too_large', 'That image is too large.');
  let image, tier;
  try { ({ image, tier } = JSON.parse(text)); } catch {}
  if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
    return fail(400, 'bad_image', 'Send a JPEG, PNG or WebP image.');
  }
  if (tier !== undefined && tier !== 'cheap' && tier !== 'strong') return fail(400, 'bad_tier', 'Unknown tier.');

  const timeoutMs = Number(env.MODEL_TIMEOUT_MS) > 0 ? Number(env.MODEL_TIMEOUT_MS) : DEFAULT_TIMEOUT;
  const cfg = { apiKey: env.OPENROUTER_API_KEY, image, baseUrl: env.OPENROUTER_BASE_URL || undefined, timeoutMs };

  const cheapReasoning = env.CHEAP_REASONING || 'off', strongReasoning = env.STRONG_REASONING || 'low';

  async function run(onItem) {
    let r;
    try {
      r = tier
        ? await single({ ...cfg, model: tier === 'cheap' ? env.CHEAP_MODEL : env.STRONG_MODEL, reasoning: tier === 'cheap' ? cheapReasoning : strongReasoning, onItem })
        : await extract({ ...cfg, cheap: env.CHEAP_MODEL, strong: env.STRONG_MODEL, cheapReasoning, strongReasoning });
    } catch (e) {
      console.error('scan failed:', e.message);
      const slow = e.name === 'TimeoutError' || e.name === 'AbortError';
      return slow
        ? { error: 'model_timeout', message: 'The bill reader took too long. Try again.' }
        : { error: 'model_failed', message: 'The bill reader is not responding. Try again.' };
    }
    if (r.notBill) return { error: 'not_bill', message: "That doesn't look like a bill." };
    const b = r.bill;
    return {
      verified: r.ok,
      escalated: !!r.escalated,
      tier: tier || null,
      model: r.model,
      currency: b.currency,
      items: b.items.map((it, i) => ({
        name: it.name, qty: it.qty, unit: it.unit_price, total: it.line_total, flag: r.flagged.includes(i),
      })),
      total: b.total,
      issues: r.issues.map((x) => x.msg),
    };
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (obj) => writer.write(enc.encode(JSON.stringify(obj) + '\n')).catch(() => {});
  const work = (async () => {
    const beat = setInterval(() => writer.write(enc.encode('\n')).catch(() => {}), HEARTBEAT_MS);
    let out;
    try {
      out = await run((it, index) => send({ type: 'item', index, item: { name: it.name, qty: it.qty, unit: it.unit_price, total: it.line_total } }));
    } catch (e) { out = { error: 'model_failed', message: 'Something went wrong. Try again.' }; }
    clearInterval(beat);
    await send({ type: out.error ? 'error' : 'result', ...out });
    try { await writer.close(); } catch {}
  })();
  if (waitUntil) waitUntil(work);
  return new Response(readable, { status: 200, headers: STREAM_HEADERS });
}
