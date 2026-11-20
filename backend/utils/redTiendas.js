// Red de tiendas de la app Compoint Pedidos: este servidor (en la nube del cliente) le manda al directorio
// de Compoint (compoint.com.mx/punto/red.php) las tiendas que quieren aparecer en el mapa, con sus productos.
//
//   - Solo corre en la nube con licencia central (la misma COMPOINT_LICENCIA_TOKEN que usa licenciaCentral):
//     con ese token el directorio sabe qué cliente es y si paga. Nunca en la computadora del negocio.
//   - Cada 15 minutos, y un momento después de que el dueño cambia algo en «Tienda en línea».
//   - Siempre manda la lista COMPLETA de sus tiendas: si el dueño apagó «Aparecer en el mapa» o la tienda,
//     el directorio la quita.
//   - El directorio decide si la red está prendida (más de 100 negocios que pagan) y si hay suficientes
//     tiendas cerca; este servidor solo informa. Sin internet: se intenta en la siguiente vuelta.
const pool = require('../db');
const licenciaCentral = require('./licenciaCentral');
const paquete = require('./paquete');

const URL_POR_DEFECTO = 'https://www.compoint.com.mx/punto/red.php';
const CADA_MS = 15 * 60 * 1000;
const ESPERA_AVISO_MS = 20 * 1000;
const TIEMPO_MAX_MS = 20000;
const MAX_PRODUCTOS = 3000;

const urlServicio = () => process.env.COMPOINT_RED_URL || URL_POR_DEFECTO;
const activa = () => licenciaCentral.configurada() && process.env.NODE_ENV !== 'test' && process.env.COMPOINT_RED_APAGADA !== '1';

let reloj = null;
let avisoPendiente = null;
let ultima = { cuando: null, resultado: null };

/** Arma lo que se manda: solo tiendas prendidas, con «Aparecer en el mapa» y ubicación. */
async function armarTiendas(db = pool) {
  try { await paquete.revisarDomicilio(); } catch (e) { return []; }   // Básico: sin tienda en línea, no aparece
  const tienda = require('../routes/tienda');
  const r = await db.query(
    `SELECT tc.*, su.nombre AS sucursal_nombre FROM tienda_config tc JOIN sucursales su ON su.id = tc.sucursal_id
      WHERE tc.activo = true AND su.activo = true AND tc.red_visible = true AND tc.red_lat IS NOT NULL
      ORDER BY tc.sucursal_id LIMIT 20`);
  const lista = [];
  for (const cfg of r.rows) {
    const neg = await tienda._datosNegocio(db, cfg.sucursal_id, cfg.sucursal_nombre);
    let productos = [];
    if (cfg.red_buscar) {
      // En «Buscar» solo salen productos con existencia (aunque la tienda muestre los agotados).
      productos = (await tienda._productosVisibles(db, cfg.sucursal_id, { ...cfg, ocultar_sin_existencia: true }))
        .slice(0, MAX_PRODUCTOS)
        .map((p) => ({ id: p.id, n: String(p.nombre).slice(0, 120), p: p.promo && p.promo.desde <= 1 ? p.promo.precio : p.precio, k: p.por_peso ? 1 : 0, d: String(p.departamento || '').slice(0, 60) }));
    }
    lista.push({
      s: cfg.sucursal_id,
      negocio: String(neg.negocio || '').slice(0, 120),
      giro: cfg.giro ? String(cfg.giro).slice(0, 120) : null,
      color: cfg.tema === 'color' && cfg.color_principal ? cfg.color_principal : null,
      tema: cfg.tema || 'letrero',
      lat: Number(cfg.red_lat), lng: Number(cfg.red_lng),
      direccion: cfg.red_direccion ? String(cfg.red_direccion).slice(0, 200) : null,
      domicilio: !!cfg.red_domicilio, recoger: !!cfg.red_recoger,
      horario: cfg.horario || null, tiempo: cfg.tiempo_entrega ? String(cfg.tiempo_entrega).slice(0, 40) : null,
      minimo: Number(cfg.pedido_minimo) || 0,
      productos
    });
  }
  return lista;
}

async function enviar() {
  if (!activa()) return { resultado: 'apagada' };
  let tiendas;
  try { tiendas = await armarTiendas(); } catch (e) { return guardar({ resultado: 'error_local', error: e.message }); }
  try {
    const resp = await fetch(urlServicio(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'CompointPunto/red' },
      body: JSON.stringify({ t: String(process.env.COMPOINT_LICENCIA_TOKEN).trim().toLowerCase(), accion: 'publicar', tiendas }),
      signal: AbortSignal.timeout(TIEMPO_MAX_MS)
    });
    const j = await resp.json().catch(() => ({}));
    return guardar({ resultado: resp.ok && j.ok ? 'ok' : 'rechazada', tiendas: tiendas.length, error: j.error || null });
  } catch (e) {
    return guardar({ resultado: 'sin_conexion', error: 'No se pudo conectar con Compoint.' });
  }
}

function guardar(x) {
  ultima = { cuando: new Date().toISOString(), ...x };
  if (x.resultado !== 'ok' && x.resultado !== 'apagada') console.warn(`[red de tiendas] ${x.resultado}${x.error ? ': ' + x.error : ''}`);
  return ultima;
}

/** El dueño cambió algo: se manda en un momento (varios cambios seguidos = un solo envío). */
function avisar() {
  if (!activa() || avisoPendiente) return;
  avisoPendiente = setTimeout(() => { avisoPendiente = null; enviar().catch(() => {}); }, ESPERA_AVISO_MS);
  if (avisoPendiente.unref) avisoPendiente.unref();
}

function iniciar() {
  if (!activa() || reloj) return;
  setTimeout(() => { enviar().catch(() => {}); }, 60 * 1000).unref?.();
  reloj = setInterval(() => { enviar().catch(() => {}); }, CADA_MS);
  if (reloj.unref) reloj.unref();
}

function detener() {
  if (reloj) { clearInterval(reloj); reloj = null; }
  if (avisoPendiente) { clearTimeout(avisoPendiente); avisoPendiente = null; }
}

module.exports = { URL_POR_DEFECTO, armarTiendas, enviar, avisar, iniciar, detener, ultimaVez: () => ultima };
