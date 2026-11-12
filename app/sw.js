// Bump VERSION whenever app files change so phones pick up the new build.
const VERSION = 'v15';
const CACHE = `race-timer-${VERSION}`;

// Must match clipKeys() in audio.js.
const CLIPS = ['go', 'final', 'min1', 'sec30', 'paused'];
for (let i = 1; i <= 20; i++) CLIPS.push(`n${i}`, `heat${i}`);
for (let i = 1; i <= 30; i++) CLIPS.push(`lap${i}`);

const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'audio.js', 'splash.js', 'store.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'sounds/airhorn.m4a',
  ...['liam', 'classic'].flatMap(set => CLIPS.map(k => `voice/${set}/${k}.m4a`))];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Network first (so updates show up when online), cache fallback (so it works at the field with no signal).
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
