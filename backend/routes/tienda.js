// Tienda en línea: los clientes del negocio piden desde su celular (tienda.html) y el pedido llega a
// Pedidos como "Por confirmar". La tienda lo revisa y al confirmarlo sigue el camino de siempre.
//
// PÚBLICO (sin sesión):  GET /api/tienda/publico/info, /productos, /seguimiento/:clave  ·  POST /pedido
// NEGOCIO (con sesión):  GET/PUT /api/tienda/config  ·  productos visibles  ·  enlaces de fiado
//
// Reglas de seguridad de lo público:
//  - los precios SIEMPRE salen del catálogo (nunca de lo que mande el celular);
//  - nada se prepara hasta que la tienda confirma; máximo N pedidos sin confirmar por teléfono;
//  - límites por dirección (anti-broma) y solo en el horario de la tienda;
//  - "Anótalo a mi cuenta" solo con el enlace personal que la tienda le da a cada cliente con crédito.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol, requiereSucursalId } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');
const U = require('../utils/pedidosUtil');
const pedidos = require('./pedidos');
const paquete = require('../utils/paquete');

const { crearPedidoCore, resolverCliente, resolverDireccion, ErrorHttp, emitir } = pedidos.interno;
const { r2, textoOnull, soloDigitos, numeroPedido } = U;
const ROLES_ADMIN = ['jefe_general', 'dueno', 'gerente'];

const limite = (minutos, max, mensaje) => rateLimit({
  windowMs: minutos * 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { error: mensaje }
});
const limiteLectura = limite(5, 300, 'Demasiadas consultas. Espera un momento.');
// Solo cuentan los pedidos que sí se hicieron (un error de captura no bloquea a otros clientes con la misma IP del celular).
const limitePedido = rateLimit({
  windowMs: 60 * 60 * 1000, max: Number(process.env.TIENDA_MAX_PEDIDOS_HORA) || 8, standardHeaders: true, legacyHeaders: false,
  skipFailedRequests: true,
  message: { error: 'Ya mandaste varios pedidos desde este celular. Si necesitas algo más, llama a la tienda.' }
});
// Tope de pedidos esperando confirmación en toda la sucursal (evita que alguien llene la pantalla de pedidos falsos).
const MAX_SIN_CONFIRMAR_SUCURSAL = Number(process.env.TIENDA_MAX_SIN_CONFIRMAR) || 30;
const limiteSeguimiento = limite(5, 120, 'Demasiadas consultas. Espera un momento.');

const nuevaClave = () => crypto.randomBytes(18).toString('base64url');            // 24 caracteres, imposible de adivinar
const HORA_OK = /^([01]\d|2[0-3]):[0-5]\d$/;

// ------------------------------------------------------------------ apoyo
async function sucursalDeLaTienda(db, s) {
  // La tienda en línea es servicio a domicilio: solo en los paquetes que lo incluyen.
  try { await paquete.revisarDomicilio(); } catch (e) { return null; }
  const id = Number(s);
  const r = Number.isInteger(id) && id > 0
    ? await db.query('SELECT tc.*, su.nombre AS sucursal_nombre FROM tienda_config tc JOIN sucursales su ON su.id = tc.sucursal_id WHERE tc.sucursal_id = $1 AND tc.activo = true AND su.activo = true', [id])
    : await db.query('SELECT tc.*, su.nombre AS sucursal_nombre FROM tienda_config tc JOIN sucursales su ON su.id = tc.sucursal_id WHERE tc.activo = true AND su.activo = true ORDER BY tc.sucursal_id LIMIT 1');
  return r.rows[0] || null;
}

