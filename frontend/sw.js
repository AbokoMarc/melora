const CACHE = 'melora-shell-v1';
const SHELL = ['/app.html', '/login.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Réseau d'abord pour l'API (toujours frais), cache pour le reste du shell.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // jamais mis en cache
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// Branché en phase suivante avec lib/push.js (VAPID) côté serveur.
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Melora', body: 'Nouveau message' };
  event.waitUntil(
    self.registration.showNotification(data.title || 'Melora', {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/app.html' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || '/app.html'));
});
