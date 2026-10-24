// Licencia CENTRAL: el servidor en la nube del cliente (Render) le pregunta a Compoint cómo está su licencia.
//
// Cómo funciona:
//   - Solo corre si existe la variable COMPOINT_LICENCIA_TOKEN (la pone Compoint en Render, sale del panel
//     admin -> Licencias Punto -> Nube) y NO es el servidor local de un cliente (ese toma la licencia de su nube).
//   - Cada hora (y al arrancar) manda su token y un número al azar a licencia.php (compoint.com.mx).
//   - La respuesta viene FIRMADA (HMAC con el token + el número al azar): si la firma no cuadra, o no es
//     una respuesta reciente a ESTA pregunta, se ignora. Nadie puede inventar una renovación.
//   - Se guarda en la fila "licencia" (la misma que ya usa todo el sistema), así que las reglas de siempre
//     siguen igual: aviso 7 días antes, 5 días de gracia y luego "solo consulta".
//   - Sin internet o si compoint.com.mx no contesta: se queda con lo último que se supo (nunca se bloquea
//     a un cliente por una falla de conexión nuestra).
//   - Renovar = cambiar la fecha en el panel; suspender = poner el estado "Suspendido". En máximo 1 hora
//     el sistema del cliente lo sabe.
//   - Si la respuesta dice «pendiente» (todavía no hay fecha capturada en el panel) no se cambia nada.
const crypto = require('crypto');
const pool = require('../db');
const licencia = require('./licencia');

const URL_POR_DEFECTO = 'https://www.compoint.com.mx/punto/licencia.php';
const CADA_MS = 60 * 60 * 1000;
const TIEMPO_MAX_MS = 12000;
const TOLERANCIA_RELOJ_MS = 2 * 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[0-9a-f]{48}$/;

const urlServicio = () => process.env.COMPOINT_LICENCIA_URL || URL_POR_DEFECTO;
const token = () => String(process.env.COMPOINT_LICENCIA_TOKEN || '').trim().toLowerCase();
const configurada = () => TOKEN_RE.test(token()) && !process.env.COMPOINT_ID_EQUIPO;

// Debe armarse EXACTAMENTE igual que en punto/licencia.php.
function firmaEsperada(r, nonce, tk) {
  const canonico = [
    r.control ? '1' : '0',
    r.pendiente ? '1' : '0',
    r.suspendida ? '1' : '0',
    r.tipo, r.plan, r.vence == null ? '' : r.vence,
    String(r.max_sucursales), r.cliente, nonce, r.emitido
  ].join('|');
  return crypto.createHmac('sha256', tk).update(canonico).digest('hex');
}

