const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requierePermiso, requiereSucursalId } = require('../middleware/auth');
const { validarTurno } = require('../utils/seguridadCaja');
const { registrarBitacora } = require('../utils/bitacora');

router.use(verificarToken, requiereSucursalId);

// Registrar entrada o salida de dinero (solo en el turno ABIERTO del propio cajero, en esta sucursal).
router.post('/', requierePermiso('CAJA_MOVIMIENTO'), async (req, res) => {
  try {
    const { turno_id, tipo } = req.body || {};
    const monto = Number(req.body && req.body.monto);
    const concepto = String((req.body && req.body.concepto) || '').replace(/[<>]/g, '').trim().slice(0, 200);

    if (!turno_id || !tipo || !monto) {
      return res.status(400).json({ error: 'Turno, tipo y monto son requeridos' });
    }
    if (!['ingreso', 'egreso'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo inválido' });
    }
    if (!(Number.isFinite(monto) && monto > 0 && monto < 1e7)) {
      return res.status(400).json({ error: 'El monto debe ser mayor a cero' });
    }
    try {
      await validarTurno(pool, { turnoId: turno_id, sucursalId: req.sucursalId, usuario: req.usuario, obligatorio: true });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.error });
    }

    const result = await pool.query(
      `INSERT INTO movimientos_caja (turno_id, usuario_id, tipo, monto, concepto)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [turno_id, req.usuario.id, tipo, monto, concepto]
    );
    await registrarBitacora(pool, {
      usuario_id: req.usuario.id, accion: tipo === 'egreso' ? 'salida_caja' : 'entrada_caja', modulo: 'caja',
      referencia_id: result.rows[0].id, valor_nuevo: { turno_id: Number(turno_id), monto, concepto }
    }).catch(() => {});
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el movimiento' });
  }
});

// Movimientos de un turno (solo de esta sucursal).
router.get('/turno/:turno_id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, u.nombre AS usuario_nombre FROM movimientos_caja m
       JOIN usuarios u ON m.usuario_id = u.id
       JOIN turnos t ON t.id = m.turno_id
       WHERE m.turno_id = $1 AND t.sucursal_id = $2 ORDER BY m.fecha DESC`,
      [req.params.turno_id, req.sucursalId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener movimientos' });
  }
});

module.exports = router;
