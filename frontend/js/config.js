// Configuración de ESTE despliegue.
//
// Una sola versión del frontend sirve a TODOS los clientes: la dirección del
// servidor (backend) se elige sola según la dirección desde la que se abre la
// página. No hay que tocar este archivo para cada cliente nuevo si sus dos
// servicios en Render se llaman así:
//    servidor:  NOMBRE-pos       (ej. cliente2-pos)
//    página:    NOMBRE-pos-web   (ej. cliente2-pos-web)
// Solo si el cliente usa dominio propio o nombres distintos, agrega una línea
// en API_POR_DIRECCION.
const API_POR_DIRECCION = {
  // 'sistema.minegocio.com': 'https://minegocio-pos.onrender.com/api',
  'cliente1-pos-web.onrender.com': 'https://cliente1-pos.onrender.com/api'
};

// Servidor de Compoint (tu propio sistema y el demo) cuando no coincide nada.
const API_PRODUCCION = 'https://cremeria-pos.onrender.com/api';

const API_URL = (function () {
  const host = location.hostname;
  if (API_POR_DIRECCION[host]) return API_POR_DIRECCION[host];
  const m = host.match(/^(.+)-web\.onrender\.com$/);
  if (m) return 'https://' + m[1] + '.onrender.com/api';
  return API_PRODUCCION;
})();