function firmaValida(r, nonce, tk) {
  if (!r || typeof r.firma !== 'string' || !/^[0-9a-f]{64}$/.test(r.firma)) return false;
  if (typeof r.tipo !== 'string' || typeof r.plan !== 'string' || typeof r.cliente !== 'string' || typeof r.emitido !== 'string') return false;
  if (r.n !== nonce) return false;
  const a = Buffer.from(firmaEsperada(r, nonce, tk), 'hex');
  const b = Buffer.from(r.firma, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Pregunta a Compoint. @returns {{resultado:'ok'|'sin_conexion'|'rechazada'|'firma_mala', respuesta?:object, error?:string}} */
async function preguntar() {
  const tk = token();
  const nonce = crypto.randomBytes(16).toString('hex');
  let resp;
  try {
    resp = await fetch(urlServicio(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'CompointPunto/licencia' },
      body: JSON.stringify({ t: tk, n: nonce }),
      signal: AbortSignal.timeout(TIEMPO_MAX_MS)
    });
  } catch (err) {
    return { resultado: 'sin_conexion', error: 'No se pudo conectar con Compoint.' };
  }
  let cuerpo = null;
  try { cuerpo = await resp.json(); } catch (e) { cuerpo = null; }
  if (resp.status === 404 && cuerpo && cuerpo.error === 'desconocido') return { resultado: 'rechazada', error: 'Compoint no reconoce este token.' };
  if (!resp.ok || !cuerpo || cuerpo.ok !== true) return { resultado: 'sin_conexion', error: `Compoint no está disponible por ahora (código ${resp.status}).` };
  if (!firmaValida(cuerpo, nonce, tk)) return { resultado: 'firma_mala', error: 'La respuesta no viene firmada por Compoint.' };
  const emitido = Date.parse(cuerpo.emitido);
  if (!Number.isFinite(emitido) || Math.abs(Date.now() - emitido) > TOLERANCIA_RELOJ_MS) return { resultado: 'firma_mala', error: 'La respuesta no es reciente.' };
  return { resultado: 'ok', respuesta: cuerpo };
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Guarda en la fila "licencia" lo que dijo Compoint. @returns {{cambio:string}} */
async function aplicar(r) {
  const hoy = licencia.hoy();
  const previa = (await pool.query('SELECT desde_nube FROM licencia WHERE id = 1')).rows[0];
  const esCentral = previa && typeof previa.desde_nube === 'string' && previa.desde_nube.startsWith('central');

  if (r.pendiente) return { cambio: 'pendiente' };

  if (!r.control) {
    // Sistema propio / demo de Compoint: sin control. Solo se quita lo que puso la consulta central.
    if (esCentral) { await pool.query('DELETE FROM licencia WHERE id = 1'); licencia.invalidarCache(); return { cambio: 'sin_control' }; }
    return { cambio: 'sin_control_nada' };
  }

  let tipo, vence, origen;
  if (r.suspendida) {
    tipo = 'anual';
    vence = licencia.sumarDias(hoy, -(licencia.GRACIA_PAGO + 1)); // ya pasó la gracia: solo consulta de inmediato
    origen = 'central_suspendida';
  } else {
    if (!['demo', 'anual', 'permanente'].includes(r.tipo)) return { cambio: 'datos_invalidos' };
    tipo = r.tipo;
    vence = tipo === 'permanente' ? licencia.SIN_FIN : r.vence;
    if (typeof vence !== 'string' || !FECHA_RE.test(vence)) return { cambio: 'datos_invalidos' };
    origen = 'central';
  }
  const plan = r.plan === 'local' ? 'local' : 'nube';
  const maxSuc = Number(r.max_sucursales) > 0 ? Math.min(Math.floor(Number(r.max_sucursales)), 99) : null;
  const cliente = r.cliente ? String(r.cliente).slice(0, 200) : null;

  await pool.query(
    `INSERT INTO licencia (id, cliente, fecha_inicio, fecha_vencimiento, tipo, plan, max_sucursales, codigo_activacion, serial,
        ultima_fecha_vista, desde_nube, nube_id_equipo, actualizado_en)
     VALUES (1, $1, $2, $3, $4, $5, $6, NULL, NULL, $2, $7, NULL, NOW())
     ON CONFLICT (id) DO UPDATE SET cliente = COALESCE(EXCLUDED.cliente, licencia.cliente),
       fecha_vencimiento = EXCLUDED.fecha_vencimiento, tipo = EXCLUDED.tipo, plan = EXCLUDED.plan,
       max_sucursales = EXCLUDED.max_sucursales, codigo_activacion = NULL, serial = NULL,
       desde_nube = EXCLUDED.desde_nube, nube_id_equipo = NULL, actualizado_en = NOW()`,
    [cliente, hoy, vence, tipo, plan, maxSuc, origen]);
  licencia.invalidarCache();
  return { cambio: origen };
}

let ultimo = { cuando: null, resultado: null, cambio: null, error: null };
let enCurso = false;

/** Una vuelta completa: preguntar y aplicar. Nunca lanza error. */
async function actualizar() {
  if (!configurada()) return { resultado: 'no_configurada' };
  if (enCurso) return { resultado: 'en_curso' };
  enCurso = true;
  try {
    const p = await preguntar();
    let cambio = null;
    if (p.resultado === 'ok') cambio = (await aplicar(p.respuesta)).cambio;
    ultimo = { cuando: new Date().toISOString(), resultado: p.resultado, cambio, error: p.error || null };
    if (p.resultado !== 'ok' && p.resultado !== 'sin_conexion') console.error('Licencia central:', p.error);
    return ultimo;
  } catch (err) {
    ultimo = { cuando: new Date().toISOString(), resultado: 'error', cambio: null, error: err.message };
    console.error('Licencia central: error al actualizar:', err.message);
    return ultimo;
  } finally { enCurso = false; }
}

let reloj = null;
/** Pone en marcha la consulta cada hora (una sola vez; solo si está configurada). */
function iniciar() {
  if (reloj || !configurada()) return false;
  reloj = setInterval(() => { actualizar().catch(() => {}); }, CADA_MS);
  if (reloj.unref) reloj.unref();
  setTimeout(() => { actualizar().catch(() => {}); }, 15 * 1000).unref();
  return true;
}
function detener() { if (reloj) { clearInterval(reloj); reloj = null; } }
const ultimaConsulta = () => ({ ...ultimo, configurada: configurada() });

module.exports = { URL_POR_DEFECTO, configurada, firmaEsperada, firmaValida, preguntar, aplicar, actualizar, iniciar, detener, ultimaConsulta };
