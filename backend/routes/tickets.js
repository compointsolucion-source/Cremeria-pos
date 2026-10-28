const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requierePermiso, requiereSucursalId, tienePermiso } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');
const { r2, subtotalRenglon } = require('../utils/importeExacto');
const { descontarInventarioVenta } = require('../utils/inventarioVenta');
const bcrypt = require('bcryptjs');
const { METODOS_PAGO, validarTurno, montoNoNegativo } = require('../utils/seguridadCaja');

// Toda ruta de este archivo ya filtra por sucursal — se resuelve una sola
// vez aquí (req.sucursalId) en vez de repetirlo en cada endpoint.
router.use(verificarToken, requiereSucursalId);

// Generar folio corto único: S<sucursal><timestamp base36>, sin guion: muchos
// lectores de código de barras cambian el "-" por otro carácter según la
// distribución del teclado. (Los tickets viejos con guion se siguen encontrando.)
function generarFolio(sucursalId) {
  const base = Date.now().toString(36).toUpperCase().slice(-6);
  return `S${sucursalId}${base}`;
}

// Revisa y limpia los renglones que manda una pantalla (mostrador, caja) ANTES de guardarlos:
//  - cantidad > 0 y precio >= 0 (sin negativos que funcionen como descuento escondido);
//  - si el renglón es de un producto o kit, debe ser de ESTA sucursal y el nombre se toma
//    del catálogo (no del que mande la pantalla);
//  - el nombre libre se limpia de caracteres que podrían esconder código (<, >, comillas).
// Devuelve los renglones listos o lanza {status, error}.
function nombreLimpio(t) {
  return String(t == null ? '' : t).replace(/[<>"'`\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
}
async function revisarRenglones(db, items, sucursalId) {
  if (!Array.isArray(items) || !items.length) throw { status: 400, error: 'El ticket necesita al menos un producto' };
  if (items.length > 500) throw { status: 400, error: 'Demasiados renglones en un solo ticket' };
  const salida = [];
  for (const it of items) {
    const cantidad = Number(it && it.cantidad);
    const precio = Number(it && it.precio_unitario);
    if (!(Number.isFinite(cantidad) && cantidad > 0 && cantidad < 1e6)) throw { status: 400, error: 'Cantidad inválida en un renglón' };
    if (!(Number.isFinite(precio) && precio >= 0 && precio < 1e7)) throw { status: 400, error: 'Precio inválido en un renglón' };
    const tipo = it.tipo === 'kit' ? 'kit' : 'producto';
    let nombre = nombreLimpio(it.nombre_producto);
    const id = tipo === 'kit' ? it.kit_id : it.producto_id;
    if (id) {
      const r = await db.query(`SELECT nombre FROM ${tipo === 'kit' ? 'kits' : 'productos'} WHERE id = $1 AND sucursal_id = $2`, [id, sucursalId]);
      if (!r.rows.length) throw { status: 400, error: 'Uno de los productos no es de esta sucursal' };
      nombre = nombreLimpio(r.rows[0].nombre) || nombre;
    }
    if (!nombre) throw { status: 400, error: 'Falta el nombre de un producto' };
    salida.push({ ...it, tipo, cantidad, precio_unitario: precio, nombre_producto: nombre,
      producto_id: tipo === 'producto' ? (it.producto_id || null) : null, kit_id: tipo === 'kit' ? (it.kit_id || null) : null });
  }
  return salida;
}

// Referencia de pago: comentario libre que escribe el cajero al cobrar con tarjeta o transferencia
// (también en pago mixto). Solo para control interno. Se guarda recortada y sin espacios de sobra;
// si viene vacía, o el método no es de los que la llevan, no se guarda nada.
function referenciaPago(metodo, texto) {
  if (!['tarjeta', 'transferencia', 'mixto'].includes(metodo)) return null;
  const limpia = String(texto == null ? '' : texto).replace(/\s+/g, ' ').trim().slice(0, 100);
  return limpia || null;
}

// Crear ticket desde mostrador
router.post('/', verificarToken, requierePermiso('VENTAS_CREAR'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    // [{tipo, producto_id|kit_id, nombre_producto, cantidad, precio_unitario}]
    const items = await revisarRenglones(cliente, req.body && req.body.items, req.sucursalId);

    await cliente.query('BEGIN');

    // Cada renglón se redondea a centavos (y respeta el importe exacto si fue venta por importe).
    const subtotales = items.map(subtotalRenglon);
    const total = r2(subtotales.reduce((sum, s) => sum + s, 0));
    const folio = generarFolio(req.sucursalId);

    const ticketResult = await cliente.query(
      `INSERT INTO tickets (folio, sucursal_id, mostrador_usuario_id, estado, total)
       VALUES ($1, $2, $3, 'pendiente', $4) RETURNING *`,
      [folio, req.sucursalId, req.usuario.id, total]
    );
    const ticket = ticketResult.rows[0];

    const itemsGuardados = [];
    for (let n = 0; n < items.length; n++) {
      const item = items[n];
      const subtotal = subtotales[n];
      const tipo = item.tipo === 'kit' ? 'kit' : 'producto';
      const detalleResult = await cliente.query(
        `INSERT INTO ticket_detalle (ticket_id, tipo, producto_id, kit_id, nombre_producto, cantidad, precio_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [ticket.id, tipo, tipo === 'producto' ? (item.producto_id || null) : null, tipo === 'kit' ? (item.kit_id || null) : null, item.nombre_producto, item.cantidad, item.precio_unitario, subtotal]
      );
      itemsGuardados.push(detalleResult.rows[0]);
    }

    await cliente.query('COMMIT');

    // Avisar a caja en tiempo real
    const io = req.app.get('io');
    if (io) io.to(`sucursal_${req.sucursalId}`).emit('nuevo_ticket', { folio, total });

    res.json({ ...ticket, items: itemsGuardados });
  } catch (err) {
    await cliente.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.error });
    console.error(err);
    res.status(500).json({ error: 'Error al generar el ticket' });
  } finally {
    cliente.release();
  }
});

// Venta cobrada SIN INTERNET en una caja: la caja la guardó en la computadora (con su folio ya
// impreso en el ticket) y la manda aquí al regresar la conexión. Crea el ticket ya pagado, descuenta
// inventario y es idempotente: si el folio ya existe, no la duplica.
router.post('/venta-offline', verificarToken, requierePermiso('VENTAS_CREAR'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    const b = req.body || {};
    const folio = String(b.folio || '').toUpperCase();
    if (!/^[A-Z0-9-]{4,20}$/.test(folio)) return res.status(400).json({ error: 'Folio inválido' });
    const metodosOk = ['efectivo', 'tarjeta', 'transferencia', 'dolares', 'cheque', 'vale_despensa', 'mixto'];
    if (!metodosOk.includes(b.metodo_pago)) return res.status(400).json({ error: 'Método de pago no permitido para ventas sin internet' });
    const previo = await conexion.query('SELECT * FROM tickets WHERE folio = $1', [folio]);
    if (previo.rows.length) {
      // Solo se devuelve si es de esta sucursal (no se enseñan tickets de otra).
      if (Number(previo.rows[0].sucursal_id) !== Number(req.sucursalId)) return res.status(409).json({ error: 'Ese folio ya existe en otra sucursal' });
      return res.json({ ...previo.rows[0], duplicado: true });
    }
    let items;
    try { items = await revisarRenglones(conexion, b.items, req.sucursalId); } catch (e) { return res.status(e.status || 400).json({ error: e.error || 'Renglón de venta inválido' }); }
    // Descuentos en una venta sin internet: solo quien tiene permiso de aplicar descuentos.
    const hayDescuento = Number(b.descuento_monto) > 0 || items.some((it) => Number(it.descuento_monto) > 0);
    if (hayDescuento && !tienePermiso(req.usuario, 'DESCUENTO_APLICAR')) {
      return res.status(403).json({ error: 'Esta venta trae descuento y tu usuario no tiene permiso de aplicar descuentos' });
    }

    // Fecha real de la venta (la de la caja), sin permitir futuro ni más de 60 días atrás.
    let fecha = new Date(b.fecha);
    const ahora = new Date();
    if (isNaN(fecha.getTime()) || fecha > ahora) fecha = ahora;
    if (ahora - fecha > 60 * 24 * 3600 * 1000) fecha = ahora;

    const lineas = items.map((it) => {
      const cantidad = Number(it.cantidad), precio = Number(it.precio_unitario);
      const subtotal = subtotalRenglon(it); // respeta el importe exacto de una venta por importe
      const desc = Math.min(Math.max(r2(Number(it.descuento_monto) || 0), 0), subtotal);
      return { it, cantidad, precio, subtotal, desc, tipo: it.tipo === 'kit' ? 'kit' : 'producto' };
    });
    const bruto = r2(lineas.reduce((s, l) => s + l.subtotal, 0));
    const descItems = r2(lineas.reduce((s, l) => s + l.desc, 0));
    const descTicket = Math.min(Math.max(r2(Number(b.descuento_monto) || 0), 0), r2(bruto - descItems));
    const neto = r2(bruto - descItems - descTicket);

    const montoEfectivo = Math.max(Number(b.monto_efectivo) || 0, 0);
    const montoTarjeta = Math.max(Number(b.monto_tarjeta) || 0, 0);
    const efectivoRecibido = b.efectivo_recibido ? Math.max(Number(b.efectivo_recibido) || 0, 0) : null;

    // El turno debe ser de esta sucursal y del propio cajero (puede ya estar cerrado: la venta se hizo sin internet).
    let turnoId = null;
    try {
      const t = await validarTurno(conexion, { turnoId: b.turno_id, sucursalId: req.sucursalId, usuario: req.usuario, exigirAbierto: false });
      turnoId = t ? t.id : null;
    } catch (e) { return res.status(e.status || 400).json({ error: e.error }); }
    if (montoEfectivo + montoTarjeta + 0.05 < neto) {
      return res.status(400).json({ error: 'Lo cobrado no cubre el total de la venta' });
    }

    await conexion.query('BEGIN');
    const tk = (await conexion.query(
      `INSERT INTO tickets (folio, sucursal_id, mostrador_usuario_id, cajero_usuario_id, turno_id, estado, total,
         metodo_pago, monto_efectivo, monto_tarjeta, fecha_creacion, fecha_pago, descuento_monto, descuento_motivo, efectivo_recibido, referencia_pago)
       VALUES ($1,$2,$3,$3,$4,'pagado',$5,$6,$7,$8,$9::timestamptz,$9::timestamptz,$10,$11,$12,$13) RETURNING *`,
      [folio, req.sucursalId, req.usuario.id, turnoId, bruto, b.metodo_pago, montoEfectivo, montoTarjeta, fecha.toISOString(),
       descTicket, descTicket > 0 ? String(b.descuento_motivo || 'Descuento (venta sin internet)').slice(0, 255) : null, efectivoRecibido,
       referenciaPago(b.metodo_pago, b.referencia_pago)]
    )).rows[0];
    for (const l of lineas) {
      await conexion.query(
        `INSERT INTO ticket_detalle (ticket_id, tipo, producto_id, kit_id, nombre_producto, cantidad, precio_unitario, subtotal, descuento_monto, descuento_motivo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tk.id, l.tipo, l.tipo === 'producto' ? (l.it.producto_id || null) : null, l.tipo === 'kit' ? (l.it.kit_id || null) : null,
         l.it.nombre_producto, l.cantidad, l.precio, l.subtotal, l.desc,
         l.desc > 0 ? String(l.it.descuento_motivo || 'Descuento (venta sin internet)').slice(0, 255) : null]
      );
    }
    const agotados = await descontarInventarioVenta(conexion, tk.id, req.usuario.id);
    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id, accion: 'cobrar_ticket', modulo: 'tickets', referencia_id: tk.id,
      valor_nuevo: { folio, total: bruto, metodo_pago: b.metodo_pago, venta_sin_internet: true, fecha_venta: fecha.toISOString() }
    });
    await conexion.query('COMMIT');

    const io = req.app.get('io');
    if (io) io.to(`sucursal_${req.sucursalId}`).emit('ticket_pagado', { id: tk.id });
    res.json({ ...tk, total_neto: neto, productos_agotados: [...new Set(agotados)] });
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') { // otro envío igual llegó al mismo tiempo
      const ya = await pool.query('SELECT * FROM tickets WHERE folio = $1 AND sucursal_id = $2', [String(req.body && req.body.folio || '').toUpperCase(), req.sucursalId]).catch(() => ({ rows: [] }));
      if (ya.rows.length) return res.json({ ...ya.rows[0], duplicado: true });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la venta hecha sin internet' });
  } finally {
    conexion.release();
  }
});

