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

// Importación masiva desde Excel (formato: Código, Producto, P. Costo,
// P. Venta, P. Mayoreo, Existencia, Inv. Mínimo, Inv. Máximo, Departamento).
// El navegador ya convirtió el archivo a un arreglo de objetos — aquí solo
// se procesa: si el código de barras (o si no hay código, el nombre) ya
// existe, se ACTUALIZA; si no, se CREA. Los departamentos que no existan
// se crean solos. Filas sin nombre de producto se omiten (no hay nada que
// dar de alta) y se reportan como omitidas, no se inventan datos.
router.post('/importar', verificarToken, requierePermiso('PRODUCTOS_CREAR'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    const { productos } = req.body;
    if (!Array.isArray(productos) || productos.length === 0) {
      return res.status(400).json({ error: 'No se recibieron productos para importar' });
    }

    await conexion.query('BEGIN');

    let creados = 0, actualizados = 0, omitidos = 0;
    const categoriasCache = {};

    for (const fila of productos) {
      const nombre = (fila.nombre || '').trim();
      if (!nombre) { omitidos++; continue; }

      const codigo_barras = (fila.codigo_barras || '').trim() || null;
      const precio_costo = fila.precio_costo || null;
      const precio = fila.precio || null;
      const precio_mayoreo = fila.precio_mayoreo || null;
      const existencia = fila.existencia !== undefined ? fila.existencia : 0;
      const stock_minimo = fila.stock_minimo || 0;
      const stock_maximo = fila.stock_maximo || null;
      const departamentoNombre = (fila.departamento || '').trim();

      // Resolver (o crear) el departamento, cacheando para no repetir la
      // misma consulta cientos de veces en un archivo grande.
      let categoria_id = null;
      if (departamentoNombre && departamentoNombre !== '- Sin Departamento -') {
        const clave = departamentoNombre.toLowerCase();
        if (categoriasCache[clave]) {
          categoria_id = categoriasCache[clave];
        } else {
          const existente = await conexion.query('SELECT id FROM categorias WHERE LOWER(nombre) = $1', [clave]);
          if (existente.rows.length > 0) {
            categoria_id = existente.rows[0].id;
          } else {
            const nueva = await conexion.query('INSERT INTO categorias (nombre) VALUES ($1) RETURNING id', [departamentoNombre]);
            categoria_id = nueva.rows[0].id;
          }
          categoriasCache[clave] = categoria_id;
        }
      }

      // Buscar producto existente: primero por código de barras (si viene),
      // si no por nombre exacto (sin distinguir mayúsculas) en esta sucursal.
      let productoExistente = null;
      if (codigo_barras) {
        const porCodigo = await conexion.query('SELECT id FROM productos WHERE codigo_barras = $1 AND sucursal_id = $2', [codigo_barras, req.usuario.sucursal_id]);
        if (porCodigo.rows.length > 0) productoExistente = porCodigo.rows[0];
      }
      if (!productoExistente) {
        const porNombre = await conexion.query('SELECT id FROM productos WHERE LOWER(nombre) = $1 AND sucursal_id = $2', [nombre.toLowerCase(), req.usuario.sucursal_id]);
        if (porNombre.rows.length > 0) productoExistente = porNombre.rows[0];
      }

      let productoId;
      if (productoExistente) {
        productoId = productoExistente.id;
        await conexion.query(
          `UPDATE productos SET
            precio = COALESCE($1, precio), precio_costo = COALESCE($2, precio_costo),
            precio_mayoreo = COALESCE($3, precio_mayoreo), categoria_id = COALESCE($4, categoria_id)
           WHERE id = $5`,
          [precio, precio_costo, precio_mayoreo, categoria_id, productoId]
        );
        actualizados++;
      } else {
        const nuevoProducto = await conexion.query(
          `INSERT INTO productos (sucursal_id, nombre, precio, precio_costo, precio_mayoreo, categoria_id, codigo_barras, tipo_venta, usa_inventario)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'peso', true) RETURNING id`,
          [req.usuario.sucursal_id, nombre, precio || 0, precio_costo, precio_mayoreo, categoria_id, codigo_barras]
        );
        productoId = nuevoProducto.rows[0].id;
        creados++;
      }

      await conexion.query(
        `INSERT INTO inventario (producto_id, existencia_actual, stock_minimo, stock_maximo)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (producto_id) DO UPDATE SET
           existencia_actual = $2, stock_minimo = $3, stock_maximo = COALESCE($4, inventario.stock_maximo)`,
        [productoId, existencia, stock_minimo, stock_maximo]
      );
    }

    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id,
      accion: 'importar_productos',
      modulo: 'productos',
      valor_nuevo: { total: productos.length, creados, actualizados, omitidos }
    });

    await conexion.query('COMMIT');
    res.json({ creados, actualizados, omitidos });
  } catch (err) {
    await conexion.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al importar el archivo: ' + err.message });
  } finally {
    conexion.release();
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
