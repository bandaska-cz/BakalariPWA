/* ==========================================================================
   ŠKOLNÍ PARŤÁK (BAKALÁŘI PWA) - SERVICE WORKER
   Offline caching & Persistent Notification Confirmation Handler
   ========================================================================== */

const CACHE_NAME = 'skolni-partak-pwa-v7';
const STATIC_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/bakalari-api.js',
  './js/notifications.js',
  './js/app.js',
  './manifest.json',
  './icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Do not cache API calls directly in static cache (handled by app localStorage cache)
  if (request.url.includes('/api/3/')) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

// Listen for messages from the main thread to trigger persistent notifications
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SHOW_PERSISTENT_NOTIFICATION') {
    const { title, body, tag, alertType, dateKey } = event.data.payload;
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon: './icons/icon.svg',
        badge: './icons/icon.svg',
        tag: tag || `skolni-partak-${alertType}-${dateKey}`,
        requireInteraction: true, // Stays on screen until manually confirmed/interacted
        renotify: true,
        vibrate: [250, 120, 250, 120, 400],
        data: { alertType, dateKey },
        actions: [
          {
            action: 'open-and-confirm',
            title: '✋ Otevřít a ručně potvrdit'
          }
        ]
      })
    );
  }
});

// Handle user clicking on the notification or its action button
self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const data = notification.data || {};
  notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus existing window if open and tell it to display the mandatory confirmation dialog
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({
            type: 'OPEN_CONFIRMATION_MODAL',
            alertType: data.alertType,
            dateKey: data.dateKey
          });
          return;
        }
      }
      // Otherwise open a new window with query param to trigger confirmation modal immediately
      if (self.clients.openWindow) {
        const targetUrl = `./index.html?confirm=${encodeURIComponent(data.alertType || 'morning')}`;
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

