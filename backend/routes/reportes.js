const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requierePermiso } = require('../middleware/auth');

// Resuelve el rango de fechas: si no se especifica, usa "hoy" completo.
function resolverRango(query) {
  const ahora = new Date();
  const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const finHoy = new Date(inicioHoy.getTime() + 24 * 60 * 60 * 1000);

  const desde = query.desde ? new Date(query.desde) : inicioHoy;
  const hasta = query.hasta ? new Date(query.hasta) : finHoy;
  return { desde, hasta };
}

router.get('/ventas', verificarToken, requierePermiso('REPORTES_VER'), async (req, res) => {
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
router.get('/ventas/exportar-csv', verificarToken, requierePermiso('REPORTES_VER'), async (req, res) => {
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

// Reporte de Compras: gasto por proveedor y evolución de costo por producto
router.get('/compras', verificarToken, requierePermiso('REPORTES_VER'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req.query);
    const sucursalId = req.usuario.sucursal_id;

    const porProveedor = await pool.query(
      `SELECT pr.nombre AS proveedor, COALESCE(SUM(c.total),0) AS total, COUNT(*) AS num_compras
       FROM compras c JOIN proveedores pr ON c.proveedor_id = pr.id
       WHERE c.sucursal_id = $1 AND c.fecha BETWEEN $2 AND $3
       GROUP BY pr.nombre ORDER BY total DESC`,
      [sucursalId, desde, hasta]
    );

    const totalGeneral = await pool.query(
      `SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS num_compras FROM compras WHERE sucursal_id = $1 AND fecha BETWEEN $2 AND $3`,
      [sucursalId, desde, hasta]
    );

    // Evolución de costo: para cada producto comprado en el rango, precio más antiguo vs. más reciente
    const evolucionCosto = await pool.query(
      `SELECT p.nombre,
              (ARRAY_AGG(cd.costo_unitario ORDER BY c.fecha ASC))[1] AS costo_inicial,
              (ARRAY_AGG(cd.costo_unitario ORDER BY c.fecha DESC))[1] AS costo_reciente
       FROM compra_detalle cd
       JOIN compras c ON cd.compra_id = c.id
       JOIN productos p ON cd.producto_id = p.id
       WHERE c.sucursal_id = $1 AND c.fecha BETWEEN $2 AND $3
       GROUP BY p.nombre
       HAVING COUNT(*) > 1
       ORDER BY p.nombre ASC`,
      [sucursalId, desde, hasta]
    );

    res.json({ total_general: totalGeneral.rows[0], por_proveedor: porProveedor.rows, evolucion_costo: evolucionCosto.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar el reporte de compras' });
  }
});

// Reporte de Clientes: deuda activa, abonos del rango, clientes más frecuentes
router.get('/clientes', verificarToken, requierePermiso('REPORTES_VER'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req.query);
    const sucursalId = req.usuario.sucursal_id;

    const deudaActiva = await pool.query(
      `SELECT COALESCE(SUM(saldo_actual),0) AS total FROM clientes WHERE sucursal_id = $1 AND activo = true`,
      [sucursalId]
    );

    const mayorDeuda = await pool.query(
      `SELECT nombre, saldo_actual, limite_credito FROM clientes
       WHERE sucursal_id = $1 AND activo = true AND saldo_actual > 0
       ORDER BY saldo_actual DESC LIMIT 10`,
      [sucursalId]
    );

    const abonosRango = await pool.query(
      `SELECT COALESCE(SUM(ca.monto),0) AS total, COUNT(*) AS num_abonos
       FROM creditos_abono ca JOIN clientes cl ON ca.cliente_id = cl.id
       WHERE cl.sucursal_id = $1 AND ca.fecha BETWEEN $2 AND $3`,
      [sucursalId, desde, hasta]
    );

    const masFrecuentes = await pool.query(
      `SELECT cl.nombre, COUNT(*) AS num_tickets, COALESCE(SUM(t.total),0) AS total_comprado
       FROM tickets t JOIN clientes cl ON t.cliente_id = cl.id
       WHERE t.estado = 'pagado' AND t.sucursal_id = $1 AND t.fecha_pago BETWEEN $2 AND $3
       GROUP BY cl.nombre ORDER BY num_tickets DESC LIMIT 10`,
      [sucursalId, desde, hasta]
    );

    res.json({
      deuda_activa_total: parseFloat(deudaActiva.rows[0].total),
      mayor_deuda: mayorDeuda.rows,
      abonos_rango: abonosRango.rows[0],
      mas_frecuentes: masFrecuentes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar el reporte de clientes' });
  }
});

module.exports = router;
