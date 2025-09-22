// service-worker.js

self.addEventListener('install', (event) => {
  // Fuerza al service worker en espera a convertirse en el activo.
  self.skipWaiting();
  console.log('Service Worker: Instalado');
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activado');
  // Toma el control de las páginas abiertas inmediatamente en lugar de esperar una recarga.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Estrategia "Network First": Intenta obtener el recurso de la red.
  // Si falla (por ejemplo, sin conexión), no hace nada más.
  // Esto es suficiente para que la app sea instalable.
  event.respondWith(fetch(event.request));
});

// Evento para manejar el clic en la notificación
self.addEventListener('notificationclick', (event) => {
  event.notification.close(); // Cierra la notificación

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Si ya hay una ventana de la app abierta, la enfoca
      if (clientList.length > 0) {
        let client = clientList[0];
        for (let i = 0; i < clientList.length; i++) {
          if (clientList[i].focused) {
            client = clientList[i];
          }
        }
        return client.focus();
      }
      // Si no hay ninguna ventana abierta, abre una nueva
      return clients.openWindow('/');
    })
  );
});