const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Generar folio corto único: M<sucursal>-<timestamp base36>
function generarFolio(sucursalId) {
  const base = Date.now().toString(36).toUpperCase().slice(-6);
  return `S${sucursalId}-${base}`;
}

// Crear ticket desde mostrador
router.post('/', verificarToken, async (req, res) => {
  const cliente = await pool.connect();
  try {
    const { items } = req.body; // [{tipo, producto_id|kit_id, nombre_producto, cantidad, precio_unitario}]
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'El ticket necesita al menos un producto' });
    }

    await cliente.query('BEGIN');

    const total = items.reduce((sum, it) => sum + (it.cantidad * it.precio_unitario), 0);
    const folio = generarFolio(req.usuario.sucursal_id);

    const ticketResult = await cliente.query(
      `INSERT INTO tickets (folio, sucursal_id, mostrador_usuario_id, estado, total)
       VALUES ($1, $2, $3, 'pendiente', $4) RETURNING *`,
      [folio, req.usuario.sucursal_id, req.usuario.id, total]
    );
    const ticket = ticketResult.rows[0];

    for (const item of items) {
      const subtotal = item.cantidad * item.precio_unitario;
      const tipo = item.tipo === 'kit' ? 'kit' : 'producto';
      await cliente.query(
        `INSERT INTO ticket_detalle (ticket_id, tipo, producto_id, kit_id, nombre_producto, cantidad, precio_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ticket.id, tipo, tipo === 'producto' ? (item.producto_id || null) : null, tipo === 'kit' ? (item.kit_id || null) : null, item.nombre_producto, item.cantidad, item.precio_unitario, subtotal]
      );
    }

    await cliente.query('COMMIT');

    // Avisar a caja en tiempo real
    const io = req.app.get('io');
    if (io) io.to(`sucursal_${req.usuario.sucursal_id}`).emit('nuevo_ticket', { folio, total });

    res.json({ ...ticket, items });
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al generar el ticket' });
  } finally {
    cliente.release();
  }
});

// Bandeja de tickets pendientes (caja)
router.get('/pendientes', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM tickets WHERE sucursal_id = $1 AND estado = 'pendiente' ORDER BY fecha_creacion ASC`,
      [req.usuario.sucursal_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener tickets pendientes' });
  }
});

