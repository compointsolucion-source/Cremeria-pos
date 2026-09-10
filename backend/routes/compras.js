const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');

// Historial de compras
router.get('/', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, p.nombre AS proveedor_nombre FROM compras c
       JOIN proveedores p ON c.proveedor_id = p.id
       WHERE c.sucursal_id = $1 ORDER BY c.fecha DESC LIMIT 50`,
      [req.usuario.sucursal_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener compras' });
  }
});

// Registrar una compra: actualiza inventario y, si se indica, el precio de venta
router.post('/', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    const { proveedor_id, items } = req.body; // [{producto_id, cantidad, costo_unitario, precio_venta_nuevo}]
    if (!proveedor_id || !items || items.length === 0) {
      return res.status(400).json({ error: 'Proveedor y al menos un producto son requeridos' });
    }

    await conexion.query('BEGIN');

    const total = items.reduce((sum, it) => sum + (it.cantidad * it.costo_unitario), 0);

    const compraResult = await conexion.query(
      `INSERT INTO compras (sucursal_id, proveedor_id, usuario_id, total) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.usuario.sucursal_id, proveedor_id, req.usuario.id, total]
    );
    const compra = compraResult.rows[0];

    for (const item of items) {
      const subtotal = item.cantidad * item.costo_unitario;

      await conexion.query(
        `INSERT INTO compra_detalle (compra_id, producto_id, cantidad, costo_unitario, precio_venta_nuevo, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [compra.id, item.producto_id, item.cantidad, item.costo_unitario, item.precio_venta_nuevo || null, subtotal]
      );

      // Actualizar precio de venta si se especificó uno nuevo
      if (item.precio_venta_nuevo) {
        await conexion.query('UPDATE productos SET precio = $1 WHERE id = $2', [item.precio_venta_nuevo, item.producto_id]);
      }

      // Sumar al inventario
      await conexion.query(
        `INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, 0) ON CONFLICT (producto_id) DO NOTHING`,
        [item.producto_id]
      );
      await conexion.query(
        'UPDATE inventario SET existencia_actual = existencia_actual + $1 WHERE producto_id = $2',
        [item.cantidad, item.producto_id]
      );
      await conexion.query(
        `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, referencia_id, usuario_id)
         VALUES ($1, 'entrada_compra', $2, $3, $4)`,
        [item.producto_id, item.cantidad, compra.id, req.usuario.id]
      );
    }

    await conexion.query('COMMIT');
    res.json(compra);
  } catch (err) {
    await conexion.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la compra' });
  } finally {
    conexion.release();
  }
});

module.exports = router;
