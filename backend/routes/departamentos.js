const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requierePermiso } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Listar departamentos (categorías)
router.get('/', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categorias ORDER BY orden ASC, nombre ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener departamentos' });
  }
});

// Crear departamento
router.post('/', verificarToken, requierePermiso('PRODUCTOS_CREAR'), async (req, res) => {
  try {
    const { nombre, orden } = req.body;
    if (!nombre) return res.status(400).json({ error: 'El nombre es requerido' });

    const result = await pool.query(
      'INSERT INTO categorias (nombre, orden) VALUES ($1, $2) RETURNING *',
      [nombre, orden || 0]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id, accion: 'crear_departamento', modulo: 'productos',
      referencia_id: result.rows[0].id, valor_nuevo: { nombre }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear el departamento' });
  }
});

// Editar departamento
router.put('/:id', verificarToken, requierePermiso('PRODUCTOS_EDITAR'), async (req, res) => {
  try {
    const { nombre, orden } = req.body;
    const result = await pool.query(
      'UPDATE categorias SET nombre = COALESCE($1, nombre), orden = COALESCE($2, orden) WHERE id = $3 RETURNING *',
      [nombre, orden, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Departamento no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al editar el departamento' });
  }
});

// Eliminar departamento (los productos que lo usaban quedan "Sin categoría")
router.delete('/:id', verificarToken, requierePermiso('PRODUCTOS_EDITAR'), async (req, res) => {
  try {
    await pool.query('UPDATE productos SET categoria_id = NULL WHERE categoria_id = $1', [req.params.id]);
    await pool.query('DELETE FROM categorias WHERE id = $1', [req.params.id]);

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id, accion: 'eliminar_departamento', modulo: 'productos',
      referencia_id: parseInt(req.params.id)
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el departamento' });
  }
});

module.exports = router;