// Ticket generado en el MOSTRADOR SIN INTERNET: el mostrador lo guardó en su computadora, imprimió el
// ticket con su folio y lo manda aquí al regresar la conexión para que caja lo cobre.
// Idempotente: si el folio ya existe, no lo duplica.
router.post('/pendiente-offline', verificarToken, requierePermiso('VENTAS_CREAR'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    const b = req.body || {};
    const folio = String(b.folio || '').toUpperCase();
    if (!/^[A-Z0-9-]{4,20}$/.test(folio)) return res.status(400).json({ error: 'Folio inválido' });
    const previo = await conexion.query('SELECT * FROM tickets WHERE folio = $1', [folio]);
    if (previo.rows.length) {
      if (Number(previo.rows[0].sucursal_id) !== Number(req.sucursalId)) return res.status(409).json({ error: 'Ese folio ya existe en otra sucursal' });
      return res.json({ ...previo.rows[0], duplicado: true });
    }
    let items;
    try { items = await revisarRenglones(conexion, b.items, req.sucursalId); } catch (e) { return res.status(e.status || 400).json({ error: e.error || 'Renglón de ticket inválido' }); }

    let fecha = new Date(b.fecha);
    const ahora = new Date();
    if (isNaN(fecha.getTime()) || fecha > ahora) fecha = ahora;
    if (ahora - fecha > 60 * 24 * 3600 * 1000) fecha = ahora;

    const subtotales = items.map(subtotalRenglon);
    const total = r2(subtotales.reduce((sum, s) => sum + s, 0));
    await conexion.query('BEGIN');
    const ticket = (await conexion.query(
      `INSERT INTO tickets (folio, sucursal_id, mostrador_usuario_id, estado, total, fecha_creacion)
       VALUES ($1, $2, $3, 'pendiente', $4, $5::timestamptz) RETURNING *`,
      [folio, req.sucursalId, req.usuario.id, total, fecha.toISOString()]
    )).rows[0];
    for (let n = 0; n < items.length; n++) {
      const item = items[n];
      const tipo = item.tipo === 'kit' ? 'kit' : 'producto';
      await conexion.query(
        `INSERT INTO ticket_detalle (ticket_id, tipo, producto_id, kit_id, nombre_producto, cantidad, precio_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ticket.id, tipo, tipo === 'producto' ? (item.producto_id || null) : null, tipo === 'kit' ? (item.kit_id || null) : null,
         item.nombre_producto, item.cantidad, item.precio_unitario, subtotales[n]]
      );
    }
    await conexion.query('COMMIT');
    const io = req.app.get('io');
    if (io) io.to(`sucursal_${req.sucursalId}`).emit('nuevo_ticket', { folio, total });
    res.json(ticket);
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      const ya = await pool.query('SELECT * FROM tickets WHERE folio = $1 AND sucursal_id = $2', [String(req.body && req.body.folio || '').toUpperCase(), req.sucursalId]).catch(() => ({ rows: [] }));
      if (ya.rows.length) return res.json({ ...ya.rows[0], duplicado: true });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al guardar el ticket hecho sin internet' });
  } finally {
    conexion.release();
  }
});

// Bandeja de tickets pendientes (caja)
router.get('/pendientes', verificarToken, async (req, res) => {
  try {
    let result;
    try {
      // Los pedidos a domicilio que cobra el repartidor al entregar, y los programados que aún no
      // toca preparar, no estorban en la bandeja de Caja: salen cuando les corresponde.
      result = await pool.query(
        `SELECT t.*, p.id AS pedido_id, p.tipo AS pedido_tipo, p.estado AS pedido_estado, p.pago_modo AS pedido_pago_modo,
                p.nombre_contacto AS pedido_contacto, p.anticipo AS pedido_anticipo, p.anticipo_metodo AS pedido_anticipo_metodo
           FROM tickets t LEFT JOIN pedidos p ON p.ticket_id = t.id
          WHERE t.sucursal_id = $1 AND t.estado = 'pendiente'
            AND (p.id IS NULL OR (p.estado NOT IN ('programado', 'cancelado') AND NOT (p.tipo = 'domicilio' AND p.pago_modo = 'al_recibir')))
          ORDER BY t.fecha_creacion ASC`,
        [req.sucursalId]
      );
    } catch (e) {
      if (e.code !== '42P01') throw e; // la tabla de pedidos aún no existe (migración pendiente): bandeja de siempre
      result = await pool.query(
        `SELECT * FROM tickets WHERE sucursal_id = $1 AND estado = 'pendiente' ORDER BY fecha_creacion ASC`,
        [req.sucursalId]
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener tickets pendientes' });
  }
});

// Buscar ticket por folio (escaneo en caja)
router.get('/folio/:folio', verificarToken, async (req, res) => {
  try {
    let ticketResult = await pool.query(
      'SELECT * FROM tickets WHERE folio = $1 AND sucursal_id = $2',
      [req.params.folio, req.sucursalId]
    );
    if (ticketResult.rows.length === 0) {
      // El lector pudo cambiar o quitar el guion (S1-ABC123 ↔ S1ABC123): se compara sin símbolos.
      const limpio = String(req.params.folio).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (limpio) {
        ticketResult = await pool.query(
          `SELECT * FROM tickets WHERE sucursal_id = $2 AND REGEXP_REPLACE(UPPER(folio), '[^A-Z0-9]', '', 'g') = $1
           ORDER BY id DESC LIMIT 1`,
          [limpio, req.sucursalId]
        );
      }
    }
    if (ticketResult.rows.length === 0) return res.status(404).json({ error: 'Ticket no encontrado' });

    const ticket = ticketResult.rows[0];
    // Cada renglón trae la foto del producto o kit (si tiene) para mostrarla en Caja.
    const detalleResult = await pool.query(
      `SELECT d.*, COALESCE(p.imagen_url, k.imagen_url) AS imagen_url, p.tipo_venta AS tipo_venta
         FROM ticket_detalle d
         LEFT JOIN productos p ON p.id = d.producto_id
         LEFT JOIN kits k ON k.id = d.kit_id
        WHERE d.ticket_id = $1 ORDER BY d.id`,
      [ticket.id]
    );
    // Si es el ticket de un pedido (a domicilio / para recoger), Caja ve quién es y si dejó anticipo.
    let pedido = {};
    try {
      const pr = await pool.query(
        `SELECT id, tipo, estado, pago_modo, nombre_contacto, anticipo, anticipo_metodo FROM pedidos WHERE ticket_id = $1`, [ticket.id]);
      if (pr.rows.length) {
        const x = pr.rows[0];
        pedido = { pedido_id: x.id, pedido_tipo: x.tipo, pedido_estado: x.estado, pedido_pago_modo: x.pago_modo, pedido_contacto: x.nombre_contacto,
          pedido_anticipo: x.anticipo, pedido_anticipo_metodo: x.anticipo_metodo };
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e; // sin tabla/columnas de pedidos todavía: el ticket de siempre
    }
    res.json({ ...ticket, ...pedido, items: detalleResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar el ticket' });
  }
});

// Último ticket cobrado (para "Reimprimir Último Ticket" en Caja Avanzada)
router.get('/ultimo-pagado', verificarToken, async (req, res) => {
  try {
    const ticketResult = await pool.query(
      `SELECT * FROM tickets WHERE sucursal_id = $1 AND estado = 'pagado'
       ORDER BY fecha_pago DESC LIMIT 1`,
      [req.sucursalId]
    );
    if (ticketResult.rows.length === 0) return res.status(404).json({ error: 'No se ha cobrado ningún ticket todavía' });

    const ticket = ticketResult.rows[0];
    const detalleResult = await pool.query(
      `SELECT d.*, p.tipo_venta AS tipo_venta
         FROM ticket_detalle d LEFT JOIN productos p ON p.id = d.producto_id
        WHERE d.ticket_id = $1 ORDER BY d.id`,
      [ticket.id]
    );
    res.json({ ...ticket, items: detalleResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el último ticket' });
  }
});

// Historial de ventas de un día (para el panel de "Ventas y Devoluciones del
// día" en Caja Avanzada) — incluye pagados y cancelados, con nombre de cajero.
router.get('/historial-dia', verificarToken, async (req, res) => {
  try {
    const { fecha, cajero_id } = req.query;
    const fechaConsulta = fecha || new Date().toISOString().split('T')[0];

    const result = await pool.query(
      `SELECT t.id, t.folio, t.total, t.estado, t.metodo_pago, t.referencia_pago, t.fecha_pago, t.fecha_creacion,
              u.nombre AS cajero_nombre,
              (SELECT COUNT(*) FROM ticket_detalle WHERE ticket_id = t.id) AS num_articulos
       FROM tickets t
       LEFT JOIN usuarios u ON t.cajero_usuario_id = u.id
       WHERE t.sucursal_id = $1
         AND COALESCE(t.fecha_pago, t.fecha_creacion)::date = $2
         AND t.estado IN ('pagado', 'cancelado')
         AND ($3::int IS NULL OR t.cajero_usuario_id = $3)
       ORDER BY COALESCE(t.fecha_pago, t.fecha_creacion) DESC`,
      [req.sucursalId, fechaConsulta, cajero_id || null]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el historial de ventas' });
  }
});

// Modificar cantidad de un item antes de cobrar (cliente se arrepiente en la fila)
// Agrega un producto/kit más a un ticket que ya existe (aún pendiente de
// pago) — para cuando se trae un ticket de Mostrador a Caja Avanzada y se
// quiere seguir agregando cosas antes de cobrar, sin generar un ticket
// aparte que dupliraría la venta.
router.post('/:id/agregar-item', verificarToken, requierePermiso('VENTAS_CREAR'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    if (!req.body || !req.body.nombre_producto) return res.status(400).json({ error: 'Faltan datos del producto a agregar' });
    const [renglon] = await revisarRenglones(cliente, [req.body], req.sucursalId);
    const { tipo, producto_id, kit_id, nombre_producto, cantidad, precio_unitario } = renglon;

    await cliente.query('BEGIN');

    const ticketResult = await cliente.query(
      'SELECT * FROM tickets WHERE id = $1 AND sucursal_id = $2 AND estado = $3 FOR UPDATE',
      [req.params.id, req.sucursalId, 'pendiente']
    );
    if (ticketResult.rows.length === 0) {
      await cliente.query('ROLLBACK');
      return res.status(404).json({ error: 'El ticket no existe o ya no está pendiente (puede que ya se haya cobrado)' });
    }
    const ticket = ticketResult.rows[0];

    const tipoNormalizado = tipo === 'kit' ? 'kit' : 'producto';
    const subtotal = subtotalRenglon({ cantidad, precio_unitario, importe: req.body.importe });

    const detalleResult = await cliente.query(
      `INSERT INTO ticket_detalle (ticket_id, tipo, producto_id, kit_id, nombre_producto, cantidad, precio_unitario, subtotal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [ticket.id, tipoNormalizado, tipoNormalizado === 'producto' ? (producto_id || null) : null, tipoNormalizado === 'kit' ? (kit_id || null) : null, nombre_producto, cantidad, precio_unitario, subtotal]
    );

    const nuevoTotal = r2(parseFloat(ticket.total) + subtotal);
    const ticketActualizado = await cliente.query(
      'UPDATE tickets SET total = $1 WHERE id = $2 RETURNING *',
      [nuevoTotal, ticket.id]
    );

    await cliente.query('COMMIT');

    const io = req.app.get('io');
    if (io) io.to(`sucursal_${req.sucursalId}`).emit('ticket_actualizado', { folio: ticket.folio, total: nuevoTotal });

    res.json({ ticket: ticketActualizado.rows[0], item: detalleResult.rows[0] });
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.error });
    console.error(err);
    res.status(500).json({ error: 'Error al agregar el producto al ticket' });
  } finally {
    cliente.release();
  }
});

