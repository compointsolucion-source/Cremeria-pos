const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol, requiereSucursalId } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Revisa los productos que trae un kit: cada uno debe ser de esta sucursal y con cantidad
// mayor a 0. Devuelve un mensaje de error, o null si todo está bien.
async function errorEnProductosDelKit(productos, sucursalId) {
  for (const p of productos) {
    const id = Number(p && p.producto_id), cantidad = Number(p && p.cantidad);
    if (!Number.isInteger(id) || id <= 0) return 'Hay un producto no válido en el kit';
    if (!Number.isFinite(cantidad) || cantidad <= 0) return 'La cantidad de cada producto del kit debe ser mayor a 0';
  }
  const ids = [...new Set(productos.map((p) => Number(p.producto_id)))];
  const r = await pool.query('SELECT id FROM productos WHERE id = ANY($1::int[]) AND sucursal_id = $2', [ids, sucursalId]);
  if (r.rows.length !== ids.length) return 'Uno de los productos del kit no existe en esta sucursal';
  return null;
}

// Toda ruta de este archivo ya filtra por sucursal — se resuelve una sola
// vez aquí (req.sucursalId) en vez de repetirlo en cada endpoint.
router.use(verificarToken, requiereSucursalId);

// Listar kits activos con sus productos incluidos
router.get('/', verificarToken, async (req, res) => {
  try {
    const kitsResult = await pool.query(
      'SELECT * FROM kits WHERE sucursal_id = $1 AND activo = true ORDER BY nombre ASC',
      [req.sucursalId]
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
      [req.params.codigo, req.sucursalId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No existe un kit con ese código' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar el kit' });
  }
});

// Crear kit
router.post('/', verificarToken, requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const { nombre, precio_kit, imagen_url, codigo_barras, productos } = req.body;
    if (!nombre || !precio_kit || !Array.isArray(productos) || productos.length === 0) {
      return res.status(400).json({ error: 'Nombre, precio y al menos un producto son requeridos' });
    }
    if (!(Number(precio_kit) > 0)) return res.status(400).json({ error: 'El precio del kit debe ser mayor a 0' });
    const errorProductos = await errorEnProductosDelKit(productos, req.sucursalId);
    if (errorProductos) return res.status(400).json({ error: errorProductos });

    await cliente.query('BEGIN');

    const kitResult = await cliente.query(
      `INSERT INTO kits (sucursal_id, nombre, precio_kit, imagen_url, codigo_barras)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.sucursalId, nombre, precio_kit, imagen_url || null, codigo_barras || null]
    );
    const kit = kitResult.rows[0];

    for (const p of productos) {
      await cliente.query(
        `INSERT INTO kit_productos (kit_id, producto_id, cantidad) VALUES ($1, $2, $3)`,
        [kit.id, Number(p.producto_id), Number(p.cantidad)]
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
    await cliente.query('ROLLBACK').catch(() => {});
    console.error(err);
    if (err.code === '23505') return res.status(400).json({ error: 'Ese código de barras ya está en uso' });
    res.status(500).json({ error: 'Error al crear el kit' });
  } finally {
    cliente.release();
  }
});

// Editar kit: cambia nombre, precio, foto y código, y reemplaza la lista de
// productos que incluye. Las ventas ya hechas no se afectan (cada ticket
// guarda su propio detalle).
router.put('/:id', verificarToken, requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const { nombre, precio_kit, imagen_url, codigo_barras, productos } = req.body;
    if (!nombre || !precio_kit || !Array.isArray(productos) || productos.length === 0) {
      return res.status(400).json({ error: 'Nombre, precio y al menos un producto son requeridos' });
    }
    if (!(Number(precio_kit) > 0)) return res.status(400).json({ error: 'El precio del kit debe ser mayor a 0' });
    const errorProductos = await errorEnProductosDelKit(productos, req.sucursalId);
    if (errorProductos) return res.status(400).json({ error: errorProductos });

    await cliente.query('BEGIN');

    const actual = await cliente.query(
      'SELECT * FROM kits WHERE id = $1 AND sucursal_id = $2 AND activo = true',
      [req.params.id, req.sucursalId]
    );
    if (actual.rows.length === 0) {
      await cliente.query('ROLLBACK');
      return res.status(404).json({ error: 'No existe ese kit' });
    }

    const kitResult = await cliente.query(
      `UPDATE kits SET nombre = $1, precio_kit = $2, imagen_url = $3, codigo_barras = $4
       WHERE id = $5 AND sucursal_id = $6 RETURNING *`,
      [nombre, precio_kit, imagen_url || null, codigo_barras || null, req.params.id, req.sucursalId]
    );
    const kit = kitResult.rows[0];

    await cliente.query('DELETE FROM kit_productos WHERE kit_id = $1', [kit.id]);
    for (const p of productos) {
      await cliente.query(
        `INSERT INTO kit_productos (kit_id, producto_id, cantidad) VALUES ($1, $2, $3)`,
        [kit.id, Number(p.producto_id), Number(p.cantidad)]
      );
    }

    await registrarBitacora(cliente, {
      usuario_id: req.usuario.id,
      accion: 'editar_kit',
      modulo: 'kits',
      referencia_id: kit.id,
      valor_anterior: { nombre: actual.rows[0].nombre, precio_kit: actual.rows[0].precio_kit },
      valor_nuevo: { nombre, precio_kit, num_productos: productos.length }
    });

    await cliente.query('COMMIT');
    res.json(kit);
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    console.error(err);
    if (err.code === '23505') return res.status(400).json({ error: 'Ese código de barras ya está en uso' });
    res.status(500).json({ error: 'Error al editar el kit' });
  } finally {
    cliente.release();
  }
});

// Desactivar kit
router.delete('/:id', verificarToken, requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  try {
    await pool.query('UPDATE kits SET activo = false WHERE id = $1 AND sucursal_id = $2', [req.params.id, req.sucursalId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el kit' });
  }
});

module.exports = router;
