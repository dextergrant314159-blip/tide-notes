'use strict';
/** Offline cache for the Tide Notes shell. data.enc.json is fetched
 *  network-first and stored separately, still encrypted.
 */
const V = 'shell-v6';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(V)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) =>
        Promise.all(ks.filter((k) => k !== V && k !== 'data').map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.endsWith('/data.enc.json')) {
    // network first; fall back to the last copy (still encrypted) when offline
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then((r) => {
          if (r.ok) {
            const cp = r.clone();
            caches.open('data').then((c) => c.put('data.enc.json', cp));
          }
          return r;
        })
        .catch(() =>
          caches
            .open('data')
            .then((c) => c.match('data.enc.json'))
            .then((r) => r || Response.error()),
        ),
    );
    return;
  }
  // shell: network first so updates land, cache when offline
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((r) => {
        if (r.ok) {
          const cp = r.clone();
          caches.open(V).then((c) => c.put(e.request, cp));
        }
        return r;
      })
      .catch(() =>
        caches
          .match(e.request, { ignoreSearch: true })
          .then((r) => r || caches.match('index.html')),
      ),
  );
});
