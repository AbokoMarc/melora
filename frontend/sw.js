const CACHE = 'melora-shell-v7';
const SHELL = [
  '/app.html', '/login.html', '/config.js', '/assets/js/idb-lite.js', '/assets/js/install-prompt.js',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png',
  '/apple-touch-icon.png', '/apple-touch-icon-152.png', '/apple-touch-icon-167.png',
];

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

// Cache-first pour le shell (ouverture instantanée hors ligne) ; jamais pour /api/ (network-first
// implicite : on ne met rien en cache côté SW pour l'API — la couche offline se fait via IndexedDB
// dans app.html, qui sait fusionner proprement les données, ce qu'un simple cache HTTP ne sait pas faire).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  // Les requêtes de navigation arrivent ici avec request.redirect = 'manual' (comportement
  // imposé par le navigateur, pas un choix de ce code) : si le serveur répond par une
  // redirection (fréquent sur Vercel), le fetch renvoie une réponse "opaqueredirect" que le
  // navigateur refuse d'utiliser pour afficher une page -> "a redirected response was used
  // for a request whose redirect mode is not follow". On reconstruit donc la requête avec
  // redirect: 'follow' explicite avant de la relayer.
  const fetchRequest = new Request(event.request, { redirect: 'follow' });
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(fetchRequest).then(res => {
      // Met aussi en cache les pages/assets rencontrés en navigation (ex: icônes ajoutées plus tard).
      if (res.ok && event.request.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(event.request, clone));
      }
      return res;
    }).catch(() => cached))
  );
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Melora', body: 'Nouveau message' };
  if ('setAppBadge' in self.navigator && typeof data.count === 'number') {
    self.navigator.setAppBadge(data.count).catch(() => {});
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Melora', {
      body: data.body,
      icon: data.icon || '/icon-192.png',
      badge: data.badge || '/icon-192.png',
      data: { url: data.url || '/app.html' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/app.html';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Réutilise un onglet déjà ouvert plutôt que d'en empiler un nouveau, et le fait naviguer
    // vers la bonne conversation (le clic sur une notif doit ouvrir CETTE conversation, pas l'accueil).
    for (const client of allClients) {
      if ('focus' in client) {
        client.postMessage({ type: 'navigate', url: targetUrl });
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl);
  })());
});
