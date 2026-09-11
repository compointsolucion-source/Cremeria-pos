const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken } = require('../middleware/auth');

// Resuelve el rango de fechas: si no se especifica, usa "hoy" completo.
function resolverRango(query) {
  const ahora = new Date();
  const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const finHoy = new Date(inicioHoy.getTime() + 24 * 60 * 60 * 1000);

  const desde = query.desde ? new Date(query.desde) : inicioHoy;
  const hasta = query.hasta ? new Date(query.hasta) : finHoy;
  return { desde, hasta };
}

router.get('/ventas', verificarToken, async (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req.query);
    const sucursalId = req.usuario.sucursal_id;

    // Resumen por método de pago
    const porMetodo = await pool.query(
      `SELECT metodo_pago, COALESCE(SUM(total),0) AS total, COUNT(*) AS num_tickets
       FROM tickets
       WHERE estado = 'pagado' AND sucursal_id = $1 AND fecha_pago BETWEEN $2 AND $3
       GROUP BY metodo_pago`,
      [sucursalId, desde, hasta]
    );

    // Total general
    const totalGeneral = await pool.query(
      `SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS num_tickets
       FROM tickets
       WHERE estado = 'pagado' AND sucursal_id = $1 AND fecha_pago BETWEEN $2 AND $3`,
      [sucursalId, desde, hasta]
    );

    // Ventas por categoría/departamento
    const porCategoria = await pool.query(
      `SELECT COALESCE(c.nombre, 'Sin categoría') AS categoria, COALESCE(SUM(td.subtotal),0) AS total
       FROM ticket_detalle td
       JOIN tickets t ON td.ticket_id = t.id
       LEFT JOIN productos p ON td.producto_id = p.id
       LEFT JOIN categorias c ON p.categoria_id = c.id
       WHERE t.estado = 'pagado' AND t.sucursal_id = $1 AND t.fecha_pago BETWEEN $2 AND $3
       GROUP BY c.nombre
       ORDER BY total DESC`,
      [sucursalId, desde, hasta]
    );

    // Productos más vendidos (por monto)
    const topProductos = await pool.query(
      `SELECT nombre_producto, COALESCE(SUM(cantidad),0) AS cantidad_total, COALESCE(SUM(subtotal),0) AS monto_total
       FROM ticket_detalle td
       JOIN tickets t ON td.ticket_id = t.id
       WHERE t.estado = 'pagado' AND t.sucursal_id = $1 AND t.fecha_pago BETWEEN $2 AND $3
       GROUP BY nombre_producto
       ORDER BY monto_total DESC
       LIMIT 10`,
      [sucursalId, desde, hasta]
    );

    // Ganancia estimada: ventas de productos (no kits) menos costo promedio de compra.
    // Aproximación, no costeo FIFO exacto — mismo criterio ya usado en Chatarra POS.
    const ganancia = await pool.query(
      `WITH costos_promedio AS (
         SELECT producto_id, AVG(costo_unitario) AS costo_promedio
         FROM compra_detalle
         GROUP BY producto_id
       )
       SELECT
         COALESCE(SUM(td.subtotal),0) AS ventas_productos,
         COALESCE(SUM(td.cantidad * cp.costo_promedio),0) AS costo_estimado
       FROM ticket_detalle td
       JOIN tickets t ON td.ticket_id = t.id
       LEFT JOIN costos_promedio cp ON td.producto_id = cp.producto_id
       WHERE t.estado = 'pagado' AND t.sucursal_id = $1 AND t.fecha_pago BETWEEN $2 AND $3 AND td.tipo = 'producto'`,
      [sucursalId, desde, hasta]
    );

    // Ventas por empleado (cajero que cobró)
    const porEmpleado = await pool.query(
      `SELECT u.nombre AS empleado, COALESCE(SUM(t.total),0) AS total, COUNT(*) AS num_tickets
       FROM tickets t
       JOIN usuarios u ON t.cajero_usuario_id = u.id
       WHERE t.estado = 'pagado' AND t.sucursal_id = $1 AND t.fecha_pago BETWEEN $2 AND $3
       GROUP BY u.nombre
       ORDER BY total DESC`,
      [sucursalId, desde, hasta]
    );

    const ventasProductos = parseFloat(ganancia.rows[0].ventas_productos);
    const costoEstimado = parseFloat(ganancia.rows[0].costo_estimado);

    res.json({
      rango: { desde, hasta },
      total_general: totalGeneral.rows[0],
      por_metodo_pago: porMetodo.rows,
      por_categoria: porCategoria.rows,
      por_empleado: porEmpleado.rows,
      top_productos: topProductos.rows,
      ganancia_estimada: {
        ventas_productos: ventasProductos,
        costo_estimado: costoEstimado,
        ganancia: ventasProductos - costoEstimado,
        nota: 'Aproximación con costo promedio de compras; no incluye componentes de Kits.'
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar el reporte' });
  }
});

// Exportar el listado de ventas del rango a CSV (abre directo en Excel/Sheets)
router.get('/ventas/exportar-csv', verificarToken, async (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req.query);
    const sucursalId = req.usuario.sucursal_id;

    const result = await pool.query(
      `SELECT t.folio, t.fecha_pago, t.metodo_pago, t.total, t.descuento_monto, u.nombre AS cajero
       FROM tickets t
       LEFT JOIN usuarios u ON t.cajero_usuario_id = u.id
       WHERE t.estado = 'pagado' AND t.sucursal_id = $1 AND t.fecha_pago BETWEEN $2 AND $3
       ORDER BY t.fecha_pago ASC`,
      [sucursalId, desde, hasta]
    );

    const encabezado = 'Folio,Fecha,Metodo de Pago,Total,Descuento,Cajero\n';
    const filas = result.rows.map(r =>
      `${r.folio},${new Date(r.fecha_pago).toISOString()},${r.metodo_pago},${r.total},${r.descuento_monto || 0},${r.cajero || ''}`
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="ventas-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(encabezado + filas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al exportar el CSV' });
  }
});

module.exports = router;
