/* POST /api/room  { doc }  →  { id, key, ver, doc }
   The host shares a bill: it is stored, and the answer holds the invite code (`id`) and the host's key. */
import { createRoom, guard, fail } from '../../../lib/rooms.js';

export async function onRequestPost({ request, env, waitUntil }) {
  try { return guard(request, env) || await createRoom(request, env, waitUntil); }
  catch (e) { console.error('room create failed:', e.message); return fail(500, 'failed', 'Could not share the bill. Try again.'); }
}
