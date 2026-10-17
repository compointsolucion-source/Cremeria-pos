// Piezas compartidas de los pedidos a domicilio (rutas de pedidos y de clientes).

// Zona horaria del negocio: las horas de entrega se guardan "como se leen en el reloj del negocio"
// (sin zona), así que para comparar con "ahora" se convierte NOW() a esa misma hora local.
const TZ = process.env.TZ_NEGOCIO || 'America/Mexico_City';
const AHORA_LOCAL = `(NOW() AT TIME ZONE '${TZ.replace(/[^A-Za-z_/+-]/g, '')}')`;

const ESTADOS = ['programado', 'preparando', 'listo', 'en_camino', 'entregado', 'no_entregado', 'cancelado'];
const ESTADOS_ACTIVOS = ['programado', 'preparando', 'listo', 'en_camino'];

// A qué estado se puede pasar desde cada uno (cancelar se valida aparte: cualquier estado activo).
const TRANSICIONES = {
  programado: ['preparando', 'listo'],
  preparando: ['listo', 'en_camino', 'entregado'],
  listo: ['preparando', 'en_camino', 'entregado'],
  en_camino: ['listo', 'entregado', 'no_entregado'],
  no_entregado: ['listo', 'preparando'],
  entregado: [],
  cancelado: []
};

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const textoOnull = (v, max) => {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max || 300) : null;
};

const soloDigitos = (t) => String(t || '').replace(/\D/g, '');

// Latitud/longitud: las dos o ninguna, y dentro del mundo real.
function coordenadas(lat, lng) {
  const vacio = (v) => v === undefined || v === null || v === '';
  if (vacio(lat) && vacio(lng)) return { latitud: null, longitud: null };
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) {
    return { error: 'La ubicación (latitud y longitud) no es válida' };
  }
  return { latitud: Math.round(a * 1e7) / 1e7, longitud: Math.round(b * 1e7) / 1e7 };
}

// Dirección tal como llega de una pantalla -> campos listos para guardar (o { error }).
function normalizarDireccion(b) {
  const calle = textoOnull(b.calle, 200);
  if (!calle) return { error: 'La calle y número de la dirección son requeridos' };
  const c = coordenadas(b.latitud, b.longitud);
  if (c.error) return { error: c.error };
  return {
    alias: textoOnull(b.alias, 60),
    calle,
    colonia: textoOnull(b.colonia, 120),
    cp: textoOnull(b.cp, 10),
    ciudad: textoOnull(b.ciudad, 120),
    referencias: textoOnull(b.referencias, 300),
    latitud: c.latitud,
    longitud: c.longitud,
    ubicacion_enlace: textoOnull(b.ubicacion_enlace, 500),
    zona_id: Number.isInteger(Number(b.zona_id)) && Number(b.zona_id) > 0 ? Number(b.zona_id) : null
  };
}

// Costo de envío de una zona para un subtotal: gratis si el subtotal alcanza el mínimo de la zona
// (o el general de la configuración cuando la zona no define uno).
async function calcularEnvio(db, sucursalId, zonaId, subtotal) {
  if (!zonaId) return { costo: 0, zona: null, gratis: false };
  const z = await db.query('SELECT * FROM zonas_envio WHERE id = $1 AND sucursal_id = $2 AND activo = true', [zonaId, sucursalId]);
  if (!z.rows.length) return { error: 'La zona de envío no existe o está desactivada' };
  const zona = z.rows[0];
  let minimo = zona.envio_gratis_desde === null ? null : Number(zona.envio_gratis_desde);
  if (minimo === null) {
    const cfg = await db.query('SELECT pedidos_envio_gratis_desde FROM configuracion WHERE sucursal_id = $1', [sucursalId]);
    minimo = cfg.rows.length ? Number(cfg.rows[0].pedidos_envio_gratis_desde || 0) : 0;
  }
  const gratis = minimo > 0 && Number(subtotal) >= minimo;
  return { costo: gratis ? 0 : r2(zona.costo), zona, gratis, minimo };
}

// "D-0192": cómo se ve el número de un pedido en pantalla.
const numeroPedido = (id) => 'D-' + String(id).padStart(4, '0');

module.exports = { TZ, AHORA_LOCAL, ESTADOS, ESTADOS_ACTIVOS, TRANSICIONES, r2, textoOnull, soloDigitos, coordenadas, normalizarDireccion, calcularEnvio, numeroPedido };
