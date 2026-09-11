const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken } = require('../middleware/auth');

router.get('/resumen', verificarToken, async (req, res) => {
  try {
    const sucursalId = req.usuario.sucursal_id;
    const ahora = new Date();
    const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
    const finHoy = new Date(inicioHoy.getTime() + 24 * 60 * 60 * 1000);

    // Ventas de hoy + utilidad estimada
    const ventasHoy = await pool.query(
      `SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS num_tickets
       FROM tickets WHERE estado = 'pagado' AND sucursal_id = $1 AND fecha_pago BETWEEN $2 AND $3`,
      [sucursalId, inicioHoy, finHoy]
    );

    const gananciaHoy = await pool.query(
      `WITH costos_promedio AS (
         SELECT producto_id, AVG(costo_unitario) AS costo_promedio FROM compra_detalle GROUP BY producto_id
       )
       SELECT
         COALESCE(SUM(td.subtotal),0) AS ventas_productos,
         COALESCE(SUM(td.cantidad * cp.costo_promedio),0) AS costo_estimado
       FROM ticket_detalle td
       JOIN tickets t ON td.ticket_id = t.id
       LEFT JOIN costos_promedio cp ON td.producto_id = cp.producto_id
       WHERE t.estado = 'pagado' AND t.sucursal_id = $1 AND t.fecha_pago BETWEEN $2 AND $3 AND td.tipo = 'producto'`,
      [sucursalId, inicioHoy, finHoy]
    );

    // Ventas por hora de hoy (para la barra visual)
    const ventasPorHora = await pool.query(
      `SELECT EXTRACT(HOUR FROM fecha_pago) AS hora, COALESCE(SUM(total),0) AS total
       FROM tickets WHERE estado = 'pagado' AND sucursal_id = $1 AND fecha_pago BETWEEN $2 AND $3
       GROUP BY hora ORDER BY hora`,
      [sucursalId, inicioHoy, finHoy]
    );

    // Fiado total pendiente
    const fiadoTotal = await pool.query(
      `SELECT COALESCE(SUM(saldo_actual),0) AS total FROM clientes WHERE sucursal_id = $1 AND activo = true`,
      [sucursalId]
    );

    // Stock bajo y agotados
    const stockBajo = await pool.query(
      `SELECT p.nombre, i.existencia_actual, i.stock_minimo
       FROM inventario i JOIN productos p ON i.producto_id = p.id
       WHERE p.sucursal_id = $1 AND p.activo = true AND i.existencia_actual <= i.stock_minimo AND i.existencia_actual > 0
       ORDER BY i.existencia_actual ASC LIMIT 10`,
      [sucursalId]
    );
    const agotados = await pool.query(
      `SELECT p.nombre, i.existencia_actual
       FROM inventario i JOIN productos p ON i.producto_id = p.id
       WHERE p.sucursal_id = $1 AND p.activo = true AND i.existencia_actual <= 0
       ORDER BY p.nombre ASC LIMIT 10`,
      [sucursalId]
    );

    // Créditos cercanos al límite (90% o más de su límite usado)
    const creditosCercaLimite = await pool.query(
      `SELECT nombre, saldo_actual, limite_credito
       FROM clientes
       WHERE sucursal_id = $1 AND activo = true AND limite_credito > 0 AND saldo_actual >= (limite_credito * 0.9)
       ORDER BY (saldo_actual / NULLIF(limite_credito,0)) DESC LIMIT 10`,
      [sucursalId]
    );

    // Actividad reciente combinada: ventas, compras, abonos, ajustes de inventario
    const actividadReciente = await pool.query(
      `(
        SELECT 'venta' AS tipo, folio AS referencia, total AS monto, fecha_pago AS fecha
        FROM tickets WHERE estado = 'pagado' AND sucursal_id = $1
        ORDER BY fecha_pago DESC LIMIT 8
      )
      UNION ALL
      (
        SELECT 'compra' AS tipo, pr.nombre AS referencia, c.total AS monto, c.fecha
        FROM compras c JOIN proveedores pr ON c.proveedor_id = pr.id
        WHERE c.sucursal_id = $1
        ORDER BY c.fecha DESC LIMIT 5
      )
      UNION ALL
      (
        SELECT 'abono' AS tipo, cl.nombre AS referencia, ca.monto, ca.fecha
        FROM creditos_abono ca JOIN clientes cl ON ca.cliente_id = cl.id
        WHERE cl.sucursal_id = $1
        ORDER BY ca.fecha DESC LIMIT 5
      )
      UNION ALL
      (
        SELECT mi.tipo AS tipo, p.nombre AS referencia, mi.cantidad AS monto, mi.fecha
        FROM movimientos_inventario mi JOIN productos p ON mi.producto_id = p.id
        WHERE p.sucursal_id = $1 AND mi.tipo IN ('merma','ajuste_manual')
        ORDER BY mi.fecha DESC LIMIT 5
      )
      ORDER BY fecha DESC LIMIT 15`,
      [sucursalId]
    );

    const ventasProductos = parseFloat(gananciaHoy.rows[0].ventas_productos);
    const costoEstimado = parseFloat(gananciaHoy.rows[0].costo_estimado);

    res.json({
      ventas_hoy: ventasHoy.rows[0],
      utilidad_hoy: {
        ventas_productos: ventasProductos,
        costo_estimado: costoEstimado,
        ganancia: ventasProductos - costoEstimado
      },
      ventas_por_hora: ventasPorHora.rows,
      fiado_total: parseFloat(fiadoTotal.rows[0].total),
      stock_bajo: stockBajo.rows,
      agotados: agotados.rows,
      creditos_cerca_limite: creditosCercaLimite.rows,
      actividad_reciente: actividadReciente.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar el resumen del dashboard' });
  }
});

module.exports = router;