// ¿Está abierta ahora? Con la hora del negocio (no la del celular).
function estadoHorario(horario, ahoraFijo) {
  const ahora = ahoraFijo || new Date(new Date().toLocaleString('en-US', { timeZone: U.TZ }));
  const dia = ahora.getDay();                                  // 0 = domingo
  const tramo = (horario && (dia === 0 ? horario.domingo : horario.semana)) || null;
  const minutos = ahora.getHours() * 60 + ahora.getMinutes();
  const aMin = (h) => { const [a, b] = String(h).split(':').map(Number); return a * 60 + b; };
  const h12 = (h) => { const [a, b] = String(h).split(':').map(Number); const p = a >= 12 ? 'pm' : 'am'; const x = a % 12 || 12; return b ? `${x}:${String(b).padStart(2, '0')} ${p}` : `${x} ${p}`; };
  if (tramo && Array.isArray(tramo) && tramo.length === 2 && minutos >= aMin(tramo[0]) && minutos < aMin(tramo[1])) {
    return { abierto: true, texto: `Abierto hasta las ${h12(tramo[1])}` };
  }
  // Cerrado: ¿cuándo abre? (hoy más tarde o el siguiente día con horario)
  if (tramo && Array.isArray(tramo) && minutos < aMin(tramo[0])) return { abierto: false, texto: `Cerrado. Recibimos pedidos a partir de las ${h12(tramo[0])}` };
  for (let i = 1; i <= 7; i++) {
    const d = (dia + i) % 7;
    const t = horario && (d === 0 ? horario.domingo : horario.semana);
    if (t && Array.isArray(t) && t.length === 2) return { abierto: false, texto: `Cerrado. Recibimos pedidos ${i === 1 ? 'mañana' : 'el ' + ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][d]} a partir de las ${h12(t[0])}` };
  }
  return { abierto: false, texto: 'Por ahora no estamos recibiendo pedidos' };
}

async function datosNegocio(db, sucursalId, sucursalNombre) {
  const c = await db.query('SELECT nombre_negocio, telefono, logo_url FROM configuracion WHERE sucursal_id = $1 ORDER BY id LIMIT 1', [sucursalId]);
  const cfg = c.rows[0] || {};
  let dn = {};
  try { dn = (await db.query('SELECT negocio, telefono, whatsapp FROM datos_negocio WHERE id = 1')).rows[0] || {}; } catch (e) { /* sin tabla */ }
  return {
    negocio: cfg.nombre_negocio || dn.negocio || sucursalNombre || 'Nuestra tienda',
    telefono: soloDigitos(dn.whatsapp || cfg.telefono || dn.telefono || '').slice(-10) || null,
    logo_url: cfg.logo_url || null
  };
}

// Cliente del enlace personal (fiado): solo si el enlace es de esta sucursal y el cliente sigue activo.
async function clienteDelEnlace(db, sucursalId, enlace) {
  if (!enlace || typeof enlace !== 'string' || !/^[A-Za-z0-9_-]{16,40}$/.test(enlace)) return null;
  const r = await db.query(
    'SELECT id, nombre, telefono, limite_credito, saldo_actual FROM clientes WHERE enlace_tienda = $1 AND sucursal_id = $2 AND activo = true',
    [enlace, sucursalId]);
  return r.rows[0] || null;
}

// Productos que se ven en la tienda, con su precio de promoción por volumen (si tiene).
async function productosVisibles(db, sucursalId, cfg, ids) {
  const r = await db.query(
    `SELECT p.id, p.nombre, p.precio, p.imagen_url, p.tipo_venta, COALESCE(c.nombre, 'Otros') AS departamento,
            p.usa_inventario, COALESCE(i.existencia_actual, 0) AS existencia,
            pr.cantidad_minima AS promo_desde, pr.precio_promocional AS promo_precio
       FROM productos p
       LEFT JOIN categorias c ON c.id = p.categoria_id
       LEFT JOIN inventario i ON i.producto_id = p.id
       LEFT JOIN LATERAL (SELECT cantidad_minima, precio_promocional FROM promociones
                           WHERE producto_id = p.id AND activo = true ORDER BY precio_promocional ASC LIMIT 1) pr ON true
      WHERE p.sucursal_id = $1 AND p.activo = true AND p.en_tienda = true AND p.precio > 0
        ${ids ? 'AND p.id = ANY($2)' : ''}
      ORDER BY p.favorito DESC, p.orden, p.nombre
      LIMIT 3000`, ids ? [sucursalId, ids] : [sucursalId]);
  return r.rows
    .filter((p) => !(cfg.ocultar_sin_existencia && p.usa_inventario && Number(p.existencia) <= 0))
    .map((p) => ({
      id: p.id, nombre: p.nombre, precio: Number(p.precio), imagen_url: p.imagen_url || null,
      por_peso: p.tipo_venta === 'peso', departamento: p.departamento,
      promo: p.promo_precio && Number(p.promo_precio) < Number(p.precio) ? { desde: Number(p.promo_desde), precio: Number(p.promo_precio) } : null
    }));
}

const precioConPromo = (p, cantidad) => (p.promo && cantidad >= p.promo.desde ? p.promo.precio : p.precio);

const responder = (res, e, next) => {
  if (e instanceof ErrorHttp) return res.status(e.status).json({ error: e.message });
  if (e && e.status && e.error) return res.status(e.status).json({ error: e.error });
  return next(e);
};

