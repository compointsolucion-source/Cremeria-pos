const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Listar kits activos con sus productos incluidos
router.get('/', verificarToken, async (req, res) => {
  try {
    const kitsResult = await pool.query(
      'SELECT * FROM kits WHERE sucursal_id = $1 AND activo = true ORDER BY nombre ASC',
      [req.usuario.sucursal_id]
    );
    const kits = kitsResult.rows;

    for (const kit of kits) {
      const detalle = await pool.query(
        `SELECT kp.cantidad, p.id AS producto_id, p.nombre, p.tipo_venta
         FROM kit_productos kp JOIN productos p ON kp.producto_id = p.id
         WHERE kp.kit_id = $1`,
        [kit.id]
      );
      kit.productos = detalle.rows;
    }

    res.json(kits);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener los kits' });
  }
});

// Buscar kit por código de barras
router.get('/codigo/:codigo', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM kits WHERE codigo_barras = $1 AND sucursal_id = $2 AND activo = true',
      [req.params.codigo, req.usuario.sucursal_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No existe un kit con ese código' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar el kit' });
  }
});

// Crear kit
router.post('/', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const { nombre, precio_kit, imagen_url, codigo_barras, productos } = req.body;
    if (!nombre || !precio_kit || !productos || productos.length === 0) {
      return res.status(400).json({ error: 'Nombre, precio y al menos un producto son requeridos' });
    }

    await cliente.query('BEGIN');

    const kitResult = await cliente.query(
      `INSERT INTO kits (sucursal_id, nombre, precio_kit, imagen_url, codigo_barras)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.usuario.sucursal_id, nombre, precio_kit, imagen_url || null, codigo_barras || null]
    );
    const kit = kitResult.rows[0];

    for (const p of productos) {
      await cliente.query(
        `INSERT INTO kit_productos (kit_id, producto_id, cantidad) VALUES ($1, $2, $3)`,
        [kit.id, p.producto_id, p.cantidad]
      );
    }

    await registrarBitacora(cliente, {
      usuario_id: req.usuario.id,
      accion: 'crear_kit',
      modulo: 'kits',
      referencia_id: kit.id,
      valor_nuevo: { nombre, precio_kit, num_productos: productos.length }
    });

    await cliente.query('COMMIT');
    res.json(kit);
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505') return res.status(400).json({ error: 'Ese código de barras ya está en uso' });
    res.status(500).json({ error: 'Error al crear el kit' });
  } finally {
    cliente.release();
  }
});

// Desactivar kit
router.delete('/:id', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    await pool.query('UPDATE kits SET activo = false WHERE id = $1 AND sucursal_id = $2', [req.params.id, req.usuario.sucursal_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el kit' });
  }
});

module.exports = router;
