// Pedidos a domicilio / para recoger / programados + módulo del repartidor + pedidos fijos de tiendas.
//
// Un pedido SIEMPRE tiene un ticket (el mismo ticket de siempre: mismos totales, mismo cobro en Caja,
// misma devolución). El pedido solo agrega: a quién y a dónde se lleva, cuándo, quién lo lleva y cómo se cobra.
//
// Cobro (pago_modo):
//   al_recibir -> el repartidor cobra en la puerta y al volver se "liquida": ahí se cobra el ticket en el turno
//                 de quien recibe el dinero (por eso estos tickets NO salen en la bandeja de Caja).
//   pagado     -> ya pagó (tarjeta/transferencia): se cobra en Caja como cualquier ticket.
//   credito    -> se cobra en Caja a crédito del cliente (fiado).
//   En un pedido "para recoger" todo se cobra en Caja (al recoger).
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol, requiereSucursalId, requierePermiso, tienePermiso } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');
const { subtotalRenglon } = require('../utils/importeExacto');
const { descontarInventarioVenta } = require('../utils/inventarioVenta');
const U = require('../utils/pedidosUtil');
const { AHORA_LOCAL, TRANSICIONES, r2, textoOnull, soloDigitos, normalizarDireccion, calcularEnvio, numeroPedido } = U;

router.use(verificarToken, requiereSucursalId);
router.param('id', (req, res, next, v) => (/^\d+$/.test(v) ? next() : next('route')));
router.param('repartidorId', (req, res, next, v) => (/^\d+$/.test(v) ? next() : next('route')));

const ROLES_ADMIN = ['jefe_general', 'dueno', 'gerente'];
const NOMBRE_LINEA_ENVIO = 'Envío a domicilio';
const METODOS_COBRO = ['efectivo', 'transferencia', 'tarjeta'];
const PAGO_MODOS = ['al_recibir', 'pagado', 'credito'];

class ErrorHttp extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}
function responderError(res, err, mensajeGeneral) {
  if (err instanceof ErrorHttp) return res.status(err.status).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: mensajeGeneral || 'Error en pedidos' });
}
const rutaAsync = (mensaje, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { responderError(res, err, mensaje); }
};

// La hora local de una columna guardada con NOW() (que usa la zona de la base de datos).
const localDe = (col) => `((${col} AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE '${U.TZ.replace(/[^A-Za-z_/+-]/g, '')}')`;
const ES_LINEA_ENVIO = `d.nombre_producto = '${NOMBRE_LINEA_ENVIO}' AND d.producto_id IS NULL AND d.kit_id IS NULL`;

// ------------------------------------------------------------------ lectura de pedidos
const SQL_PEDIDO = `
  SELECT p.*,
    to_char(p.programado_para, 'YYYY-MM-DD"T"HH24:MI') AS _prog,
    to_char(p.preparar_desde, 'YYYY-MM-DD"T"HH24:MI') AS _prep,
    to_char(p.fecha_entrega, 'YYYY-MM-DD') AS _fecha,
    t.folio, t.estado AS ticket_estado, t.total AS ticket_total,
    (t.total - COALESCE(t.descuento_monto, 0) - COALESCE(dd.descuento_items, 0)) AS total_neto,
    COALESCE(dd.n_items, 0) AS n_items,
    u.nombre AS repartidor_nombre, u.telefono AS repartidor_telefono,
    ua.nombre AS aceptado_por_nombre,
    c.tipo AS cliente_tipo, c.usa_mayoreo AS cliente_mayoreo,
    z.nombre AS zona_nombre,
    CASE WHEN p.estado IN ('programado', 'preparando', 'listo', 'en_camino')
          AND p.programado_para IS NOT NULL
          AND NOT (p.estado = 'programado' AND p.preparar_desde IS NULL)
          AND p.programado_para < ${AHORA_LOCAL}
         THEN FLOOR(EXTRACT(EPOCH FROM (${AHORA_LOCAL} - p.programado_para)) / 60)::int
         ELSE 0 END AS retraso_min
  FROM pedidos p
  JOIN tickets t ON t.id = p.ticket_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(d.descuento_monto), 0) AS descuento_items,
           COUNT(*) FILTER (WHERE NOT (${ES_LINEA_ENVIO})) AS n_items
      FROM ticket_detalle d WHERE d.ticket_id = p.ticket_id
  ) dd ON true
  LEFT JOIN usuarios u ON u.id = p.repartidor_id
  LEFT JOIN usuarios ua ON ua.id = p.aceptado_por
  LEFT JOIN clientes c ON c.id = p.cliente_id
  LEFT JOIN zonas_envio z ON z.id = p.zona_id
`;

const aNumero = (v) => (v === null || v === undefined ? null : Number(v));

function formato(r) {
  const o = { ...r };
  o.programado_para = r._prog;
  o.preparar_desde = r._prep;
  o.fecha_entrega = r._fecha;
  delete o._prog; delete o._prep; delete o._fecha;
  o.etiqueta = numeroPedido(r.id);
  for (const k of ['costo_envio', 'total_neto', 'ticket_total', 'monto_cobrado', 'paga_con', 'latitud', 'longitud']) o[k] = aNumero(r[k]);
  o.n_items = Number(r.n_items || 0);
  o.retraso_min = Number(r.retraso_min || 0);
  // Anticipo: lo que el cliente ya dejó. "resta" es lo que todavía hay que cobrar (en la puerta o en Caja).
  o.anticipo = r2(Number(r.anticipo) || 0);
  o.anticipo_metodo = o.anticipo > 0 ? (r.anticipo_metodo || 'efectivo') : null;
  o.resta = o.total_neto !== null ? Math.max(0, r2(o.total_neto - o.anticipo)) : null;
  // estado_cobro = lo que de verdad pasa con el dinero (así ninguna pantalla dice "ya pagado" por error):
  //   pagado     el ticket ya se cobró en Caja, o el cliente pagó TODO por adelantado
  //   credito    se carga a la cuenta del cliente
  //   al_recibir el repartidor cobra la resta en la puerta
  //   en_caja    se cobra en Caja (antes de salir o al recoger)
  const cubierto = r.ticket_estado === 'pagado' || (o.total_neto !== null && o.total_neto > 0 && o.anticipo >= o.total_neto);
  o.estado_cobro = cubierto ? 'pagado' : r.pago_modo === 'credito' ? 'credito' : (r.tipo === 'domicilio' && r.pago_modo === 'al_recibir') ? 'al_recibir' : 'en_caja';
  o.por_cobrar = o.estado_cobro === 'al_recibir' && r.ticket_estado === 'pendiente' && r.estado !== 'cancelado';
  o.cambio = o.paga_con !== null && o.resta !== null ? Math.max(0, r2(o.paga_con - o.resta)) : null;
  return o;
}

async function itemsDelTicket(db, ticketId) {
  const r = await db.query(
    `SELECT d.id, d.tipo, d.producto_id, d.nombre_producto, d.cantidad, d.precio_unitario, d.subtotal, d.descuento_monto, p.tipo_venta
       FROM ticket_detalle d LEFT JOIN productos p ON p.id = d.producto_id
      WHERE d.ticket_id = $1 ORDER BY d.id`, [ticketId]);
  return r.rows.map((i) => ({
    ...i, cantidad: Number(i.cantidad), precio_unitario: Number(i.precio_unitario), subtotal: Number(i.subtotal),
    descuento_monto: Number(i.descuento_monto || 0), es_envio: i.nombre_producto === NOMBRE_LINEA_ENVIO && !i.producto_id
  }));
}

async function cargarPedido(db, id, sucursalId, { conItems = true } = {}) {
  const r = await db.query(`${SQL_PEDIDO} WHERE p.id = $1 AND p.sucursal_id = $2`, [id, sucursalId]);
  if (!r.rows.length) return null;
  const p = formato(r.rows[0]);
  if (conItems) {
    p.items = await itemsDelTicket(db, p.ticket_id);
    const ev = await db.query('SELECT id, tipo, creado_en FROM pedido_evidencias WHERE pedido_id = $1 ORDER BY id', [id]);
    p.evidencias = ev.rows;
  }
  return p;
}

// Los pedidos que ya llegaron a su hora de preparación pasan solos de "Programado" a "Preparando".
async function avanzarProgramados(io, sucursalId) {
  const r = await pool.query(
    `UPDATE pedidos SET estado = 'preparando'
      WHERE estado = 'programado' AND preparar_desde IS NOT NULL AND preparar_desde <= ${AHORA_LOCAL}
        ${sucursalId ? 'AND sucursal_id = $1' : ''}
      RETURNING id, sucursal_id, ticket_id, tipo, pago_modo`,
    sucursalId ? [sucursalId] : []
  );
  if (io) {
    for (const p of r.rows) {
      io.to(`sucursal_${p.sucursal_id}`).emit('pedido_actualizado', { id: p.id, estado: 'preparando', repartidor_id: null });
      if (visibleEnCaja({ ...p, estado: 'preparando' })) {
        const t = await pool.query('SELECT folio, total FROM tickets WHERE id = $1', [p.ticket_id]);
        if (t.rows.length) io.to(`sucursal_${p.sucursal_id}`).emit('nuevo_ticket', { folio: t.rows[0].folio, total: t.rows[0].total });
      }
    }
  }
  return r.rows.length;
}

// ¿Este pedido debe aparecer en la bandeja de Caja? (misma regla que usa /tickets/pendientes)
function visibleEnCaja(p) {
  if (['programado', 'cancelado'].includes(p.estado)) return false;
  if (p.tipo === 'domicilio' && p.pago_modo === 'al_recibir') return false;
  return true;
}

function emitir(io, sucursalId, evento, datos) {
  if (io) io.to(`sucursal_${sucursalId}`).emit(evento, datos);
}

// ------------------------------------------------------------------ validaciones
function validarFechaHora(v) {
  if (v === undefined || v === null || v === '') return { valor: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(v).trim());
  if (!m) return { error: 'La fecha y hora de entrega no es válida' };
  const [, a, mes, d, h, mi] = m.map(Number);
  const f = new Date(Date.UTC(a, mes - 1, d, h, mi));
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== d || h > 23 || mi > 59) return { error: 'La fecha y hora de entrega no es válida' };
  if (a < 2020 || a > 2100) return { error: 'La fecha de entrega no es válida' };
  return { valor: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` };
}
function validarFecha(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (!m) return false;
  const f = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return f.getUTCMonth() === +m[2] - 1 && f.getUTCDate() === +m[3] ? String(v).trim() : false;
}

function validarItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new ErrorHttp(400, 'El pedido necesita al menos un producto');
  if (items.length > 200) throw new ErrorHttp(400, 'El pedido tiene demasiados renglones');
  for (const it of items) {
    const cant = Number(it && it.cantidad), precio = Number(it && it.precio_unitario);
    if (!it || !it.nombre_producto || !Number.isFinite(cant) || cant <= 0 || !Number.isFinite(precio) || precio < 0) {
      throw new ErrorHttp(400, 'Hay un producto con cantidad o precio inválido');
    }
  }
}

async function folioUnico(db, sucursalId) {
  for (let i = 0; i < 8; i++) {
    const folio = `S${sucursalId}${Date.now().toString(36).toUpperCase().slice(-6)}${i || ''}`;
    const ya = await db.query('SELECT 1 FROM tickets WHERE folio = $1', [folio]);
    if (!ya.rows.length) return folio;
    await new Promise((ok) => setTimeout(ok, 3));
  }
  throw new ErrorHttp(500, 'No se pudo generar el folio del ticket');
}

async function repartidorValido(db, sucursalId, id) {
  if (id === undefined || id === null || id === '') return null;
  const r = await db.query("SELECT id FROM usuarios WHERE id = $1 AND sucursal_id = $2 AND rol = 'repartidor' AND activo = true", [id, sucursalId]);
  if (!r.rows.length) throw new ErrorHttp(400, 'Ese repartidor no existe o está desactivado');
  return r.rows[0].id;
}

// Renglones de producto o kit de un ticket de pedido.
async function insertarRenglones(db, ticketId, items, subtotales) {
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    const tipo = it.tipo === 'kit' ? 'kit' : 'producto';
    await db.query(
      `INSERT INTO ticket_detalle (ticket_id, tipo, producto_id, kit_id, nombre_producto, cantidad, precio_unitario, subtotal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ticketId, tipo, tipo === 'producto' ? (it.producto_id || null) : null, tipo === 'kit' ? (it.kit_id || null) : null, it.nombre_producto, it.cantidad, it.precio_unitario, subtotales[n]]
    );
  }
}

