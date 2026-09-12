const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken } = require('../middleware/auth');

// Genera una nueva ficha de turno. El número reinicia cada día (busca el
// máximo número creado HOY en esta sucursal, y suma 1; si no hay ninguna
// hoy, empieza en 1).
router.post('/', verificarToken, async (req, res) => {
  try {
    const sucursalId = req.usuario.sucursal_id;
    const maxResult = await pool.query(
      `SELECT COALESCE(MAX(numero), 0) AS maximo FROM fichas
       WHERE sucursal_id = $1 AND fecha_creacion::date = CURRENT_DATE`,
      [sucursalId]
    );
    const siguienteNumero = parseInt(maxResult.rows[0].maximo) + 1;

    const result = await pool.query(
      `INSERT INTO fichas (sucursal_id, numero, estado) VALUES ($1, $2, 'esperando') RETURNING *`,
      [sucursalId, siguienteNumero]
    );

    const io = req.app.get('io');
    if (io) io.to(`sucursal_${sucursalId}`).emit('nueva_ficha', result.rows[0]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar la ficha' });
  }
});

// La ficha actualmente "llamada" (la última que se llamó) — para la pantalla
// de visualización, que la consulta al cargar por primera vez.
router.get('/actual', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM fichas WHERE sucursal_id = $1 AND estado = 'llamado'
       ORDER BY fecha_llamado DESC LIMIT 1`,
      [req.usuario.sucursal_id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la ficha actual' });
  }
});

// Últimas fichas llamadas (para el historial pequeño en la pantalla)
router.get('/recientes', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM fichas WHERE sucursal_id = $1 AND estado IN ('llamado','atendido')
       ORDER BY fecha_llamado DESC LIMIT 8`,
      [req.usuario.sucursal_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener fichas recientes' });
  }
});

// Cuántas fichas están esperando todavía (informativo, para el empleado)
router.get('/pendientes-count', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS total FROM fichas WHERE sucursal_id = $1 AND estado = 'esperando'`,
      [req.usuario.sucursal_id]
    );
    res.json({ total: parseInt(result.rows[0].total) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al contar fichas pendientes' });
  }
});

// Llama a la siguiente ficha en espera (la más antigua), y la asigna al
// mostrador que la llamó. Avisa en tiempo real a la pantalla de visualización.
router.post('/llamar-siguiente', verificarToken, async (req, res) => {
  try {
    const { mostrador } = req.body;
    if (!mostrador) return res.status(400).json({ error: 'Especifica qué mostrador está llamando' });

    const siguienteResult = await pool.query(
      `SELECT * FROM fichas WHERE sucursal_id = $1 AND estado = 'esperando'
       ORDER BY fecha_creacion ASC LIMIT 1 FOR UPDATE`,
      [req.usuario.sucursal_id]
    );
    if (siguienteResult.rows.length === 0) {
      return res.status(404).json({ error: 'No hay turnos esperando en este momento' });
    }
    const ficha = siguienteResult.rows[0];

    const result = await pool.query(
      `UPDATE fichas SET estado = 'llamado', mostrador_asignado = $1, fecha_llamado = NOW()
       WHERE id = $2 RETURNING *`,
      [mostrador, ficha.id]
    );
    const fichaLlamada = result.rows[0];

    const io = req.app.get('io');
    if (io) io.to(`sucursal_${req.usuario.sucursal_id}`).emit('ficha_llamada', fichaLlamada);

    res.json(fichaLlamada);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al llamar el siguiente turno' });
  }
});

module.exports = router;
