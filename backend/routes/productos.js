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
    let query = `SELECT p.*, c.nombre AS categoria_nombre,
         COALESCE(
           (SELECT json_agg(json_build_object('cantidad_minima', pr.cantidad_minima, 'precio_promocional', pr.precio_promocional) ORDER BY pr.cantidad_minima ASC)
            FROM promociones pr WHERE pr.producto_id = p.id AND pr.activo = true),
           '[]'::json
         ) AS promociones
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

// Busca un código de barras en Open Food Facts (base de datos pública y
// gratuita) para autocompletar nombre e imagen de un producto que NUNCA
// se ha dado de alta — típicamente refrescos, botanas y productos empacados
// con marca. No tiene nada que ver con TU catálogo; es solo para no escribir
// a mano productos comerciales conocidos. Si no lo encuentra, no es un error:
// simplemente no hay datos que autocompletar.
router.get('/buscar-externo/:codigo', verificarToken, async (req, res) => {
  try {
    const respuesta = await fetch(`https://world.openfoodfacts.org/api/v2/product/${req.params.codigo}.json`);
    const datos = await respuesta.json();

    if (datos.status !== 1 || !datos.product) {
      return res.status(404).json({ error: 'No se encontró este código en la base de datos pública' });
    }

    res.json({
      nombre: datos.product.product_name || datos.product.product_name_es || null,
      imagen_url: datos.product.image_url || datos.product.image_front_url || null
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'No se pudo consultar la base de datos externa en este momento' });
  }
});

// Crear producto (solo dueño/gerente)
router.post('/', verificarToken, requierePermiso('PRODUCTOS_CREAR'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    const {
      nombre, precio, categoria_id, imagen_url, favorito, orden, codigo_barras, tipo_venta,
      precio_costo, ganancia_porcentaje, precio_mayoreo, usa_inventario,
      existencia_inicial, stock_minimo, stock_maximo
    } = req.body;
    if (!nombre || !precio) {
      return res.status(400).json({ error: 'Nombre y precio son requeridos' });
    }
    if (tipo_venta && !['peso', 'unidad'].includes(tipo_venta)) {
      return res.status(400).json({ error: 'Tipo de venta inválido' });
    }

    await conexion.query('BEGIN');

    const result = await conexion.query(
      `INSERT INTO productos (
         sucursal_id, categoria_id, nombre, precio, imagen_url, favorito, orden, codigo_barras, tipo_venta,
         precio_costo, ganancia_porcentaje, precio_mayoreo, usa_inventario
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        req.usuario.sucursal_id, categoria_id || null, nombre, precio, imagen_url || null, favorito || false,
        orden || 0, codigo_barras || null, tipo_venta || 'peso',
        precio_costo || null, ganancia_porcentaje || null, precio_mayoreo || null, usa_inventario !== false
      ]
    );
    const producto = result.rows[0];

    // Si se especificó una existencia inicial (o mínimo/máximo), crea el
    // registro de inventario de una vez — así no hay que ir a otra pantalla.
    if (usa_inventario !== false && (existencia_inicial !== undefined || stock_minimo !== undefined || stock_maximo !== undefined)) {
      await conexion.query(
        `INSERT INTO inventario (producto_id, existencia_actual, stock_minimo, stock_maximo)
         VALUES ($1, $2, $3, $4)`,
        [producto.id, existencia_inicial || 0, stock_minimo || 0, stock_maximo || null]
      );
    }

    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id,
      accion: 'crear_producto',
      modulo: 'productos',
      referencia_id: producto.id,
      valor_nuevo: { nombre, precio, tipo_venta: tipo_venta || 'peso' }
    });

    await conexion.query('COMMIT');
    res.json(producto);
  } catch (err) {
    await conexion.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505') return res.status(400).json({ error: 'Ese código de barras ya está en uso' });
    res.status(500).json({ error: 'Error al crear producto' });
  } finally {
    conexion.release();
  }
});

// Editar producto
router.put('/:id', verificarToken, async (req, res) => {
  try {
    const {
      nombre, precio, categoria_id, imagen_url, favorito, orden, activo, codigo_barras, tipo_venta,
      precio_costo, ganancia_porcentaje, precio_mayoreo, usa_inventario
    } = req.body;

    const camposDistintosDePrecio = [nombre, categoria_id, imagen_url, favorito, orden, activo, codigo_barras, tipo_venta, precio_costo, ganancia_porcentaje, precio_mayoreo, usa_inventario]
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
        tipo_venta = COALESCE($9, tipo_venta),
        precio_costo = COALESCE($10, precio_costo),
        ganancia_porcentaje = COALESCE($11, ganancia_porcentaje),
        precio_mayoreo = COALESCE($12, precio_mayoreo),
        usa_inventario = COALESCE($13, usa_inventario)
       WHERE id = $14 AND sucursal_id = $15 RETURNING *`,
      [nombre, precio, categoria_id, imagen_url, favorito, orden, activo, codigo_barras || null, tipo_venta,
       precio_costo, ganancia_porcentaje, precio_mayoreo, usa_inventario, req.params.id, req.usuario.sucursal_id]
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
