# Split the Bill

A phone-first PWA: scan a bill, add people, tap who shared what, share the result.

- `public/` — the app (static files, no build step)
- `public/core.js` — the bill's maths and every change to it as a small op; runs in the app and on the server
- `functions/api/scan.js` — Cloudflare Pages Function that reads a bill photo through OpenRouter
- `functions/api/room/` and `lib/rooms.js` — shared bills, stored in D1
- `public/ocr.js` and `public/tess/` — Tesseract.js fallback: reads the bill on the phone when the scan service fails or there is no internet
- `lib/extract.js` — prompt, JSON schema, arithmetic checks, cheap → strong escalation
- `scripts/bench.mjs` — compares models on your own bills

## How scanning works

1. The phone shrinks the photo (1600 px long side, JPEG) and posts it to `/api/scan`.
2. The cheap model returns items, charges, discounts, subtotal and total as JSON.
3. The function checks the arithmetic (qty × unit price = line total, items = subtotal, items + charges − discounts = total).
4. If it adds up, done. If not, the strong model retries. If that still fails, the app shows the items with a warning and highlights the lines that don't add up.

**Feels fast.** Three things keep the wait short:

- *Thinking off for the first read.* On one test bill the same model gave its first item at 2 s (7 s total) with thinking off, against 35 s (44 s total) with it on. `CHEAP_REASONING` and `STRONG_REASONING` in `wrangler.toml` control this; the double-check keeps thinking on.
- *Streaming.* `/api/scan` returns JSON lines: an `item` event as each item is read, then a `result` with the checked reading. The app shows items as they arrive.
- *Background scan.* There is no wait screen. A status strip shows progress on every step, and the user can add people while the bill is read. Assigning items waits until reading is done.

**Slow models.** Free vision models have taken about 140 s. The app makes one request per model (`tier: "cheap"`, then `"strong"`), waits up to 200 s for each, and keeps the screen awake. The function waits up to `MODEL_TIMEOUT_MS` (default 170 s) per model and sends a blank line every 10 s so the connection never looks idle.

## Offline fallback (Tesseract.js)

If `/api/scan` fails (OpenRouter down, timeout, no key) or the phone is offline, the app reads the bill on the device with Tesseract.js and a rough line parser, then shows a note to check the result. It is less accurate than the vision model. Tesseract.js, its wasm core and the English data (about 10 MB) live in `public/tess/`; the service worker downloads them in the background on the first online visit, so offline use works without scanning a bill first. No server setup is needed.

## Shared bills

The host taps **Share** at the top of the Split step and sends the link. Everyone who opens it picks their name, taps what they had, and confirms their share. The host can still add people, pick for anyone, confirm for someone without a phone, and finalize. Until a bill is shared it stays on the host's phone.

**Roles.** The link (`?r=code`) lets anyone open the bill. The host's phone also holds a secret key, which is what allows editing items and finalizing. Each guest phone has its own token, tied to the person it joined as, and the server only lets it change that person's picks.

**Simultaneous changes.** Phones never send the bill, only small ops that say what the person meant: "put me on this item", "one more roti for me". The server reads the bill, applies the ops, and saves only if the version is still the one it read; if someone else saved first, it reads again and re-applies. So two taps at the same moment both land, and when two people go for the last free unit one gets it and the other is told it is taken.

- A phone applies its own op at once and shows the server's bill with its unsent ops on top, so taps feel instant and nothing jumps when the answer arrives.
- Each op has an id. A request retried after a dropped connection is not applied twice. Ops made offline are kept and sent later.
- Phones ask for changes every 2 seconds while the page is visible; an unchanged bill answers with an empty 204.
- A confirmation stores the share that was agreed to. If that person's items or the bill's tax change afterwards, it lapses and they are asked again.

## Paying back via UPI

On ₹ bills the host taps **Get paid back via UPI** on the Result step and enters their UPI ID once; it is kept on their phone for later bills. Everyone else then gets a **Pay ₹X via UPI** button (on a shared bill, once they confirm) that opens their UPI app with the host and their share filled in, so they only enter their PIN. Chat apps don't let `upi://` links be tapped, so the share text sent to each person links to `pay.html` instead, which opens the UPI app. On iPhones, which send `upi://` to a single app, it also offers GPay, PhonePe, super.money and BHIM directly. `public/upi.js` builds the links.

## Run locally

```bash
cp .dev.vars.example .dev.vars   # then put your OpenRouter key in it
npx wrangler pages dev --port 8788
```

Open http://localhost:8788.

## Pick models with your own bills

Put 10–15 bill photos in `samples/`, then:

```bash
node scripts/bench.mjs
```

It prints pass rate, time to first item, total time and cost per bill for each model. Add `REASONING=low` in front to compare with thinking on. Set the winners as `CHEAP_MODEL` and `STRONG_MODEL` in `wrangler.toml`.

## Deploy

```bash
npx wrangler d1 create split-the-bill   # once; paste the id it prints into wrangler.toml
npx wrangler pages deploy
npx wrangler pages secret put OPENROUTER_API_KEY
```

The built-in rate limit (8 scans a minute per IP) is best-effort. For a hard limit, add a rate-limiting rule for `/api/scan` in the Cloudflare dashboard, and set a spending cap on the OpenRouter key.
