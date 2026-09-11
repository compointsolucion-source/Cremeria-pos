const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requierePermiso } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Obtener turno abierto actual de la sucursal
router.get('/actual', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM turnos WHERE sucursal_id = $1 AND estado = 'abierto' ORDER BY fecha_apertura DESC LIMIT 1`,
      [req.usuario.sucursal_id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el turno actual' });
  }
});

// Abrir turno
router.post('/abrir', verificarToken, requierePermiso('CAJA_ABRIR'), async (req, res) => {
  try {
    const { fondo_inicial } = req.body;

    const abierto = await pool.query(
      `SELECT * FROM turnos WHERE sucursal_id = $1 AND estado = 'abierto'`,
      [req.usuario.sucursal_id]
    );
    if (abierto.rows.length > 0) {
      return res.status(400).json({ error: 'Ya hay un turno abierto en esta sucursal' });
    }

    const result = await pool.query(
      `INSERT INTO turnos (sucursal_id, usuario_id, fondo_inicial) VALUES ($1, $2, $3) RETURNING *`,
      [req.usuario.sucursal_id, req.usuario.id, fondo_inicial || 0]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'abrir_turno',
      modulo: 'turnos',
      referencia_id: result.rows[0].id,
      valor_nuevo: { fondo_inicial: fondo_inicial || 0 }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al abrir el turno' });
  }
});

// Cerrar turno (corte de caja)
router.post('/:id/cerrar', verificarToken, requierePermiso('CAJA_CERRAR'), async (req, res) => {
  try {
    const { saldo_contado } = req.body;
    const turnoId = req.params.id;

    const ventasResult = await pool.query(
      `SELECT COALESCE(SUM(monto_efectivo),0) AS efectivo, COALESCE(SUM(monto_tarjeta),0) AS tarjeta
       FROM tickets WHERE turno_id = $1 AND estado = 'pagado'`,
      [turnoId]
    );
    const movResult = await pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END),0) AS ingresos,
        COALESCE(SUM(CASE WHEN tipo = 'egreso' THEN monto ELSE 0 END),0) AS egresos
       FROM movimientos_caja WHERE turno_id = $1`,
      [turnoId]
    );

    const turnoActual = await pool.query('SELECT fondo_inicial FROM turnos WHERE id = $1', [turnoId]);
    const fondoInicial = parseFloat(turnoActual.rows[0].fondo_inicial);
    const efectivoVentas = parseFloat(ventasResult.rows[0].efectivo);
    const ingresos = parseFloat(movResult.rows[0].ingresos);
    const egresos = parseFloat(movResult.rows[0].egresos);

    const saldoTeorico = fondoInicial + efectivoVentas + ingresos - egresos;

    const result = await pool.query(
      `UPDATE turnos SET estado = 'cerrado', saldo_teorico = $1, saldo_contado = $2, fecha_cierre = NOW()
       WHERE id = $3 RETURNING *`,
      [saldoTeorico, saldo_contado, turnoId]
    );

    const diferencia = saldo_contado - saldoTeorico;
    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'cerrar_turno',
      modulo: 'turnos',
      referencia_id: parseInt(turnoId),
      valor_nuevo: { saldo_teorico: saldoTeorico, saldo_contado, diferencia }
    });

    res.json({
      ...result.rows[0],
      resumen: {
        fondo_inicial: fondoInicial,
        ventas_efectivo: efectivoVentas,
        ventas_tarjeta: parseFloat(ventasResult.rows[0].tarjeta),
        ingresos,
        egresos,
        diferencia: saldo_contado - saldoTeorico
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cerrar el turno' });
  }
});

// Historial de turnos
router.get('/historial', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, u.nombre AS usuario_nombre FROM turnos t
       JOIN usuarios u ON t.usuario_id = u.id
       WHERE t.sucursal_id = $1 ORDER BY t.fecha_apertura DESC LIMIT 50`,
      [req.usuario.sucursal_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el historial' });
  }
});

module.exports = router;