// ------------------------------------------------------------------ anticipo
// "d" trae anticipo / anticipo_metodo / ya_pago_todo (lo que mandó la pantalla). Devuelve lo que se guarda.
// Si el cliente ya pagó TODO, el repartidor no tiene nada que cobrar: el pedido pasa a "se cobra en Caja".
function validarAnticipo(d, total, pagoModoActual) {
  const pagoModo = pagoModoActual || d.pago_modo;
  let anticipo = 0;
  if (d.ya_pago_todo === true) anticipo = r2(total);
  else if (d.anticipo !== undefined && d.anticipo !== null && d.anticipo !== '') {
    anticipo = Number(d.anticipo);
    if (!Number.isFinite(anticipo) || anticipo < 0) throw new ErrorHttp(400, 'El anticipo no es válido');
    anticipo = r2(anticipo);
  }
  if (anticipo > 0 && pagoModo === 'credito') throw new ErrorHttp(400, 'Un pedido a crédito no lleva anticipo: quita el anticipo o cambia la forma de pago');
  if (anticipo > total + 0.001) throw new ErrorHttp(400, `El anticipo ($${anticipo.toFixed(2)}) no puede ser mayor que el total del pedido ($${total.toFixed(2)})`);
  let metodo = null;
  if (anticipo > 0) {
    metodo = d.anticipo_metodo === undefined || d.anticipo_metodo === null || d.anticipo_metodo === '' ? 'efectivo' : d.anticipo_metodo;
    if (!METODOS_COBRO.includes(metodo)) throw new ErrorHttp(400, 'Elige con qué dejó el anticipo: efectivo, transferencia o tarjeta');
  }
  const pagoFinal = anticipo > 0 && total > 0 && anticipo >= total && pagoModo === 'al_recibir' ? 'pagado' : pagoModo;
  return { anticipo, anticipo_metodo: metodo, pago_modo: pagoFinal };
}

// ------------------------------------------------------------------ crear un pedido (ticket + pedido)
// "d" ya viene validado y con el cliente/dirección resueltos. Se llama dentro de una transacción.
async function crearPedidoCore(db, d) {
  const subtotales = d.items.map(subtotalRenglon);
  const subtotal = r2(subtotales.reduce((s, x) => s + x, 0));

  let costoEnvio = 0, zonaNombre = null;
  if (d.tipo === 'domicilio') {
    const calc = await calcularEnvio(db, d.sucursalId, d.zona_id, subtotal);
    if (calc.error) throw new ErrorHttp(400, calc.error);
    costoEnvio = d.costo_envio_forzado !== null && d.costo_envio_forzado !== undefined ? r2(d.costo_envio_forzado) : calc.costo;
    zonaNombre = calc.zona ? calc.zona.nombre : null;
  }
  const total = r2(subtotal + costoEnvio);

  // Anticipo: 0 = nada, igual al total = ya pagó todo. Nunca más que el total, y a crédito no lleva anticipo.
  const an = validarAnticipo(d, total);

  const folio = await folioUnico(db, d.sucursalId);
  const tk = (await db.query(
    `INSERT INTO tickets (folio, sucursal_id, mostrador_usuario_id, estado, total, cliente_id)
     VALUES ($1, $2, $3, 'pendiente', $4, $5) RETURNING *`,
    [folio, d.sucursalId, d.usuarioId, total, d.cliente ? d.cliente.id : null]
  )).rows[0];

  await insertarRenglones(db, tk.id, d.items, subtotales);
  if (costoEnvio > 0) {
    await db.query(
      `INSERT INTO ticket_detalle (ticket_id, tipo, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
       VALUES ($1, 'producto', NULL, $2, 1, $3, $3)`,
      [tk.id, NOMBRE_LINEA_ENVIO, costoEnvio]
    );
  }

  const cfg = await db.query('SELECT pedidos_min_preparacion FROM configuracion WHERE sucursal_id = $1', [d.sucursalId]);
  const minPrep = cfg.rows.length ? Number(cfg.rows[0].pedidos_min_preparacion) : 30;
  const dir = d.direccion || {};

  const p = (await db.query(
    `INSERT INTO pedidos (sucursal_id, ticket_id, cliente_id, direccion_id, tipo, estado,
        nombre_contacto, telefono, calle, colonia, cp, ciudad, referencias, latitud, longitud, ubicacion_enlace, zona_id,
        costo_envio, pago_modo, paga_con, programado_para, fecha_entrega, preparar_desde,
        creado_por, repartidor_id, notas, origen, pedido_fijo_id, anticipo, anticipo_metodo)
     VALUES ($1,$2,$3,$4,$5,
        CASE WHEN $22::boolean = false THEN 'programado'
             WHEN $21::text IS NOT NULL AND ($21::text::timestamp - make_interval(mins => $23::int)) > ${AHORA_LOCAL} THEN 'programado'
             ELSE 'preparando' END,
        $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        $17,$18,$19,$21::text::timestamp,
        COALESCE($21::text::timestamp::date, (${AHORA_LOCAL})::date),
        CASE WHEN $22::boolean = false OR $21::text IS NULL THEN NULL ELSE $21::text::timestamp - make_interval(mins => $23::int) END,
        $20,$24,$25,$26,$27,$28,$29)
     RETURNING id, estado`,
    [d.sucursalId, tk.id, d.cliente ? d.cliente.id : null, d.direccion_id || null, d.tipo,
     d.nombre_contacto, d.telefono, dir.calle || null, dir.colonia || null, dir.cp || null, dir.ciudad || null, dir.referencias || null,
     dir.latitud === undefined ? null : dir.latitud, dir.longitud === undefined ? null : dir.longitud, dir.ubicacion_enlace || null, d.zona_id || null,
     costoEnvio, an.pago_modo, an.pago_modo === d.pago_modo ? d.paga_con : null, d.usuarioId, d.programado_para, d.enviar !== false, minPrep,
     d.repartidor_id || null, d.notas, d.origen || 'manual', d.pedido_fijo_id || null, an.anticipo, an.anticipo_metodo]
  )).rows[0];

  return { pedido_id: p.id, estado: p.estado, ticket_id: tk.id, folio, total, costo_envio: costoEnvio, zona_nombre: zonaNombre };
}

async function resolverCliente(db, sucursalId, b) {
  if (b.cliente_id) {
    const r = await db.query('SELECT * FROM clientes WHERE id = $1 AND sucursal_id = $2 AND activo = true', [b.cliente_id, sucursalId]);
    if (!r.rows.length) throw new ErrorHttp(400, 'Ese cliente no existe');
    const c = r.rows[0];
    return { cliente: c, nombre: textoOnull(b.nombre_contacto, 150) || c.nombre, telefono: textoOnull(b.telefono, 30) || c.telefono };
  }
  const nombre = textoOnull(b.nombre_contacto, 150);
  if (!nombre) throw new ErrorHttp(400, 'Escribe el nombre del cliente');
  const telefono = textoOnull(b.telefono, 30);
  let cliente = null;
  if (b.guardar_cliente !== false) {
    const dig = soloDigitos(telefono);
    if (dig.length >= 8) {
      const ya = await db.query(
        `SELECT * FROM clientes WHERE sucursal_id = $1 AND activo = true
            AND RIGHT(REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g'), 8) = $2 ORDER BY id LIMIT 1`,
        [sucursalId, dig.slice(-8)]
      );
      if (ya.rows.length) cliente = ya.rows[0];
    }
    if (!cliente) {
      cliente = (await db.query(
        'INSERT INTO clientes (sucursal_id, nombre, telefono, limite_credito) VALUES ($1, $2, $3, 0) RETURNING *',
        [sucursalId, nombre, telefono]
      )).rows[0];
    }
  }
  return { cliente, nombre, telefono };
}

// Dirección de entrega: una guardada del cliente, o una nueva (que se guarda en el cliente).
async function resolverDireccion(db, sucursalId, cliente, b) {
  if (b.direccion_id) {
    const r = await db.query(
      `SELECT cd.* FROM cliente_direcciones cd JOIN clientes c ON c.id = cd.cliente_id
        WHERE cd.id = $1 AND cd.activo = true AND c.sucursal_id = $2`, [b.direccion_id, sucursalId]);
    if (!r.rows.length) throw new ErrorHttp(400, 'Esa dirección no existe');
    if (cliente && r.rows[0].cliente_id !== cliente.id) throw new ErrorHttp(400, 'Esa dirección es de otro cliente');
    await db.query('UPDATE cliente_direcciones SET ultimo_uso = NOW() WHERE id = $1', [b.direccion_id]);
    return { direccion: r.rows[0], direccion_id: r.rows[0].id };
  }
  if (!b.direccion) throw new ErrorHttp(400, 'Falta la dirección de entrega');
  const d = normalizarDireccion(b.direccion);
  if (d.error) throw new ErrorHttp(400, d.error);
  let direccionId = null;
  if (cliente && b.guardar_direccion !== false) {
    const dup = await db.query(
      `SELECT id FROM cliente_direcciones WHERE cliente_id = $1 AND activo = true
          AND LOWER(calle) = LOWER($2) AND LOWER(COALESCE(colonia, '')) = LOWER($3) LIMIT 1`,
      [cliente.id, d.calle, d.colonia || '']);
    if (dup.rows.length) {
      direccionId = dup.rows[0].id;
      await db.query(
        `UPDATE cliente_direcciones SET ultimo_uso = NOW(), referencias = COALESCE($2, referencias),
                latitud = COALESCE($3, latitud), longitud = COALESCE($4, longitud),
                ubicacion_enlace = COALESCE($5, ubicacion_enlace), zona_id = COALESCE($6, zona_id) WHERE id = $1`,
        [direccionId, d.referencias, d.latitud, d.longitud, d.ubicacion_enlace, d.zona_id]);
    } else {
      const hay = await db.query('SELECT COUNT(*)::int AS n FROM cliente_direcciones WHERE cliente_id = $1 AND activo = true', [cliente.id]);
      direccionId = (await db.query(
        `INSERT INTO cliente_direcciones (cliente_id, alias, calle, colonia, cp, ciudad, referencias, latitud, longitud, ubicacion_enlace, zona_id, principal, ultimo_uso)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING id`,
        [cliente.id, d.alias, d.calle, d.colonia, d.cp, d.ciudad, d.referencias, d.latitud, d.longitud, d.ubicacion_enlace, d.zona_id, hay.rows[0].n === 0]
      )).rows[0].id;
    }
  }
  return { direccion: d, direccion_id: direccionId };
}

// ------------------------------------------------------------------ cambios de estado
async function transicionar(req, id, nuevo, datos = {}, opciones = {}) {
  const io = req.app.get('io');
  const conexion = await pool.connect();
  try {
    await conexion.query('BEGIN');
    const fila = await conexion.query(`${SQL_PEDIDO} WHERE p.id = $1 AND p.sucursal_id = $2 FOR UPDATE OF p`, [id, req.sucursalId]);
    if (!fila.rows.length) throw new ErrorHttp(404, 'Pedido no encontrado');
    const ped = formato(fila.rows[0]);
    const actual = ped.estado;
    const rechazar = (msg) => { throw new ErrorHttp(409, msg); };

    if (opciones.soloRepartidor && ped.repartidor_id !== req.usuario.id) throw new ErrorHttp(403, 'Este pedido no es tuyo');

    if (nuevo === 'cancelado') {
      const eraEntregado = actual === 'entregado';
      if (!eraEntregado && !['programado', 'preparando', 'listo', 'en_camino', 'no_entregado'].includes(actual)) rechazar('Este pedido ya no se puede cancelar');
      if (eraEntregado) {
        // Corregir un error: solo dueño/gerente, con motivo, y mientras el repartidor no haya liquidado en Caja.
        if (!ROLES_ADMIN.includes(req.usuario.rol)) throw new ErrorHttp(403, 'Solo el dueño o el gerente pueden cancelar un pedido ya entregado');
        if (ped.liquidacion_id) rechazar('Este pedido ya se liquidó en Caja: para regresar el dinero haz una devolución desde Devoluciones');
        if (!textoOnull(datos.motivo, 300)) throw new ErrorHttp(400, 'Escribe por qué cancelas un pedido ya entregado');
      }
      if (ped.ticket_estado === 'pagado') rechazar('Este pedido ya está cobrado: para regresar el dinero haz una devolución desde Devoluciones');
      await conexion.query("UPDATE tickets SET estado = 'cancelado' WHERE id = $1 AND estado = 'pendiente'", [ped.ticket_id]);
      await conexion.query("UPDATE pedidos SET estado = 'cancelado', motivo_cancelacion = $2 WHERE id = $1", [id, textoOnull(datos.motivo, 300)]);
    } else {
      if (!TRANSICIONES[actual] || !TRANSICIONES[actual].includes(nuevo)) rechazar(`Este pedido está "${actual}" y no puede pasar a "${nuevo}"`);
      if (ped.tipo === 'recoger' && ['en_camino', 'no_entregado'].includes(nuevo)) rechazar('Un pedido para recoger no sale con repartidor');
      if (nuevo === 'en_camino' && !ped.repartidor_id) throw new ErrorHttp(400, 'Primero asigna un repartidor');

      if (nuevo === 'preparando') {
        // Al reabrir la preparación, Mostrador lo vuelve a ver como NUEVO (hay que volver a aceptarlo).
        await conexion.query("UPDATE pedidos SET estado = 'preparando', salio_en = NULL, llego_en = NULL, aceptado_en = NULL, aceptado_por = NULL WHERE id = $1", [id]);
      } else if (nuevo === 'listo') {
        await conexion.query("UPDATE pedidos SET estado = 'listo', listo_en = COALESCE(listo_en, NOW()), salio_en = NULL, llego_en = NULL WHERE id = $1", [id]);
      } else if (nuevo === 'en_camino') {
        await conexion.query("UPDATE pedidos SET estado = 'en_camino', salio_en = NOW(), llego_en = NULL, listo_en = COALESCE(listo_en, NOW()) WHERE id = $1", [id]);
      } else if (nuevo === 'no_entregado') {
        const motivo = textoOnull(datos.motivo, 300);
        if (!motivo) throw new ErrorHttp(400, 'Escribe por qué no se pudo entregar');
        await conexion.query("UPDATE pedidos SET estado = 'no_entregado', motivo_no_entrega = $2, llego_en = COALESCE(llego_en, NOW()) WHERE id = $1", [id, motivo]);
      } else if (nuevo === 'entregado') {
        let metodo = null, monto = null;
        if (ped.tipo === 'domicilio' && ped.pago_modo === 'al_recibir') {
          if (!ped.repartidor_id) throw new ErrorHttp(400, 'Asigna un repartidor para registrar el cobro de este pedido');
          metodo = datos.metodo_cobro || 'efectivo';
          if (!METODOS_COBRO.includes(metodo)) throw new ErrorHttp(400, 'Forma de cobro inválida');
          monto = ped.resta;   // en la puerta se cobra lo que RESTA (total menos el anticipo)
        }
        if (opciones.evidencias) await guardarEvidencias(conexion, req, id, opciones.evidencias);
        await conexion.query(
          `UPDATE pedidos SET estado = 'entregado', entregado_en = NOW(), llego_en = COALESCE(llego_en, NOW()),
                  metodo_cobro = $2, monto_cobrado = $3, listo_en = COALESCE(listo_en, NOW()),
                  salio_en = CASE WHEN tipo = 'domicilio' THEN COALESCE(salio_en, NOW()) ELSE salio_en END
            WHERE id = $1`, [id, metodo, monto]);
      }
    }
    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id, accion: 'pedido_' + nuevo, modulo: 'pedidos', referencia_id: id,
      valor_anterior: { estado: actual }, valor_nuevo: { estado: nuevo, motivo: datos.motivo || undefined }
    });
    await conexion.query('COMMIT');
    const enCaja = visibleEnCaja({ ...ped, estado: nuevo });
    const completo = await cargarPedido(pool, id, req.sucursalId);
    emitir(io, req.sucursalId, 'pedido_actualizado', { id, estado: nuevo, repartidor_id: completo.repartidor_id });
    if (nuevo === 'cancelado') emitir(io, req.sucursalId, 'ticket_actualizado', { folio: completo.folio });
    if (enCaja && actual === 'no_entregado') emitir(io, req.sucursalId, 'nuevo_ticket', { folio: completo.folio, total: completo.ticket_total });
    return completo;
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conexion.release();
  }
}

