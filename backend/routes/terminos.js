// Aceptación de los Términos y condiciones dentro del sistema.
//   GET  /api/terminos/estado   -> versión vigente, si este negocio ya la aceptó y el resumen a mostrar
//   POST /api/terminos/aceptar  -> el dueño (o jefe general) acepta la versión vigente
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');
const T = require('../utils/terminos');

const corto = (v, max) => String(v == null ? '' : v).slice(0, max);
// IP según Express (respeta la regla de proxy de server.js; no se puede inventar con un encabezado).
const ipDe = (req) => corto(req.ip || '', 60);

async function ultimaAceptacion() {
  const r = await pool.query(
    'SELECT usuario_nombre, creado_en FROM terminos_aceptaciones WHERE version = $1 ORDER BY creado_en DESC LIMIT 1', [T.VERSION]);
  return r.rows[0] || null;
}

router.get('/estado', verificarToken, async (req, res) => {
  try {
    const a = await ultimaAceptacion();
    res.json({
      version: T.VERSION,
      aceptado: !!a,
      aceptado_por: a ? a.usuario_nombre : null,
      aceptado_en: a ? a.creado_en : null,
      puede_aceptar: T.ROLES_QUE_ACEPTAN.includes(req.usuario.rol),
      resumen: T.RESUMEN,
      texto_acepto: T.ACEPTO,
      url_completos: T.URL_COMPLETOS,
      url_privacidad: T.URL_PRIVACIDAD
    });
  } catch (err) {
    // Si la tabla aún no existe o la base falla, no se bloquea a nadie.
    console.error('terminos/estado:', err.message);
    res.json({ version: T.VERSION, aceptado: true, sin_dato: true });
  }
});

router.post('/aceptar', verificarToken, async (req, res) => {
  if (!T.ROLES_QUE_ACEPTAN.includes(req.usuario.rol)) {
    return res.status(403).json({ error: 'Solo el dueño del negocio puede aceptar los términos.' });
  }
  const b = req.body || {};
  if (b.acepto !== true) return res.status(400).json({ error: 'Marca la casilla de "Acepto" para continuar.' });
  if (b.version !== T.VERSION) {
    return res.status(409).json({ error: 'Los términos se actualizaron. Recarga la pantalla para ver la versión nueva.', version: T.VERSION });
  }
  try {
    const previa = await ultimaAceptacion();
    if (previa) return res.json({ ok: true, ya_estaba: true, version: T.VERSION });
    const nombre = corto(req.usuario.nombre || req.usuario.usuario, 120);
    const r = await pool.query(
      `INSERT INTO terminos_aceptaciones (version, huella, usuario_id, usuario_nombre, usuario_rol, ip, navegador, medio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, creado_en`,
      [T.VERSION, T.huella(), req.usuario.id, nombre, req.usuario.rol, ipDe(req), corto(req.headers['user-agent'], 300),
       process.env.COMPOINT_ID_EQUIPO ? 'programa' : 'nube']);
    await registrarBitacora(pool, {
      usuario_id: req.usuario.id, accion: 'terminos_aceptar', modulo: 'terminos', referencia_id: r.rows[0].id,
      valor_anterior: null, valor_nuevo: { version: T.VERSION, huella: T.huella() }
    }).catch(() => {});
    res.json({ ok: true, version: T.VERSION, aceptado_en: r.rows[0].creado_en });
  } catch (err) {
    console.error('terminos/aceptar:', err.message);
    res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
  }
});

module.exports = router;
