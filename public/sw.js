/* eslint-disable no-restricted-globals */
// Use importScripts instead of ES imports for better PWA compatibility on some iOS versions
importScripts('https://storage.googleapis.com/workbox-cdn/releases/6.4.1/workbox-sw.js');

if (workbox) {
    console.log('[Service Worker] Workbox is loaded');
    workbox.precaching.precacheAndRoute(self.__WB_MANIFEST || []);
}

const CACHE_NAME = 'alphatrade-v6-build';
const RUNTIME_CACHE = 'alphatrade-runtime';

// Install event - skip waiting immediately
self.addEventListener('install', (event) => {
    console.log('[Service Worker] Installing...');
    self.skipWaiting();
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
// Push notification handler - THE CRITICAL PART FOR BACKGROUND ALERTS
self.addEventListener('push', (event) => {
    console.log('[Service Worker] Push Received.');
    let data = {};
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data = { title: 'Alpha Trade', body: event.data.text() };
        }
    }

    const title = data.title || 'Alpha Trade';
    // Use unique tag per alert type so different notifications don't overwrite each other
    const tag = data.tag || 'alpha-generic';
    const options = {
        body: data.body || 'Máte novou notifikaci',
        icon: '/logos/at_logo_light_clean.png',
        badge: '/logos/at_logo_light_clean.png',
        vibrate: [200, 100, 200],
        data: data.url || '/',
        tag: tag,
        renotify: true // vibrate again even if same tag replaces existing notification
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