// ================================================================== PÚBLICO
router.get('/publico/info', limiteLectura, async (req, res, next) => {
  try {
    const cfg = await sucursalDeLaTienda(pool, req.query.s);
    if (!cfg) return res.status(404).json({ error: 'Esta tienda no está recibiendo pedidos por internet.' });
    const neg = await datosNegocio(pool, cfg.sucursal_id, cfg.sucursal_nombre);
    const z = await pool.query('SELECT id, nombre, costo, envio_gratis_desde FROM zonas_envio WHERE sucursal_id = $1 AND activo = true ORDER BY orden, nombre', [cfg.sucursal_id]);
    const g = await pool.query('SELECT pedidos_envio_gratis_desde FROM configuracion WHERE sucursal_id = $1', [cfg.sucursal_id]);
    const gratisGeneral = g.rows.length ? Number(g.rows[0].pedidos_envio_gratis_desde || 0) : 0;
    const cli = cfg.fiado_en_linea ? await clienteDelEnlace(pool, cfg.sucursal_id, req.query.c) : null;
    res.set('Cache-Control', 'no-store');
    res.json({
      sucursal_id: cfg.sucursal_id, ...aparienciaPublica(cfg),
      negocio: neg.negocio, giro: cfg.giro, telefono: neg.telefono, logo_url: neg.logo_url,
      horario: estadoHorario(cfg.horario), tiempo_entrega: cfg.tiempo_entrega,
      pedido_minimo: Number(cfg.pedido_minimo), acepta_tarjeta: cfg.acepta_tarjeta,
      zonas: z.rows.map((x) => ({ id: x.id, nombre: x.nombre, costo: Number(x.costo),
        envio_gratis_desde: x.envio_gratis_desde === null ? (gratisGeneral || null) : Number(x.envio_gratis_desde) })),
      cuenta: cli && Number(cli.limite_credito) > 0
        ? { nombre: cli.nombre, saldo: Number(cli.saldo_actual || 0), limite: Number(cli.limite_credito) }
        : null
    });
  } catch (e) { next(e); }
});

