// Keeps the installed page working without the internet: its own files are saved when first fetched
// and refreshed whenever the network answers. Map pictures and place look-ups are left to the network.
const CACHE = 'family-graph-1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (evt) => evt.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (evt) => {
  const { request } = evt;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  evt.respondWith(caches.open(CACHE).then(async (cache) => {
    try {
      const fresh = await fetch(request);
      if (fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    } catch {
      return (await cache.match(request, { ignoreSearch: true })) ?? Response.error();
    }
  }));
});
