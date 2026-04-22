export const prerender = true;

const serviceWorkerSource = `
const CACHE_NAME = 'presence-tracker-pwa-v3';
const PWA_ROOT_PATH = new URL('./', self.location.href).pathname;
const withPwaRoot = (relativePath) => \`\${PWA_ROOT_PATH}\${relativePath.replace(/^\\/+/, '')}\`;
const FAVICON_PATH = new URL('../favicon.svg', self.location.href).pathname;
const STATIC_ASSETS = [
  PWA_ROOT_PATH,
  withPwaRoot('index.html'),
  withPwaRoot('manifest.json'),
  FAVICON_PATH,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames
        .filter((name) => name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') {
    return;
  }

  if (url.pathname.startsWith('/api/') || url.pathname.includes('/auth/')) {
    return;
  }

  if (STATIC_ASSETS.some((asset) => url.pathname === asset || url.pathname === asset.replace(/index\\.html$/, ''))) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          fetch(event.request)
            .then((networkResponse) => {
              if (networkResponse.ok) {
                caches.open(CACHE_NAME).then((cache) => {
                  cache.put(event.request, networkResponse);
                });
              }
            })
            .catch(() => {});

          return cachedResponse;
        }

        return fetch(event.request).then((networkResponse) => {
          if (networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
`;

export function GET() {
  return new Response(serviceWorkerSource, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