router.get('/publico/productos', limiteLectura, async (req, res, next) => {
  try {
    const cfg = await sucursalDeLaTienda(pool, req.query.s);
    if (!cfg) return res.status(404).json({ error: 'Esta tienda no está recibiendo pedidos por internet.' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await productosVisibles(pool, cfg.sucursal_id, cfg));
  } catch (e) { next(e); }
});

router.post('/publico/pedido', limitePedido, async (req, res, next) => {
  const b = req.body || {};
  let conexion;
  try {
    conexion = await pool.connect();
    const cfg = await sucursalDeLaTienda(conexion, b.s);
    if (!cfg) throw new ErrorHttp(404, 'Esta tienda no está recibiendo pedidos por internet.');
    const hor = estadoHorario(cfg.horario);
    if (!hor.abierto) throw new ErrorHttp(409, hor.texto);

    // --- quién y a dónde
    const nombre = textoOnull(b.nombre, 150);
    const telefono = soloDigitos(b.telefono).slice(-10);
    if (!nombre || nombre.length < 2) throw new ErrorHttp(400, 'Escribe tu nombre');
    if (telefono.length !== 10) throw new ErrorHttp(400, 'Escribe tu WhatsApp a 10 números');
    const calle = textoOnull(b.calle, 200);
    if (!calle) throw new ErrorHttp(400, 'Escribe tu calle y número');
    const zonaId = Number(b.zona_id) || null;
    const zonas = await conexion.query('SELECT id, nombre FROM zonas_envio WHERE sucursal_id = $1 AND activo = true', [cfg.sucursal_id]);
    let zona = null;
    if (zonas.rows.length) {
      zona = zonas.rows.find((z) => z.id === zonaId);
      if (!zona) throw new ErrorHttp(400, 'Elige tu colonia');
    }
    const siFalta = ['parecido', 'llamar', 'quitar'].includes(b.si_falta) ? b.si_falta : 'llamar';

    // --- forma de pago
    const pago = ['efectivo', 'tarjeta', 'cuenta'].includes(b.pago) ? b.pago : 'efectivo';
    if (pago === 'tarjeta' && !cfg.acepta_tarjeta) throw new ErrorHttp(400, 'Esta tienda no acepta tarjeta en la entrega');
    let pagaCon = null;
    if (pago === 'efectivo' && b.paga_con !== undefined && b.paga_con !== null && b.paga_con !== '') {
      pagaCon = Number(b.paga_con);
      if (!Number.isFinite(pagaCon) || pagaCon < 0 || pagaCon > 100000) throw new ErrorHttp(400, 'El monto con el que pagas no es válido');
    }
    const clienteCuenta = pago === 'cuenta' && cfg.fiado_en_linea ? await clienteDelEnlace(conexion, cfg.sucursal_id, b.c) : null;
    if (pago === 'cuenta' && (!clienteCuenta || Number(clienteCuenta.limite_credito) <= 0)) {
      throw new ErrorHttp(403, 'Para anotarlo a tu cuenta usa el enlace personal que te dio la tienda');
    }

    // --- productos: precio y nombre SIEMPRE del catálogo
    if (!Array.isArray(b.items) || !b.items.length) throw new ErrorHttp(400, 'Tu pedido está vacío');
    if (b.items.length > 80) throw new ErrorHttp(400, 'Tu pedido tiene demasiados productos');
    const cantidades = new Map();
    for (const it of b.items) {
      const id = Number(it && it.producto_id);
      const cant = Math.round(Number(it && it.cantidad) * 1000) / 1000;
      if (!Number.isInteger(id) || id <= 0 || id > 2147483647 || !Number.isFinite(cant) || cant <= 0 || cant > 999) throw new ErrorHttp(400, 'Hay un producto con cantidad inválida');
      cantidades.set(id, Math.round(((cantidades.get(id) || 0) + cant) * 1000) / 1000);
    }
    const catalogo = await productosVisibles(conexion, cfg.sucursal_id, cfg, [...cantidades.keys()]);
    const porId = new Map(catalogo.map((p) => [p.id, p]));
    const items = [];
    for (const [id, cantidad] of cantidades) {
      const p = porId.get(id);
      if (!p) throw new ErrorHttp(409, 'Uno de tus productos ya no está disponible. Revisa tu pedido.');
      const cant = p.por_peso ? cantidad : Math.round(cantidad);
      if (cant <= 0) continue;
      items.push({ tipo: 'producto', producto_id: id, nombre_producto: p.nombre, cantidad: cant, precio_unitario: precioConPromo(p, cant) });
    }
    if (!items.length) throw new ErrorHttp(400, 'Tu pedido está vacío');
    const subtotal = r2(items.reduce((s, i) => s + i.cantidad * i.precio_unitario, 0));
    if (subtotal + 0.001 < Number(cfg.pedido_minimo)) throw new ErrorHttp(400, `El pedido mínimo es de $${Number(cfg.pedido_minimo).toFixed(0)} en productos`);

    await conexion.query('BEGIN');
    // Máximo de pedidos sin confirmar por teléfono (evita pedidos de broma en cadena).
    // El candado por teléfono hace que dos pedidos al mismo tiempo del mismo número se cuenten bien.
    await conexion.query('SELECT pg_advisory_xact_lock($1, $2)', [cfg.sucursal_id, Number(telefono.slice(-9))]);
    const pend = await conexion.query(
      `SELECT COUNT(*)::int AS n FROM pedidos WHERE sucursal_id = $1 AND origen = 'en_linea' AND confirmado_en IS NULL
          AND estado = 'programado' AND RIGHT(REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g'), 10) = $2`,
      [cfg.sucursal_id, telefono]);
    const todos = await conexion.query(
      `SELECT COUNT(*)::int AS n FROM pedidos WHERE sucursal_id = $1 AND origen = 'en_linea' AND confirmado_en IS NULL AND estado = 'programado'`,
      [cfg.sucursal_id]);
    if (todos.rows[0].n >= MAX_SIN_CONFIRMAR_SUCURSAL) {
      throw new ErrorHttp(429, 'La tienda tiene muchos pedidos por confirmar. Intenta en unos minutos o llama a la tienda.');
    }
    if (pend.rows[0].n >= Number(cfg.max_pendientes_por_telefono)) {
      throw new ErrorHttp(429, 'Ya tienes pedidos esperando que la tienda los confirme. Espera a que te confirmen o llama a la tienda.');
    }
    if (clienteCuenta) {
      // Con candado sobre el cliente y contando lo que ya pidió a su cuenta y todavía no se entrega,
      // así dos pedidos al mismo tiempo no pueden pasarse de su límite.
      const fila = (await conexion.query('SELECT limite_credito, saldo_actual FROM clientes WHERE id = $1 FOR UPDATE', [clienteCuenta.id])).rows[0];
      const enCamino = (await conexion.query(
        `SELECT COALESCE(SUM(t.total - COALESCE(t.descuento_monto, 0)), 0) AS n FROM pedidos p JOIN tickets t ON t.id = p.ticket_id
          WHERE p.cliente_id = $1 AND p.origen = 'en_linea' AND p.pago_previsto = 'cuenta' AND p.estado NOT IN ('cancelado', 'entregado', 'no_entregado')`,
        [clienteCuenta.id])).rows[0].n;
      const disponible = Number(fila.limite_credito) - Number(fila.saldo_actual || 0) - Number(enCamino);
      if (subtotal > disponible + 0.001) throw new ErrorHttp(400, `Tu cuenta solo tiene $${Math.max(0, disponible).toFixed(2)} disponibles. Elige efectivo o tarjeta.`);
    }

    const cliente = clienteCuenta
      ? (await conexion.query('SELECT * FROM clientes WHERE id = $1', [clienteCuenta.id])).rows[0]
      : (await resolverCliente(conexion, cfg.sucursal_id, { nombre_contacto: nombre, telefono })).cliente;
    const dir = await resolverDireccion(conexion, cfg.sucursal_id, cliente, {
      // Desde internet no se tocan las direcciones guardadas del cliente: la dirección va solo en este pedido.
      guardar_direccion: false,
      direccion: { calle, colonia: zona ? zona.nombre : textoOnull(b.colonia, 120), referencias: textoOnull(b.referencias, 300),
        latitud: b.latitud, longitud: b.longitud, zona_id: zona ? zona.id : null }
    });
    const notas = [
      siFalta === 'parecido' ? 'Si falta algo: cambiarlo por algo parecido (mismo precio o menos)' : siFalta === 'quitar' ? 'Si falta algo: quitarlo del pedido' : 'Si falta algo: llamar al cliente',
      pago === 'tarjeta' ? 'Paga con tarjeta: llevar terminal' : null
    ].filter(Boolean).join('. ');

    const creado = await crearPedidoCore(conexion, {
      sucursalId: cfg.sucursal_id, usuarioId: null, items, tipo: 'domicilio', zona_id: zona ? zona.id : null,
      cliente, direccion: dir.direccion, direccion_id: dir.direccion_id, nombre_contacto: nombre, telefono,
      pago_modo: pago === 'cuenta' ? 'credito' : 'al_recibir', paga_con: pagaCon, programado_para: null,
      enviar: false, notas, origen: 'en_linea'
    });
    const clave = nuevaClave();
    await conexion.query('UPDATE pedidos SET seguimiento = $2, si_falta = $3, pago_previsto = $4 WHERE id = $1', [creado.pedido_id, clave, siFalta, pago]);
    await registrarBitacora(conexion, {
      usuario_id: null, accion: 'pedido_en_linea', modulo: 'pedidos', referencia_id: creado.pedido_id,
      valor_nuevo: { total: creado.total, pago }
    });
    await conexion.query('COMMIT');

    emitir(req.app.get('io'), cfg.sucursal_id, 'pedido_actualizado', {
      id: creado.pedido_id, estado: 'programado', nuevo: true, en_linea: true, nombre, colonia: zona ? zona.nombre : null, total: creado.total
    });
    res.json({ ok: true, seguimiento: clave, numero: numeroPedido(creado.pedido_id), total: creado.total, costo_envio: creado.costo_envio });
  } catch (e) {
    if (conexion) await conexion.query('ROLLBACK').catch(() => {});
    responder(res, e, next);
  } finally {
    if (conexion) conexion.release();
  }
});

// Lo que ve el cliente en su enlace de seguimiento (solo lo de SU pedido, con la clave secreta).
router.get('/publico/seguimiento/:clave', limiteSeguimiento, async (req, res, next) => {
  try {
    const clave = String(req.params.clave || '');
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(clave)) return res.status(404).json({ error: 'No encontramos ese pedido' });
    const r = await pool.query(
      `SELECT p.id, p.sucursal_id, p.ticket_id, p.estado, p.confirmado_en, p.creado_en, p.salio_en, p.entregado_en,
              p.paga_con, p.pago_previsto, p.motivo_cancelacion, p.nombre_contacto,
              t.total, t.descuento_monto, u.nombre AS repartidor_nombre, u.telefono AS repartidor_telefono,
              (SELECT su.nombre FROM sucursales su WHERE su.id = p.sucursal_id) AS sucursal_nombre
         FROM pedidos p JOIN tickets t ON t.id = p.ticket_id LEFT JOIN usuarios u ON u.id = p.repartidor_id
        WHERE p.seguimiento = $1`, [clave]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontramos ese pedido' });
    const p = r.rows[0];
    const items = await pool.query(
      'SELECT nombre_producto, cantidad, subtotal, producto_id FROM ticket_detalle WHERE ticket_id = $1 ORDER BY id', [p.ticket_id]);
    const neg = await datosNegocio(pool, p.sucursal_id, p.sucursal_nombre);
    const apar = (await pool.query('SELECT tema, color_principal, color_oferta FROM tienda_config WHERE sucursal_id = $1', [p.sucursal_id])).rows[0] || {};
    const paso = p.estado === 'cancelado' ? 'cancelado'
      : p.estado === 'entregado' ? 'entregado'
      : p.estado === 'en_camino' ? 'en_camino'
      : p.estado === 'no_entregado' ? 'no_entregado'
      : !p.confirmado_en ? 'recibido'
      : p.estado === 'listo' ? 'listo' : 'surtiendo';
    const hora = (t) => (t ? new Date(t).toISOString() : null);
    const total = r2(Number(p.total) - Number(p.descuento_monto || 0));
    res.set('Cache-Control', 'no-store');
    res.json({
      numero: numeroPedido(p.id), negocio: neg.negocio, telefono_tienda: neg.telefono, nombre: p.nombre_contacto, ...aparienciaPublica(apar),
      paso, motivo_cancelacion: paso === 'cancelado' ? p.motivo_cancelacion : null,
      horas: { recibido: hora(p.creado_en), confirmado: hora(p.confirmado_en), salio: hora(p.salio_en), entregado: hora(p.entregado_en) },
      repartidor: p.repartidor_nombre ? { nombre: String(p.repartidor_nombre).split(' ')[0], telefono: paso === 'en_camino' ? (p.repartidor_telefono || null) : null } : null,
      total, pago_previsto: p.pago_previsto, paga_con: p.paga_con === null ? null : Number(p.paga_con),
      cambio: p.paga_con !== null && Number(p.paga_con) > total ? r2(Number(p.paga_con) - total) : null,
      items: items.rows.map((i) => ({ nombre: i.nombre_producto, cantidad: Number(i.cantidad), subtotal: Number(i.subtotal), producto_id: i.producto_id }))
    });
  } catch (e) { next(e); }
});

// ================================================================== NEGOCIO (con sesión)
const soloAdmin = [verificarToken, requiereSucursalId, requiereRol(...ROLES_ADMIN)];

async function leerConfig(db, sucursalId) {
  await db.query('INSERT INTO tienda_config (sucursal_id) VALUES ($1) ON CONFLICT (sucursal_id) DO NOTHING', [sucursalId]);
  return (await db.query('SELECT * FROM tienda_config WHERE sucursal_id = $1', [sucursalId])).rows[0];
}

router.get('/config', ...soloAdmin, async (req, res, next) => {
  try {
    const cfg = await leerConfig(pool, req.sucursalId);
    const ocultos = await pool.query('SELECT COUNT(*)::int AS n FROM productos WHERE sucursal_id = $1 AND activo = true AND en_tienda = false', [req.sucursalId]);
    const zonas = await pool.query('SELECT COUNT(*)::int AS n FROM zonas_envio WHERE sucursal_id = $1 AND activo = true', [req.sucursalId]);
    res.json({ ...cfg, pedido_minimo: Number(cfg.pedido_minimo), productos_ocultos: ocultos.rows[0].n, zonas: zonas.rows[0].n, horario_texto: estadoHorario(cfg.horario).texto });
  } catch (e) { next(e); }
});

function validarTramo(t) {
  if (t === null || t === false) return null;
  if (!Array.isArray(t) || t.length !== 2 || !HORA_OK.test(t[0]) || !HORA_OK.test(t[1]) || t[0] >= t[1]) {
    throw new ErrorHttp(400, 'El horario no es válido: escribe la hora en que abres y la hora en que cierras (ej. 08:00 y 20:00)');
  }
  return t;
}

const TEMAS = ['letrero', 'libreta', 'minisuper', 'tianguis', 'color', 'pizarron', 'receta', 'cuadritos', 'estraza', 'taller'];
const colorValido = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : null);
const aparienciaPublica = (cfg) => ({ tema: TEMAS.includes(cfg.tema) ? cfg.tema : 'letrero', color_principal: cfg.color_principal || null, color_oferta: cfg.color_oferta || null });

