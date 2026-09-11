const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');

// Solo dueño/gerente pueden ver la bitácora completa
router.get('/', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    const { modulo, usuario_id, desde, hasta } = req.query;
    const condiciones = [`u.sucursal_id = $1`];
    const valores = [req.usuario.sucursal_id];
    let contador = 1;

    if (modulo) { contador++; condiciones.push(`b.modulo = $${contador}`); valores.push(modulo); }
    if (usuario_id) { contador++; condiciones.push(`b.usuario_id = $${contador}`); valores.push(usuario_id); }
    if (desde) { contador++; condiciones.push(`b.fecha >= $${contador}`); valores.push(desde); }
    if (hasta) { contador++; condiciones.push(`b.fecha <= $${contador}`); valores.push(hasta); }

    const result = await pool.query(
      `SELECT b.*, u.nombre AS usuario_nombre
       FROM bitacora b JOIN usuarios u ON b.usuario_id = u.id
       WHERE ${condiciones.join(' AND ')}
       ORDER BY b.fecha DESC LIMIT 200`,
      valores
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la bitácora' });
  }
});

module.exports = router;
