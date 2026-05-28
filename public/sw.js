// TotoroTrader service worker — offline app shell + runtime caching.
// Vite fingerprints asset filenames at build time, so instead of a static
// precache list we cache hashed assets on first request (cache-first) and use
// network-first for navigations so a fresh build is picked up when online,
// with the cached shell as the offline fallback.

const VERSION = 'v1';
const SHELL_CACHE = `totoro-shell-${VERSION}`;
const ASSET_CACHE = `totoro-assets-${VERSION}`;

const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon.ico'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll is atomic; if one fails nothing is cached, so tolerate misses
      // (e.g. icons missing in dev) by adding individually and ignoring errors.
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // App navigations: network-first, fall back to the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('/', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match(request)) || (await cache.match('/')) || Response.error();
        }
      })()
    );
    return;
  }

  // Cross-origin (Google Fonts, etc.): stale-while-revalidate.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res && res.status === 200) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || (await network) || Response.error();
      })()
    );
    return;
  }

  // Same-origin static assets (hashed JS/CSS/images): cache-first.
  event.respondWith(
    (async () => {
      const cache = await caches.open(ASSET_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const res = await fetch(request);
        if (res && res.status === 200 && res.type === 'basic') {
          cache.put(request, res.clone());
        }
        return res;
      } catch {
        return Response.error();
      }
    })()
  );
});