router.put('/config', ...soloAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const actual = await leerConfig(pool, req.sucursalId);
    const bool = (v, def) => (typeof v === 'boolean' ? v : def);
    const horario = b.horario
      ? { semana: validarTramo(b.horario.semana), domingo: validarTramo(b.horario.domingo) }
      : actual.horario;
    const minimo = b.pedido_minimo === undefined ? Number(actual.pedido_minimo) : Number(b.pedido_minimo);
    if (!Number.isFinite(minimo) || minimo < 0 || minimo > 100000) throw new ErrorHttp(400, 'El pedido mínimo no es válido');
    const maxPend = b.max_pendientes_por_telefono === undefined ? actual.max_pendientes_por_telefono : Number(b.max_pendientes_por_telefono);
    if (!Number.isInteger(maxPend) || maxPend < 1 || maxPend > 20) throw new ErrorHttp(400, 'El máximo de pedidos sin confirmar debe ser de 1 a 20');
    if (b.tema !== undefined && !TEMAS.includes(b.tema)) throw new ErrorHttp(400, 'Ese tema no existe');
    for (const k of ['color_principal', 'color_oferta']) {
      if (b[k] !== undefined && b[k] !== null && b[k] !== '' && !colorValido(b[k])) throw new ErrorHttp(400, 'El color debe ser como #1D6A3A');
    }
    const color = (k) => (b[k] === undefined ? actual[k] || null : colorValido(b[k]));
    const r = await pool.query(
      `UPDATE tienda_config SET activo = $2, giro = $3, horario = $4, tiempo_entrega = $5, pedido_minimo = $6,
              max_pendientes_por_telefono = $7, acepta_tarjeta = $8, fiado_en_linea = $9, ocultar_sin_existencia = $10,
              imprimir_al_confirmar = $11, sonido = $12, tema = $13, color_principal = $14, color_oferta = $15, actualizado_en = NOW()
        WHERE sucursal_id = $1 RETURNING *`,
      [req.sucursalId, bool(b.activo, actual.activo), b.giro === undefined ? actual.giro : textoOnull(b.giro, 120), JSON.stringify(horario),
       textoOnull(b.tiempo_entrega, 40) || actual.tiempo_entrega, r2(minimo), maxPend,
       bool(b.acepta_tarjeta, actual.acepta_tarjeta), bool(b.fiado_en_linea, actual.fiado_en_linea),
       bool(b.ocultar_sin_existencia, actual.ocultar_sin_existencia), bool(b.imprimir_al_confirmar, actual.imprimir_al_confirmar), bool(b.sonido, actual.sonido),
       b.tema === undefined ? (actual.tema || 'letrero') : b.tema, color('color_principal'), color('color_oferta')]);
    await registrarBitacora(pool, { usuario_id: req.usuario.id, accion: 'tienda_config', modulo: 'pedidos', referencia_id: req.sucursalId, valor_nuevo: { activo: r.rows[0].activo } });
    require('../utils/redTiendas').avisar();
    res.json({ ...r.rows[0], pedido_minimo: Number(r.rows[0].pedido_minimo), horario_texto: estadoHorario(r.rows[0].horario).texto });
  } catch (e) { responder(res, e, next); }
});