// Busca un renglón SOLO si su ticket es de esta sucursal y sigue pendiente (no se tocan ventas cobradas).
async function renglonEditable(db, itemId, sucursalId) {
  const r = await db.query(
    `SELECT d.* FROM ticket_detalle d JOIN tickets t ON t.id = d.ticket_id
      WHERE d.id = $1 AND t.sucursal_id = $2 AND t.estado = 'pendiente' FOR UPDATE OF t`,
    [itemId, sucursalId]);
  return r.rows[0] || null;
}

router.put('/item/:itemId', verificarToken, requierePermiso('VENTAS_CREAR'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    const cantidad = Number(req.body && req.body.cantidad);
    if (!(Number.isFinite(cantidad) && cantidad > 0 && cantidad < 1e6)) return res.status(400).json({ error: 'Cantidad inválida' });

    await conexion.query('BEGIN');
    const item = await renglonEditable(conexion, req.params.itemId, req.sucursalId);
    if (!item) { await conexion.query('ROLLBACK'); return res.status(404).json({ error: 'El producto no existe o el ticket ya se cobró' }); }

    const nuevoSubtotal = r2(cantidad * item.precio_unitario);
    await conexion.query('UPDATE ticket_detalle SET cantidad = $1, subtotal = $2 WHERE id = $3', [cantidad, nuevoSubtotal, item.id]);

    const totalResult = await conexion.query('SELECT COALESCE(SUM(subtotal),0) AS total FROM ticket_detalle WHERE ticket_id = $1', [item.ticket_id]);
    await conexion.query('UPDATE tickets SET total = $1 WHERE id = $2', [totalResult.rows[0].total, item.ticket_id]);
    await registrarBitacora(conexion, { usuario_id: req.usuario.id, accion: 'modificar_renglon', modulo: 'tickets', referencia_id: item.ticket_id,
      valor_anterior: { renglon: item.id, cantidad: item.cantidad }, valor_nuevo: { renglon: item.id, cantidad } });
    await conexion.query('COMMIT');

    res.json({ ok: true, nuevo_total: totalResult.rows[0].total });
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al modificar la cantidad' });
  } finally {
    conexion.release();
  }
});

