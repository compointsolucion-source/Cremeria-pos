const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Listado de existencias con datos del producto
router.get('/', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id AS producto_id, p.nombre, p.tipo_venta, p.imagen_url,
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
    const { stock_minimo } = req.body;
    await pool.query(
      `INSERT INTO inventario (producto_id, stock_minimo) VALUES ($1, $2)
       ON CONFLICT (producto_id) DO UPDATE SET stock_minimo = $2`,
      [req.params.producto_id, stock_minimo]
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
    const { producto_id, cantidad, tipo, motivo } = req.body; // tipo: 'merma' o 'ajuste_manual'; cantidad siempre positiva, se resta
    if (!producto_id || !cantidad || cantidad <= 0) {
      return res.status(400).json({ error: 'Producto y cantidad son requeridos' });
    }
    if (!['merma', 'ajuste_manual'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de ajuste inválido' });
    }

    await conexion.query('BEGIN');

    await conexion.query(
      `INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, 0) ON CONFLICT (producto_id) DO NOTHING`,
      [producto_id]
    );
    await conexion.query(
      'UPDATE inventario SET existencia_actual = existencia_actual - $1 WHERE producto_id = $2',
      [cantidad, producto_id]
    );
    await conexion.query(
      `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, usuario_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [producto_id, tipo, -cantidad, motivo || null, req.usuario.id]
    );

    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id,
      accion: tipo === 'merma' ? 'registrar_merma' : 'ajustar_inventario',
      modulo: 'inventario',
      referencia_id: producto_id,
      valor_nuevo: { cantidad, motivo }
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