// Buscar ticket por folio (escaneo en caja)
router.get('/folio/:folio', verificarToken, async (req, res) => {
  try {
    const ticketResult = await pool.query(
      'SELECT * FROM tickets WHERE folio = $1 AND sucursal_id = $2',
      [req.params.folio, req.usuario.sucursal_id]
    );
    if (ticketResult.rows.length === 0) return res.status(404).json({ error: 'Ticket no encontrado' });

    const ticket = ticketResult.rows[0];
    const detalleResult = await pool.query(
      'SELECT * FROM ticket_detalle WHERE ticket_id = $1',
      [ticket.id]
    );
    res.json({ ...ticket, items: detalleResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar el ticket' });
  }
});

// Modificar cantidad de un item antes de cobrar (cliente se arrepiente en la fila)
router.put('/item/:itemId', verificarToken, async (req, res) => {
  try {
    const { cantidad } = req.body;
    if (!cantidad || cantidad <= 0) return res.status(400).json({ error: 'Cantidad inválida' });

    const itemResult = await pool.query('SELECT * FROM ticket_detalle WHERE id = $1', [req.params.itemId]);
    if (itemResult.rows.length === 0) return res.status(404).json({ error: 'Item no encontrado' });
    const item = itemResult.rows[0];

    const nuevoSubtotal = cantidad * item.precio_unitario;
    await pool.query('UPDATE ticket_detalle SET cantidad = $1, subtotal = $2 WHERE id = $3', [cantidad, nuevoSubtotal, item.id]);

    const totalResult = await pool.query('SELECT COALESCE(SUM(subtotal),0) AS total FROM ticket_detalle WHERE ticket_id = $1', [item.ticket_id]);
    await pool.query('UPDATE tickets SET total = $1 WHERE id = $2', [totalResult.rows[0].total, item.ticket_id]);

    res.json({ ok: true, nuevo_total: totalResult.rows[0].total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al modificar la cantidad' });
  }
});

// Eliminar un item del ticket antes de cobrar
router.delete('/item/:itemId', verificarToken, async (req, res) => {
  try {
    const itemResult = await pool.query('SELECT ticket_id FROM ticket_detalle WHERE id = $1', [req.params.itemId]);
    if (itemResult.rows.length === 0) return res.status(404).json({ error: 'Item no encontrado' });
    const ticketId = itemResult.rows[0].ticket_id;

    await pool.query('DELETE FROM ticket_detalle WHERE id = $1', [req.params.itemId]);

    const totalResult = await pool.query('SELECT COALESCE(SUM(subtotal),0) AS total FROM ticket_detalle WHERE ticket_id = $1', [ticketId]);
    await pool.query('UPDATE tickets SET total = $1 WHERE id = $2', [totalResult.rows[0].total, ticketId]);

    res.json({ ok: true, nuevo_total: totalResult.rows[0].total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el item' });
  }
});

// Cobrar ticket (efectivo/tarjeta/mixto/crédito) + descuenta inventario automáticamente
router.post('/:id/pagar', verificarToken, async (req, res) => {
  const conexion = await pool.connect();
  try {
    const { metodo_pago, monto_efectivo, monto_tarjeta, turno_id, cliente_id } = req.body;

    if (metodo_pago === 'credito' && !cliente_id) {
      return res.status(400).json({ error: 'Selecciona un cliente para autorizar el fiado' });
    }

    await conexion.query('BEGIN');

    // FOR UPDATE bloquea esta fila hasta que termine la transacción: si dos cobros
    // llegan casi al mismo tiempo, el segundo espera a que el primero termine y
    // entonces ve el ticket ya pagado, en vez de cobrarlo dos veces.
    const ticketActualResult = await conexion.query(
      'SELECT * FROM tickets WHERE id = $1 AND estado = $2 FOR UPDATE',
      [req.params.id, 'pendiente']
    );
    if (ticketActualResult.rows.length === 0) {
      await conexion.query('ROLLBACK');
      return res.status(409).json({ error: 'Este ticket ya fue pagado, cancelado, o no existe' });
    }
    const ticketActual = ticketActualResult.rows[0];

    // Validar límite de crédito si aplica
    if (metodo_pago === 'credito') {
      const clienteResult = await conexion.query('SELECT * FROM clientes WHERE id = $1 AND sucursal_id = $2', [cliente_id, req.usuario.sucursal_id]);
      if (clienteResult.rows.length === 0) {
        await conexion.query('ROLLBACK');
        return res.status(404).json({ error: 'Cliente no encontrado' });
      }
      const c = clienteResult.rows[0];
      const nuevoSaldo = parseFloat(c.saldo_actual) + parseFloat(ticketActual.total);
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
        fecha_pago = NOW()
       WHERE id = $7 AND estado = 'pendiente' RETURNING *`,
      [req.usuario.id, metodo_pago, monto_efectivo || 0, monto_tarjeta || 0, turno_id || null, metodo_pago === 'credito' ? cliente_id : null, req.params.id]
    );
    if (result.rows.length === 0) {
      await conexion.query('ROLLBACK');
      return res.status(409).json({ error: 'Este ticket ya fue procesado por otra solicitud' });
    }
    const ticketPagado = result.rows[0];

    // Si es fiado: registrar el cargo y actualizar saldo del cliente
    if (metodo_pago === 'credito') {
      await conexion.query(
        `INSERT INTO creditos_cargo (cliente_id, ticket_id, monto, autorizado_por) VALUES ($1, $2, $3, $4)`,
        [cliente_id, ticketPagado.id, ticketPagado.total, req.usuario.id]
      );
      await conexion.query('UPDATE clientes SET saldo_actual = saldo_actual + $1 WHERE id = $2', [ticketPagado.total, cliente_id]);
    }

    // Descontar inventario automáticamente por cada producto vendido (no aplica a kits, que descuentan sus componentes)
    const items = await conexion.query('SELECT * FROM ticket_detalle WHERE ticket_id = $1', [ticketPagado.id]);
    for (const item of items.rows) {
      if (item.tipo === 'producto' && item.producto_id) {
        await conexion.query(
          `INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, 0)
           ON CONFLICT (producto_id) DO NOTHING`,
          [item.producto_id]
        );
        await conexion.query(
          'UPDATE inventario SET existencia_actual = existencia_actual - $1 WHERE producto_id = $2',
          [item.cantidad, item.producto_id]
        );
        await conexion.query(
          `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, referencia_id, usuario_id)
           VALUES ($1, 'salida_venta', $2, $3, $4)`,
          [item.producto_id, -item.cantidad, ticketPagado.id, req.usuario.id]
        );
      } else if (item.tipo === 'kit' && item.kit_id) {
        const componentes = await conexion.query('SELECT * FROM kit_productos WHERE kit_id = $1', [item.kit_id]);
        for (const comp of componentes.rows) {
          const cantidadTotal = comp.cantidad * item.cantidad; // por si el kit se vendió más de una vez
          await conexion.query(
            `INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, 0) ON CONFLICT (producto_id) DO NOTHING`,
            [comp.producto_id]
          );
          await conexion.query(
            'UPDATE inventario SET existencia_actual = existencia_actual - $1 WHERE producto_id = $2',
            [cantidadTotal, comp.producto_id]
          );
          await conexion.query(
            `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, referencia_id, usuario_id)
             VALUES ($1, 'salida_venta', $2, $3, $4)`,
            [comp.producto_id, -cantidadTotal, ticketPagado.id, req.usuario.id]
          );
        }
      }
    }

    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id,
      accion: 'cobrar_ticket',
      modulo: 'tickets',
      referencia_id: ticketPagado.id,
      valor_nuevo: { folio: ticketPagado.folio, total: ticketPagado.total, metodo_pago }
    });

    await conexion.query('COMMIT');

    const io = req.app.get('io');
    if (io) io.to(`sucursal_${req.usuario.sucursal_id}`).emit('ticket_pagado', { id: req.params.id });

    res.json(ticketPagado);
  } catch (err) {
    await conexion.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al procesar el pago' });
  } finally {
    conexion.release();
  }
});

// Cancelar ticket
router.post('/:id/cancelar', verificarToken, async (req, res) => {
  try {
    await pool.query(
      `UPDATE tickets SET estado = 'cancelado' WHERE id = $1 AND estado = 'pendiente'`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar el ticket' });
  }
});

module.exports = router;
