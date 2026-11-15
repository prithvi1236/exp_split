const CACHE = 'splitbill-v14';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'ocr.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const OCR_FILES = ['tess/tesseract.min.js', 'tess/worker.min.js', 'tess/tesseract-core-lstm.wasm.js', 'tess/tesseract-core-simd-lstm.wasm.js', 'tess/eng.traineddata.gz'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => {
    // The OCR files are large: fetch them in the background so a slow connection never blocks the install.
    OCR_FILES.forEach((f) => c.add(f).catch(() => {}));
    return c.addAll(SHELL);
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;
  const sameOrigin = new URL(req.url).origin === location.origin;
  const put = (res) => {
    if (res && (res.ok || res.type === 'opaque')) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  };
  // Big OCR files never change: serve from cache first.
  if (sameOrigin && new URL(req.url).pathname.includes('/tess/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(put)));
    return;
  }
  if (!sameOrigin || new URL(req.url).pathname.includes('/api/')) return;
  // App files: fresh when online, cached when offline.
  e.respondWith(fetch(req).then(put).catch(() => caches.match(req, { ignoreSearch: true })));
});
