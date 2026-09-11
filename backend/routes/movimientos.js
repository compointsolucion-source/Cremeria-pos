const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requierePermiso } = require('../middleware/auth');

// Registrar entrada o salida de dinero
router.post('/', verificarToken, requierePermiso('CAJA_MOVIMIENTO'), async (req, res) => {
  try {
    const { turno_id, tipo, monto, concepto } = req.body;

    if (!turno_id || !tipo || !monto) {
      return res.status(400).json({ error: 'Turno, tipo y monto son requeridos' });
    }
    if (!['ingreso', 'egreso'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo inválido' });
    }

    const result = await pool.query(
      `INSERT INTO movimientos_caja (turno_id, usuario_id, tipo, monto, concepto)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [turno_id, req.usuario.id, tipo, monto, concepto || '']
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el movimiento' });
  }
});

// Movimientos del turno actual
router.get('/turno/:turno_id', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, u.nombre AS usuario_nombre FROM movimientos_caja m
       JOIN usuarios u ON m.usuario_id = u.id
       WHERE m.turno_id = $1 ORDER BY m.fecha DESC`,
      [req.params.turno_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener movimientos' });
  }
});

module.exports = router;
