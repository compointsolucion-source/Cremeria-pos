// Service Worker de Cremería POS — guarda copia de Mostrador, Caja y Caja
// Avanzada para que abran incluso sin internet. Las llamadas a la API
// NUNCA se interceptan aquí (siempre van a la red) — la sincronización de
// datos offline se maneja en las tandas siguientes, no en este archivo.
//
// IMPORTANTE PARA MANTENIMIENTO: cada vez que se modifique alguno de los
// archivos listados en ARCHIVOS_A_GUARDAR, hay que subir el número de
// CACHE_VERSION — si no, los navegadores pueden seguir sirviendo la
// versión vieja desde la copia guardada por un rato.
const CACHE_VERSION = 'cremeria-pos-v1';

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

  evento.respondWith(
    caches.match(evento.request).then((respuestaGuardada) => respuestaGuardada || fetch(evento.request))
  );
});
