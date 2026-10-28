const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol, requierePermiso, tienePermiso, requiereSucursalId } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// ¿Ese producto es de esta sucursal? (nadie puede mover el inventario de otra sucursal mandando otro id)
async function productoDeLaSucursal(db, productoId, sucursalId) {
  const id = Number(productoId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const r = await db.query('SELECT id FROM productos WHERE id = $1 AND sucursal_id = $2', [id, sucursalId]);
  return r.rows.length > 0;
}

// Cantidad opcional: vacía = no se cambia (null); si viene, debe ser un número >= 0.
const cantidadOpcional = (v) => {
  if (v === undefined || v === null || v === '') return { valor: null };
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? { valor: n } : { error: true };
};

// Toda ruta de este archivo ya filtra por sucursal — se resuelve una sola
// vez aquí (req.sucursalId) en vez de repetirlo en cada endpoint.
router.use(verificarToken, requiereSucursalId);

// Inventario valorizado: costo total, valor potencial de venta, margen potencial.
// El "costo" usa el promedio de costo_unitario de las compras registradas de
// cada producto; si un producto nunca se ha comprado (se dio de alta a mano o se
// importó de Excel) se usa el costo capturado en el propio producto. Solo si no
// hay ninguno de los dos, ese producto no aporta costo (no se inventa uno).
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
         COALESCE(cp.costo_promedio, p.precio_costo) AS costo_promedio,
         CASE WHEN COALESCE(cp.costo_promedio, p.precio_costo) IS NOT NULL THEN COALESCE(i.existencia_actual, 0) * COALESCE(cp.costo_promedio, p.precio_costo) ELSE NULL END AS valor_costo,
         COALESCE(i.existencia_actual, 0) * p.precio AS valor_venta_potencial
       FROM productos p
       LEFT JOIN inventario i ON p.id = i.producto_id
       LEFT JOIN costos_promedio cp ON p.id = cp.producto_id
       WHERE p.sucursal_id = $1 AND p.activo = true
       ORDER BY p.nombre ASC`,
      [req.sucursalId]
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

// Reporte de inventario estilo tabla completa: código, descripción, costo,
// precio venta, existencia, mínimo, máximo — con filtro opcional por
// departamento y totales generales. Solo incluye productos que SÍ usan
// inventario (los que no, no tienen nada que reportar aquí).
router.get('/reporte', verificarToken, requierePermiso('INVENTARIO_VER'), async (req, res) => {
  try {
    const { categoria_id } = req.query;
    const result = await pool.query(
      `SELECT p.id, p.codigo_barras, p.nombre, p.precio_costo, p.precio, p.categoria_id, p.tipo_venta,
              c.nombre AS categoria_nombre,
              COALESCE(i.existencia_actual, 0) AS existencia,
              COALESCE(i.stock_minimo, 0) AS stock_minimo,
              COALESCE(i.stock_maximo, 0) AS stock_maximo
       FROM productos p
       LEFT JOIN inventario i ON p.id = i.producto_id
       LEFT JOIN categorias c ON p.categoria_id = c.id
       WHERE p.sucursal_id = $1 AND p.activo = true AND p.usa_inventario = true
         AND ($2::int IS NULL OR p.categoria_id = $2)
       ORDER BY p.nombre ASC`,
      [req.sucursalId, categoria_id || null]
    );

    const costoTotal = result.rows.reduce((sum, r) => sum + (r.precio_costo ? parseFloat(r.precio_costo) * parseFloat(r.existencia) : 0), 0);
    const cantidadTotal = result.rows.reduce((sum, r) => sum + parseFloat(r.existencia), 0);

    res.json({ productos: result.rows, totales: { costo_total: costoTotal, cantidad_total: cantidadTotal } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar el reporte de inventario' });
  }
});

// Listado de existencias con datos del producto
router.get('/', verificarToken, requierePermiso('INVENTARIO_VER'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id AS producto_id, p.nombre, p.tipo_venta, p.imagen_url, p.codigo_barras,
              p.precio_costo, p.precio, p.precio_mayoreo,
              COALESCE(i.existencia_actual, 0) AS existencia_actual,
              COALESCE(i.stock_minimo, 0) AS stock_minimo,
              COALESCE(i.stock_maximo, 0) AS stock_maximo
       FROM productos p
       LEFT JOIN inventario i ON p.id = i.producto_id
       WHERE p.sucursal_id = $1 AND p.activo = true
       ORDER BY p.nombre ASC`,
      [req.sucursalId]
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
      [req.sucursalId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener alertas' });
  }
});