// Eliminar un item del ticket antes de cobrar
router.delete('/item/:itemId', verificarToken, requierePermiso('VENTAS_CREAR'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    await conexion.query('BEGIN');
    const item = await renglonEditable(conexion, req.params.itemId, req.sucursalId);
    if (!item) { await conexion.query('ROLLBACK'); return res.status(404).json({ error: 'El producto no existe o el ticket ya se cobró' }); }
    const ticketId = item.ticket_id;

    await conexion.query('DELETE FROM ticket_detalle WHERE id = $1', [item.id]);

    const totalResult = await conexion.query('SELECT COALESCE(SUM(subtotal),0) AS total FROM ticket_detalle WHERE ticket_id = $1', [ticketId]);
    await conexion.query('UPDATE tickets SET total = $1 WHERE id = $2', [totalResult.rows[0].total, ticketId]);
    await registrarBitacora(conexion, { usuario_id: req.usuario.id, accion: 'quitar_renglon', modulo: 'tickets', referencia_id: ticketId,
      valor_anterior: { renglon: item.id, producto: item.nombre_producto, cantidad: item.cantidad } });
    await conexion.query('COMMIT');

    res.json({ ok: true, nuevo_total: totalResult.rows[0].total });
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el item' });
  } finally {
    conexion.release();
  }
});