// Preparación para la red de tiendas de Compoint Pedidos (todavía no se muestra a los clientes):
// el dueño guarda dónde está su tienda y si quiere aparecer cuando se prenda.
router.put('/red', ...soloAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const actual = await leerConfig(pool, req.sucursalId);
    const bool = (v, def) => (typeof v === 'boolean' ? v : def);
    let lat = actual.red_lat == null ? null : Number(actual.red_lat);
    let lng = actual.red_lng == null ? null : Number(actual.red_lng);
    if (b.lat !== undefined || b.lng !== undefined) {
      if (b.lat === null && b.lng === null) { lat = null; lng = null; } else {
        lat = Number(b.lat); lng = Number(b.lng);
        if (b.lat === null || b.lng === null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
          throw new ErrorHttp(400, 'La ubicación no es válida. Usa el botón o pega el enlace de Google Maps de tu tienda');
        }
        lat = Math.round(lat * 1e6) / 1e6; lng = Math.round(lng * 1e6) / 1e6;
      }
    }
    const visible = bool(b.visible, actual.red_visible);
    if (visible && lat === null) throw new ErrorHttp(400, 'Primero pon dónde está tu tienda');
    const domicilio = bool(b.domicilio, actual.red_domicilio);
    const recoger = bool(b.recoger, actual.red_recoger);
    if (visible && !domicilio && !recoger) throw new ErrorHttp(400, 'Escoge al menos una forma de entregar');
    const r = await pool.query(
      `UPDATE tienda_config SET red_visible = $2, red_lat = $3, red_lng = $4, red_direccion = $5, red_domicilio = $6,
              red_recoger = $7, red_buscar = $8, actualizado_en = NOW()
        WHERE sucursal_id = $1
        RETURNING red_visible, red_lat, red_lng, red_direccion, red_domicilio, red_recoger, red_buscar`,
      [req.sucursalId, visible, lat, lng, b.direccion === undefined ? actual.red_direccion : textoOnull(b.direccion, 200),
       domicilio, recoger, bool(b.buscar, actual.red_buscar)]);
    await registrarBitacora(pool, { usuario_id: req.usuario.id, accion: 'tienda_red', modulo: 'pedidos', referencia_id: req.sucursalId, valor_nuevo: { visible } });
    require('../utils/redTiendas').avisar();   // manda el cambio al directorio de Compoint en un momento
    const x = r.rows[0];
    res.json({ ...x, red_lat: x.red_lat == null ? null : Number(x.red_lat), red_lng: x.red_lng == null ? null : Number(x.red_lng) });
  } catch (e) { responder(res, e, next); }
});

