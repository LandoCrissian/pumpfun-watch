// VERDICT Service Worker
// Fixed: only precache same-origin assets, runtime cache external

const CACHE_NAME = 'verdict-v2';
const OFFLINE_URL = '/';

// Only precache same-origin assets
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/analysis/analyze.js',
  '/analysis/modules/worthMyTime.js',
  '/analysis/modules/fakeMove.js',
  '/analysis/modules/tooLate.js',
  '/analysis/modules/deadVsSleeping.js',
  '/analysis/modules/holderPsychology.js',
  '/analysis/modules/rugNarrative.js',
  '/adapters/helius.js',
  '/adapters/dexscreener.js',
  '/adapters/pumpfun.js'
];

// External resources to cache on first fetch
const RUNTIME_CACHE_URLS = [
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// Install event - cache same-origin assets only
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        // Cache each asset individually, don't fail on errors
        return Promise.allSettled(
          PRECACHE_ASSETS.map(url => 
            cache.add(url).catch(err => {
              console.warn(`Failed to cache ${url}:`, err);
              return null;
            })
          )
        );
      })
      .then(() => {
        self.skipWaiting();
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name.startsWith('verdict-') && name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        );
      })
      .then(() => {
        self.clients.claim();
      })
  );
});

// Fetch event - network first with runtime caching for external resources
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Skip chrome extension requests
  if (event.request.url.startsWith('chrome-extension://')) {
    return;
  }

  const url = new URL(event.request.url);
  const isExternalCacheable = RUNTIME_CACHE_URLS.some(domain => url.hostname.includes(domain));
  const isSameOrigin = url.origin === self.location.origin;

  // Handle external cacheable resources (CDN, fonts)
  if (isExternalCacheable) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cachedResponse) => {
          const fetchPromise = fetch(event.request)
            .then((networkResponse) => {
              // Cache the new response
              if (networkResponse.ok) {
                cache.put(event.request, networkResponse.clone());
              }
              return networkResponse;
            })
            .catch(() => {
              // Network failed, return cached if available
              return cachedResponse;
            });
          
          // Return cached immediately if available, otherwise wait for network
          return cachedResponse || fetchPromise;
        });
      })
    );
    return;
  }

  // Handle same-origin requests - network first
  if (isSameOrigin) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Clone and cache successful responses
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Network failed, try cache
          return caches.match(event.request)
            .then((cachedResponse) => {
              if (cachedResponse) {
                return cachedResponse;
              }
              
              // If it's a navigation request, return the offline page
              if (event.request.mode === 'navigate') {
                return caches.match(OFFLINE_URL);
              }
              
              // Return offline response
              return new Response('Offline', {
                status: 503,
                statusText: 'Service Unavailable',
                headers: new Headers({
                  'Content-Type': 'text/plain'
                })
              });
            });
        })
    );
    return;
  }

  // For other external requests, just fetch (don't cache)
  event.respondWith(fetch(event.request));
});

// Handle messages from the client
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