// Aplicar un descuento al ticket antes de cobrar. Descuentos mayores al 15%
// requieren autorización extra (usuario y contraseña de un dueño/gerente),
// aunque quien esté cobrando ya tenga el permiso DESCUENTO_APLICAR — es una
// segunda capa para descuentos grandes, no un reemplazo del permiso.
// Valida la autorización extra requerida cuando un descuento supera el 15%.
// Devuelve el id de quien autoriza, o lanza un objeto {status, error} si falla.
async function verificarAutorizacionDescuento(porcentajeEfectivo, autorizacion, usuarioActual, sucursalId) {
  if (porcentajeEfectivo <= 15) return usuarioActual.id;

  if (!autorizacion || !autorizacion.usuario || !autorizacion.password) {
    throw { status: 403, error: 'Este descuento supera el 15% y requiere autorización de un dueño o gerente (usuario y contraseña)' };
  }
  const autorizador = await pool.query(
    `SELECT * FROM usuarios WHERE usuario = $1 AND sucursal_id = $2 AND activo = true AND rol IN ('dueno','gerente')`,
    [autorizacion.usuario, sucursalId]
  );
  if (autorizador.rows.length === 0) {
    throw { status: 403, error: 'Usuario de autorización no encontrado o no tiene rango suficiente' };
  }
  const passwordValida = await bcrypt.compare(autorizacion.password, autorizador.rows[0].password_hash);
  if (!passwordValida) {
    throw { status: 403, error: 'Contraseña de autorización incorrecta' };
  }
  return autorizador.rows[0].id;
}

