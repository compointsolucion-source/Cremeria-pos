const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requierePermiso } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Historial de devoluciones
router.get('/', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, t.folio, u.nombre AS usuario_nombre
       FROM devoluciones d
       JOIN tickets t ON d.ticket_id = t.id
       JOIN usuarios u ON d.usuario_id = u.id
       WHERE t.sucursal_id = $1
       ORDER BY d.fecha DESC LIMIT 50`,
      [req.usuario.sucursal_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el historial de devoluciones' });
  }
});

// Registrar una devolución
router.post('/', verificarToken, requierePermiso('VENTAS_DEVOLVER'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    const { ticket_id, items, metodo_reembolso, motivo, turno_id } = req.body;
    // items: [{ ticket_detalle_id, cantidad_devuelta, regresa_inventario }]

    if (!ticket_id || !items || items.length === 0 || !metodo_reembolso) {
      return res.status(400).json({ error: 'Ticket, items y método de reembolso son requeridos' });
    }
    if (!['efectivo', 'ajuste_credito', 'sin_reembolso'].includes(metodo_reembolso)) {
      return res.status(400).json({ error: 'Método de reembolso inválido' });
    }

    await conexion.query('BEGIN');

    const ticketResult = await conexion.query(
      'SELECT * FROM tickets WHERE id = $1 AND sucursal_id = $2 AND estado = $3',
      [ticket_id, req.usuario.sucursal_id, 'pagado']
    );
    if (ticketResult.rows.length === 0) {
      await conexion.query('ROLLBACK');
      return res.status(404).json({ error: 'Ticket no encontrado o no está pagado' });
    }
    const ticket = ticketResult.rows[0];

    if (metodo_reembolso === 'ajuste_credito' && ticket.metodo_pago !== 'credito') {
      await conexion.query('ROLLBACK');
      return res.status(400).json({ error: 'Solo se puede ajustar crédito si el ticket original fue Fiado' });
    }
    if (metodo_reembolso === 'efectivo' && !turno_id) {
      await conexion.query('ROLLBACK');
      return res.status(400).json({ error: 'Se necesita un turno de caja abierto para reembolsar en efectivo' });
    }

    let montoTotal = 0;
    const devolucionResult = await conexion.query(
      `INSERT INTO devoluciones (ticket_id, turno_id, usuario_id, motivo, monto_total, metodo_reembolso)
       VALUES ($1, $2, $3, $4, 0, $5) RETURNING *`,
      [ticket_id, turno_id || null, req.usuario.id, motivo || null, metodo_reembolso]
    );
    const devolucion = devolucionResult.rows[0];

    for (const item of items) {
      const detalleResult = await conexion.query(
        'SELECT * FROM ticket_detalle WHERE id = $1 AND ticket_id = $2 FOR UPDATE',
        [item.ticket_detalle_id, ticket_id]
      );
      if (detalleResult.rows.length === 0) {
        await conexion.query('ROLLBACK');
        return res.status(404).json({ error: `Línea de ticket ${item.ticket_detalle_id} no encontrada` });
      }
      const detalle = detalleResult.rows[0];

      const yaDevuelto = parseFloat(detalle.cantidad_devuelta);
      const cantidadOriginal = parseFloat(detalle.cantidad);
      const cantidadDisponible = cantidadOriginal - yaDevuelto;
      const cantidadDevolver = parseFloat(item.cantidad_devuelta);

      if (cantidadDevolver <= 0 || cantidadDevolver > cantidadDisponible) {
        await conexion.query('ROLLBACK');
        return res.status(400).json({ error: `Cantidad inválida para "${detalle.nombre_producto}" (disponible para devolver: ${cantidadDisponible})` });
      }

      const montoDevuelto = cantidadDevolver * parseFloat(detalle.precio_unitario);
      montoTotal += montoDevuelto;

      await conexion.query(
        `INSERT INTO devolucion_detalle (devolucion_id, ticket_detalle_id, cantidad_devuelta, monto_devuelto, regresa_inventario)
         VALUES ($1, $2, $3, $4, $5)`,
        [devolucion.id, detalle.id, cantidadDevolver, montoDevuelto, item.regresa_inventario !== false]
      );

      await conexion.query(
        'UPDATE ticket_detalle SET cantidad_devuelta = cantidad_devuelta + $1 WHERE id = $2',
        [cantidadDevolver, detalle.id]
      );

      // Si el producto regresa físicamente al inventario (no está dañado/caducado)
      if (item.regresa_inventario !== false && detalle.tipo === 'producto' && detalle.producto_id) {
        await conexion.query(
          'UPDATE inventario SET existencia_actual = existencia_actual + $1 WHERE producto_id = $2',
          [cantidadDevolver, detalle.producto_id]
        );
        await conexion.query(
          `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, referencia_id, usuario_id)
           VALUES ($1, 'devolucion_venta', $2, $3, $4, $5)`,
          [detalle.producto_id, cantidadDevolver, motivo || 'Devolución de venta', devolucion.id, req.usuario.id]
        );
      }
    }

    await conexion.query('UPDATE devoluciones SET monto_total = $1 WHERE id = $2', [montoTotal, devolucion.id]);

    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id,
      accion: 'procesar_devolucion',
      modulo: 'devoluciones',
      referencia_id: devolucion.id,
      valor_nuevo: { ticket_folio: ticket.folio, monto_total: montoTotal, metodo_reembolso, motivo }
    });

    // Aplicar el reembolso según el método
    if (metodo_reembolso === 'efectivo') {
      await conexion.query(
        `INSERT INTO movimientos_caja (turno_id, usuario_id, tipo, monto, concepto)
         VALUES ($1, $2, 'egreso', $3, $4)`,
        [turno_id, req.usuario.id, montoTotal, `Devolución ticket ${ticket.folio}`]
      );
    } else if (metodo_reembolso === 'ajuste_credito') {
      await conexion.query('UPDATE clientes SET saldo_actual = saldo_actual - $1 WHERE id = $2', [montoTotal, ticket.cliente_id]);
    }

    await conexion.query('COMMIT');
    res.json({ ...devolucion, monto_total: montoTotal });
  } catch (err) {
    await conexion.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la devolución' });
  } finally {
    conexion.release();
  }
});

module.exports = router;
