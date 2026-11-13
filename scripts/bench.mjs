#!/usr/bin/env node
/* Compare vision models on your own bills.
   Put photos in samples/, then:  OPENROUTER_API_KEY=... node scripts/bench.mjs [model ...]
   (the key is also read from .dev.vars). A bill "passes" when its numbers add up. */
import { readdirSync, readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callModel, check } from '../lib/extract.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODELS = [
  "inclusionai/ling-3.0-flash-vl",
  "qwen/qwen3.8-flash",
  "google/gemini-3.1-flash-lite",
];
const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS;
const REASONING = process.env.REASONING || 'off'; // 'off' (fast) or 'low' / 'medium' / 'high'
const SIZE = Number(process.env.SIZE || 1600); // long side in px; try SIZE=1024 to see what smaller images cost you

let apiKey = process.env.OPENROUTER_API_KEY;
const vars = join(root, '.dev.vars');
if (!apiKey && existsSync(vars)) apiKey = readFileSync(vars, 'utf8').match(/^OPENROUTER_API_KEY=(.+)$/m)?.[1]?.trim();
if (!apiKey) { console.error('Set OPENROUTER_API_KEY (env or .dev.vars).'); process.exit(1); }

const files = readdirSync(join(root, 'samples')).filter((f) => /\.(jpe?g|png|webp|heic)$/i.test(f));
if (!files.length) { console.error('No images in samples/.'); process.exit(1); }

// Same downscale the app does, using macOS `sips`.
const tmp = mkdtempSync(join(tmpdir(), 'bills-'));
const images = files.map((f) => {
  const out = join(tmp, f.replace(/\.\w+$/, '') + '.jpg');
  execFileSync('sips', ['-Z', String(SIZE), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', join(root, 'samples', f), '--out', out], { stdio: 'ignore' });
  return { name: f, url: 'data:image/jpeg;base64,' + readFileSync(out).toString('base64') };
});

console.log(`${images.length} bills × ${models.length} models at ${SIZE}px, reasoning ${REASONING}\n`);
const rows = [];
for (const model of models) {
  let pass = 0, errors = 0, ms = 0, first = 0, cost = 0;
  const fails = [];
  for (const img of images) {
    try {
      const r = await callModel({ apiKey, model, image: img.url, reasoning: REASONING, onItem: () => {} }); // streamed, like the app
      ms += r.ms; first += r.firstItemMs ?? r.ms; cost += r.usage?.cost || 0;
      const c = check(r.bill);
      if (c.ok) pass++; else fails.push(`${img.name}: ${c.issues[0].msg}`);
    } catch (e) { errors++; fails.push(`${img.name}: ${e.message.slice(0, 90)}`); }
  }
  const done = images.length - errors;
  rows.push({ model, pass: `${pass}/${images.length}`, errors, 'first item s': done ? (first / done / 1000).toFixed(1) : '-', 'total s': done ? (ms / done / 1000).toFixed(1) : '-', '$/bill': done ? (cost / done).toFixed(5) : '-' });
  console.log(`${model}: ${pass}/${images.length} pass`);
  fails.forEach((f) => console.log('   ✗ ' + f));
}
console.log();
console.table(rows);
console.log('"pass" means the numbers add up, which is a strong sign but not proof: spot-check a few results against the paper bills.');
