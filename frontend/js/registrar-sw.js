// Registra el Service Worker que permite que Mostrador, Caja y Caja
// Avanzada carguen incluso sin internet. Si el navegador no lo soporta
// (muy poco común hoy en día) o falla el registro, la app sigue
// funcionando normal — solo sin esta protección extra.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('No se pudo activar el modo sin conexión:', err.message);
    });
  });
}
