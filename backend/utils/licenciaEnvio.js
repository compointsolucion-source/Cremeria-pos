// Envío de la solicitud de licencia a Compoint (correo automático) con cola y reintentos.
//
// Cómo funciona:
//   1. Al pedir contratar/renovar, la solicitud se GUARDA primero (tabla licencia_solicitud).
//   2. Se intenta mandar de inmediato a solicitud.php (en el hosting de Compoint), que la
//      convierte en un correo a contacto@compoint.com.mx.
//   3. Si no hay internet (o el servicio no contesta), queda "pendiente" y se reintenta sola
//      cada pocos minutos, hasta por 14 días. Mientras tanto, el cliente puede usar WhatsApp.
//
// La dirección del servicio se puede cambiar con la variable COMPOINT_SOLICITUD_URL (para pruebas).
const pool = require('../db');
const solicitud = require('./licenciaSolicitud');

const URL_POR_DEFECTO = 'https://www.compoint.com.mx/punto/solicitud.php';
const CORREO_DESTINO = 'contacto@compoint.com.mx';
const ESPERA_REINTENTO_MIN = 10;      // mínimo entre intentos de la misma solicitud
const VIGENCIA_DIAS = 14;             // después de esto ya no se reintenta
const CADA_MS = 5 * 60 * 1000;        // el reloj de reintentos
const TIEMPO_MAX_MS = 12000;          // una petición no espera más que esto

const urlServicio = () => process.env.COMPOINT_SOLICITUD_URL || URL_POR_DEFECTO;

let enProceso = false;

// Lo que se manda al servicio (solicitud.php vuelve a validar todo por su lado).
function cargaUtil(fila, extra) {
  const lectura = solicitud.leerCodigo(fila.codigo);
  const d = lectura.ok ? lectura.datos : {};
  return {
    v: 1,
    web: '',                                  // campo trampa: un robot lo llena, nosotros no
    codigo: fila.codigo,
    tipo: d.tipo || fila.tipo,
    plan: d.plan || fila.plan,
    paquete: d.paquete || '',
    periodo: d.periodo || '',
    sucursales: d.sucursales || fila.sucursales,
    id_equipo: d.id_equipo || '',
    negocio: d.negocio || {},
    nota: d.nota || '',
    app: d.app || '',
    prueba_dias_restantes: d.prueba_dias_restantes == null ? null : d.prueba_dias_restantes,
    origen: extra && extra.origen ? extra.origen : ''
  };
}

/**
 * Manda UNA solicitud al servicio y regresa qué pasó.
 * @returns {{resultado:'enviada'|'reintentar'|'rechazada', error?:string}}
 */
async function mandar(fila, extra) {
  let resp;
  try {
    resp = await fetch(urlServicio(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'CompointPunto/solicitud' },
      body: JSON.stringify(cargaUtil(fila, extra)),
      signal: AbortSignal.timeout(TIEMPO_MAX_MS)
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { resultado: 'reintentar', error: timeout ? 'El servicio de Compoint tardó demasiado en contestar.' : 'Sin conexión a internet.' };
  }
  let cuerpo = null;
  try { cuerpo = await resp.json(); } catch (e) { cuerpo = null; }
  if (resp.ok && cuerpo && cuerpo.ok === true) return { resultado: 'enviada' };
  // 400/413/422: los datos no sirven; repetir no ayuda.
  if ([400, 413, 422].includes(resp.status)) {
    return { resultado: 'rechazada', error: (cuerpo && cuerpo.error) || 'El servicio de Compoint no aceptó la solicitud.' };
  }
  // 404/403/5xx/429/lo demás: el servicio todavía no está o está ocupado: se reintenta.
  return { resultado: 'reintentar', error: `El servicio de Compoint no está disponible por ahora (código ${resp.status}).` };
}

/** Intenta enviar una solicitud guardada y actualiza su estado. */
async function enviarUna(id, extra) {
  const r = await pool.query(`SELECT * FROM licencia_solicitud WHERE id = $1 AND estado = 'pendiente'`, [id]);
  const fila = r.rows[0];
  if (!fila) return null;
  const res = await mandar(fila, extra);
  if (res.resultado === 'enviada') {
    await pool.query(`UPDATE licencia_solicitud SET estado = 'enviada', enviada_en = NOW(), intentos = intentos + 1, ultimo_intento = NOW(), ultimo_error = NULL WHERE id = $1`, [id]);
  } else if (res.resultado === 'rechazada') {
    await pool.query(`UPDATE licencia_solicitud SET estado = 'rechazada', intentos = intentos + 1, ultimo_intento = NOW(), ultimo_error = $2 WHERE id = $1`, [id, res.error]);
  } else {
    await pool.query(`UPDATE licencia_solicitud SET intentos = intentos + 1, ultimo_intento = NOW(), ultimo_error = $2 WHERE id = $1`, [id, res.error]);
  }
  return res;
}

/**
 * Revisa las solicitudes pendientes y manda las que toca.
 * @param {{forzar?:boolean, origen?:string}} opciones  forzar = ignora la espera entre intentos
 */
async function procesarPendientes({ forzar = false, origen = '' } = {}) {
  if (enProceso) return { omitido: true };
  enProceso = true;
  try {
    // Las muy viejas ya no se intentan.
    await pool.query(`UPDATE licencia_solicitud SET estado = 'vencida' WHERE estado = 'pendiente' AND creada_en < NOW() - make_interval(days => $1::int)`, [VIGENCIA_DIAS]);
    const cond = forzar ? '' : `AND (ultimo_intento IS NULL OR ultimo_intento < NOW() - make_interval(mins => $1::int))`;
    const r = await pool.query(
      `SELECT id FROM licencia_solicitud WHERE estado = 'pendiente' ${cond} ORDER BY id`,
      forzar ? [] : [ESPERA_REINTENTO_MIN]);
    const salida = [];
    for (const { id } of r.rows) salida.push({ id, ...(await enviarUna(id, { origen })) });
    return { intentadas: salida };
  } catch (err) {
    // La tabla puede no existir todavía (migración en curso): no es motivo de ruido.
    if (err.code !== '42P01') console.error('Solicitudes de licencia: error al reintentar:', err.message);
    return { error: err.message };
  } finally {
    enProceso = false;
  }
}

let reloj = null;
/** Pone en marcha el reintento automático (una sola vez). */
function iniciarReintentos(origen = '') {
  if (reloj) return;
  reloj = setInterval(() => { procesarPendientes({ origen }).catch(() => {}); }, CADA_MS);
  if (reloj.unref) reloj.unref(); // no impide que el servidor se cierre
  setTimeout(() => { procesarPendientes({ origen }).catch(() => {}); }, 20 * 1000).unref();
}

function detenerReintentos() { if (reloj) { clearInterval(reloj); reloj = null; } }

module.exports = {
  URL_POR_DEFECTO, CORREO_DESTINO, ESPERA_REINTENTO_MIN, VIGENCIA_DIAS,
  urlServicio, mandar, enviarUna, procesarPendientes, iniciarReintentos, detenerReintentos
};