// Foto o firma del cliente al entregar: imágenes pequeñas (la pantalla las reduce antes de mandarlas).
const IMAGEN_OK = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
async function guardarEvidencias(db, req, pedidoId, ev) {
  for (const tipo of ['foto', 'firma']) {
    const dato = ev && ev[tipo];
    if (!dato) continue;
    if (typeof dato !== 'string' || dato.length > 450000 || !IMAGEN_OK.test(dato)) throw new ErrorHttp(400, `La ${tipo} no es válida o pesa demasiado`);
    await db.query('INSERT INTO pedido_evidencias (pedido_id, tipo, dato, creado_por) VALUES ($1, $2, $3, $4)', [pedidoId, tipo, dato, req.usuario.id]);
  }
}

// =================================================================== ZONAS DE ENVÍO
router.get('/zonas', rutaAsync('Error al obtener las zonas', async (req, res) => {
  const todas = req.query.todas === '1' && ROLES_ADMIN.includes(req.usuario.rol);
  const r = await pool.query(
    `SELECT * FROM zonas_envio WHERE sucursal_id = $1 ${todas ? '' : 'AND activo = true'} ORDER BY orden, costo, id`, [req.sucursalId]);
  const cfg = await pool.query('SELECT pedidos_envio_gratis_desde FROM configuracion WHERE sucursal_id = $1', [req.sucursalId]);
  res.json({ zonas: r.rows.map((z) => ({ ...z, costo: Number(z.costo), envio_gratis_desde: aNumero(z.envio_gratis_desde) })),
    envio_gratis_desde: cfg.rows.length ? Number(cfg.rows[0].pedidos_envio_gratis_desde) : 0 });
}));

function validarZona(b) {
  const nombre = textoOnull(b.nombre, 80);
  if (!nombre) return { error: 'El nombre de la zona es requerido' };
  const costo = Number(b.costo);
  if (!Number.isFinite(costo) || costo < 0 || costo > 100000) return { error: 'El costo de envío debe ser 0 o más' };
  let gratis = null;
  if (b.envio_gratis_desde !== undefined && b.envio_gratis_desde !== null && b.envio_gratis_desde !== '') {
    gratis = Number(b.envio_gratis_desde);
    if (!Number.isFinite(gratis) || gratis < 0) return { error: 'El monto para envío gratis no es válido' };
  }
  return { nombre, descripcion: textoOnull(b.descripcion, 160), costo: r2(costo), gratis, orden: Number.isInteger(Number(b.orden)) ? Number(b.orden) : 0 };
}

