const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');

router.get('/', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM proveedores WHERE sucursal_id = $1 AND activo = true ORDER BY nombre ASC',
      [req.usuario.sucursal_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener proveedores' });
  }
});

router.post('/', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    const { nombre, contacto, telefono } = req.body;
    if (!nombre) return res.status(400).json({ error: 'El nombre es requerido' });

    const result = await pool.query(
      `INSERT INTO proveedores (sucursal_id, nombre, contacto, telefono) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.usuario.sucursal_id, nombre, contacto || null, telefono || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear proveedor' });
  }
});

router.delete('/:id', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    await pool.query('UPDATE proveedores SET activo = false WHERE id = $1 AND sucursal_id = $2', [req.params.id, req.usuario.sucursal_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar proveedor' });
  }
});

module.exports = router;
