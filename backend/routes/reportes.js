const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requierePermiso, requiereSucursalId } = require('../middleware/auth');

// Toda ruta de este archivo ya filtra por sucursal — se resuelve una sola
// vez aquí (req.sucursalId) en vez de repetirlo en cada endpoint.
router.use(verificarToken, requiereSucursalId);

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
    const sucursalId = req.sucursalId;

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
      `SELECT td.nombre_producto, COALESCE(SUM(td.cantidad),0) AS cantidad_total, COALESCE(SUM(td.subtotal),0) AS monto_total,
              MAX(td.tipo) AS tipo, MAX(p.tipo_venta) AS tipo_venta
       FROM ticket_detalle td
       JOIN tickets t ON td.ticket_id = t.id
       LEFT JOIN productos p ON p.id = td.producto_id
       WHERE t.estado = 'pagado' AND t.sucursal_id = $1 AND t.fecha_pago BETWEEN $2 AND $3
       GROUP BY td.nombre_producto
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

// Celda segura para CSV: si empieza con = + - @ (o tabulador/retorno), Excel la tomaría como
// fórmula; se le pone un apóstrofo adelante para que se vea como texto. Si trae comas, comillas
// o saltos de línea, va entre comillas.
function celdaCsv(valor) {
  let t = valor === null || valor === undefined ? '' : String(valor);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  if (/[",\r\n]/.test(t)) t = '"' + t.replace(/"/g, '""') + '"';
  return t;
}

// Exportar el listado de ventas del rango a CSV (abre directo en Excel/Sheets)
router.get('/ventas/exportar-csv', verificarToken, requierePermiso('REPORTES_VER'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req.query);
    const sucursalId = req.sucursalId;

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
      [r.folio, new Date(r.fecha_pago).toISOString(), r.metodo_pago, r.total, r.descuento_monto || 0, r.cajero || ''].map(celdaCsv).join(',')
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
    const sucursalId = req.sucursalId;

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
    const sucursalId = req.sucursalId;

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

// ---------------------------------------------------------------------------
// Pérdidas: tickets cancelados, devoluciones y fichas (turnos) que se cancelaron
// sin atenderse. Sirve para ver cuánto dinero y cuántos clientes se pierden.
router.get('/perdidas', verificarToken, requierePermiso('REPORTES_VER'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req.query);
    const sucursalId = req.sucursalId;

    // Granularidad: por día hasta ~3 meses; por mes si el periodo es más largo.
    const dias = Math.max(1, Math.round((hasta - desde) / 86400000));
    const porMes = dias > 92;
    const fmt = porMes ? 'YYYY-MM' : 'YYYY-MM-DD';

    // Tickets cancelados (la fecha es la de la cancelación; si no hay bitácora, la de creación)
    const canc = await pool.query(
      `SELECT t.id, t.folio, t.total, u.nombre AS usuario,
              b.valor_nuevo->>'motivo' AS motivo,
              to_char(COALESCE(b.fecha, t.fecha_creacion), $4) AS clave,
              to_char(COALESCE(b.fecha, t.fecha_creacion), 'HH24')::int AS hora,
              to_char(COALESCE(b.fecha, t.fecha_creacion), 'YYYY-MM-DD HH24:MI') AS fecha
       FROM tickets t
       LEFT JOIN LATERAL (
         SELECT fecha, usuario_id, valor_nuevo FROM bitacora
         WHERE accion = 'cancelar_ticket' AND modulo = 'tickets' AND referencia_id = t.id
         ORDER BY fecha DESC LIMIT 1
       ) b ON true
       LEFT JOIN usuarios u ON u.id = b.usuario_id
       WHERE t.estado = 'cancelado' AND t.sucursal_id = $1
         AND COALESCE(b.fecha, t.fecha_creacion) >= $2 AND COALESCE(b.fecha, t.fecha_creacion) < $3
       ORDER BY COALESCE(b.fecha, t.fecha_creacion) DESC`,
      [sucursalId, desde, hasta, fmt]
    );

    const devo = await pool.query(
      `SELECT d.monto_total, d.motivo, u.nombre AS usuario, t.folio,
              to_char(d.fecha, $4) AS clave
       FROM devoluciones d
       JOIN tickets t ON t.id = d.ticket_id
       LEFT JOIN usuarios u ON u.id = d.usuario_id
       WHERE t.sucursal_id = $1 AND d.fecha >= $2 AND d.fecha < $3`,
      [sucursalId, desde, hasta, fmt]
    );

    const fichas = await pool.query(
      `SELECT to_char(fecha_creacion, $4) AS clave,
              COUNT(*) FILTER (WHERE estado = 'cancelado')::int AS n,
              COUNT(*) FILTER (WHERE estado IN ('atendido','llamado'))::int AS atendidas
       FROM fichas
       WHERE sucursal_id = $1 AND estado IN ('cancelado','atendido','llamado') AND fecha_creacion >= $2 AND fecha_creacion < $3
       GROUP BY 1`,
      [sucursalId, desde, hasta, fmt]
    );

    const ventasSerie = await pool.query(
      `SELECT to_char(fecha_pago, $4) AS clave, COALESCE(SUM(total),0) AS monto, COUNT(*)::int AS n
       FROM tickets
       WHERE estado = 'pagado' AND sucursal_id = $1 AND fecha_pago >= $2 AND fecha_pago < $3
       GROUP BY 1`,
      [sucursalId, desde, hasta, fmt]
    );

    const vendido = await pool.query(
      `SELECT COALESCE(SUM(total),0) AS total FROM tickets
       WHERE estado = 'pagado' AND sucursal_id = $1 AND fecha_pago >= $2 AND fecha_pago < $3`,
      [sucursalId, desde, hasta]
    );

    const topProd = canc.rows.length ? await pool.query(
      `SELECT nombre_producto, COALESCE(SUM(cantidad),0) AS cantidad, COALESCE(SUM(subtotal),0) AS monto
       FROM ticket_detalle WHERE ticket_id = ANY($1::int[])
       GROUP BY nombre_producto ORDER BY monto DESC LIMIT 10`,
      [canc.rows.map(r => r.id)]
    ) : { rows: [] };

    // Serie con todos los periodos (los vacíos en cero)
    const serie = [];
    const mapa = {};
    const ini = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth(), porMes ? 1 : desde.getUTCDate()));
    for (let d = new Date(ini); d < hasta && serie.length < 400; porMes ? d.setUTCMonth(d.getUTCMonth() + 1) : d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString();
      const clave = porMes ? iso.slice(0, 7) : iso.slice(0, 10);
      const fila = { clave, cancelaciones: 0, monto_cancelado: 0, devoluciones: 0, monto_devuelto: 0, fichas: 0, fichas_atendidas: 0, ventas: 0, tickets_pagados: 0 };
      serie.push(fila); mapa[clave] = fila;
    }
    const buscar = (clave) => mapa[clave] || (serie.length < 400 ? (mapa[clave] = serie[serie.push({ clave, cancelaciones: 0, monto_cancelado: 0, devoluciones: 0, monto_devuelto: 0, fichas: 0, fichas_atendidas: 0, ventas: 0, tickets_pagados: 0 }) - 1]) : null);

    let montoCanc = 0, montoDevo = 0, totalFichas = 0;
    const porUsuario = {}, motivos = {};
    const sumaMotivo = (motivo, monto, tipo) => {
      const k = (motivo || 'Sin motivo').trim() || 'Sin motivo';
      const m = motivos[k] || (motivos[k] = { motivo: k, cancelaciones: 0, devoluciones: 0, monto: 0 });
      m[tipo]++; m.monto += monto;
    };
    const sumaUsuario = (nombre, monto, tipo) => {
      const k = nombre || 'Sin registro';
      const u = porUsuario[k] || (porUsuario[k] = { usuario: k, cancelaciones: 0, devoluciones: 0, monto: 0 });
      u[tipo]++; u.monto += monto;
    };
    for (const r of canc.rows) {
      const m = parseFloat(r.total); montoCanc += m;
      const f = buscar(r.clave); if (f) { f.cancelaciones++; f.monto_cancelado += m; }
      sumaMotivo(r.motivo, m, 'cancelaciones'); sumaUsuario(r.usuario, m, 'cancelaciones');
    }
    for (const r of devo.rows) {
      const m = parseFloat(r.monto_total); montoDevo += m;
      const f = buscar(r.clave); if (f) { f.devoluciones++; f.monto_devuelto += m; }
      sumaMotivo(r.motivo, m, 'devoluciones'); sumaUsuario(r.usuario, m, 'devoluciones');
    }
    for (const r of fichas.rows) { totalFichas += r.n; const f = buscar(r.clave); if (f) { f.fichas += r.n; f.fichas_atendidas += r.atendidas; } }
    for (const r of ventasSerie.rows) { const f = buscar(r.clave); if (f) { f.ventas += parseFloat(r.monto); f.tickets_pagados += r.n; } }
    const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, cancelaciones: 0, monto: 0 }));
    for (const r of canc.rows) { porHora[r.hora].cancelaciones++; porHora[r.hora].monto += parseFloat(r.total); }
    serie.sort((a, b) => a.clave.localeCompare(b.clave));

    const totalVendido = parseFloat(vendido.rows[0].total);
    const totalPerdido = montoCanc + montoDevo;
    res.json({
      granularidad: porMes ? 'mes' : 'dia',
      resumen: {
        cancelaciones: canc.rows.length, monto_cancelado: montoCanc,
        devoluciones: devo.rows.length, monto_devuelto: montoDevo,
        fichas_canceladas: totalFichas,
        total_perdido: totalPerdido, total_vendido: totalVendido,
        porcentaje_sobre_ventas: (totalVendido + totalPerdido) > 0 ? (totalPerdido / (totalVendido + totalPerdido)) * 100 : 0
      },
      serie,
      por_hora: porHora,
      por_usuario: Object.values(porUsuario).sort((a, b) => b.monto - a.monto).slice(0, 10),
      motivos: Object.values(motivos).sort((a, b) => b.monto - a.monto).slice(0, 10),
      top_productos: topProd.rows,
      ultimas_cancelaciones: canc.rows.slice(0, 15).map(r => ({ folio: r.folio, fecha: r.fecha, total: parseFloat(r.total), usuario: r.usuario, motivo: r.motivo }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar el reporte de pérdidas' });
  }
});

module.exports = router;
module.exports._celdaCsv = celdaCsv; // para las pruebas
