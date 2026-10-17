const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');
const licencia = require('../utils/licencia');

// Estado de la licencia de esta instalación (lo ve cualquier usuario que haya entrado).
router.get('/', verificarToken, async (req, res) => {
  try {
    const est = await licencia.estado();
    const limite = await licencia.limiteSucursales();
    const { serial, ...publico } = est;
    res.json({ ...publico, limite_sucursales: limite, contacto: licencia.CONTACTO });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo consultar la licencia' });
  }
});

const limitadorActivar = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos con el código. Espera unos minutos e intenta de nuevo.' }
});

// Activar con un código firmado por Compoint (funciona sin internet).
router.post('/activar', limitadorActivar, verificarToken, requiereRol('dueno', 'jefe_general'), async (req, res) => {
  const texto = String((req.body && req.body.codigo) || '');
  if (!texto.trim()) return res.status(400).json({ error: 'Pega aquí el código de activación que te mandó Compoint.' });
  if (texto.length > 4000) return res.status(400).json({ error: 'Eso es demasiado largo para ser un código de activación. Pega solo el código.' });
  try {
    const r = await licencia.activar(texto, { usuarioId: req.usuario.id });
    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'licencia_activar',
      modulo: 'licencia',
      referencia_id: null,
      valor_anterior: r.anterior && r.anterior.control ? { tipo: r.anterior.tipo, vence: r.anterior.vence, estado: r.anterior.estado } : null,
      valor_nuevo: { tipo: r.datos.tipo, plan: r.datos.plan, vence: r.datos.vence, max_sucursales: r.datos.maxSucursales, serial: r.datos.serial }
    });
    const { serial, ...publico } = r.estado;
    res.json({ ok: true, estado: publico, limite_sucursales: await licencia.limiteSucursales() });
  } catch (err) {
    if (err instanceof licencia.ErrorLicencia) return res.status(400).json({ error: err.message, motivo: err.motivo });
    console.error('Error al activar la licencia:', err.message);
    res.status(500).json({ error: 'No se pudo activar. Intenta de nuevo.' });
  }
});

module.exports = router;
