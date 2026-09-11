const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, tienePermiso } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

function puedeEditarPrecios(req, res, next) {
  if (tienePermiso(req.usuario, 'PRODUCTOS_PRECIO') || tienePermiso(req.usuario, 'PRODUCTOS_EDITAR')) return next();
  return res.status(403).json({ error: 'No tienes permiso para configurar promociones de precio' });
}

// Listar los escalones de precio de un producto
router.get('/:producto_id', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM promociones WHERE producto_id = $1 AND activo = true ORDER BY cantidad_minima ASC',
      [req.params.producto_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las promociones' });
  }
});

// Agregar un escalón de precio
router.post('/:producto_id', verificarToken, puedeEditarPrecios, async (req, res) => {
  try {
    const { cantidad_minima, precio_promocional } = req.body;
    if (!cantidad_minima || cantidad_minima <= 0 || !precio_promocional || precio_promocional <= 0) {
      return res.status(400).json({ error: 'Cantidad mínima y precio promocional deben ser mayores a 0' });
    }

    const productoResult = await pool.query('SELECT precio FROM productos WHERE id = $1 AND sucursal_id = $2', [req.params.producto_id, req.usuario.sucursal_id]);
    if (productoResult.rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    if (parseFloat(precio_promocional) >= parseFloat(productoResult.rows[0].precio)) {
      return res.status(400).json({ error: 'El precio promocional debe ser menor al precio normal del producto' });
    }

    const result = await pool.query(
      `INSERT INTO promociones (producto_id, cantidad_minima, precio_promocional) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.producto_id, cantidad_minima, precio_promocional]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id, accion: 'crear_promocion', modulo: 'productos',
      referencia_id: parseInt(req.params.producto_id),
      valor_nuevo: { cantidad_minima, precio_promocional }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear la promoción' });
  }
});

// Eliminar un escalón de precio
router.delete('/escalon/:id', verificarToken, puedeEditarPrecios, async (req, res) => {
  try {
    await pool.query('UPDATE promociones SET activo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar la promoción' });
  }
});

module.exports = router;
