// Notifications only: no caching, no offline mode. The page always asks the remote for the truth.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let n = { title: 'A builder is waiting', body: '', tag: 'village' };
  try {
    n = { ...n, ...e.data.json() };
  } catch {
    // a push with no readable payload still says something
  }
  // one notification per builder: a newer wait replaces the older one
  e.waitUntil(self.registration.showNotification(n.title, { body: n.body, tag: n.tag, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png' }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((open) => {
      for (const c of open) if ('focus' in c) return c.focus();
      return self.clients.openWindow('/');
    }),
  );
});