router.post('/zonas', requiereRol(...ROLES_ADMIN), rutaAsync('Error al guardar la zona', async (req, res) => {
  const z = validarZona(req.body);
  if (z.error) return res.status(400).json({ error: z.error });
  const r = await pool.query(
    `INSERT INTO zonas_envio (sucursal_id, nombre, descripcion, costo, envio_gratis_desde, orden) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.sucursalId, z.nombre, z.descripcion, z.costo, z.gratis, z.orden]);
  res.json(r.rows[0]);
}));

router.put('/zonas/:id', requiereRol(...ROLES_ADMIN), rutaAsync('Error al guardar la zona', async (req, res) => {
  const z = validarZona(req.body);
  if (z.error) return res.status(400).json({ error: z.error });
  const r = await pool.query(
    `UPDATE zonas_envio SET nombre = $1, descripcion = $2, costo = $3, envio_gratis_desde = $4, orden = $5,
            activo = COALESCE($6, activo) WHERE id = $7 AND sucursal_id = $8 RETURNING *`,
    [z.nombre, z.descripcion, z.costo, z.gratis, z.orden, typeof req.body.activo === 'boolean' ? req.body.activo : null, req.params.id, req.sucursalId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Zona no encontrada' });
  res.json(r.rows[0]);
}));

// Una zona no se borra (hay pedidos y direcciones que ya la usaron): se desactiva.
router.delete('/zonas/:id', requiereRol(...ROLES_ADMIN), rutaAsync('Error al quitar la zona', async (req, res) => {
  const r = await pool.query('UPDATE zonas_envio SET activo = false WHERE id = $1 AND sucursal_id = $2 RETURNING id', [req.params.id, req.sucursalId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Zona no encontrada' });
  res.json({ ok: true });
}));

router.get('/cotizar-envio', rutaAsync('Error al calcular el envío', async (req, res) => {
  const calc = await calcularEnvio(pool, req.sucursalId, Number(req.query.zona_id) || null, Number(req.query.subtotal) || 0);
  if (calc.error) return res.status(400).json({ error: calc.error });
  res.json({ costo: calc.costo, gratis: calc.gratis, minimo_gratis: calc.minimo || 0, zona: calc.zona ? calc.zona.nombre : null });
}));

// =================================================================== CLIENTES PARA PEDIDOS
// Busca por nombre o teléfono y trae sus direcciones y cuántos pedidos lleva.
router.get('/clientes', requirePermisoVentas(), rutaAsync('Error al buscar clientes', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const dig = soloDigitos(q);
  const porTel = dig.length >= 3;
  const r = await pool.query(
    `SELECT c.id, c.nombre, c.telefono, c.tipo, c.usa_mayoreo, c.saldo_actual, c.limite_credito,
            (SELECT COUNT(*)::int FROM pedidos p WHERE p.cliente_id = c.id AND p.estado <> 'cancelado') AS n_pedidos,
            (SELECT MAX(p.creado_en) FROM pedidos p WHERE p.cliente_id = c.id AND p.estado <> 'cancelado') AS ultimo_pedido
       FROM clientes c
      WHERE c.sucursal_id = $1 AND c.activo = true
        AND (c.nombre ILIKE $2 ${porTel ? "OR REGEXP_REPLACE(COALESCE(c.telefono, ''), '[^0-9]', '', 'g') LIKE $3" : ''})
      ORDER BY c.nombre LIMIT 8`,
    porTel ? [req.sucursalId, `%${q}%`, `%${dig}%`] : [req.sucursalId, `%${q}%`]);
  const ids = r.rows.map((c) => c.id);
  const dirs = ids.length ? (await pool.query(
    `SELECT * FROM cliente_direcciones WHERE cliente_id = ANY($1) AND activo = true
      ORDER BY principal DESC, ultimo_uso DESC NULLS LAST, id`, [ids])).rows : [];
  res.json(r.rows.map((c) => ({ ...c, saldo_actual: Number(c.saldo_actual || 0), limite_credito: Number(c.limite_credito || 0),
    direcciones: dirs.filter((d) => d.cliente_id === c.id).map((d) => ({ ...d, latitud: aNumero(d.latitud), longitud: aNumero(d.longitud) })) })));
}));

function requirePermisoVentas() { return requierePermiso('VENTAS_CREAR'); }

// =================================================================== REPARTIDORES (para asignar)
router.get('/repartidores', rutaAsync('Error al obtener los repartidores', async (req, res) => {
  const us = await pool.query(
    "SELECT id, nombre, telefono FROM usuarios WHERE sucursal_id = $1 AND rol = 'repartidor' AND activo = true ORDER BY nombre", [req.sucursalId]);
  const ps = await pool.query(
    `${SQL_PEDIDO} WHERE p.sucursal_id = $1 AND p.repartidor_id IS NOT NULL
        AND (p.estado IN ('preparando', 'listo', 'en_camino') OR (p.estado = 'entregado' AND p.liquidacion_id IS NULL))`, [req.sucursalId]);
  const hoy = await pool.query(
    `SELECT repartidor_id, COUNT(*)::int AS n FROM pedidos
      WHERE sucursal_id = $1 AND estado = 'entregado' AND ${localDe('entregado_en')}::date = (${AHORA_LOCAL})::date GROUP BY repartidor_id`, [req.sucursalId]);
  const rows = ps.rows.map(formato);
  res.json(us.rows.map((u) => {
    const mios = rows.filter((p) => p.repartidor_id === u.id);
    const enCamino = mios.filter((p) => p.estado === 'en_camino');
    const aEntregar = mios.filter((p) => p.estado === 'entregado' && p.pago_modo === 'al_recibir' && p.ticket_estado === 'pendiente');
    const suma = (a) => r2(a.reduce((s, p) => s + (p.resta || 0), 0));   // lo que el repartidor cobra: total menos anticipo
    return {
      ...u,
      en_camino: enCamino.length,
      por_salir: mios.filter((p) => ['preparando', 'listo'].includes(p.estado)).length,
      trae_por_cobrar: suma(enCamino.filter((p) => p.pago_modo === 'al_recibir')),
      por_entregar_a_caja: suma(aEntregar),
      efectivo_por_entregar: suma(aEntregar.filter((p) => (p.metodo_cobro || 'efectivo') === 'efectivo')),
      pedidos_por_liquidar: mios.filter((p) => p.estado === 'entregado').length,
      entregas_hoy: ((hoy.rows.find((h) => h.repartidor_id === u.id) || {}).n) || 0,
      estado: enCamino.length ? 'en_ruta' : 'libre'
    };
  }));
}));

// =================================================================== LISTA / TABLERO / AGENDA
router.get('/', rutaAsync('Error al obtener los pedidos', async (req, res) => {
  const io = req.app.get('io');
  await avanzarProgramados(io, req.sucursalId);
  await asegurarFijos(io, req.sucursalId);

  const cond = ['p.sucursal_id = $1'];
  const vals = [req.sucursalId];
  const push = (v) => { vals.push(v); return `$${vals.length}`; };

  const fecha = validarFecha(req.query.fecha);
  const desde = validarFecha(req.query.desde), hasta = validarFecha(req.query.hasta);
  if (fecha === false || desde === false || hasta === false) return res.status(400).json({ error: 'Fecha inválida' });

  if (fecha) {
    // El día pedido + lo que quedó pendiente de días anteriores (para que nada se pierda de vista).
    const f = push(fecha);
    cond.push(`(p.fecha_entrega = ${f}::date OR (p.fecha_entrega < ${f}::date AND p.estado IN ('programado', 'preparando', 'listo', 'en_camino', 'no_entregado')))`);
  }
  if (desde) cond.push(`p.fecha_entrega >= ${push(desde)}::date`);
  if (hasta) cond.push(`p.fecha_entrega <= ${push(hasta)}::date`);
  if (req.query.estado) {
    const estados = String(req.query.estado).split(',').filter((e) => U.ESTADOS.includes(e));
    if (estados.length) cond.push(`p.estado = ANY(${push(estados)})`);
  }
  if (req.query.tipo && ['domicilio', 'recoger'].includes(req.query.tipo)) cond.push(`p.tipo = ${push(req.query.tipo)}`);
  if (req.query.repartidor_id && /^\d+$/.test(req.query.repartidor_id)) cond.push(`p.repartidor_id = ${push(Number(req.query.repartidor_id))}`);
  if (req.query.cliente_id && /^\d+$/.test(req.query.cliente_id)) cond.push(`p.cliente_id = ${push(Number(req.query.cliente_id))}`);
  if (req.query.q) {
    const q = String(req.query.q).trim().slice(0, 60);
    const t = push(`%${q}%`);
    const dig = soloDigitos(q);
    cond.push(`(p.nombre_contacto ILIKE ${t} OR t.folio ILIKE ${t} OR p.calle ILIKE ${t} OR p.colonia ILIKE ${t}
      ${dig.length >= 3 ? `OR REGEXP_REPLACE(COALESCE(p.telefono, ''), '[^0-9]', '', 'g') LIKE ${push('%' + dig + '%')}` : ''})`);
  }
  const limite = Math.min(Math.max(parseInt(req.query.limit, 10) || 400, 1), 1000);
  const r = await pool.query(
    `${SQL_PEDIDO} WHERE ${cond.join(' AND ')}
      ORDER BY p.fecha_entrega ASC, p.programado_para ASC NULLS FIRST, p.id ASC LIMIT ${limite}`, vals);
  res.json(r.rows.map(formato));
}));

// Números de arriba del tablero y estado de los repartidores.
router.get('/resumen', rutaAsync('Error al obtener el resumen', async (req, res) => {
  await avanzarProgramados(req.app.get('io'), req.sucursalId);
  const fecha = validarFecha(req.query.fecha);
  if (fecha === false) return res.status(400).json({ error: 'Fecha inválida' });
  const f = fecha || (await pool.query(`SELECT to_char((${AHORA_LOCAL})::date, 'YYYY-MM-DD') AS f`)).rows[0].f;
  const r = await pool.query(
    `WITH x AS (${SQL_PEDIDO} WHERE p.sucursal_id = $1)
     SELECT
       COUNT(*) FILTER (WHERE fecha_entrega = $2::date AND estado <> 'cancelado')::int AS pedidos_dia,
       COUNT(*) FILTER (WHERE estado = 'en_camino')::int AS en_camino,
       COALESCE(SUM(GREATEST(total_neto - anticipo, 0)) FILTER (WHERE tipo = 'domicilio' AND pago_modo = 'al_recibir' AND ticket_estado = 'pendiente' AND estado IN ('en_camino', 'entregado')), 0) AS por_cobrar,
       COUNT(*) FILTER (WHERE retraso_min > 0)::int AS con_retraso,
       COALESCE(SUM(total_neto) FILTER (WHERE estado = 'entregado' AND ${localDe('entregado_en')}::date = $2::date), 0) AS entregado_hoy,
       COUNT(*) FILTER (WHERE estado = 'programado' AND fecha_entrega > $2::date)::int AS futuros
     FROM x WHERE (fecha_entrega = $2::date OR estado IN ('programado', 'preparando', 'listo', 'en_camino', 'no_entregado') OR (estado = 'entregado' AND liquidacion_id IS NULL))`,
    [req.sucursalId, f]);
  const k = r.rows[0];
  res.json({ fecha: f, pedidos_dia: k.pedidos_dia, en_camino: k.en_camino, por_cobrar: Number(k.por_cobrar), con_retraso: k.con_retraso, entregado_hoy: Number(k.entregado_hoy), futuros: k.futuros });
}));

// Hoja de producción: cuánto hay que preparar de cada producto para un día.
router.get('/produccion', rutaAsync('Error al armar la hoja de producción', async (req, res) => {
  await avanzarProgramados(req.app.get('io'), req.sucursalId);
  const fecha = validarFecha(req.query.fecha);
  if (!fecha) return res.status(400).json({ error: 'Indica la fecha (AAAA-MM-DD)' });
  const estados = req.query.todos === '1' ? ['programado', 'preparando', 'listo', 'en_camino', 'entregado'] : ['programado', 'preparando'];
  const ps = await pool.query(`${SQL_PEDIDO} WHERE p.sucursal_id = $1 AND p.fecha_entrega = $2::date AND p.estado = ANY($3)
      ORDER BY p.programado_para ASC NULLS FIRST, p.id`, [req.sucursalId, fecha, estados]);
  const pedidos = [];
  const acum = new Map();
  for (const row of ps.rows) {
    const p = formato(row);
    const items = (await itemsDelTicket(pool, p.ticket_id)).filter((i) => !i.es_envio);
    pedidos.push({ id: p.id, etiqueta: p.etiqueta, estado: p.estado, tipo: p.tipo, cliente: p.nombre_contacto, hora: p.programado_para ? p.programado_para.slice(11) : null, repartidor_nombre: p.repartidor_nombre,
      items: items.map((i) => ({ nombre: i.nombre_producto, cantidad: i.cantidad, tipo_venta: i.tipo_venta || null })) });
    for (const i of items) {
      const clave = (i.producto_id ? 'p' + i.producto_id : 'n' + i.nombre_producto);
      const a = acum.get(clave) || { producto_id: i.producto_id, nombre: i.nombre_producto, tipo_venta: i.tipo_venta || null, cantidad: 0, pedidos: 0 };
      a.cantidad = Math.round((a.cantidad + i.cantidad) * 1000) / 1000;
      a.pedidos += 1;
      acum.set(clave, a);
    }
  }
  res.json({ fecha, productos: [...acum.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')), pedidos });
}));

// Ruta del día: las paradas a domicilio en orden (se puede reordenar).
router.get('/ruta', rutaAsync('Error al armar la ruta', async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  if (!fecha) return res.status(400).json({ error: 'Indica la fecha (AAAA-MM-DD)' });
  const vals = [req.sucursalId, fecha];
  let filtro = '';
  if (req.query.repartidor_id === 'ninguno') filtro = ' AND p.repartidor_id IS NULL';
  else if (/^\d+$/.test(req.query.repartidor_id || '')) { vals.push(Number(req.query.repartidor_id)); filtro = ' AND p.repartidor_id = $3'; }
  const r = await pool.query(
    `${SQL_PEDIDO} WHERE p.sucursal_id = $1 AND p.tipo = 'domicilio' AND p.fecha_entrega = $2::date
        AND p.estado IN ('programado', 'preparando', 'listo', 'en_camino') ${filtro}
      ORDER BY p.orden_ruta ASC NULLS LAST, p.programado_para ASC NULLS LAST, p.id`, vals);
  res.json(r.rows.map(formato));
}));

router.put('/ruta/orden', requierePermiso('VENTAS_CREAR'), rutaAsync('Error al guardar el orden', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length || ids.length > 300) return res.status(400).json({ error: 'Lista de pedidos inválida' });
  await pool.query(
    `UPDATE pedidos p SET orden_ruta = x.pos FROM (SELECT id, ord::int AS pos FROM UNNEST($1::int[]) WITH ORDINALITY AS t(id, ord)) x
      WHERE p.id = x.id AND p.sucursal_id = $2`, [ids, req.sucursalId]);
  emitir(req.app.get('io'), req.sucursalId, 'pedido_actualizado', { id: null, estado: null });
  res.json({ ok: true });
}));

// =================================================================== MÓDULO DEL REPARTIDOR
// Solo los usuarios con rol «Repartidor» toman, llevan y entregan pedidos. El dueño y el gerente ASIGNAN el
// repartidor (y corrigen entregas) desde la pantalla de Pedidos, pero no quedan registrados como repartidores.
const rolesReparto = requiereRol('repartidor');

function resumenParaRepartidor(p) {
  return {
    id: p.id, etiqueta: p.etiqueta, folio: p.folio, estado: p.estado, tipo: p.tipo,
    nombre_contacto: p.nombre_contacto, telefono: p.telefono,
    calle: p.calle, colonia: p.colonia, cp: p.cp, ciudad: p.ciudad, referencias: p.referencias,
    latitud: p.latitud, longitud: p.longitud, ubicacion_enlace: p.ubicacion_enlace,
    programado_para: p.programado_para, retraso_min: p.retraso_min, notas: p.notas,
    pago_modo: p.pago_modo, por_cobrar: p.por_cobrar, total_neto: p.total_neto, paga_con: p.paga_con, cambio: p.cambio,
    anticipo: p.anticipo, anticipo_metodo: p.anticipo_metodo, resta: p.resta, estado_cobro: p.estado_cobro,
    metodo_cobro: p.metodo_cobro, monto_cobrado: p.monto_cobrado, repartidor_id: p.repartidor_id,
    salio_en: p.salio_en, llego_en: p.llego_en, entregado_en: p.entregado_en, motivo_no_entrega: p.motivo_no_entrega, n_items: p.n_items
  };
}

router.get('/repartidor/mis-pedidos', rolesReparto, rutaAsync('Error al obtener tus entregas', async (req, res) => {
  const io = req.app.get('io');
  await avanzarProgramados(io, req.sucursalId);
  const base = `${SQL_PEDIDO} WHERE p.sucursal_id = $1 AND p.tipo = 'domicilio'`;
  const orden = 'ORDER BY p.orden_ruta ASC NULLS LAST, p.programado_para ASC NULLS LAST, p.id';
  const mios = await pool.query(`${base} AND p.repartidor_id = $2 AND p.estado IN ('preparando', 'listo', 'en_camino') ${orden}`, [req.sucursalId, req.usuario.id]);
  const hechos = await pool.query(
    `${base} AND p.repartidor_id = $2 AND p.estado IN ('entregado', 'no_entregado')
        AND ${localDe('COALESCE(p.entregado_en, p.llego_en, p.creado_en)')}::date = (${AHORA_LOCAL})::date
      ORDER BY COALESCE(p.entregado_en, p.llego_en) DESC`, [req.sucursalId, req.usuario.id]);
  const libres = await pool.query(`${base} AND p.repartidor_id IS NULL AND p.estado = 'listo' ${orden}`, [req.sucursalId]);
  const cfg = await pool.query('SELECT pedidos_foto_obligatoria, pedidos_firma_obligatoria, nombre_negocio FROM configuracion WHERE sucursal_id = $1', [req.sucursalId]);
  const items = async (rows) => Promise.all(rows.map(async (row) => {
    const p = formato(row);
    const r = resumenParaRepartidor(p);
    r.items = (await itemsDelTicket(pool, p.ticket_id)).filter((i) => !i.es_envio).map((i) => ({ nombre: i.nombre_producto, cantidad: i.cantidad, tipo_venta: i.tipo_venta || null }));
    return r;
  }));
  res.json({
    repartidor: { id: req.usuario.id, nombre: req.usuario.nombre },
    negocio: cfg.rows.length ? cfg.rows[0].nombre_negocio : null,
    foto_obligatoria: cfg.rows.length ? cfg.rows[0].pedidos_foto_obligatoria : false,
    firma_obligatoria: cfg.rows.length ? cfg.rows[0].pedidos_firma_obligatoria : false,
    pendientes: await items(mios.rows),
    hechos_hoy: await items(hechos.rows),
    disponibles: await items(libres.rows)
  });
}));

// Su corte: todo lo entregado que todavía no ha liquidado en Caja.
router.get('/repartidor/mi-corte', rolesReparto, rutaAsync('Error al armar tu corte', async (req, res) => {
  res.json(await armarLiquidacion(req.sucursalId, req.usuario.id));
}));

router.post('/repartidor/:id/tomar', rolesReparto, rutaAsync('Error al tomar el pedido', async (req, res) => {
  const r = await pool.query(
    `UPDATE pedidos SET repartidor_id = $3 WHERE id = $1 AND sucursal_id = $2 AND tipo = 'domicilio' AND estado = 'listo' AND repartidor_id IS NULL RETURNING id`,
    [req.params.id, req.sucursalId, req.usuario.id]);
  if (!r.rows.length) return res.status(409).json({ error: 'Este pedido ya lo tomó otra persona o ya no está disponible' });
  emitir(req.app.get('io'), req.sucursalId, 'pedido_actualizado', { id: Number(req.params.id), estado: 'listo', repartidor_id: req.usuario.id });
  res.json(await cargarPedido(pool, req.params.id, req.sucursalId));
}));

router.post('/repartidor/:id/salir', rolesReparto, rutaAsync('Error al salir con el pedido', async (req, res) => {
  res.json(await transicionar(req, req.params.id, 'en_camino', {}, { soloRepartidor: true }));
}));

router.post('/repartidor/:id/llegue', rolesReparto, rutaAsync('Error al avisar que llegaste', async (req, res) => {
  const r = await pool.query(
    "UPDATE pedidos SET llego_en = COALESCE(llego_en, NOW()) WHERE id = $1 AND sucursal_id = $2 AND repartidor_id = $3 AND estado = 'en_camino' RETURNING id",
    [req.params.id, req.sucursalId, req.usuario.id]);
  if (!r.rows.length) return res.status(409).json({ error: 'Este pedido no está en camino contigo' });
  emitir(req.app.get('io'), req.sucursalId, 'pedido_actualizado', { id: Number(req.params.id), estado: 'en_camino', repartidor_id: req.usuario.id });
  res.json(await cargarPedido(pool, req.params.id, req.sucursalId));
}));

router.post('/repartidor/:id/entregar', rolesReparto, rutaAsync('Error al registrar la entrega', async (req, res) => {
  const cfg = await pool.query('SELECT pedidos_foto_obligatoria, pedidos_firma_obligatoria FROM configuracion WHERE sucursal_id = $1', [req.sucursalId]);
  const c = cfg.rows[0] || {};
  const ev = req.body.evidencias || {};
  if (c.pedidos_foto_obligatoria && !ev.foto) return res.status(400).json({ error: 'Falta la foto de la entrega' });
  if (c.pedidos_firma_obligatoria && !ev.firma) return res.status(400).json({ error: 'Falta la firma del cliente' });
  res.json(await transicionar(req, req.params.id, 'entregado', { metodo_cobro: req.body.metodo_cobro }, { soloRepartidor: true, evidencias: ev }));
}));

router.post('/repartidor/:id/no-entregado', rolesReparto, rutaAsync('Error al registrar que no se entregó', async (req, res) => {
  res.json(await transicionar(req, req.params.id, 'no_entregado', { motivo: req.body.motivo }, { soloRepartidor: true }));
}));

// =================================================================== LIQUIDACIÓN DEL REPARTIDOR
async function armarLiquidacion(sucursalId, repartidorId) {
  const r = await pool.query(
    `${SQL_PEDIDO} WHERE p.sucursal_id = $1 AND p.repartidor_id = $2 AND p.tipo = 'domicilio'
        AND p.estado = 'entregado' AND p.liquidacion_id IS NULL ORDER BY p.entregado_en ASC`, [sucursalId, repartidorId]);
  const u = await pool.query('SELECT id, nombre, telefono FROM usuarios WHERE id = $1 AND sucursal_id = $2', [repartidorId, sucursalId]);
  const pedidos = r.rows.map(formato);
  const sumas = { efectivo: 0, transferencia: 0, tarjeta: 0, pagados_antes: 0, credito: 0, ya_cobrados_en_caja: 0, n_efectivo: 0 };
  const detalle = pedidos.map((p) => {
    let tipo;
    if (p.pago_modo === 'al_recibir') {
      if (p.ticket_estado !== 'pendiente') { tipo = 'ya_cobrado_en_caja'; sumas.ya_cobrados_en_caja += p.total_neto; }
      else { tipo = p.metodo_cobro || 'efectivo'; sumas[tipo] += p.resta; if (tipo === 'efectivo') sumas.n_efectivo += 1; }   // lo que el repartidor cobró: la resta
    } else if (p.pago_modo === 'credito') { tipo = 'credito'; sumas.credito += p.total_neto; }
    else { tipo = 'pagado_antes'; sumas.pagados_antes += p.total_neto; }
    return { ...resumenParaRepartidor(p), cobro: tipo };
  });
  for (const k of Object.keys(sumas)) if (k !== 'n_efectivo') sumas[k] = r2(sumas[k]);
  const hechas = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE estado = 'entregado')::int AS entregadas, COUNT(*) FILTER (WHERE estado = 'no_entregado')::int AS no_entregadas
       FROM pedidos WHERE sucursal_id = $1 AND repartidor_id = $2 AND tipo = 'domicilio' AND liquidacion_id IS NULL AND estado IN ('entregado', 'no_entregado')`, [sucursalId, repartidorId]);
  return { repartidor: u.rows[0] || null, pedidos: detalle, resumen: sumas, entregadas: hechas.rows[0].entregadas, no_entregadas: hechas.rows[0].no_entregadas,
    debe_entregar_efectivo: sumas.efectivo };
}

router.get('/liquidacion/:repartidorId', requierePermiso('CAJA_MOVIMIENTO'), rutaAsync('Error al armar la liquidación', async (req, res) => {
  const rep = await pool.query("SELECT id FROM usuarios WHERE id = $1 AND sucursal_id = $2 AND rol = 'repartidor'", [req.params.repartidorId, req.sucursalId]);
  if (!rep.rows.length) return res.status(404).json({ error: 'Repartidor no encontrado' });
  res.json(await armarLiquidacion(req.sucursalId, Number(req.params.repartidorId)));
}));

router.post('/liquidar', requierePermiso('CAJA_MOVIMIENTO'), async (req, res) => {
  const conexion = await pool.connect();
  const cobrados = [];
  try {
    const repartidorId = Number(req.body.repartidor_id);
    const turnoId = Number(req.body.turno_id);
    const entregado = Number(req.body.efectivo_entregado);
    if (!Number.isInteger(repartidorId) || repartidorId <= 0) throw new ErrorHttp(400, 'Elige al repartidor');
    if (!Number.isInteger(turnoId) || turnoId <= 0) throw new ErrorHttp(400, 'Abre tu turno de caja para recibir el dinero');
    if (!Number.isFinite(entregado) || entregado < 0) throw new ErrorHttp(400, 'Escribe cuánto efectivo entregó el repartidor');

    await conexion.query('BEGIN');
    const turno = await conexion.query("SELECT id FROM turnos WHERE id = $1 AND sucursal_id = $2 AND estado = 'abierto'", [turnoId, req.sucursalId]);
    if (!turno.rows.length) throw new ErrorHttp(400, 'El turno de caja no está abierto');
    const rep = await conexion.query("SELECT id, nombre FROM usuarios WHERE id = $1 AND sucursal_id = $2 AND rol = 'repartidor'", [repartidorId, req.sucursalId]);
    if (!rep.rows.length) throw new ErrorHttp(404, 'Repartidor no encontrado');

    const filtroIds = Array.isArray(req.body.pedido_ids) && req.body.pedido_ids.length ? req.body.pedido_ids.map(Number).filter(Number.isInteger) : null;
    const lista = await conexion.query(
      `${SQL_PEDIDO} WHERE p.sucursal_id = $1 AND p.repartidor_id = $2 AND p.tipo = 'domicilio' AND p.estado = 'entregado' AND p.liquidacion_id IS NULL
          ${filtroIds ? 'AND p.id = ANY($3)' : ''} ORDER BY p.entregado_en FOR UPDATE OF p`,
      filtroIds ? [req.sucursalId, repartidorId, filtroIds] : [req.sucursalId, repartidorId]);
    if (!lista.rows.length) throw new ErrorHttp(400, 'Este repartidor no tiene entregas pendientes por liquidar');

    const tot = { efectivo: 0, transferencia: 0, tarjeta: 0 };
    const todosAgotados = [];
    for (const row of lista.rows) {
      const p = formato(row);
      if (p.pago_modo !== 'al_recibir' || p.ticket_estado !== 'pendiente') continue;
      const metodo = p.metodo_cobro || 'efectivo';
      const neto = p.total_neto;
      const resta = p.resta;                 // lo que el repartidor cobró en la puerta
      // El ticket se cobra por el TOTAL: la resta (como la pagó el cliente al repartidor) + el anticipo (con lo que lo dejó).
      // El anticipo en efectivo ya está en la caja desde que se recibió; por eso cuenta como efectivo del ticket.
      const efectivo = r2((metodo === 'efectivo' ? resta : 0) + (p.anticipo_metodo === 'efectivo' ? p.anticipo : 0));
      const monto = { efectivo, tarjeta: r2(neto - efectivo) };
      const metodoPago = p.anticipo > 0 && monto.efectivo > 0 && monto.tarjeta > 0 ? 'mixto'
        : monto.efectivo > 0 ? 'efectivo'
        : (metodo !== 'efectivo' ? metodo : p.anticipo_metodo);
      const upd = await conexion.query(
        `UPDATE tickets SET estado = 'pagado', cajero_usuario_id = $1, metodo_pago = $2, monto_efectivo = $3, monto_tarjeta = $4,
                turno_id = $5, fecha_pago = NOW(), efectivo_recibido = $6
          WHERE id = $7 AND estado = 'pendiente' RETURNING id`,
        [req.usuario.id, metodoPago, monto.efectivo, monto.tarjeta, turnoId, monto.efectivo > 0 ? monto.efectivo : null, p.ticket_id]);
      if (!upd.rows.length) continue;
      todosAgotados.push(...(await descontarInventarioVenta(conexion, p.ticket_id, req.usuario.id)));
      tot[metodo] = r2(tot[metodo] + resta);
      cobrados.push(p.ticket_id);
    }
    const esperado = r2(tot.efectivo);
    const dif = r2(entregado - esperado);
    const liq = (await conexion.query(
      `INSERT INTO liquidaciones_repartidor (sucursal_id, repartidor_id, turno_id, recibido_por, num_pedidos, esperado_efectivo, entregado_efectivo, diferencia, total_transferencia, total_tarjeta, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.sucursalId, repartidorId, turnoId, req.usuario.id, lista.rows.length, esperado, r2(entregado), dif, tot.transferencia, tot.tarjeta, textoOnull(req.body.notas, 300)])).rows[0];
    await conexion.query('UPDATE pedidos SET liquidacion_id = $1 WHERE id = ANY($2)', [liq.id, lista.rows.map((x) => x.id)]);
    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id, accion: 'liquidar_repartidor', modulo: 'pedidos', referencia_id: liq.id,
      valor_nuevo: { repartidor: rep.rows[0].nombre, pedidos: lista.rows.length, esperado, entregado: r2(entregado), diferencia: dif }
    });
    await conexion.query('COMMIT');

    const io = req.app.get('io');
    for (const tid of cobrados) emitir(io, req.sucursalId, 'ticket_pagado', { id: tid });
    emitir(io, req.sucursalId, 'pedido_actualizado', { id: null, estado: 'entregado' });
    res.json({ ok: true, liquidacion: { ...liq, esperado_efectivo: Number(liq.esperado_efectivo), entregado_efectivo: Number(liq.entregado_efectivo), diferencia: Number(liq.diferencia),
      total_transferencia: Number(liq.total_transferencia), total_tarjeta: Number(liq.total_tarjeta) }, repartidor: rep.rows[0].nombre, productos_agotados: [...new Set(todosAgotados)] });
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    responderError(res, err, 'Error al liquidar al repartidor');
  } finally {
    conexion.release();
  }
});

router.get('/liquidaciones', requierePermiso('CAJA_MOVIMIENTO'), rutaAsync('Error al obtener las liquidaciones', async (req, res) => {
  const r = await pool.query(
    `SELECT l.*, u.nombre AS repartidor_nombre, r.nombre AS recibido_por_nombre FROM liquidaciones_repartidor l
       LEFT JOIN usuarios u ON u.id = l.repartidor_id LEFT JOIN usuarios r ON r.id = l.recibido_por
      WHERE l.sucursal_id = $1 ORDER BY l.id DESC LIMIT 60`, [req.sucursalId]);
  res.json(r.rows.map((l) => ({ ...l, esperado_efectivo: Number(l.esperado_efectivo), entregado_efectivo: Number(l.entregado_efectivo), diferencia: Number(l.diferencia),
    total_transferencia: Number(l.total_transferencia), total_tarjeta: Number(l.total_tarjeta) })));
}));

// Reporte de repartidores: entregas, a tiempo, tiempos y dinero.
router.get('/reporte-repartidores', requiereRol(...ROLES_ADMIN), rutaAsync('Error al armar el reporte', async (req, res) => {
  const desde = validarFecha(req.query.desde), hasta = validarFecha(req.query.hasta);
  if (!desde || !hasta) return res.status(400).json({ error: 'Indica desde y hasta (AAAA-MM-DD)' });
  const r = await pool.query(
    `WITH x AS (${SQL_PEDIDO} WHERE p.sucursal_id = $1 AND p.tipo = 'domicilio' AND p.repartidor_id IS NOT NULL AND p.fecha_entrega BETWEEN $2::date AND $3::date)
     SELECT repartidor_id, MAX(repartidor_nombre) AS nombre,
            COUNT(*) FILTER (WHERE estado = 'entregado')::int AS entregas,
            COUNT(*) FILTER (WHERE estado = 'no_entregado')::int AS no_entregadas,
            COALESCE(SUM(total_neto) FILTER (WHERE estado = 'entregado'), 0) AS total_entregado,
            COALESCE(SUM(costo_envio) FILTER (WHERE estado = 'entregado'), 0) AS envios,
            COALESCE(AVG(EXTRACT(EPOCH FROM (entregado_en - salio_en)) / 60) FILTER (WHERE estado = 'entregado' AND salio_en IS NOT NULL), 0) AS min_promedio,
            COUNT(*) FILTER (WHERE estado = 'entregado' AND programado_para IS NOT NULL AND ${localDe('entregado_en')} <= programado_para + INTERVAL '10 minutes')::int AS a_tiempo,
            COUNT(*) FILTER (WHERE estado = 'entregado' AND programado_para IS NOT NULL)::int AS con_hora
       FROM x GROUP BY repartidor_id ORDER BY entregas DESC`, [req.sucursalId, desde, hasta]);
  const liq = await pool.query(
    `SELECT repartidor_id, COUNT(*)::int AS liquidaciones, COALESCE(SUM(diferencia), 0) AS diferencia
       FROM liquidaciones_repartidor WHERE sucursal_id = $1 AND ${localDe('creada_en')}::date BETWEEN $2::date AND $3::date GROUP BY repartidor_id`, [req.sucursalId, desde, hasta]);
  res.json(r.rows.map((x) => {
    const l = liq.rows.find((q) => q.repartidor_id === x.repartidor_id);
    return { repartidor_id: x.repartidor_id, nombre: x.nombre, entregas: x.entregas, no_entregadas: x.no_entregadas, total_entregado: Number(x.total_entregado),
      envios: Number(x.envios), min_promedio: Math.round(Number(x.min_promedio)), a_tiempo: x.a_tiempo, con_hora: x.con_hora,
      liquidaciones: l ? l.liquidaciones : 0, diferencia: l ? Number(l.diferencia) : 0 };
  }));
}));

// =================================================================== PEDIDOS FIJOS
function validarFijo(b) {
  const dias = [...new Set((Array.isArray(b.dias) ? b.dias : String(b.dias || '').split(',')).map((d) => parseInt(d, 10)).filter((d) => d >= 0 && d <= 6))].sort();
  if (!dias.length) return { error: 'Elige al menos un día de la semana' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.hora || ''))) return { error: 'La hora de entrega debe verse así: 09:00' };
  const tipo = b.tipo === 'recoger' ? 'recoger' : 'domicilio';
  const pago = PAGO_MODOS.includes(b.pago_modo) ? b.pago_modo : 'credito';
  const items = (Array.isArray(b.items) ? b.items : []).map((i) => ({ producto_id: Number(i.producto_id), nombre: textoOnull(i.nombre, 150), cantidad: Number(i.cantidad) }));
  if (!items.length || items.length > 100) return { error: 'Agrega al menos un producto al pedido fijo' };
  if (items.some((i) => !Number.isInteger(i.producto_id) || i.producto_id <= 0 || !Number.isFinite(i.cantidad) || i.cantidad <= 0)) return { error: 'Hay un producto con cantidad inválida' };
  return { dias: dias.join(','), hora: String(b.hora), tipo, pago_modo: pago, items, nombre: textoOnull(b.nombre, 100), notas: textoOnull(b.notas, 300) };
}

const SQL_FIJO = `
  SELECT f.*, c.nombre AS cliente_nombre, c.telefono AS cliente_telefono, c.tipo AS cliente_tipo,
         cd.calle, cd.colonia, cd.alias AS direccion_alias, u.nombre AS repartidor_nombre
    FROM pedidos_fijos f
    JOIN clientes c ON c.id = f.cliente_id
    LEFT JOIN cliente_direcciones cd ON cd.id = f.direccion_id
    LEFT JOIN usuarios u ON u.id = f.repartidor_id`;

// Con ?todos=1 también salen los pausados (para poder reanudarlos).
router.get('/fijos', rutaAsync('Error al obtener los pedidos fijos', async (req, res) => {
  const r = await pool.query(`${SQL_FIJO} WHERE f.sucursal_id = $1 AND ($2::boolean OR f.activo = true) ORDER BY f.activo DESC, c.nombre, f.id`, [req.sucursalId, req.query.todos === '1']);
  res.json(r.rows);
}));

async function validarRelacionesFijo(db, sucursalId, b, v) {
  const c = await db.query('SELECT * FROM clientes WHERE id = $1 AND sucursal_id = $2 AND activo = true', [b.cliente_id, sucursalId]);
  if (!c.rows.length) throw new ErrorHttp(400, 'Elige un cliente');
  let direccionId = null;
  if (v.tipo === 'domicilio') {
    if (!b.direccion_id) throw new ErrorHttp(400, 'Elige la dirección de entrega');
    const d = await db.query('SELECT id, zona_id FROM cliente_direcciones WHERE id = $1 AND cliente_id = $2 AND activo = true', [b.direccion_id, c.rows[0].id]);
    if (!d.rows.length) throw new ErrorHttp(400, 'Esa dirección no es de este cliente');
    direccionId = d.rows[0].id;
  }
  if (v.pago_modo === 'credito' && !c.rows[0]) throw new ErrorHttp(400, 'Elige un cliente');
  let zonaId = null;
  if (b.zona_id) {
    const z = await db.query('SELECT id FROM zonas_envio WHERE id = $1 AND sucursal_id = $2', [b.zona_id, sucursalId]);
    if (!z.rows.length) throw new ErrorHttp(400, 'La zona de envío no existe');
    zonaId = z.rows[0].id;
  }
  const repartidorId = await repartidorValido(db, sucursalId, b.repartidor_id);
  const ids = v.items.map((i) => i.producto_id);
  const ps = await db.query('SELECT id, nombre FROM productos WHERE id = ANY($1) AND sucursal_id = $2', [ids, sucursalId]);
  if (ps.rows.length !== new Set(ids).size) throw new ErrorHttp(400, 'Hay un producto que ya no existe');
  v.items.forEach((i) => { i.nombre = i.nombre || ps.rows.find((p) => p.id === i.producto_id).nombre; });
  return { cliente: c.rows[0], direccionId, zonaId, repartidorId };
}

router.post('/fijos', requiereRol(...ROLES_ADMIN), rutaAsync('Error al guardar el pedido fijo', async (req, res) => {
  const v = validarFijo(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const rel = await validarRelacionesFijo(pool, req.sucursalId, req.body, v);
  const r = await pool.query(
    `INSERT INTO pedidos_fijos (sucursal_id, cliente_id, direccion_id, nombre, dias, hora, tipo, pago_modo, zona_id, repartidor_id, items, notas)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING id`,
    [req.sucursalId, rel.cliente.id, rel.direccionId, v.nombre, v.dias, v.hora, v.tipo, v.pago_modo, rel.zonaId, rel.repartidorId, JSON.stringify(v.items), v.notas]);
  await registrarBitacora(pool, { usuario_id: req.usuario.id, accion: 'crear_pedido_fijo', modulo: 'pedidos', referencia_id: r.rows[0].id, valor_nuevo: { cliente: rel.cliente.nombre, dias: v.dias, hora: v.hora } });
  res.json((await pool.query(`${SQL_FIJO} WHERE f.id = $1`, [r.rows[0].id])).rows[0]);
}));

router.put('/fijos/:id', requiereRol(...ROLES_ADMIN), rutaAsync('Error al guardar el pedido fijo', async (req, res) => {
  const v = validarFijo(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const ya = await pool.query('SELECT id FROM pedidos_fijos WHERE id = $1 AND sucursal_id = $2', [req.params.id, req.sucursalId]);
  if (!ya.rows.length) return res.status(404).json({ error: 'Pedido fijo no encontrado' });
  const rel = await validarRelacionesFijo(pool, req.sucursalId, req.body, v);
  await pool.query(
    `UPDATE pedidos_fijos SET cliente_id = $1, direccion_id = $2, nombre = $3, dias = $4, hora = $5, tipo = $6, pago_modo = $7,
            zona_id = $8, repartidor_id = $9, items = $10::jsonb, notas = $11, activo = COALESCE($12, activo) WHERE id = $13`,
    [rel.cliente.id, rel.direccionId, v.nombre, v.dias, v.hora, v.tipo, v.pago_modo, rel.zonaId, rel.repartidorId, JSON.stringify(v.items), v.notas,
     typeof req.body.activo === 'boolean' ? req.body.activo : null, req.params.id]);
  res.json((await pool.query(`${SQL_FIJO} WHERE f.id = $1`, [req.params.id])).rows[0]);
}));

router.delete('/fijos/:id', requiereRol(...ROLES_ADMIN), rutaAsync('Error al quitar el pedido fijo', async (req, res) => {
  // Quitar = borrarlo de verdad (los pedidos que ya salieron de él se quedan como están). Pausar es otra cosa: activo = false.
  const r = await pool.query('DELETE FROM pedidos_fijos WHERE id = $1 AND sucursal_id = $2 RETURNING id', [req.params.id, req.sucursalId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Pedido fijo no encontrado' });
  res.json({ ok: true });
}));

// Genera los pedidos de un día a partir de los fijos que tocan ese día (no duplica: uno por fijo por día).
async function generarFijosDelDia(io, sucursalId, fecha, { omitirNuevosYaPasados = false } = {}) {
  // Un pedido fijo creado HOY cuya hora de hoy ya pasó no genera el pedido de hoy (empieza mañana).
  const fijos = await pool.query(
    `${SQL_FIJO} WHERE f.sucursal_id = $1 AND f.activo = true AND c.activo = true
        AND (',' || f.dias || ',') LIKE '%,' || EXTRACT(DOW FROM $2::date)::int || ',%'
        AND NOT ($3::boolean AND ${localDe('f.creado_en')}::date = $2::date AND f.hora <= to_char(${AHORA_LOCAL}, 'HH24:MI'))
      ORDER BY f.hora, f.id`, [sucursalId, fecha, omitirNuevosYaPasados]);
  const resultado = { creados: 0, omitidos: 0, errores: [] };
  for (const f of fijos.rows) {
    const conexion = await pool.connect();
    try {
      const ya = await conexion.query('SELECT 1 FROM pedidos WHERE pedido_fijo_id = $1 AND fecha_entrega = $2::date', [f.id, fecha]);
      if (ya.rows.length) { resultado.omitidos++; continue; }
      await conexion.query('BEGIN');
      const items = await armarItemsFijo(conexion, sucursalId, f);
      if (!items.length) throw new ErrorHttp(400, 'ningún producto del pedido fijo está disponible');
      const cliente = (await conexion.query('SELECT * FROM clientes WHERE id = $1', [f.cliente_id])).rows[0];
      let direccion = null;
      if (f.tipo === 'domicilio' && f.direccion_id) direccion = (await conexion.query('SELECT * FROM cliente_direcciones WHERE id = $1', [f.direccion_id])).rows[0];
      const rep = f.repartidor_id ? (await conexion.query("SELECT id FROM usuarios WHERE id = $1 AND rol = 'repartidor' AND activo = true", [f.repartidor_id])).rows[0] : null;
      const c = await crearPedidoCore(conexion, {
        sucursalId, usuarioId: null, items, tipo: f.tipo, cliente, nombre_contacto: cliente.nombre, telefono: cliente.telefono,
        direccion: direccion ? { ...direccion, latitud: aNumero(direccion.latitud), longitud: aNumero(direccion.longitud) } : null, direccion_id: f.direccion_id,
        zona_id: f.zona_id || (direccion && direccion.zona_id) || null,
        pago_modo: f.pago_modo, paga_con: null, programado_para: `${fecha}T${f.hora}`, enviar: true, repartidor_id: rep ? rep.id : null,
        notas: f.notas, origen: 'fijo', pedido_fijo_id: f.id
      });
      await conexion.query('COMMIT');
      resultado.creados++;
      emitir(io, sucursalId, 'pedido_actualizado', { id: c.pedido_id, estado: c.estado, nuevo: true });
      if (visibleEnCaja({ estado: c.estado, tipo: f.tipo, pago_modo: f.pago_modo })) emitir(io, sucursalId, 'nuevo_ticket', { folio: c.folio, total: c.total });
    } catch (err) {
      await conexion.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') resultado.omitidos++;
      else resultado.errores.push(`${f.cliente_nombre}: ${err.message}`);
    } finally {
      conexion.release();
    }
  }
  return resultado;
}

// Precio de cada producto del pedido fijo HOY: mayoreo si el cliente lo usa, y el precio por volumen si conviene.
async function armarItemsFijo(db, sucursalId, f) {
  const lista = Array.isArray(f.items) ? f.items : [];
  const ids = lista.map((i) => Number(i.producto_id));
  const ps = await db.query('SELECT id, nombre, precio, precio_mayoreo FROM productos WHERE id = ANY($1) AND sucursal_id = $2 AND activo = true', [ids, sucursalId]);
  const promos = await db.query('SELECT producto_id, cantidad_minima, precio_promocional FROM promociones WHERE producto_id = ANY($1) AND activo = true', [ids]);
  const cli = (await db.query('SELECT usa_mayoreo FROM clientes WHERE id = $1', [f.cliente_id])).rows[0] || {};
  const items = [];
  for (const i of lista) {
    const p = ps.rows.find((x) => x.id === Number(i.producto_id));
    if (!p) continue;
    const cantidad = Number(i.cantidad);
    let precio = Number(p.precio);
    if (cli.usa_mayoreo && Number(p.precio_mayoreo) > 0) precio = Number(p.precio_mayoreo);
    for (const pr of promos.rows) {
      if (pr.producto_id === p.id && Number(pr.cantidad_minima) <= cantidad && Number(pr.precio_promocional) < precio) precio = Number(pr.precio_promocional);
    }
    items.push({ tipo: 'producto', producto_id: p.id, nombre_producto: p.nombre, cantidad, precio_unitario: precio });
  }
  return items;
}

router.post('/fijos/generar', requiereRol(...ROLES_ADMIN), rutaAsync('Error al generar los pedidos fijos', async (req, res) => {
  const fecha = validarFecha(req.body.fecha);
  if (!fecha) return res.status(400).json({ error: 'Indica la fecha (AAAA-MM-DD)' });
  const lim = await pool.query(`SELECT (${AHORA_LOCAL})::date + 14 >= $1::date AS ok`, [fecha]);
  if (!lim.rows[0].ok) return res.status(400).json({ error: 'Solo se pueden generar pedidos de los próximos 14 días' });
  res.json(await generarFijosDelDia(req.app.get('io'), req.sucursalId, fecha));
}));

// Generación automática: hoy siempre, y mañana desde la hora configurada.
const ultimaRevisionFijos = new Map();
async function asegurarFijos(io, sucursalId) {
  const ahora = Date.now();
  if (ahora - (ultimaRevisionFijos.get(sucursalId) || 0) < 50000) return;
  ultimaRevisionFijos.set(sucursalId, ahora);
  const hay = await pool.query('SELECT 1 FROM pedidos_fijos WHERE sucursal_id = $1 AND activo = true LIMIT 1', [sucursalId]);
  if (!hay.rows.length) return;
  const cfg = await pool.query('SELECT pedidos_hora_aviso_fijos FROM configuracion WHERE sucursal_id = $1', [sucursalId]);
  const horaAviso = cfg.rows.length ? cfg.rows[0].pedidos_hora_aviso_fijos : '18:00';
  const t = await pool.query(
    `SELECT to_char((${AHORA_LOCAL})::date, 'YYYY-MM-DD') AS hoy, to_char((${AHORA_LOCAL})::date + 1, 'YYYY-MM-DD') AS manana,
            to_char(${AHORA_LOCAL}, 'HH24:MI') AS hora`);
  await generarFijosDelDia(io, sucursalId, t.rows[0].hoy, { omitirNuevosYaPasados: true });
  if (t.rows[0].hora >= horaAviso) await generarFijosDelDia(io, sucursalId, t.rows[0].manana);
}

// Cada minuto: pasa a "Preparando" lo que ya toca y genera los pedidos fijos que faltan.
function iniciarTemporizador(io) {
  const tick = async () => {
    try {
      await avanzarProgramados(io, null);
      const s = await pool.query('SELECT DISTINCT sucursal_id FROM pedidos_fijos WHERE activo = true');
      for (const x of s.rows) await asegurarFijos(io, x.sucursal_id);
    } catch (e) { /* sin base de datos un momento: se reintenta en el siguiente minuto */ }
  };
  const h = setInterval(tick, 60000);
  if (h.unref) h.unref();
  return h;
}

// =================================================================== CREAR / VER / EDITAR / CAMBIAR
router.post('/', requierePermiso('VENTAS_CREAR'), async (req, res) => {
  const conexion = await pool.connect();
  let creado = null;
  try {
    const b = req.body || {};
    validarItems(b.items);
    const tipo = b.tipo === 'recoger' ? 'recoger' : 'domicilio';
    const pagoModo = PAGO_MODOS.includes(b.pago_modo) ? b.pago_modo : 'al_recibir';
    const fh = validarFechaHora(b.programado_para);
    if (fh.error) throw new ErrorHttp(400, fh.error);
    let pagaCon = null;
    if (b.paga_con !== undefined && b.paga_con !== null && b.paga_con !== '') {
      pagaCon = Number(b.paga_con);
      if (!Number.isFinite(pagaCon) || pagaCon < 0) throw new ErrorHttp(400, 'El monto con el que paga no es válido');
    }
    let forzado = null;
    if (b.costo_envio !== undefined && b.costo_envio !== null && b.costo_envio !== '' && tipo === 'domicilio') {
      if (!tienePermiso(req.usuario, 'DESCUENTO_APLICAR')) throw new ErrorHttp(403, 'No tienes permiso para cambiar el costo de envío');
      forzado = Number(b.costo_envio);
      if (!Number.isFinite(forzado) || forzado < 0) throw new ErrorHttp(400, 'El costo de envío no es válido');
    }

    await conexion.query('BEGIN');
    const { cliente, nombre, telefono } = await resolverCliente(conexion, req.sucursalId, b);
    if (pagoModo === 'credito' && !cliente) throw new ErrorHttp(400, 'Para vender a crédito elige un cliente guardado');
    let direccion = null, direccionId = null;
    if (tipo === 'domicilio') {
      const d = await resolverDireccion(conexion, req.sucursalId, cliente, b);
      direccion = d.direccion; direccionId = d.direccion_id;
    }
    const zonaId = tipo === 'domicilio' ? (Number(b.zona_id) || (direccion && direccion.zona_id) || null) : null;
    const repartidorId = tipo === 'domicilio' ? await repartidorValido(conexion, req.sucursalId, b.repartidor_id) : null;

    const c = await crearPedidoCore(conexion, {
      sucursalId: req.sucursalId, usuarioId: req.usuario.id, items: b.items, tipo, cliente, nombre_contacto: nombre, telefono,
      direccion, direccion_id: direccionId, zona_id: zonaId, costo_envio_forzado: forzado, pago_modo: pagoModo, paga_con: pagaCon,
      anticipo: b.anticipo, anticipo_metodo: b.anticipo_metodo, ya_pago_todo: b.ya_pago_todo === true,
      programado_para: fh.valor, enviar: b.enviar !== false, repartidor_id: repartidorId, notas: textoOnull(b.notas, 300), origen: 'manual'
    });
    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id, accion: 'crear_pedido', modulo: 'pedidos', referencia_id: c.pedido_id,
      valor_nuevo: { folio: c.folio, tipo, total: c.total, estado: c.estado, cliente: nombre }
    });
    await conexion.query('COMMIT');
    creado = c;
    const completo = await cargarPedido(pool, c.pedido_id, req.sucursalId);
    const io = req.app.get('io');
    emitir(io, req.sucursalId, 'pedido_actualizado', { id: c.pedido_id, estado: c.estado, nuevo: true });
    if (visibleEnCaja(completo)) emitir(io, req.sucursalId, 'nuevo_ticket', { folio: c.folio, total: c.total });
    res.json(completo);
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    responderError(res, err, 'Error al crear el pedido');
  } finally {
    conexion.release();
  }
});

router.get('/:id', rutaAsync('Error al obtener el pedido', async (req, res) => {
  const p = await cargarPedido(pool, req.params.id, req.sucursalId);
  if (!p) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json(p);
}));

router.get('/:id/evidencias/:evId', rutaAsync('Error al obtener la imagen', async (req, res) => {
  const r = await pool.query(
    `SELECT e.tipo, e.dato, e.creado_en FROM pedido_evidencias e JOIN pedidos p ON p.id = e.pedido_id
      WHERE e.id = $1 AND e.pedido_id = $2 AND p.sucursal_id = $3`, [req.params.evId, req.params.id, req.sucursalId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Imagen no encontrada' });
  res.json(r.rows[0]);
}));

// Editar un pedido que todavía no sale: contacto, dirección, hora, cobro, notas, zona (recalcula el envío) y productos.
router.put('/:id', requierePermiso('VENTAS_CREAR'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    const b = req.body || {};
    await conexion.query('BEGIN');
    const fila = await conexion.query(`${SQL_PEDIDO} WHERE p.id = $1 AND p.sucursal_id = $2 FOR UPDATE OF p`, [req.params.id, req.sucursalId]);
    if (!fila.rows.length) throw new ErrorHttp(404, 'Pedido no encontrado');
    const ped = formato(fila.rows[0]);
    if (!['programado', 'preparando', 'listo', 'no_entregado'].includes(ped.estado)) throw new ErrorHttp(409, 'Este pedido ya no se puede editar');

    const campos = [], vals = [];
    const poner = (col, v) => { vals.push(v); campos.push(`${col} = $${vals.length}`); };

    if (b.nombre_contacto !== undefined) {
      const n = textoOnull(b.nombre_contacto, 150);
      if (!n) throw new ErrorHttp(400, 'Escribe el nombre del cliente');
      poner('nombre_contacto', n);
    }
    if (b.telefono !== undefined) poner('telefono', textoOnull(b.telefono, 30));
    if (b.notas !== undefined) poner('notas', textoOnull(b.notas, 300));
    if (b.pago_modo !== undefined) {
      if (!PAGO_MODOS.includes(b.pago_modo)) throw new ErrorHttp(400, 'Forma de cobro inválida');
      if (b.pago_modo === 'credito' && !ped.cliente_id) throw new ErrorHttp(400, 'Para vender a crédito el pedido debe tener un cliente guardado');
      if (ped.ticket_estado !== 'pendiente') throw new ErrorHttp(409, 'El ticket de este pedido ya fue cobrado');
      poner('pago_modo', b.pago_modo);
    }
    if (b.paga_con !== undefined) {
      const v = b.paga_con === null || b.paga_con === '' ? null : Number(b.paga_con);
      if (v !== null && (!Number.isFinite(v) || v < 0)) throw new ErrorHttp(400, 'El monto con el que paga no es válido');
      poner('paga_con', v);
    }
    if (ped.tipo === 'domicilio' && b.direccion) {
      const d = normalizarDireccion(b.direccion);
      if (d.error) throw new ErrorHttp(400, d.error);
      for (const k of ['calle', 'colonia', 'cp', 'ciudad', 'referencias', 'latitud', 'longitud', 'ubicacion_enlace']) poner(k, d[k]);
      if (d.zona_id && b.zona_id === undefined) b.zona_id = d.zona_id;
    }
    if (b.programado_para !== undefined) {
      const fh = validarFechaHora(b.programado_para);
      if (fh.error) throw new ErrorHttp(400, fh.error);
      const cfg = await conexion.query('SELECT pedidos_min_preparacion FROM configuracion WHERE sucursal_id = $1', [req.sucursalId]);
      const minPrep = cfg.rows.length ? Number(cfg.rows[0].pedidos_min_preparacion) : 30;
      poner('programado_para', fh.valor);
      vals.push(minPrep);
      const mp = `$${vals.length}`;
      vals.push(fh.valor);
      const fv = `$${vals.length}`;
      campos.push(`fecha_entrega = COALESCE(${fv}::text::timestamp::date, (${AHORA_LOCAL})::date)`);
      campos.push(`preparar_desde = CASE WHEN ${fv}::text IS NULL OR (estado = 'programado' AND preparar_desde IS NULL) THEN preparar_desde ELSE ${fv}::text::timestamp - make_interval(mins => ${mp}::int) END`);
    }
    // Zona o costo de envío: se recalcula la línea de envío del ticket.
    let recalcular = false, forzado = null;
    if (ped.tipo === 'domicilio' && (b.zona_id !== undefined || b.costo_envio !== undefined)) {
      if (ped.ticket_estado !== 'pendiente') throw new ErrorHttp(409, 'El ticket de este pedido ya fue cobrado: no se puede cambiar el envío');
      recalcular = true;
      if (b.zona_id !== undefined) poner('zona_id', Number(b.zona_id) || null);
      if (b.costo_envio !== undefined && b.costo_envio !== null && b.costo_envio !== '') {
        if (!tienePermiso(req.usuario, 'DESCUENTO_APLICAR')) throw new ErrorHttp(403, 'No tienes permiso para cambiar el costo de envío');
        forzado = Number(b.costo_envio);
        if (!Number.isFinite(forzado) || forzado < 0) throw new ErrorHttp(400, 'El costo de envío no es válido');
      }
    }
    // Productos: "lineas" = los renglones que se quedan (con su cantidad nueva; los que no vengan se quitan) y
    // "agregar" = productos nuevos. Solo mientras el ticket siga pendiente (todavía no se cobra en Caja).
    if (b.lineas !== undefined || b.agregar !== undefined) {
      if (ped.ticket_estado !== 'pendiente') throw new ErrorHttp(409, 'El ticket de este pedido ya fue cobrado: no se pueden cambiar los productos');
      const existentes = (await conexion.query(
        `SELECT d.id, d.cantidad, d.precio_unitario, d.subtotal FROM ticket_detalle d
          WHERE d.ticket_id = $1 AND NOT (${ES_LINEA_ENVIO}) ORDER BY d.id FOR UPDATE`, [ped.ticket_id])).rows;
      const quedan = new Map();
      if (b.lineas === undefined) existentes.forEach((e) => quedan.set(e.id, Number(e.cantidad)));
      else {
        if (!Array.isArray(b.lineas)) throw new ErrorHttp(400, 'La lista de productos no es válida');
        for (const l of b.lineas) {
          const id = Number(l && l.id), cant = Number(l && l.cantidad);
          if (!existentes.some((e) => e.id === id)) throw new ErrorHttp(400, 'Hay un producto que ya no está en el pedido');
          if (!Number.isFinite(cant) || cant <= 0) throw new ErrorHttp(400, 'Hay un producto con cantidad inválida');
          quedan.set(id, cant);
        }
      }
      const nuevos = b.agregar === undefined ? [] : b.agregar;
      if (!Array.isArray(nuevos)) throw new ErrorHttp(400, 'La lista de productos nuevos no es válida');
      if (nuevos.length) validarItems(nuevos);
      if (quedan.size + nuevos.length === 0) throw new ErrorHttp(400, 'El pedido necesita al menos un producto');
      if (quedan.size + nuevos.length > 200) throw new ErrorHttp(400, 'El pedido tiene demasiados renglones');

      // ¿El envío que tiene hoy es el de la zona, o alguien lo cambió a mano? Si fue a mano, se respeta.
      if (!recalcular) {
        const subViejo = r2(existentes.reduce((sum, e) => sum + Number(e.subtotal), 0));
        const calcViejo = ped.tipo === 'domicilio' ? await calcularEnvio(conexion, req.sucursalId, ped.zona_id, subViejo) : { costo: 0 };
        forzado = calcViejo.error || r2(calcViejo.costo) !== r2(ped.costo_envio || 0) ? r2(ped.costo_envio || 0) : null;
        recalcular = true;
      }
      for (const e of existentes) {
        if (!quedan.has(e.id)) await conexion.query('DELETE FROM ticket_detalle WHERE id = $1', [e.id]);
        else if (Math.abs(quedan.get(e.id) - Number(e.cantidad)) > 0.0005) {
          await conexion.query('UPDATE ticket_detalle SET cantidad = $1, subtotal = $2 WHERE id = $3',
            [quedan.get(e.id), r2(quedan.get(e.id) * Number(e.precio_unitario)), e.id]);
        }
      }
      if (nuevos.length) await insertarRenglones(conexion, ped.ticket_id, nuevos, nuevos.map(subtotalRenglon));
    }
    if (campos.length) {
      vals.push(ped.id);
      await conexion.query(`UPDATE pedidos SET ${campos.join(', ')} WHERE id = $${vals.length}`, vals);
    }
    if (recalcular) await recalcularEnvio(conexion, req.sucursalId, ped.id, forzado);

    // Anticipo / "ya pagó todo": se valida contra el total YA recalculado (si bajan productos, el anticipo no puede pasarse).
    const tocaAnticipo = b.anticipo !== undefined || b.anticipo_metodo !== undefined || b.ya_pago_todo === true;
    if (tocaAnticipo && ped.ticket_estado !== 'pendiente') throw new ErrorHttp(409, 'El ticket de este pedido ya fue cobrado: no se puede cambiar el anticipo');
    const act = formato((await conexion.query(`${SQL_PEDIDO} WHERE p.id = $1`, [ped.id])).rows[0]);
    const an = validarAnticipo({
      anticipo: b.ya_pago_todo === true || b.anticipo !== undefined ? b.anticipo : act.anticipo,
      anticipo_metodo: b.anticipo_metodo !== undefined ? b.anticipo_metodo : act.anticipo_metodo,
      ya_pago_todo: b.ya_pago_todo === true
    }, act.total_neto, act.pago_modo);
    if (an.anticipo !== act.anticipo || an.anticipo_metodo !== act.anticipo_metodo || an.pago_modo !== act.pago_modo) {
      await conexion.query(
        `UPDATE pedidos SET anticipo = $1, anticipo_metodo = $2, pago_modo = $3::varchar,
                paga_con = CASE WHEN $3::varchar = 'al_recibir' THEN paga_con ELSE NULL END WHERE id = $4`,
        [an.anticipo, an.anticipo_metodo, an.pago_modo, ped.id]);
    }
    await registrarBitacora(conexion, { usuario_id: req.usuario.id, accion: 'editar_pedido', modulo: 'pedidos', referencia_id: ped.id, valor_nuevo: { campos: Object.keys(b) } });
    await conexion.query('COMMIT');
    const completo = await cargarPedido(pool, ped.id, req.sucursalId);
    emitir(req.app.get('io'), req.sucursalId, 'pedido_actualizado', { id: ped.id, estado: completo.estado, repartidor_id: completo.repartidor_id });
    res.json(completo);
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    responderError(res, err, 'Error al editar el pedido');
  } finally {
    conexion.release();
  }
});

// Vuelve a calcular la línea de envío y el total del ticket (el ticket debe seguir pendiente).
async function recalcularEnvio(db, sucursalId, pedidoId, forzado) {
  const p = (await db.query('SELECT ticket_id, zona_id FROM pedidos WHERE id = $1', [pedidoId])).rows[0];
  await db.query(`DELETE FROM ticket_detalle d WHERE d.ticket_id = $1 AND ${ES_LINEA_ENVIO}`, [p.ticket_id]);
  const sub = r2((await db.query('SELECT COALESCE(SUM(subtotal), 0) AS s FROM ticket_detalle WHERE ticket_id = $1', [p.ticket_id])).rows[0].s);
  const calc = await calcularEnvio(db, sucursalId, p.zona_id, sub);
  if (calc.error && forzado === null) throw new ErrorHttp(400, calc.error);
  const costo = forzado !== null ? r2(forzado) : calc.costo;
  if (costo > 0) {
    await db.query(
      `INSERT INTO ticket_detalle (ticket_id, tipo, producto_id, nombre_producto, cantidad, precio_unitario, subtotal) VALUES ($1, 'producto', NULL, $2, 1, $3, $3)`,
      [p.ticket_id, NOMBRE_LINEA_ENVIO, costo]);
  }
  await db.query('UPDATE tickets SET total = $1 WHERE id = $2', [r2(sub + costo), p.ticket_id]);
  await db.query('UPDATE pedidos SET costo_envio = $1 WHERE id = $2', [costo, pedidoId]);
}

router.post('/:id/estado', requierePermiso('VENTAS_CREAR'), rutaAsync('Error al cambiar el estado', async (req, res) => {
  const nuevo = String(req.body.estado || '');
  if (!U.ESTADOS.includes(nuevo) || nuevo === 'programado') return res.status(400).json({ error: 'Estado inválido' });
  if (nuevo === 'cancelado' && !tienePermiso(req.usuario, 'VENTAS_CANCELAR')) return res.status(403).json({ error: 'No tienes permiso para cancelar pedidos' });
  res.json(await transicionar(req, req.params.id, nuevo, { motivo: req.body.motivo, metodo_cobro: req.body.metodo_cobro }));
}));

// Mostrador acepta un pedido que está por preparar: queda marcado quién lo toma y a qué hora.
// Si ya lo aceptó alguien, no se pisa (cualquiera puede abrirlo y terminarlo, pero se conserva quién lo tomó primero).
router.post('/:id/aceptar', requierePermiso('VENTAS_CREAR'), rutaAsync('Error al aceptar el pedido', async (req, res) => {
  const r = await pool.query(
    `UPDATE pedidos SET aceptado_en = COALESCE(aceptado_en, NOW()), aceptado_por = COALESCE(aceptado_por, $3)
      WHERE id = $1 AND sucursal_id = $2 AND estado = 'preparando' RETURNING id`, [req.params.id, req.sucursalId, req.usuario.id]);
  if (!r.rows.length) {
    const hay = await pool.query('SELECT estado FROM pedidos WHERE id = $1 AND sucursal_id = $2', [req.params.id, req.sucursalId]);
    if (!hay.rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    return res.status(409).json({ error: `Este pedido está "${hay.rows[0].estado}" y ya no se puede aceptar para preparar` });
  }
  await registrarBitacora(pool, { usuario_id: req.usuario.id, accion: 'pedido_aceptado', modulo: 'pedidos', referencia_id: Number(req.params.id) });
  const completo = await cargarPedido(pool, req.params.id, req.sucursalId);
  emitir(req.app.get('io'), req.sucursalId, 'pedido_actualizado', { id: completo.id, estado: completo.estado, repartidor_id: completo.repartidor_id, aceptado: true });
  res.json(completo);
}));

router.post('/:id/asignar', requierePermiso('VENTAS_CREAR'), rutaAsync('Error al asignar el repartidor', async (req, res) => {
  const ped = await cargarPedido(pool, req.params.id, req.sucursalId, { conItems: false });
  if (!ped) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (ped.tipo !== 'domicilio') return res.status(400).json({ error: 'Un pedido para recoger no lleva repartidor' });
  const corrigeEntregado = ped.estado === 'entregado';
  if (corrigeEntregado) {
    // Corregir quién entregó: solo dueño/gerente, siempre con un repartidor, y antes de que se liquide en Caja.
    if (!ROLES_ADMIN.includes(req.usuario.rol)) return res.status(403).json({ error: 'Solo el dueño o el gerente pueden cambiar el repartidor de un pedido ya entregado' });
    if (ped.liquidacion_id) return res.status(409).json({ error: 'Este pedido ya se liquidó en Caja: ya no se puede cambiar el repartidor' });
  } else if (!['programado', 'preparando', 'listo', 'en_camino', 'no_entregado'].includes(ped.estado)) {
    return res.status(409).json({ error: 'Este pedido ya no se puede reasignar' });
  }
  const rid = await repartidorValido(pool, req.sucursalId, req.body.repartidor_id);
  if (corrigeEntregado && !rid) return res.status(400).json({ error: 'Elige el repartidor que sí entregó este pedido' });
  await pool.query('UPDATE pedidos SET repartidor_id = $1 WHERE id = $2', [rid, ped.id]);
  await registrarBitacora(pool, { usuario_id: req.usuario.id, accion: 'asignar_repartidor', modulo: 'pedidos', referencia_id: ped.id,
    valor_anterior: { repartidor_id: ped.repartidor_id }, valor_nuevo: { repartidor_id: rid } });
  const completo = await cargarPedido(pool, ped.id, req.sucursalId);
  emitir(req.app.get('io'), req.sucursalId, 'pedido_actualizado', { id: ped.id, estado: completo.estado, repartidor_id: rid });
  res.json(completo);
}));

// «Deshacer entrega» (dueño/gerente): el pedido entregado por error regresa a «En camino» (o a «Listo» si no tiene
// repartidor) y se borra el cobro que se había registrado, para volver a marcarlo bien. Solo antes de liquidar en Caja.
router.post('/:id/deshacer-entrega', requiereRol(...ROLES_ADMIN), rutaAsync('Error al deshacer la entrega', async (req, res) => {
  const io = req.app.get('io');
  const conexion = await pool.connect();
  try {
    await conexion.query('BEGIN');
    const fila = await conexion.query(`${SQL_PEDIDO} WHERE p.id = $1 AND p.sucursal_id = $2 FOR UPDATE OF p`, [req.params.id, req.sucursalId]);
    if (!fila.rows.length) throw new ErrorHttp(404, 'Pedido no encontrado');
    const ped = formato(fila.rows[0]);
    if (ped.estado !== 'entregado') throw new ErrorHttp(409, 'Este pedido no está entregado');
    if (ped.liquidacion_id) throw new ErrorHttp(409, 'Este pedido ya se liquidó en Caja: ya no se puede deshacer la entrega');
    if (ped.ticket_estado === 'cancelado') throw new ErrorHttp(409, 'El ticket de este pedido está cancelado');
    // Si el repartidor anotado ya no es un repartidor válido (por ejemplo, quedó a nombre del dueño), el pedido
    // regresa a «Listo» sin repartidor, para que lo asignen bien o lo tome uno de verdad.
    let rid = ped.repartidor_id;
    if (rid) {
      const valido = await conexion.query("SELECT 1 FROM usuarios WHERE id = $1 AND sucursal_id = $2 AND rol = 'repartidor' AND activo = true", [rid, req.sucursalId]);
      if (!valido.rows.length) rid = null;
    }
    const destino = ped.tipo === 'domicilio' && rid ? 'en_camino' : 'listo';
    await conexion.query(
      `UPDATE pedidos SET estado = $2::varchar, entregado_en = NULL, metodo_cobro = NULL, monto_cobrado = NULL, llego_en = NULL,
              salio_en = CASE WHEN $2::varchar = 'en_camino' THEN COALESCE(salio_en, NOW()) ELSE NULL END,
              listo_en = COALESCE(listo_en, NOW()),
              repartidor_id = $3
        WHERE id = $1`, [ped.id, destino, ped.tipo === 'domicilio' ? rid : null]);
    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id, accion: 'pedido_deshacer_entrega', modulo: 'pedidos', referencia_id: ped.id,
      valor_anterior: { estado: 'entregado', repartidor_id: ped.repartidor_id, metodo_cobro: ped.metodo_cobro, monto_cobrado: ped.monto_cobrado },
      valor_nuevo: { estado: destino, repartidor_id: rid }
    });
    await conexion.query('COMMIT');
    const completo = await cargarPedido(pool, ped.id, req.sucursalId);
    emitir(io, req.sucursalId, 'pedido_actualizado', { id: ped.id, estado: destino, repartidor_id: completo.repartidor_id });
    res.json(completo);
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conexion.release();
  }
}));

// Se avisó al cliente por WhatsApp que su pedido va en camino (el aviso lo abre la pantalla con un enlace wa.me).
router.post('/:id/avisado', requierePermiso('VENTAS_CREAR'), rutaAsync('Error al registrar el aviso', async (req, res) => {
  const r = await pool.query('UPDATE pedidos SET aviso_camino_en = NOW() WHERE id = $1 AND sucursal_id = $2 RETURNING id', [req.params.id, req.sucursalId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json(await cargarPedido(pool, req.params.id, req.sucursalId));
}));

module.exports = router;
module.exports.iniciarTemporizador = iniciarTemporizador;
module.exports.avanzarProgramados = avanzarProgramados;
module.exports.generarFijosDelDia = generarFijosDelDia;
