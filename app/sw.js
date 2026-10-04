/* sw.js — offline-first service worker for Travel PWA.
   VERSION is rewritten by build.py on every build. */
const VERSION = '20261004-082101';
const SHELL_CACHE = 'shell-' + VERSION;
const DATA_CACHE = 'data-' + VERSION;
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'md.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL);
    const data = await caches.open(DATA_CACHE);
    // trips.json + attachments listed in precache.json (best-effort, don't fail install on one bad file)
    await data.add('data/trips.json').catch(() => { });
    try {
      const list = await (await fetch('precache.json', { cache: 'no-cache' })).json();
      await Promise.all(list.map(u => data.add(u).catch(() => { })));
    } catch (e) { }
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname;

  // data: network-first, fall back to cache (so edits show up when online, still work offline)
  if (path.endsWith('/data/trips.json') || path.endsWith('/data/version.json') || path.endsWith('/precache.json')) {
    e.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      try {
        const fresh = await fetch(req, { cache: 'no-cache' });
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        const hit = await cache.match(req);
        return hit || new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }
  // everything else (shell + attachments): cache-first, then network (and store)
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && (path.includes('/data/att/') )) {
        const cache = await caches.open(DATA_CACHE); cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      if (req.mode === 'navigate') return caches.match('index.html');
      throw err;
    }
  })());
});
