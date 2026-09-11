const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol, requierePermiso } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Listar clientes. Soporta paginación opcional con ?limit=&offset=
router.get('/', verificarToken, async (req, res) => {
  try {
    const { limit, offset } = req.query;
    let query = 'SELECT * FROM clientes WHERE sucursal_id = $1 AND activo = true ORDER BY nombre ASC';
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
        'SELECT COUNT(*) FROM clientes WHERE sucursal_id = $1 AND activo = true',
        [req.usuario.sucursal_id]
      );
      res.json({ clientes: result.rows, total: parseInt(totalResult.rows[0].count) });
    } else {
      res.json(result.rows);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

// Buscar clientes por nombre (para el selector de Fiado en caja)
router.get('/buscar/:texto', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM clientes WHERE sucursal_id = $1 AND activo = true AND nombre ILIKE $2 ORDER BY nombre ASC LIMIT 10`,
      [req.usuario.sucursal_id, `%${req.params.texto}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar clientes' });
  }
});

// Crear cliente
router.post('/', verificarToken, requierePermiso('CLIENTES_CREAR'), async (req, res) => {
  try {
    const { nombre, telefono, limite_credito } = req.body;
    if (!nombre) return res.status(400).json({ error: 'El nombre es requerido' });

    const result = await pool.query(
      `INSERT INTO clientes (sucursal_id, nombre, telefono, limite_credito) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.usuario.sucursal_id, nombre, telefono || null, limite_credito || 0]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'crear_cliente',
      modulo: 'clientes',
      referencia_id: result.rows[0].id,
      valor_nuevo: { nombre, telefono, limite_credito: limite_credito || 0 }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear cliente' });
  }
});

// Editar cliente (nombre, teléfono, límite)
router.put('/:id', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    const { nombre, telefono, limite_credito, activo } = req.body;
    const result = await pool.query(
      `UPDATE clientes SET
        nombre = COALESCE($1, nombre),
        telefono = COALESCE($2, telefono),
        limite_credito = COALESCE($3, limite_credito),
        activo = COALESCE($4, activo)
       WHERE id = $5 AND sucursal_id = $6 RETURNING *`,
      [nombre, telefono, limite_credito, activo, req.params.id, req.usuario.sucursal_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar cliente' });
  }
});

// Estado de cuenta: cargos y abonos de un cliente
router.get('/:id/estado-cuenta', verificarToken, async (req, res) => {
  try {
    const cliente = await pool.query('SELECT * FROM clientes WHERE id = $1 AND sucursal_id = $2', [req.params.id, req.usuario.sucursal_id]);
    if (cliente.rows.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });

    const cargos = await pool.query(
      `SELECT cc.*, t.folio FROM creditos_cargo cc JOIN tickets t ON cc.ticket_id = t.id
       WHERE cc.cliente_id = $1 ORDER BY cc.fecha DESC`,
      [req.params.id]
    );
    const abonos = await pool.query(
      'SELECT * FROM creditos_abono WHERE cliente_id = $1 ORDER BY fecha DESC',
      [req.params.id]
    );

    res.json({ cliente: cliente.rows[0], cargos: cargos.rows, abonos: abonos.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el estado de cuenta' });
  }
});

// Registrar un abono (pago a cuenta)
router.post('/:id/abono', verificarToken, requierePermiso('CREDITO_ABONO'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const { monto, metodo_pago, turno_id } = req.body;
    if (!monto || monto <= 0) return res.status(400).json({ error: 'Monto inválido' });

    await cliente.query('BEGIN');

    await cliente.query(
      `INSERT INTO creditos_abono (cliente_id, monto, metodo_pago, turno_id, recibido_por)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, monto, metodo_pago || 'efectivo', turno_id || null, req.usuario.id]
    );

    const result = await cliente.query(
      `UPDATE clientes SET saldo_actual = saldo_actual - $1 WHERE id = $2 RETURNING *`,
      [monto, req.params.id]
    );

    await cliente.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el abono' });
  } finally {
    cliente.release();
  }
});

module.exports = router;
