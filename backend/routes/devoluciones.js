const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requierePermiso, requiereSucursalId } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');
const { validarTurno } = require('../utils/seguridadCaja');
const { r2 } = require('../utils/importeExacto');

// Toda ruta de este archivo ya filtra por sucursal — se resuelve una sola
// vez aquí (req.sucursalId) en vez de repetirlo en cada endpoint.
router.use(verificarToken, requiereSucursalId);

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
      [req.sucursalId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el historial de devoluciones' });
  }
});

// Registrar una devolución.
// Se reembolsa lo que el cliente PAGÓ de verdad, no el precio de lista: a cada renglón se le
// quita su propio descuento y la parte proporcional del descuento general del ticket. Y entre
// todas las devoluciones de un ticket nunca se regresa más de lo que se cobró.
router.post('/', verificarToken, requierePermiso('VENTAS_DEVOLVER'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    const { ticket_id, items, metodo_reembolso, motivo, turno_id } = req.body;
    // items: [{ ticket_detalle_id, cantidad_devuelta, regresa_inventario }]

    if (!ticket_id || !Array.isArray(items) || items.length === 0 || !metodo_reembolso) {
      return res.status(400).json({ error: 'Ticket, items y método de reembolso son requeridos' });
    }
    if (!['efectivo', 'ajuste_credito', 'sin_reembolso'].includes(metodo_reembolso)) {
      return res.status(400).json({ error: 'Método de reembolso inválido' });
    }

    await conexion.query('BEGIN');

    // FOR UPDATE: si llegan dos devoluciones del mismo ticket al mismo tiempo, la segunda
    // espera y ya ve lo que devolvió la primera (así no se reembolsa dos veces).
    const ticketResult = await conexion.query(
      'SELECT * FROM tickets WHERE id = $1 AND sucursal_id = $2 AND estado = $3 FOR UPDATE',
      [ticket_id, req.sucursalId, 'pagado']
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
    // Una venta a crédito (fiado) no se pagó con dinero: no se le puede regresar efectivo, solo bajar su deuda.
    if (ticket.metodo_pago === 'credito' && metodo_reembolso === 'efectivo') {
      await conexion.query('ROLLBACK');
      return res.status(400).json({ error: 'Esta venta fue a crédito: la devolución se descuenta de la cuenta del cliente, no en efectivo' });
    }

    // El turno (si se manda) debe estar abierto, ser de esta sucursal y del propio cajero
    // (dueño/gerente pueden usar cualquiera). Reembolsar en efectivo SIEMPRE necesita uno.
    const turno = await validarTurno(conexion, {
      turnoId: turno_id, sucursalId: req.sucursalId, usuario: req.usuario,
      obligatorio: metodo_reembolso === 'efectivo'
    });
    const turnoId = turno ? turno.id : null;

    // Lo que se cobró del ticket y lo que ya se devolvió antes.
    const sumas = await conexion.query(
      'SELECT COALESCE(SUM(subtotal - descuento_monto), 0) AS neto_renglones FROM ticket_detalle WHERE ticket_id = $1',
      [ticket.id]
    );
    const netoRenglones = parseFloat(sumas.rows[0].neto_renglones);
    const descuentoTicket = Math.max(parseFloat(ticket.descuento_monto || 0), 0);
    const pagado = Math.max(r2(netoRenglones - descuentoTicket), 0);
    // Qué parte de cada peso se quedó con el descuento general del ticket (0 = sin descuento).
    const factorDescuento = netoRenglones > 0 ? Math.min(descuentoTicket / netoRenglones, 1) : 0;
    const previas = await conexion.query(
      'SELECT COALESCE(SUM(monto_total), 0) AS total FROM devoluciones WHERE ticket_id = $1',
      [ticket.id]
    );
    const disponible = Math.max(r2(pagado - parseFloat(previas.rows[0].total)), 0);

    let montoTotal = 0;
    const devolucionResult = await conexion.query(
      `INSERT INTO devoluciones (ticket_id, turno_id, usuario_id, motivo, monto_total, metodo_reembolso)
       VALUES ($1, $2, $3, $4, 0, $5) RETURNING *`,
      [ticket.id, turnoId, req.usuario.id, motivo || null, metodo_reembolso]
    );
    const devolucion = devolucionResult.rows[0];

    for (const item of items) {
      const detalleResult = await conexion.query(
        'SELECT * FROM ticket_detalle WHERE id = $1 AND ticket_id = $2 FOR UPDATE',
        [item.ticket_detalle_id, ticket.id]
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

      if (!Number.isFinite(cantidadDevolver) || cantidadDevolver <= 0 || cantidadDevolver > cantidadDisponible + 0.0005) {
        await conexion.query('ROLLBACK');
        return res.status(400).json({ error: `Cantidad inválida para "${detalle.nombre_producto}" (disponible para devolver: ${cantidadDisponible})` });
      }

      // Lo que se pagó por este renglón (su subtotal menos su descuento; también sirve para
      // lo vendido POR IMPORTE, porque el subtotal es el importe exacto), repartido por
      // cantidad, y menos la parte que le toca del descuento general del ticket.
      const netoRenglon = Math.max(parseFloat(detalle.subtotal) - parseFloat(detalle.descuento_monto || 0), 0);
      const montoDevuelto = cantidadOriginal > 0
        ? r2(cantidadDevolver * (netoRenglon / cantidadOriginal) * (1 - factorDescuento))
        : 0;
      montoTotal = r2(montoTotal + montoDevuelto);

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

    // Tope: nunca se regresa más de lo que se cobró (menos lo ya devuelto antes).
    if (montoTotal > disponible) montoTotal = disponible;

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
        [turnoId, req.usuario.id, montoTotal, `Devolución ticket ${ticket.folio}`]
      );
    } else if (metodo_reembolso === 'ajuste_credito') {
      await conexion.query('UPDATE clientes SET saldo_actual = saldo_actual - $1 WHERE id = $2', [montoTotal, ticket.cliente_id]);
    }

    await conexion.query('COMMIT');
    res.json({ ...devolucion, monto_total: montoTotal });
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.error });
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la devolución' });
  } finally {
    conexion.release();
  }
});

module.exports = router;
