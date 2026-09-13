const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol, requierePermiso, tienePermiso } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Inventario valorizado: costo total, valor potencial de venta, margen potencial.
// El "costo" usa el promedio de costo_unitario de las compras registradas de
// cada producto — si un producto nunca se ha comprado (solo se dio de alta a
// mano), no hay costo real y se indica "Costo no disponible" en vez de inventarlo.
router.get('/valorizado', verificarToken, requierePermiso('INVENTARIO_VER'), async (req, res) => {
  try {
    const result = await pool.query(
      `WITH costos_promedio AS (
         SELECT producto_id, AVG(costo_unitario) AS costo_promedio
         FROM compra_detalle
         GROUP BY producto_id
       )
       SELECT
         p.id AS producto_id,
         p.nombre,
         p.tipo_venta,
         p.precio,
         COALESCE(i.existencia_actual, 0) AS existencia_actual,
         cp.costo_promedio,
         CASE WHEN cp.costo_promedio IS NOT NULL THEN COALESCE(i.existencia_actual, 0) * cp.costo_promedio ELSE NULL END AS valor_costo,
         COALESCE(i.existencia_actual, 0) * p.precio AS valor_venta_potencial
       FROM productos p
       LEFT JOIN inventario i ON p.id = i.producto_id
       LEFT JOIN costos_promedio cp ON p.id = cp.producto_id
       WHERE p.sucursal_id = $1 AND p.activo = true
       ORDER BY p.nombre ASC`,
      [req.usuario.sucursal_id]
    );

    const totalCosto = result.rows.reduce((sum, r) => sum + (r.valor_costo ? parseFloat(r.valor_costo) : 0), 0);
    const totalVentaPotencial = result.rows.reduce((sum, r) => sum + parseFloat(r.valor_venta_potencial), 0);

    res.json({
      productos: result.rows,
      totales: {
        valor_costo: totalCosto,
        valor_venta_potencial: totalVentaPotencial,
        margen_potencial: totalVentaPotencial - totalCosto
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al calcular el inventario valorizado' });
  }
});

// Listado de existencias con datos del producto
router.get('/', verificarToken, requierePermiso('INVENTARIO_VER'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id AS producto_id, p.nombre, p.tipo_venta, p.imagen_url, p.codigo_barras,
              COALESCE(i.existencia_actual, 0) AS existencia_actual,
              COALESCE(i.stock_minimo, 0) AS stock_minimo
       FROM productos p
       LEFT JOIN inventario i ON p.id = i.producto_id
       WHERE p.sucursal_id = $1 AND p.activo = true
       ORDER BY p.nombre ASC`,
      [req.usuario.sucursal_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el inventario' });
  }
});

// Productos con stock bajo (para alertas en dashboard)
router.get('/alertas', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id AS producto_id, p.nombre, i.existencia_actual, i.stock_minimo
       FROM inventario i JOIN productos p ON i.producto_id = p.id
       WHERE p.sucursal_id = $1 AND i.existencia_actual <= i.stock_minimo AND p.activo = true`,
      [req.usuario.sucursal_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener alertas' });
  }
});

// Configurar el stock mínimo de un producto
router.put('/:producto_id/minimo', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    const { stock_minimo, stock_maximo } = req.body;
    await pool.query(
      `INSERT INTO inventario (producto_id, stock_minimo, stock_maximo) VALUES ($1, $2, $3)
       ON CONFLICT (producto_id) DO UPDATE SET
         stock_minimo = COALESCE($2, inventario.stock_minimo),
         stock_maximo = COALESCE($3, inventario.stock_maximo)`,
      [req.params.producto_id, stock_minimo, stock_maximo !== undefined ? stock_maximo : null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al configurar el stock mínimo' });
  }
});

// Registrar una merma o ajuste manual
router.post('/ajuste', verificarToken, async (req, res) => {
  const conexion = await pool.connect();
  try {
    const { producto_id, cantidad, tipo, motivo, precio_costo, precio, precio_mayoreo } = req.body;
    // tipo: 'entrada_manual' (SUMA — encontraste más de lo que decía el sistema,
    //        o recibiste mercancía sin pasar por Compras),
    //       'merma' (SIEMPRE RESTA — caducidad/desperdicio),
    //       'ajuste_manual' (SIEMPRE RESTA — conteo físico que dio menos de lo esperado)
    if (!producto_id || !cantidad || cantidad <= 0) {
      return res.status(400).json({ error: 'Producto y cantidad son requeridos' });
    }
    if (!['merma', 'ajuste_manual', 'entrada_manual'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de ajuste inválido' });
    }

    const permisoRequerido = tipo === 'merma' ? 'INVENTARIO_MERMA' : 'INVENTARIO_AJUSTAR';
    if (!tienePermiso(req.usuario, permisoRequerido)) {
      return res.status(403).json({ error: `No tienes el permiso "${permisoRequerido}" para esta acción. Pide a tu gerente que te lo asigne en Equipo.` });
    }

    const cantidadConSigno = tipo === 'entrada_manual' ? cantidad : -cantidad;

    await conexion.query('BEGIN');

    await conexion.query(
      `INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, 0) ON CONFLICT (producto_id) DO NOTHING`,
      [producto_id]
    );
    await conexion.query(
      'UPDATE inventario SET existencia_actual = existencia_actual + $1 WHERE producto_id = $2',
      [cantidadConSigno, producto_id]
    );
    await conexion.query(
      `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, usuario_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [producto_id, tipo, cantidadConSigno, motivo || null, req.usuario.id]
    );

    // Si se recibió mercancía con costo/precio nuevo, actualizar el producto
    // de una vez (solo tiene sentido en entrada manual, no al restar por merma).
    if (tipo === 'entrada_manual' && (precio_costo || precio || precio_mayoreo)) {
      await conexion.query(
        `UPDATE productos SET
          precio_costo = COALESCE($1, precio_costo),
          precio = COALESCE($2, precio),
          precio_mayoreo = COALESCE($3, precio_mayoreo)
         WHERE id = $4`,
        [precio_costo || null, precio || null, precio_mayoreo || null, producto_id]
      );
    }

    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id,
      accion: tipo === 'merma' ? 'registrar_merma' : (tipo === 'entrada_manual' ? 'entrada_manual_inventario' : 'ajustar_inventario'),
      modulo: 'inventario',
      referencia_id: producto_id,
      valor_nuevo: { cantidad, motivo, precio_costo, precio, precio_mayoreo }
    });

    await conexion.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await conexion.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el ajuste' });
  } finally {
    conexion.release();
  }
});

// Historial de movimientos de un producto
router.get('/:producto_id/movimientos', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, u.nombre AS usuario_nombre FROM movimientos_inventario m
       JOIN usuarios u ON m.usuario_id = u.id
       WHERE m.producto_id = $1 ORDER BY m.fecha DESC LIMIT 50`,
      [req.params.producto_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener movimientos' });
  }
});

module.exports = router;
