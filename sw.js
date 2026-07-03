// Service Worker v1.1.210
// Intercepts every page navigation and fetches index.html fresh from the
// network (cache: 'no-store'), permanently bypassing WKWebView's HTTP cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request.url, { cache: 'no-store' })
        .catch(() => fetch(e.request))
    );
  }
});
