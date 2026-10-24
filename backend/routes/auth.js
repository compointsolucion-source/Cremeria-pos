const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { verificarToken } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');
const recuperacion = require('../utils/recuperacion');
const licencia = require('../utils/licencia');

// Máximo 8 intentos de login por IP cada 15 minutos. Suficiente para que una
// persona real que se equivoca de contraseña no se quede bloqueada, pero
// frena un ataque de fuerza bruta automatizado contra el usuario Admin.
const limitadorLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Espera unos minutos e intenta de nuevo.' }
});

router.post('/login', limitadorLogin, async (req, res) => {
  try {
    const { usuario, password } = req.body;
    if (!usuario || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
    }

    const result = await pool.query(
      'SELECT * FROM usuarios WHERE usuario = $1 AND activo = true',
      [usuario]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const user = result.rows[0];
    const passwordValida = await bcrypt.compare(password, user.password_hash);

    if (!passwordValida) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    // jefe_general no pertenece a una sola sucursal (sucursal_id NULL) — para
    // el resto, si la sucursal a la que pertenecen quedó desactivada, no
    // dejamos entrar (su cuenta y su historial siguen intactos, solo no
    // pueden operar mientras esa sucursal esté pausada).
    if (user.sucursal_id) {
      const sucursal = await pool.query('SELECT activo FROM sucursales WHERE id = $1', [user.sucursal_id]);
      if (sucursal.rows.length > 0 && !sucursal.rows[0].activo) {
        return res.status(403).json({ error: 'Tu sucursal está desactivada actualmente. Contacta al dueño del negocio.' });
      }
    }

    const token = jwt.sign(
      {
        id: user.id,
        nombre: user.nombre,
        usuario: user.usuario,
        rol: user.rol,
        sucursal_id: user.sucursal_id,
        permisos: user.permisos
      },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    await registrarBitacora(pool, {
      usuario_id: user.id,
      accion: 'login',
      modulo: 'usuarios',
      referencia_id: user.id
    });

    res.json({
      token,
      usuario: {
        id: user.id,
        nombre: user.nombre,
        rol: user.rol,
        sucursal_id: user.sucursal_id,
        nombre_mostrador: user.nombre_mostrador || null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// Cambiar la propia contraseña: exige la contraseña actual para evitar que
// alguien con una sesión abierta y desatendida la cambie sin autorización.
router.put('/cambiar-password', verificarToken, async (req, res) => {
  try {
    const { password_actual, password_nueva } = req.body;
    if (!password_actual || !password_nueva) {
      return res.status(400).json({ error: 'La contraseña actual y la nueva son requeridas' });
    }
    if (password_nueva.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const result = await pool.query('SELECT * FROM usuarios WHERE id = $1', [req.usuario.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    const passwordValida = await bcrypt.compare(password_actual, result.rows[0].password_hash);
    if (!passwordValida) return res.status(400).json({ error: 'La contraseña actual es incorrecta' });

    const nuevoHash = await bcrypt.hash(password_nueva, 10);
    await pool.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [nuevoHash, req.usuario.id]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar la contraseña' });
  }
});

// Registra el cierre de sesión en la bitácora. El JWT sigue siendo válido
// hasta que expire (es stateless), esto solo deja constancia de la acción.
router.post('/logout', verificarToken, async (req, res) => {
  await registrarBitacora(pool, {
    usuario_id: req.usuario.id,
    accion: 'logout',
    modulo: 'usuarios',
    referencia_id: req.usuario.id
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Información pública para la pantalla de entrada (sin iniciar sesión):
// nombre del negocio, sucursal (si solo hay una) y estado de la licencia.
// No devuelve nada sensible (ni serial, ni usuarios).
// ---------------------------------------------------------------------------
const limitadorInfo = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas consultas. Espera un momento.' }
});

router.get('/info-login', limitadorInfo, async (req, res) => {
  const info = { negocio: null, sucursal: null, licencia: null, version: process.env.COMPOINT_VERSION || require('../package.json').version };
  try {
    const sucs = await pool.query('SELECT id, nombre FROM sucursales WHERE activo = true ORDER BY id ASC');
    if (sucs.rows.length === 1) info.sucursal = sucs.rows[0].nombre || null;
    const cfg = await pool.query(
      `SELECT nombre_negocio FROM configuracion WHERE nombre_negocio IS NOT NULL AND nombre_negocio <> ''
       ORDER BY (sucursal_id = $1) DESC NULLS LAST, id ASC LIMIT 1`,
      [sucs.rows.length ? sucs.rows[0].id : null]
    );
    if (cfg.rows.length) info.negocio = cfg.rows[0].nombre_negocio;
  } catch (err) { /* sin datos del negocio: la pantalla muestra solo lo demás */ }
  try {
    const est = await licencia.estado();
    if (est && est.control) info.licencia = { estado: est.estado, tipo: est.tipo || null, dias: est.dias == null ? null : est.dias };
  } catch (err) { /* sin licencia: no se muestra */ }
  res.json(info);
});

// ---------------------------------------------------------------------------
// Recuperar contraseña con un código que llega al correo del usuario.
//   1) solicitar  -> manda el código (15 min, 5 intentos)
//   2) verificar  -> comprueba el código (no lo gasta)
//   3) restablecer-> pone la contraseña nueva (gasta el código)
// Las respuestas de "solicitar" son iguales si el usuario no existe o no tiene
// correo, para que nadie pueda averiguar qué usuarios existen.
// ---------------------------------------------------------------------------
const limitadorPedirCodigo = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Pediste demasiados códigos. Espera unos minutos e intenta de nuevo.' }
});
const limitadorCodigo = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' }
});

const ERROR_CODIGO = 'El código no es correcto o ya venció. Pide uno nuevo.';

router.post('/recuperar/solicitar', limitadorPedirCodigo, async (req, res) => {
  try {
    const usuario = String((req.body && req.body.usuario) || '').trim();
    if (!usuario || usuario.length > 50) return res.status(400).json({ error: 'Escribe tu usuario' });

    const r = await pool.query(
      `SELECT id, nombre, correo FROM usuarios WHERE usuario = $1 AND activo = true AND eliminado_en IS NULL`, [usuario]);
    const u = r.rows[0];
    if (!u || !u.correo || !recuperacion.correoValido(u.correo)) return res.json({ ok: true, sin_correo: true });

    // Un código nuevo como máximo cada minuto por usuario.
    const reciente = await pool.query(
      `SELECT 1 FROM recuperacion_codigos WHERE usuario_id = $1 AND creado_en > NOW() - ($2 || ' seconds')::interval LIMIT 1`,
      [u.id, String(recuperacion.ESPERA_ENTRE_ENVIOS_SEG)]);
    if (reciente.rows.length) {
      return res.status(429).json({ error: 'Ya te enviamos un código hace un momento. Espera un minuto para pedir otro.' });
    }

    const codigo = recuperacion.generarCodigo();
    await pool.query('UPDATE recuperacion_codigos SET usado = true WHERE usuario_id = $1 AND usado = false', [u.id]);
    const ins = await pool.query(
      `INSERT INTO recuperacion_codigos (usuario_id, codigo_hash, expira_en)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval) RETURNING id`,
      [u.id, recuperacion.huella(codigo, u.id), String(recuperacion.MINUTOS_VIGENCIA)]);

    let negocio = '';
    try {
      const c = await pool.query(`SELECT nombre_negocio FROM configuracion WHERE nombre_negocio IS NOT NULL AND nombre_negocio <> '' ORDER BY id ASC LIMIT 1`);
      if (c.rows.length) negocio = c.rows[0].nombre_negocio;
    } catch (e) { /* sin nombre de negocio */ }

    const envio = await recuperacion.enviarCodigo({ correo: u.correo, codigo, nombre: u.nombre, negocio });
    if (!envio.ok) {
      await pool.query('UPDATE recuperacion_codigos SET usado = true WHERE id = $1', [ins.rows[0].id]);
      return res.status(502).json({ error: envio.error });
    }
    res.json({ ok: true, enviado: true, correo: recuperacion.enmascarar(u.correo), minutos: recuperacion.MINUTOS_VIGENCIA });
  } catch (err) {
    console.error('Recuperar contraseña (solicitar):', err.message);
    res.status(500).json({ error: 'No se pudo enviar el código. Intenta de nuevo.' });
  }
});

// Revisa el código contra el más reciente vigente. Cuenta el intento; a los 5 fallos se anula.
// Devuelve { fila, usuario } si es correcto, o null.
async function comprobarCodigo(usuario, codigo) {
  const u = (await pool.query(
    `SELECT id FROM usuarios WHERE usuario = $1 AND activo = true AND eliminado_en IS NULL`, [usuario])).rows[0];
  if (!u || !/^\d{6}$/.test(String(codigo || '').trim())) return null;
  const fila = (await pool.query(
    `SELECT * FROM recuperacion_codigos WHERE usuario_id = $1 AND usado = false AND expira_en > NOW()
     ORDER BY creado_en DESC LIMIT 1`, [u.id])).rows[0];
  if (!fila) return null;
  if (fila.intentos >= recuperacion.MAX_INTENTOS) return null;
  if (!recuperacion.huellaCoincide(fila.codigo_hash, codigo, u.id)) {
    await pool.query(
      `UPDATE recuperacion_codigos SET intentos = intentos + 1, usado = (intentos + 1 >= $2) WHERE id = $1`,
      [fila.id, recuperacion.MAX_INTENTOS]);
    return null;
  }
  return { fila, usuarioId: u.id };
}

router.post('/recuperar/verificar', limitadorCodigo, async (req, res) => {
  try {
    const usuario = String((req.body && req.body.usuario) || '').trim();
    const ok = await comprobarCodigo(usuario, req.body && req.body.codigo);
    if (!ok) return res.status(400).json({ error: ERROR_CODIGO });
    res.json({ ok: true });
  } catch (err) {
    console.error('Recuperar contraseña (verificar):', err.message);
    res.status(500).json({ error: 'No se pudo comprobar el código. Intenta de nuevo.' });
  }
});

router.post('/recuperar/restablecer', limitadorCodigo, async (req, res) => {
  try {
    const usuario = String((req.body && req.body.usuario) || '').trim();
    const nueva = String((req.body && req.body.password_nueva) || '');
    if (nueva.length < 6) return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 6 caracteres' });
    if (nueva.length > 100) return res.status(400).json({ error: 'La contraseña es demasiado larga' });

    const ok = await comprobarCodigo(usuario, req.body && req.body.codigo);
    if (!ok) return res.status(400).json({ error: ERROR_CODIGO });

    const hash = await bcrypt.hash(nueva, 10);
    await pool.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [hash, ok.usuarioId]);
    await pool.query('UPDATE recuperacion_codigos SET usado = true WHERE usuario_id = $1', [ok.usuarioId]);
    await registrarBitacora(pool, { usuario_id: ok.usuarioId, accion: 'recuperar_password', modulo: 'usuarios', referencia_id: ok.usuarioId });
    res.json({ ok: true });
  } catch (err) {
    console.error('Recuperar contraseña (restablecer):', err.message);
    res.status(500).json({ error: 'No se pudo cambiar la contraseña. Intenta de nuevo.' });
  }
});

// Correo propio para recuperar la contraseña (cada quien el suyo; pide la contraseña actual).
router.get('/mi-correo', verificarToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT correo FROM usuarios WHERE id = $1', [req.usuario.id]);
    res.json({ correo: (r.rows[0] && r.rows[0].correo) || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo consultar tu correo' });
  }
});

router.put('/mi-correo', verificarToken, async (req, res) => {
  try {
    const { password_actual } = req.body || {};
    const correo = String((req.body && req.body.correo) || '').trim().toLowerCase();
    if (!password_actual) return res.status(400).json({ error: 'Escribe tu contraseña actual para guardar el correo' });
    if (correo && !recuperacion.correoValido(correo)) return res.status(400).json({ error: 'Ese correo no parece válido. Revísalo (ejemplo: nombre@correo.com).' });
    const r = await pool.query('SELECT password_hash FROM usuarios WHERE id = $1', [req.usuario.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!(await bcrypt.compare(password_actual, r.rows[0].password_hash))) return res.status(400).json({ error: 'La contraseña actual es incorrecta' });
    await pool.query('UPDATE usuarios SET correo = $1 WHERE id = $2', [correo || null, req.usuario.id]);
    await registrarBitacora(pool, { usuario_id: req.usuario.id, accion: 'cambiar_correo_recuperacion', modulo: 'usuarios', referencia_id: req.usuario.id });
    res.json({ ok: true, correo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo guardar el correo' });
  }
});

module.exports = router;