router.put('/:id/descuento', verificarToken, requierePermiso('DESCUENTO_APLICAR'), async (req, res) => {
  try {
    const { porcentaje, monto, motivo, autorizacion } = req.body;
    if (!motivo) return res.status(400).json({ error: 'El motivo del descuento es obligatorio' });
    if (!porcentaje && !monto) return res.status(400).json({ error: 'Especifica un porcentaje o un monto de descuento' });

    const ticketResult = await pool.query('SELECT * FROM tickets WHERE id = $1 AND sucursal_id = $2 AND estado = $3', [req.params.id, req.sucursalId, 'pendiente']);
    if (ticketResult.rows.length === 0) return res.status(404).json({ error: 'Ticket no encontrado o ya no está pendiente' });
    const ticket = ticketResult.rows[0];

    const descuentoMonto = porcentaje ? (parseFloat(ticket.total) * (parseFloat(porcentaje) / 100)) : parseFloat(monto);
    if (descuentoMonto <= 0 || descuentoMonto > parseFloat(ticket.total)) {
      return res.status(400).json({ error: 'El descuento debe ser mayor a 0 y no puede superar el total del ticket' });
    }

    const porcentajeEfectivo = (descuentoMonto / parseFloat(ticket.total)) * 100;
    const autorizadoPor = await verificarAutorizacionDescuento(porcentajeEfectivo, autorizacion, req.usuario, req.sucursalId);

    await pool.query(
      'UPDATE tickets SET descuento_monto = $1, descuento_motivo = $2, descuento_autorizado_por = $3 WHERE id = $4',
      [descuentoMonto, motivo, autorizadoPor, req.params.id]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'aplicar_descuento',
      modulo: 'tickets',
      referencia_id: parseInt(req.params.id),
      valor_nuevo: { descuento_monto: descuentoMonto, motivo, autorizado_por: autorizadoPor, porcentaje: porcentajeEfectivo.toFixed(1) }
    });

    res.json({ ok: true, descuento_monto: descuentoMonto, total_final: parseFloat(ticket.total) - descuentoMonto });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.error });
    console.error(err);
    res.status(500).json({ error: 'Error al aplicar el descuento' });
  }
});

