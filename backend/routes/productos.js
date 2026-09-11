const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol, requierePermiso, tienePermiso } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Listar productos activos (para mostrador y admin). Soporta paginación
// opcional con ?limit=&offset= — si no se pasan, devuelve todo (compatibilidad
// con el Mostrador, que necesita el catálogo completo de una vez).
router.get('/', verificarToken, async (req, res) => {
  try {
    const { limit, offset } = req.query;
    let query = `SELECT p.*, c.nombre AS categoria_nombre
       FROM productos p
       LEFT JOIN categorias c ON p.categoria_id = c.id
       WHERE p.sucursal_id = $1 AND p.activo = true
       ORDER BY p.favorito DESC, p.orden ASC, p.nombre ASC`;
    const valores = [req.usuario.sucursal_id];

    if (limit) {
      valores.push(parseInt(limit));
      query += ` LIMIT $${valores.length}`;
      if (offset) {
        valores.push(parseInt(offset));
        query += ` OFFSET $${valores.length}`;
      }
    }

    const result = await pool.query(query, valores);

    if (limit) {
      const totalResult = await pool.query(
        'SELECT COUNT(*) FROM productos WHERE sucursal_id = $1 AND activo = true',
        [req.usuario.sucursal_id]
      );
      res.json({ productos: result.rows, total: parseInt(totalResult.rows[0].count) });
    } else {
      res.json(result.rows);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

// Listar categorías
router.get('/categorias', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categorias ORDER BY orden ASC, nombre ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener categorías' });
  }
});

// Buscar producto por código de barras (escaneo en mostrador)
router.get('/codigo/:codigo', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM productos WHERE codigo_barras = $1 AND sucursal_id = $2 AND activo = true',
      [req.params.codigo, req.usuario.sucursal_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No existe un producto con ese código' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar el producto' });
  }
});

// Crear producto (solo dueño/gerente)
router.post('/', verificarToken, requierePermiso('PRODUCTOS_CREAR'), async (req, res) => {
  try {
    const { nombre, precio, categoria_id, imagen_url, favorito, orden, codigo_barras, tipo_venta } = req.body;
    if (!nombre || !precio) {
      return res.status(400).json({ error: 'Nombre y precio son requeridos' });
    }
    if (tipo_venta && !['peso', 'unidad'].includes(tipo_venta)) {
      return res.status(400).json({ error: 'Tipo de venta inválido' });
    }

    const result = await pool.query(
      `INSERT INTO productos (sucursal_id, categoria_id, nombre, precio, imagen_url, favorito, orden, codigo_barras, tipo_venta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.usuario.sucursal_id, categoria_id || null, nombre, precio, imagen_url || null, favorito || false, orden || 0, codigo_barras || null, tipo_venta || 'peso']
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'crear_producto',
      modulo: 'productos',
      referencia_id: result.rows[0].id,
      valor_nuevo: { nombre, precio, tipo_venta: tipo_venta || 'peso' }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(400).json({ error: 'Ese código de barras ya está en uso' });
    res.status(500).json({ error: 'Error al crear producto' });
  }
});

// Editar producto
router.put('/:id', verificarToken, async (req, res) => {
  try {
    const { nombre, precio, categoria_id, imagen_url, favorito, orden, activo, codigo_barras, tipo_venta } = req.body;

    const camposDistintosDePrecio = [nombre, categoria_id, imagen_url, favorito, orden, activo, codigo_barras, tipo_venta]
      .some(campo => campo !== undefined);

    if (camposDistintosDePrecio && !tienePermiso(req.usuario, 'PRODUCTOS_EDITAR')) {
      return res.status(403).json({ error: 'No tienes el permiso "PRODUCTOS_EDITAR" para cambiar estos datos del producto.' });
    }
    if (precio !== undefined && !tienePermiso(req.usuario, 'PRODUCTOS_PRECIO') && !tienePermiso(req.usuario, 'PRODUCTOS_EDITAR')) {
      return res.status(403).json({ error: 'No tienes el permiso "PRODUCTOS_PRECIO" para cambiar el precio.' });
    }

    const result = await pool.query(
      `UPDATE productos SET
        nombre = COALESCE($1, nombre),
        precio = COALESCE($2, precio),
        categoria_id = $3,
        imagen_url = COALESCE($4, imagen_url),
        favorito = COALESCE($5, favorito),
        orden = COALESCE($6, orden),
        activo = COALESCE($7, activo),
        codigo_barras = $8,
        tipo_venta = COALESCE($9, tipo_venta)
       WHERE id = $10 AND sucursal_id = $11 RETURNING *`,
      [nombre, precio, categoria_id, imagen_url, favorito, orden, activo, codigo_barras || null, tipo_venta, req.params.id, req.usuario.sucursal_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(400).json({ error: 'Ese código de barras ya está en uso' });
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
});

// Eliminar (desactivar) producto
router.delete('/:id', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    await pool.query(
      'UPDATE productos SET activo = false WHERE id = $1 AND sucursal_id = $2',
      [req.params.id, req.usuario.sucursal_id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar producto' });
  }
});

module.exports = router;