// Lista de productos para escoger cuáles se ven en la tienda.
router.get('/productos', ...soloAdmin, async (req, res, next) => {
  try {
    const q = textoOnull(req.query.q, 80);
    const r = await pool.query(
      `SELECT p.id, p.nombre, p.precio, p.en_tienda, (p.imagen_url IS NOT NULL AND p.imagen_url <> '') AS con_foto,
              COALESCE(c.nombre, 'Otros') AS departamento
         FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
        WHERE p.sucursal_id = $1 AND p.activo = true ${q ? 'AND p.nombre ILIKE $2' : ''}
        ORDER BY COALESCE(c.nombre, 'Otros'), p.nombre LIMIT 5000`, q ? [req.sucursalId, `%${q.replace(/[%_\\]/g, '\\$&')}%`] : [req.sucursalId]);
    res.json(r.rows.map((p) => ({ ...p, precio: Number(p.precio) })));
  } catch (e) { next(e); }
});

// Varios de un jalón (un departamento completo o lo que salió en la búsqueda).
router.put('/productos', ...soloAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(Number))] : [];
    if (typeof b.en_tienda !== 'boolean' || !ids.length || ids.length > 5000 || ids.some((i) => !Number.isInteger(i) || i <= 0 || i > 2147483647)) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }
    const r = await pool.query('UPDATE productos SET en_tienda = $3 WHERE id = ANY($1::int[]) AND sucursal_id = $2', [ids, req.sucursalId, b.en_tienda]);
    require('../utils/redTiendas').avisar();
    res.json({ cambiados: r.rowCount });
  } catch (e) { next(e); }
});