// Descuento sobre un producto/línea específica del ticket (en vez de todo el ticket)
router.put('/item/:itemId/descuento', verificarToken, requierePermiso('DESCUENTO_APLICAR'), async (req, res) => {
  try {
    const { porcentaje, monto, motivo, autorizacion } = req.body;
    if (!motivo) return res.status(400).json({ error: 'El motivo del descuento es obligatorio' });
    if (!porcentaje && !monto) return res.status(400).json({ error: 'Especifica un porcentaje o un monto de descuento' });

    const itemResult = await pool.query(
      `SELECT td.*, t.sucursal_id, t.estado FROM ticket_detalle td
       JOIN tickets t ON td.ticket_id = t.id WHERE td.id = $1`,
      [req.params.itemId]
    );
    if (itemResult.rows.length === 0) return res.status(404).json({ error: 'Producto del ticket no encontrado' });
    const item = itemResult.rows[0];
    if (item.sucursal_id !== req.sucursalId) return res.status(404).json({ error: 'Producto del ticket no encontrado' });
    if (item.estado !== 'pendiente') return res.status(400).json({ error: 'El ticket ya no está pendiente' });

    const descuentoMonto = porcentaje ? (parseFloat(item.subtotal) * (parseFloat(porcentaje) / 100)) : parseFloat(monto);
    if (descuentoMonto <= 0 || descuentoMonto > parseFloat(item.subtotal)) {
      return res.status(400).json({ error: 'El descuento debe ser mayor a 0 y no puede superar el subtotal de ese producto' });
    }

    const porcentajeEfectivo = (descuentoMonto / parseFloat(item.subtotal)) * 100;
    const autorizadoPor = await verificarAutorizacionDescuento(porcentajeEfectivo, autorizacion, req.usuario, req.sucursalId);

    await pool.query(
      'UPDATE ticket_detalle SET descuento_monto = $1, descuento_motivo = $2 WHERE id = $3',
      [descuentoMonto, motivo, item.id]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'aplicar_descuento',
      modulo: 'tickets',
      referencia_id: item.ticket_id,
      valor_nuevo: { producto: item.nombre_producto, descuento_monto: descuentoMonto, motivo, autorizado_por: autorizadoPor }
    });

    res.json({ ok: true, descuento_monto: descuentoMonto });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.error });
    console.error(err);
    res.status(500).json({ error: 'Error al aplicar el descuento al producto' });
  }
});

