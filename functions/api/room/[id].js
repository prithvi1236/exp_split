/* GET  /api/room/:id?v=<ver>         →  204 if the phone is up to date, else { ver, doc }
   POST /api/room/:id  { ops, token, key? }  →  { ver, doc, me, missed }
   See lib/rooms.js for how simultaneous changes are kept safe. */
import { readRoom, writeRoom, guard, fail } from '../../../lib/rooms.js';
import { ID } from '../../../public/core.js';

const run = (fn) => async ({ request, env, params }) => {
  try { return guard(request, env) || (ID.test(params.id) ? await fn(request, env, params.id) : fail(404, 'gone', 'This bill is no longer available.')); }
  catch (e) { console.error('room failed:', e.message); return fail(500, 'failed', 'Something went wrong. Try again.'); }
};
export const onRequestGet = run(readRoom);
export const onRequestPost = run(writeRoom);
