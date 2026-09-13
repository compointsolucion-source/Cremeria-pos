// Service Worker de Cremería POS — guarda copia de Mostrador, Caja y Caja
// Avanzada para que abran incluso sin internet. Las llamadas a la API
// NUNCA se interceptan aquí (siempre van a la red) — la sincronización de
// datos offline se maneja en las tandas siguientes, no en este archivo.
//
// Estrategia "red primero": mientras haya internet, siempre se sirve la
// versión más nueva (y se actualiza la copia de respaldo de paso) — la
// copia guardada solo se usa cuando de verdad no hay conexión. Esto evita
// quedarse con una versión vieja por olvidar subir CACHE_VERSION.
const CACHE_VERSION = 'cremeria-pos-v3';

const ARCHIVOS_A_GUARDAR = [
  '/mostrador.html',
  '/caja.html',
  '/caja-avanzada.html',
  '/css/app-theme.css',
  '/js/api.js',
  '/js/estado-conexion.js',
  '/js/ui-components.js',
  '/js/tema.js',
  '/js/lector-fisico.js',
  '/js/impresora-termica.js',
  '/js/offline-db.js',
  '/js/mostrador.js',
  '/js/caja.js'
];

self.addEventListener('install', (evento) => {
  // No espera a que se cierren las pestañas viejas para activarse — así
  // una actualización se aplica lo antes posible.
  self.skipWaiting();
  evento.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ARCHIVOS_A_GUARDAR))
  );
});

self.addEventListener('activate', (evento) => {
  // Borra copias de versiones anteriores para no acumular archivos viejos
  // ni arriesgarse a servir algo desactualizado por error.
  evento.waitUntil(
    caches.keys()
      .then((nombresGuardados) =>
        Promise.all(nombresGuardados.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evento) => {
  const url = new URL(evento.request.url);

  // Las llamadas a la API (nuestro backend) siempre van directo a la red.
  // Nunca se cachean aquí — evita servir datos de ventas/inventario
  // desactualizados sin que la app se dé cuenta.
  if (url.pathname.startsWith('/api/')) return;

  // Solo nos interesa cachear archivos de nuestro propio sitio (no CDNs
  // externos como jsQR o JsBarcode — esos se piden normal a la red).
  if (url.origin !== self.location.origin) return;

  // "Red primero, copia guardada como respaldo": mientras haya internet,
  // SIEMPRE se usa la versión más nueva del servidor (y de paso se
  // actualiza la copia guardada) — la copia solo se usa cuando de verdad
  // no hay conexión. Esto evita quedarse pegado en una versión vieja por
  // olvidar subir CACHE_VERSION en alguna actualización futura.
  evento.respondWith(
    fetch(evento.request)
      .then((respuestaDeRed) => {
        const copia = respuestaDeRed.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(evento.request, copia));
        return respuestaDeRed;
      })
      .catch(() => caches.match(evento.request))
  );
});