// Cobrar ticket (efectivo/tarjeta/mixto/crédito) + descuenta inventario automáticamente
router.post('/:id/pagar', verificarToken, async (req, res) => {
  const conexion = await pool.connect();
  try {
    const { metodo_pago, turno_id, cliente_id } = req.body || {};
    const referencia = referenciaPago(metodo_pago, req.body.referencia_pago);
    if (!METODOS_PAGO.includes(metodo_pago)) return res.status(400).json({ error: 'Forma de pago no válida' });
    const monto_efectivo = montoNoNegativo(req.body.monto_efectivo);
    const monto_tarjeta = montoNoNegativo(req.body.monto_tarjeta);
    const efectivo_recibido = montoNoNegativo(req.body.efectivo_recibido);
    if (monto_efectivo === null || monto_tarjeta === null || efectivo_recibido === null) return res.status(400).json({ error: 'Montos de pago no válidos' });

    if (metodo_pago === 'credito' && !cliente_id) {
      return res.status(400).json({ error: 'Selecciona un cliente para autorizar el fiado' });
    }

    await conexion.query('BEGIN');

    // Se cobra SIEMPRE dentro del turno abierto del propio cajero (dueño/gerente pueden usar uno de la sucursal).
    let turno;
    try {
      turno = await validarTurno(conexion, { turnoId: turno_id, sucursalId: req.sucursalId, usuario: req.usuario, obligatorio: true });
    } catch (e) {
      await conexion.query('ROLLBACK');
      return res.status(e.status || 400).json({ error: e.error });
    }

    // FOR UPDATE bloquea esta fila hasta que termine la transacción: si dos cobros
    // llegan casi al mismo tiempo, el segundo espera a que el primero termine y
    // entonces ve el ticket ya pagado, en vez de cobrarlo dos veces.
    const ticketActualResult = await conexion.query(
      'SELECT * FROM tickets WHERE id = $1 AND estado = $2 AND sucursal_id = $3 FOR UPDATE',
      [req.params.id, 'pendiente', req.sucursalId]
    );
    if (ticketActualResult.rows.length === 0) {
      await conexion.query('ROLLBACK');
      return res.status(409).json({ error: 'Este ticket ya fue pagado, cancelado, o no existe' });
    }
    const ticketActual = ticketActualResult.rows[0];
    const itemsDescuentoResult = await conexion.query(
      'SELECT COALESCE(SUM(descuento_monto),0) AS total FROM ticket_detalle WHERE ticket_id = $1',
      [req.params.id]
    );
    const descuentoItems = parseFloat(itemsDescuentoResult.rows[0].total);
    const totalNeto = parseFloat(ticketActual.total) - parseFloat(ticketActual.descuento_monto || 0) - descuentoItems;
    if (totalNeto < -0.005) {
      await conexion.query('ROLLBACK');
      return res.status(400).json({ error: 'El descuento es mayor que el total. Quita o ajusta el descuento antes de cobrar.' });
    }
    // Lo cobrado debe cubrir el total (salvo fiado, que se carga a la cuenta del cliente).
    if (metodo_pago !== 'credito' && monto_efectivo + monto_tarjeta + 0.05 < totalNeto) {
      await conexion.query('ROLLBACK');
      return res.status(400).json({ error: 'Lo cobrado no cubre el total del ticket' });
    }

    // Validar límite de crédito si aplica
    if (metodo_pago === 'credito') {
      const clienteResult = await conexion.query('SELECT * FROM clientes WHERE id = $1 AND sucursal_id = $2 FOR UPDATE', [cliente_id, req.sucursalId]);
      if (clienteResult.rows.length === 0) {
        await conexion.query('ROLLBACK');
        return res.status(404).json({ error: 'Cliente no encontrado' });
      }
      const c = clienteResult.rows[0];
      const nuevoSaldo = parseFloat(c.saldo_actual) + totalNeto;
      if (nuevoSaldo > parseFloat(c.limite_credito)) {
        await conexion.query('ROLLBACK');
        return res.status(400).json({ error: `Límite de crédito excedido. Saldo actual: $${c.saldo_actual}, límite: $${c.limite_credito}` });
      }
    }

    const result = await conexion.query(
      `UPDATE tickets SET
        estado = 'pagado',
        cajero_usuario_id = $1,
        metodo_pago = $2,
        monto_efectivo = $3,
        monto_tarjeta = $4,
        turno_id = $5,
        cliente_id = $6,
        fecha_pago = NOW(),
        efectivo_recibido = $8,
        referencia_pago = $9
       WHERE id = $7 AND estado = 'pendiente' RETURNING *`,
      [req.usuario.id, metodo_pago, monto_efectivo, monto_tarjeta, turno.id, metodo_pago === 'credito' ? cliente_id : null, req.params.id, efectivo_recibido || null, referencia]
    );
    if (result.rows.length === 0) {
      await conexion.query('ROLLBACK');
      return res.status(409).json({ error: 'Este ticket ya fue procesado por otra solicitud' });
    }
    const ticketPagado = result.rows[0];

    // Si es fiado: registrar el cargo y actualizar saldo del cliente (usando el
    // total NETO, es decir ya con el descuento aplicado si lo hubo)
    if (metodo_pago === 'credito') {
      await conexion.query(
        `INSERT INTO creditos_cargo (cliente_id, ticket_id, monto, autorizado_por) VALUES ($1, $2, $3, $4)`,
        [cliente_id, ticketPagado.id, totalNeto, req.usuario.id]
      );
      await conexion.query('UPDATE clientes SET saldo_actual = saldo_actual + $1 WHERE id = $2', [totalNeto, cliente_id]);
    }

    const productosAgotados = await descontarInventarioVenta(conexion, ticketPagado.id, req.usuario.id);

    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id,
      accion: 'cobrar_ticket',
      modulo: 'tickets',
      referencia_id: ticketPagado.id,
      valor_nuevo: { folio: ticketPagado.folio, total: ticketPagado.total, metodo_pago }
    });

    await conexion.query('COMMIT');

    const io = req.app.get('io');
    if (io) io.to(`sucursal_${req.sucursalId}`).emit('ticket_pagado', { id: req.params.id });

    res.json({ ...ticketPagado, total_neto: totalNeto, productos_agotados: [...new Set(productosAgotados)] });
  } catch (err) {
    await conexion.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al procesar el pago' });
  } finally {
    conexion.release();
  }
});

// Cancelar ticket
router.post('/:id/cancelar', verificarToken, requierePermiso('VENTAS_CANCELAR'), async (req, res) => {
  try {
    const { motivo } = req.body;
    const result = await pool.query(
      `UPDATE tickets SET estado = 'cancelado' WHERE id = $1 AND estado = 'pendiente' AND sucursal_id = $2 RETURNING folio`,
      [req.params.id, req.sucursalId]
    );

    if (result.rows.length > 0) {
      // Si el ticket era de un pedido a domicilio / para recoger, el pedido también queda cancelado.
      try {
        const ped = await pool.query(
          `UPDATE pedidos SET estado = 'cancelado', motivo_cancelacion = $2
            WHERE ticket_id = $1 AND estado NOT IN ('entregado', 'cancelado') RETURNING id, sucursal_id`,
          [req.params.id, motivo || 'Se canceló el ticket']
        );
        const io = req.app.get('io');
        if (io) for (const p of ped.rows) io.to(`sucursal_${p.sucursal_id}`).emit('pedido_actualizado', { id: p.id, estado: 'cancelado' });
      } catch (e) {
        if (e.code !== '42P01') console.error(e);
      }
      await registrarBitacora(pool, {
        usuario_id: req.usuario.id,
        accion: 'cancelar_ticket',
        modulo: 'tickets',
        referencia_id: parseInt(req.params.id),
        valor_nuevo: { folio: result.rows[0].folio, motivo: motivo || 'Sin motivo especificado' }
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar el ticket' });
  }
});

module.exports = router;