router.put('/productos/:id', ...soloAdmin, async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id) || typeof (req.body || {}).en_tienda !== 'boolean') return res.status(400).json({ error: 'Datos inválidos' });
    const r = await pool.query('UPDATE productos SET en_tienda = $3 WHERE id = $1 AND sucursal_id = $2 RETURNING id, en_tienda', [req.params.id, req.sucursalId, req.body.en_tienda]);
    if (!r.rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// Clientes con crédito: su enlace personal para pedir "a su cuenta".
router.get('/fiado', ...soloAdmin, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, nombre, telefono, limite_credito, saldo_actual, enlace_tienda FROM clientes
        WHERE sucursal_id = $1 AND activo = true AND limite_credito > 0 ORDER BY nombre LIMIT 500`, [req.sucursalId]);
    res.json(r.rows.map((c) => ({ ...c, limite_credito: Number(c.limite_credito), saldo_actual: Number(c.saldo_actual || 0) })));
  } catch (e) { next(e); }
});

router.post('/fiado/:id/enlace', ...soloAdmin, async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Cliente inválido' });
    const nuevo = !!(req.body && req.body.nuevo === true);   // "Cambiar enlace": el anterior deja de servir
    const r = await pool.query(
      `UPDATE clientes SET enlace_tienda = CASE WHEN $3 OR enlace_tienda IS NULL THEN $4 ELSE enlace_tienda END
        WHERE id = $1 AND sucursal_id = $2 AND activo = true AND limite_credito > 0 RETURNING id, enlace_tienda`,
      [req.params.id, req.sucursalId, nuevo, nuevaClave()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Ese cliente no existe o no tiene crédito autorizado' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

module.exports = router;
module.exports._estadoHorario = estadoHorario;
// Para la red de tiendas de Compoint Pedidos (utils/redTiendas.js).
module.exports._productosVisibles = productosVisibles;
module.exports._datosNegocio = datosNegocio;
