/* Shared bills ("rooms"), kept in D1. One row per bill:
     id       the code in the invite link; knowing it lets you open the bill
     host     the host's secret key; only the host's phone has it
     ver      goes up by one on every change
     doc      the bill as JSON (see public/core.js)
     members  { device token: person id } — which person each phone joined as
     seen     ids of the last ops applied, so a retried request is never applied twice

   Concurrency: a write reads the row, applies the ops, and saves only if `ver` is still the one
   it read (UPDATE ... WHERE ver = ?). If someone else got in first, it reads again and re-applies.
   Ops are small intents, so nobody's change is ever overwritten by somebody else's copy of the bill. */
import { apply, sanitize, allowed, cleanDoc } from '../public/core.js';

const MAX_DOC = 200_000;         // characters of JSON
const KEEP_DAYS = 30;
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
export const fail = (status, error, message) => json({ error, message }, status);

let ready = null;
async function db(env) {
  if (!env.DB) return null;
  ready ||= env.DB.prepare(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, host TEXT NOT NULL, ver INTEGER NOT NULL, doc TEXT NOT NULL,
    members TEXT NOT NULL, seen TEXT NOT NULL, at INTEGER NOT NULL)`).run();
  try { await ready; } catch (e) { ready = null; throw e; }
  return env.DB;
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const code = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => ALPHABET[b % ALPHABET.length]).join('');

export function guard(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return fail(403, 'forbidden', 'Wrong origin.');
  if (!env.DB) return fail(500, 'not_configured', 'Sharing is not set up yet (missing D1 binding "DB").');
  return null;
}

async function body(request) {
  const text = await request.text();
  if (text.length > MAX_DOC * 2) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function createRoom(request, env, waitUntil) {
  const DB = await db(env);
  const doc = cleanDoc((await body(request))?.doc);
  if (!doc || !doc.items.length) return fail(400, 'bad_bill', 'Add at least one item before sharing.');
  const text = JSON.stringify(doc);
  if (text.length > MAX_DOC) return fail(413, 'too_large', 'That bill is too large to share.');
  const id = code(10), key = code(24), now = Date.now();
  await DB.prepare('INSERT INTO rooms (id, host, ver, doc, members, seen, at) VALUES (?, ?, 1, ?, ?, ?, ?)')
    .bind(id, key, text, '{}', '[]', now).run();
  const sweep = DB.prepare('DELETE FROM rooms WHERE at < ?').bind(now - KEEP_DAYS * 86_400_000).run().catch(() => {});
  if (waitUntil) waitUntil(sweep);
  return json({ id, key, ver: 1, doc });
}

/* GET ?v=<ver the phone has>: 204 when nothing changed, else the bill. */
export async function readRoom(request, env, id) {
  const DB = await db(env);
  const row = await DB.prepare('SELECT ver, doc FROM rooms WHERE id = ?').bind(id).first();
  if (!row) return fail(404, 'gone', 'This bill is no longer available.');
  if (String(row.ver) === new URL(request.url).searchParams.get('v')) return new Response(null, { status: 204, headers: HEADERS });
  return json({ ver: row.ver, doc: JSON.parse(row.doc) });
}

/* POST { ops, token, key? }: applies the ops and answers with the bill as it now stands. */
export async function writeRoom(request, env, id) {
  const DB = await db(env);
  const req = await body(request);
  if (!req || !Array.isArray(req.ops)) return fail(400, 'bad_request', 'Bad request.');
  const token = typeof req.token === 'string' && req.token.length >= 16 && req.token.length <= 64 ? req.token : null;
  const ops = req.ops.slice(0, 200).map(sanitize).filter(Boolean);

  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await DB.prepare('SELECT ver, host, doc, members, seen FROM rooms WHERE id = ?').bind(id).first();
    if (!row) return fail(404, 'gone', 'This bill is no longer available.');
    const doc = JSON.parse(row.doc), members = JSON.parse(row.members), seen = JSON.parse(row.seen);
    const host = typeof req.key === 'string' && req.key === row.host;
    const missed = [];
    let changed = false;
    for (const op of ops) {
      if (seen.includes(op.o)) continue;                 // a retry of something already applied
      const me = token && doc.people.some((p) => p.id === members[token]) ? members[token] : null;
      if (!allowed(op, { host, me })) { missed.push({ o: op.o, why: 'denied' }); continue; }
      const out = apply(doc, op);
      if (out.me && token && !host) members[token] = out.me;
      if (out.miss) missed.push({ o: op.o, why: out.miss });
      seen.push(op.o);
      changed = true;
    }
    const me = token && doc.people.some((p) => p.id === members[token]) ? members[token] : null;
    if (!changed) return json({ ver: row.ver, doc, me, missed });
    const text = JSON.stringify(doc);
    if (text.length > MAX_DOC || doc.items.length > 300 || doc.people.length > 40) return fail(413, 'too_large', 'This bill is full.');
    const tokens = Object.keys(members);
    if (tokens.length > 200) delete members[tokens[0]];
    const res = await DB.prepare('UPDATE rooms SET ver = ver + 1, doc = ?, members = ?, seen = ?, at = ? WHERE id = ? AND ver = ?')
      .bind(text, JSON.stringify(members), JSON.stringify(seen.slice(-400)), Date.now(), id, row.ver).run();
    if (res.meta.changes) return json({ ver: row.ver + 1, doc, me, missed });
    // Someone else changed the bill between our read and our write: go round again on their version.
  }
  return fail(409, 'busy', 'The bill is busy. Try again.');
}
