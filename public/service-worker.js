const CACHE_NAME = 'alphatrade-v3-build';
const RUNTIME_CACHE = 'alphatrade-runtime';

// Assets to cache immediately on install
const PRECACHE_ASSETS = [
    '/',
    '/index.html',
    '/index.css',
    '/logos/at_logo_light_clean.png',
    '/manifest.json'
    // Note: Build assets (JS/CSS) will be cached dynamically via Runtime Cache
];

// Install event - precache core assets
self.addEventListener('install', (event) => {
    console.log('[Service Worker] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[Service Worker] Precaching app shell');
                return cache.addAll(PRECACHE_ASSETS);
            })
            .then(() => self.skipWaiting())
    );
});

// Activate event - cleanup old caches
self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activating...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME && name !== RUNTIME_CACHE)
                    .map((name) => {
                        console.log('[Service Worker] Deleting old cache:', name);
                        return caches.delete(name);
                    })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch event - smart caching strategy
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Skip Supabase API calls (always fetch fresh)
    if (url.hostname.includes('supabase.co')) {
        return;
    }

    // Skip external domains except CDN libraries
    const isCDN = url.hostname.includes('aistudiocdn.com') ||
        url.hostname.includes('googleapis.com') ||
        url.hostname.includes('gstatic.com') ||
        url.hostname.includes('cdn.tailwindcss.com');

    if (url.origin !== self.location.origin && !isCDN) {
        return;
    }

    // Strategy: Cache First for static assets, Network First for API
    if (
        request.destination === 'image' ||
        request.destination === 'font' ||
        request.destination === 'style' ||
        request.destination === 'script' ||
        url.pathname.endsWith('.png') ||
        url.pathname.endsWith('.jpg') ||
        url.pathname.endsWith('.svg') ||
        url.pathname.endsWith('.woff2') ||
        url.pathname.includes('/logos/') ||
        isCDN
    ) {
        // Cache First strategy for static assets
        event.respondWith(
            caches.match(request).then((cachedResponse) => {
                if (cachedResponse) {
                    return cachedResponse;
                }
                return caches.open(RUNTIME_CACHE).then((cache) => {
                    return fetch(request).then((response) => {
                        if (response.status === 200) {
                            cache.put(request, response.clone());
                        }
                        return response;
                    });
                });
            }).catch(() => {
                // Fallback for offline image
                if (request.destination === 'image') {
                    return caches.match('/logos/at_logo_light_clean.png');
                }
            })
        );
    } else {
        // Network First strategy for HTML/API
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 200) {
                        const responseClone = response.clone();
                        caches.open(RUNTIME_CACHE).then((cache) => {
                            cache.put(request, responseClone);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // Fallback to cache if offline
                    return caches.match(request).then((cachedResponse) => {
                        if (cachedResponse) {
                            return cachedResponse;
                        }
                        // Fallback to index.html for navigation requests
                        if (request.mode === 'navigate') {
                            return caches.match('/');
                        }
                    });
                })
        );
    }
});

// Background sync for offline trade submissions (future feature)
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-trades') {
        console.log('[Service Worker] Background sync: trades');
        event.waitUntil(syncTrades());
    }
});

async function syncTrades() {
    // TODO: Implement background sync logic
    // Fetch pending trades from IndexedDB and POST to Supabase
    console.log('[Service Worker] Syncing trades...');
}

// Push notification handler (future feature)
self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'Alpha Trade';
    const options = {
        body: data.body || 'You have a new notification',
        icon: '/logos/at_logo_light_clean.png',
        badge: '/logos/at_logo_light_clean.png',
        vibrate: [200, 100, 200],
        data: data.url || '/'
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data)
    );
});
