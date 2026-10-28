const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol, requiereSucursalId, tienePermiso } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Toda ruta de este archivo ya filtra por sucursal — se resuelve una sola
// vez aquí (req.sucursalId) en vez de repetirlo en cada endpoint.
router.use(verificarToken, requiereSucursalId);

// Historial de compras
router.get('/', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, p.nombre AS proveedor_nombre,
         (SELECT COUNT(*) FROM compra_detalle d WHERE d.compra_id = c.id)::int AS num_productos
       FROM compras c
       JOIN proveedores p ON c.proveedor_id = p.id
       WHERE c.sucursal_id = $1 ORDER BY c.fecha DESC LIMIT 50`,
      [req.sucursalId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener compras' });
  }
});

// Por proveedor: cuántas compras, cuánto se ha comprado en total y la fecha de la última
// (se calcula con TODAS las compras, no solo con las 50 que muestra el historial).
router.get('/resumen-proveedores', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT proveedor_id, COUNT(*)::int AS num_compras,
              COALESCE(SUM(total), 0) AS total_comprado, MAX(fecha) AS ultima_compra
       FROM compras WHERE sucursal_id = $1 GROUP BY proveedor_id`,
      [req.sucursalId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el resumen de proveedores' });
  }
});

// Detalle de una compra: los productos que se compraron
router.get('/:id/detalle', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.producto_id, pr.nombre, pr.tipo_venta, d.cantidad, d.costo_unitario, d.precio_venta_nuevo, d.subtotal
       FROM compra_detalle d
       JOIN compras c ON c.id = d.compra_id
       JOIN productos pr ON pr.id = d.producto_id
       WHERE d.compra_id = $1 AND c.sucursal_id = $2
       ORDER BY d.id`,
      [req.params.id, req.sucursalId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el detalle de la compra' });
  }
});

// Registrar una compra: actualiza inventario y, si se indica, el precio de venta
router.post('/', verificarToken, requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    const { proveedor_id, items } = req.body; // [{producto_id, cantidad, costo_unitario, precio_venta_nuevo}]
    if (!proveedor_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Proveedor y al menos un producto son requeridos' });
    }

    // Cada renglón: producto válido, cantidad mayor a 0, costo y precio nuevo de $0 en adelante.
    for (const it of items) {
      const cantidad = Number(it.cantidad), costo = Number(it.costo_unitario);
      if (!Number.isInteger(Number(it.producto_id)) || Number(it.producto_id) <= 0) {
        return res.status(400).json({ error: 'Hay un producto no válido en la compra' });
      }
      if (!Number.isFinite(cantidad) || cantidad <= 0) {
        return res.status(400).json({ error: 'La cantidad de cada producto debe ser mayor a 0' });
      }
      if (!Number.isFinite(costo) || costo < 0) {
        return res.status(400).json({ error: 'El costo de cada producto debe ser de $0 en adelante' });
      }
      if (it.precio_venta_nuevo) {
        const precioNuevo = Number(it.precio_venta_nuevo);
        if (!Number.isFinite(precioNuevo) || precioNuevo < 0) {
          return res.status(400).json({ error: 'El precio de venta nuevo no es válido' });
        }
      }
    }
    // Cambiar el precio de venta desde una compra pide el permiso de precios.
    if (items.some((it) => it.precio_venta_nuevo) && !tienePermiso(req.usuario, 'PRODUCTOS_PRECIO')) {
      return res.status(403).json({ error: 'No tienes el permiso "PRODUCTOS_PRECIO" para cambiar el precio de venta.' });
    }

    // El proveedor y todos los productos deben ser de esta sucursal.
    if (!Number.isInteger(Number(proveedor_id)) || Number(proveedor_id) <= 0) return res.status(400).json({ error: 'Proveedor no válido' });
    const proveedor = await conexion.query('SELECT id FROM proveedores WHERE id = $1 AND sucursal_id = $2', [Number(proveedor_id), req.sucursalId]);
    if (proveedor.rows.length === 0) return res.status(404).json({ error: 'Proveedor no encontrado' });
    const idsProductos = [...new Set(items.map((it) => Number(it.producto_id)))];
    const propios = await conexion.query('SELECT id FROM productos WHERE id = ANY($1::int[]) AND sucursal_id = $2', [idsProductos, req.sucursalId]);
    if (propios.rows.length !== idsProductos.length) return res.status(404).json({ error: 'Uno de los productos no existe en esta sucursal' });

    await conexion.query('BEGIN');

    const total = items.reduce((sum, it) => sum + (Number(it.cantidad) * Number(it.costo_unitario)), 0);

    const compraResult = await conexion.query(
      `INSERT INTO compras (sucursal_id, proveedor_id, usuario_id, total) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.sucursalId, Number(proveedor_id), req.usuario.id, total]
    );
    const compra = compraResult.rows[0];

    for (const item of items) {
      const subtotal = Number(item.cantidad) * Number(item.costo_unitario);

      await conexion.query(
        `INSERT INTO compra_detalle (compra_id, producto_id, cantidad, costo_unitario, precio_venta_nuevo, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [compra.id, item.producto_id, item.cantidad, item.costo_unitario, item.precio_venta_nuevo || null, subtotal]
      );

      // Actualizar precio de venta si se especificó uno nuevo
      if (item.precio_venta_nuevo) {
        await conexion.query('UPDATE productos SET precio = $1 WHERE id = $2', [item.precio_venta_nuevo, item.producto_id]);
      }

      // El costo de compra pasa a ser el costo actual del producto (y el % de
      // ganancia se recalcula con el precio de venta vigente).
      if (Number(item.costo_unitario) > 0) {
        await conexion.query(
          `UPDATE productos SET precio_costo = $1,
             ganancia_porcentaje = CASE WHEN precio > 0 THEN ROUND(((precio - $1::numeric) / $1::numeric * 100), 2) ELSE ganancia_porcentaje END
           WHERE id = $2`,
          [item.costo_unitario, item.producto_id]
        );
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

    await registrarBitacora(conexion, {
      usuario_id: req.usuario.id,
      accion: 'registrar_compra',
      modulo: 'compras',
      referencia_id: compra.id,
      valor_nuevo: { proveedor_id, total, num_items: items.length }
    });

    await conexion.query('COMMIT');
    res.json(compra);
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la compra' });
  } finally {
    conexion.release();
  }
});

module.exports = router;