// Configurar el stock mínimo de un producto
router.put('/:producto_id/minimo', verificarToken, requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  try {
    if (!(await productoDeLaSucursal(pool, req.params.producto_id, req.sucursalId))) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    const minimo = cantidadOpcional(req.body.stock_minimo);
    const maximo = cantidadOpcional(req.body.stock_maximo);
    if (minimo.error || maximo.error) return res.status(400).json({ error: 'El mínimo y el máximo deben ser números de 0 en adelante' });
    await pool.query(
      `INSERT INTO inventario (producto_id, stock_minimo, stock_maximo) VALUES ($1, COALESCE($2::numeric, 0), $3)
       ON CONFLICT (producto_id) DO UPDATE SET
         stock_minimo = COALESCE($2::numeric, inventario.stock_minimo),
         stock_maximo = COALESCE($3::numeric, inventario.stock_maximo)`,
      [Number(req.params.producto_id), minimo.valor, maximo.valor]
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
    if (!producto_id || !(Number(cantidad) > 0) || !Number.isFinite(Number(cantidad))) {
      return res.status(400).json({ error: 'Producto y cantidad son requeridos' });
    }
    if (!['merma', 'ajuste_manual', 'entrada_manual'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de ajuste inválido' });
    }

    const permisoRequerido = tipo === 'merma' ? 'INVENTARIO_MERMA' : 'INVENTARIO_AJUSTAR';
    if (!tienePermiso(req.usuario, permisoRequerido)) {
      return res.status(403).json({ error: `No tienes el permiso "${permisoRequerido}" para esta acción. Pide a tu gerente que te lo asigne en Equipo.` });
    }

    if (!(await productoDeLaSucursal(conexion, producto_id, req.sucursalId))) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // Cambiar precios de paso (al recibir mercancía) es cambiar precios: pide su propio permiso.
    const cambiaPrecios = tipo === 'entrada_manual' && (precio_costo || precio || precio_mayoreo);
    if (cambiaPrecios) {
      if (!tienePermiso(req.usuario, 'PRODUCTOS_PRECIO')) {
        return res.status(403).json({ error: 'No tienes el permiso "PRODUCTOS_PRECIO" para cambiar precios. Pide a tu gerente que te lo asigne en Equipo.' });
      }
      const malos = [precio_costo, precio, precio_mayoreo].some((v) => v && !(Number(v) >= 0 && Number.isFinite(Number(v))));
      if (malos) return res.status(400).json({ error: 'Los precios deben ser números de 0 en adelante' });
    }

    const cantidadConSigno = tipo === 'entrada_manual' ? Number(cantidad) : -Number(cantidad);

    await conexion.query('BEGIN');

    await conexion.query(
      `INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, 0) ON CONFLICT (producto_id) DO NOTHING`,
      [producto_id]
    );
    // GREATEST evita que una merma/ajuste deje la existencia en negativo — si
    // la cantidad a restar es mayor a lo que hay, se queda en 0 (no en -X).
    await conexion.query(
      'UPDATE inventario SET existencia_actual = GREATEST(existencia_actual + $1, 0) WHERE producto_id = $2',
      [cantidadConSigno, producto_id]
    );
    await conexion.query(
      `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, usuario_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [producto_id, tipo, cantidadConSigno, motivo || null, req.usuario.id]
    );

    // Si se recibió mercancía con costo/precio nuevo, actualizar el producto
    // de una vez (solo tiene sentido en entrada manual, no al restar por merma).
    if (cambiaPrecios) {
      await conexion.query(
        `UPDATE productos SET
          precio_costo = COALESCE($1, precio_costo),
          precio = COALESCE($2, precio),
          precio_mayoreo = COALESCE($3, precio_mayoreo)
         WHERE id = $4 AND sucursal_id = $5`,
        [precio_costo || null, precio || null, precio_mayoreo || null, producto_id, req.sucursalId]
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
    await conexion.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el ajuste' });
  } finally {
    conexion.release();
  }
});

// Historial de movimientos de un producto (solo productos de esta sucursal)
router.get('/:producto_id/movimientos', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, u.nombre AS usuario_nombre FROM movimientos_inventario m
       JOIN productos p ON p.id = m.producto_id
       JOIN usuarios u ON m.usuario_id = u.id
       WHERE m.producto_id = $1 AND p.sucursal_id = $2 ORDER BY m.fecha DESC LIMIT 50`,
      [req.params.producto_id, req.sucursalId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener movimientos' });
  }
});

module.exports = router;
