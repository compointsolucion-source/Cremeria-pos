// Control de licencia de ESTA instalación (prueba de 15 días, renta anual o permanente).
// La lógica de los estados vive en utils/licencia.js; aquí solo se aplica a cada petición.
//
// - Sin fila en la tabla "licencia" y en la nube: NO hay control (tu sistema propio).
// - En cada respuesta lleva encabezados para que la pantalla muestre su barra de aviso:
//     X-Licencia-Estado  demo | por_vencer | gracia | solo_consulta   (no se manda si todo está normal)
//     X-Licencia-Tipo    demo | anual | permanente
//     X-Licencia-Dias    días que faltan (negativo si ya venció)
//     X-Licencia-Vence   fecha de vencimiento
// - "solo_consulta" (venció y se acabó la gracia): se puede entrar, ver reportes y respaldar,
//   pero las peticiones que registran o cambian algo se rechazan con 402.
// - Si la base de datos falla al consultar, NO se bloquea.
// Para renovar o cambiar algo: ver backend/scripts/LEEME-LICENCIA.txt
const licencia = require('../utils/licencia');

// Lo que SÍ se puede hacer aun en "solo consulta" (aunque cambie datos).
const PERMITIDAS_EN_SOLO_CONSULTA = [
  /^\/api\/auth\//,                 // iniciar y cerrar sesión, cambiar contraseña
  /^\/api\/licencia(\/|$)/,         // meter el código de activación, pedir contratar
  /^\/api\/terminos\/aceptar$/,     // aceptar los términos y condiciones
  /^\/api\/turnos\/\d+\/cerrar$/,   // cerrar el turno que estaba abierto
  /^\/api\/facturacion\/publico\//  // la página pública para pedir factura
];

function rutaSinParametros(req) { return String(req.originalUrl || req.url || '').split('?')[0]; }

function esEscritura(req) { return !['GET', 'HEAD', 'OPTIONS'].includes(req.method); }

function ponerEncabezados(res, est) {
  if (est.estado === 'activa') return; // todo normal: sin barra
  res.set('X-Licencia-Estado', est.estado);
  res.set('X-Licencia-Tipo', est.tipo);
  if (est.dias != null) res.set('X-Licencia-Dias', String(est.dias));
  if (est.vence) res.set('X-Licencia-Vence', est.vence);
}

async function verificarLicencia(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  // Cerrar sesión siempre debe poder hacerse.
  if (req.originalUrl.startsWith('/api/auth/logout')) return next();
  let est;
  try { est = await licencia.estado(); } catch (e) { return next(); }
  if (!est || !est.control) return next();

  ponerEncabezados(res, est);

  if (est.solo_consulta && esEscritura(req)) {
    const ruta = rutaSinParametros(req);
    if (!PERMITIDAS_EN_SOLO_CONSULTA.some((re) => re.test(ruta))) {
      return res.status(402).json({
        error: est.mensaje,
        licencia_vencida: true,
        solo_consulta: true,
        tipo: est.tipo
      });
    }
  }
  next();
}

module.exports = { verificarLicencia, PERMITIDAS_EN_SOLO_CONSULTA };
