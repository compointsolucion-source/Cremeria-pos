const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Obtener la configuración de la sucursal (crea una fila por defecto si no existe)
router.get('/', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM configuracion WHERE sucursal_id = $1', [req.usuario.sucursal_id]);
    if (result.rows.length === 0) {
      return res.json({
        sucursal_id: req.usuario.sucursal_id,
        logo_url: null,
        direccion: null,
        telefono: null,
        rfc: null,
        ancho_ticket: '80mm',
        terminos: null
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la configuración' });
  }
});

// Actualizar (o crear si no existe) la configuración
router.put('/', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    const { logo_url, direccion, telefono, rfc, ancho_ticket, terminos } = req.body;
    if (ancho_ticket && !['58mm', '80mm'].includes(ancho_ticket)) {
      return res.status(400).json({ error: 'Ancho de ticket inválido' });
    }

    const result = await pool.query(
      `INSERT INTO configuracion (sucursal_id, logo_url, direccion, telefono, rfc, ancho_ticket, terminos)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (sucursal_id) DO UPDATE SET
         logo_url = COALESCE($2, configuracion.logo_url),
         direccion = COALESCE($3, configuracion.direccion),
         telefono = COALESCE($4, configuracion.telefono),
         rfc = COALESCE($5, configuracion.rfc),
         ancho_ticket = COALESCE($6, configuracion.ancho_ticket),
         terminos = COALESCE($7, configuracion.terminos)
       RETURNING *`,
      [req.usuario.sucursal_id, logo_url || null, direccion || null, telefono || null, rfc || null, ancho_ticket || '80mm', terminos || null]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'actualizar_configuracion',
      modulo: 'configuracion',
      referencia_id: req.usuario.sucursal_id,
      valor_nuevo: { direccion, telefono, rfc, ancho_ticket, terminos } // logo_url excluido: puede pesar varios KB en base64
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la configuración' });
  }
});

module.exports = router;
