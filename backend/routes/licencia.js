const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');
const licencia = require('../utils/licencia');
const sol = require('../utils/licenciaSolicitud');
const envio = require('../utils/licenciaEnvio');

const ROLES_NEGOCIO = ['dueno', 'jefe_general', 'gerente'];
const WHATSAPP_COMPOINT = '523325907090';
const VERSION_APP = process.env.COMPOINT_VERSION || require('../package.json').version;
const origenInstalacion = () => (process.env.COMPOINT_ID_EQUIPO ? 'local' : 'nube');

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

// ---------------------------------------------------------------------------
// Datos del negocio (para agilizar el registro) y solicitud de licencia
// ---------------------------------------------------------------------------
const vacio = (v) => v == null || String(v).trim() === '';

async function leerDatosNegocio() {
  const r = await pool.query(`SELECT *, to_char(bienvenida_vista_en,'YYYY-MM-DD') AS vista FROM datos_negocio WHERE id = 1`);
  return r.rows[0] || null;
}

function datosDeFila(fila) {
  const d = {};
  for (const c of sol.CAMPOS) d[c] = (fila && fila[c]) || '';
  d.sucursales = fila && fila.sucursales ? fila.sucursales : null;
  return d;
}

// Lo que el sistema ya sabe (encabezado del ticket, sucursales) para no hacer escribir dos veces.
async function sugerencias(sucursalId) {
  const s = {};
  try {
    if (sucursalId) {
      const c = (await pool.query('SELECT nombre_negocio, direccion, telefono, rfc FROM configuracion WHERE sucursal_id = $1', [sucursalId])).rows[0];
      if (c) {
        if (!vacio(c.nombre_negocio)) s.negocio = c.nombre_negocio;
        if (!vacio(c.direccion)) s.direccion = c.direccion;
        if (!vacio(c.telefono)) s.telefono = c.telefono;
        if (!vacio(c.rfc)) s.rfc = c.rfc;
      }
    }
    const n = (await pool.query('SELECT COUNT(*)::int AS n FROM sucursales WHERE activo IS NOT FALSE')).rows[0];
    if (n && n.n > 0) s.sucursales = n.n;
  } catch (e) { /* sin sugerencias */ }
  return s;
}

function sucursalDeLaPeticion(req) {
  if (req.usuario && req.usuario.sucursal_id) return req.usuario.sucursal_id;
  const n = parseInt(req.query.sucursal_id || req.headers['x-sucursal-id'], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Guarda los datos tal como llegan (la pantalla manda todo el formulario). Devuelve la fila resultante.
async function guardarDatosNegocio(d, extra = {}) {
  const cols = [...sol.CAMPOS, 'sucursales'];
  const valores = cols.map((c) => (d[c] === '' ? null : d[c]));
  const completado = sol.datosCompletos(d);
  const sets = cols.map((c, i) => `${c} = $${i + 2}`);
  sets.push(`completado = $${cols.length + 2}`, 'actualizado_en = NOW()');
  const r = await pool.query(
    `INSERT INTO datos_negocio (id, ${cols.join(', ')}, completado)
     VALUES ($1, ${cols.map((_, i) => '$' + (i + 2)).join(', ')}, $${cols.length + 2})
     ON CONFLICT (id) DO UPDATE SET ${sets.join(', ')}
     RETURNING *`, [1, ...valores, completado]);
  if (extra.acepto) {
    const u = await pool.query(
      'UPDATE datos_negocio SET acepto_privacidad_en = NOW(), version_aviso = $1 WHERE id = 1 RETURNING *', [sol.VERSION_AVISO]);
    return u.rows[0];
  }
  return r.rows[0];
}

// Llena el encabezado del ticket con los datos del negocio, SOLO donde todavía estaba vacío.
async function aplicarATicket(sucursalId, d) {
  if (!sucursalId) return [];
  const actual = (await pool.query('SELECT nombre_negocio, direccion, telefono, rfc FROM configuracion WHERE sucursal_id = $1', [sucursalId])).rows[0] || {};
  const nuevo = {};
  const dir = [d.direccion, d.ciudad, d.estado].filter(Boolean).join(', ');
  if (actual.nombre_negocio == null && d.negocio) nuevo.nombre_negocio = d.negocio.slice(0, 60);
  if (vacio(actual.direccion) && dir) nuevo.direccion = dir;
  if (vacio(actual.telefono) && (d.telefono || d.whatsapp)) nuevo.telefono = (d.telefono || d.whatsapp).slice(0, 20);
  if (vacio(actual.rfc) && d.rfc) nuevo.rfc = d.rfc.slice(0, 20);
  const campos = Object.keys(nuevo);
  if (!campos.length) return [];
  await pool.query(
    `INSERT INTO configuracion (sucursal_id, ${campos.join(', ')})
     VALUES ($1, ${campos.map((_, i) => '$' + (i + 2)).join(', ')})
     ON CONFLICT (sucursal_id) DO UPDATE SET ${campos.map((c, i) => `${c} = $${i + 2}`).join(', ')}`,
    [sucursalId, ...campos.map((c) => nuevo[c])]);
  return campos;
}

// Ver los datos del negocio + si toca mostrar la bienvenida del demo.
router.get('/datos', verificarToken, requiereRol(...ROLES_NEGOCIO), async (req, res) => {
  try {
    const fila = await leerDatosNegocio();
    const est = await licencia.estado();
    const datos = datosDeFila(fila);
    const sug = await sugerencias(sucursalDeLaPeticion(req));
    const completado = !!(fila && fila.completado);
    // La bienvenida: solo en la prueba, mientras falten los datos y sin repetir más de 1 vez cada 2 días.
    const hoy = licencia.hoy();
    const vista = fila && fila.vista;
    const mostrar = !!(est.control && est.estado === 'demo' && !completado && (!vista || licencia.diferenciaDias(hoy, vista) >= 2));
    res.json({
      datos, sugerencias: sug, completado, mostrar_bienvenida: mostrar,
      acepto_privacidad: !!(fila && fila.acepto_privacidad_en),
      aviso_version: sol.VERSION_AVISO,
      dias_prueba: est.control && est.estado === 'demo' ? est.dias : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron consultar los datos del negocio' });
  }
});

// Guardar los datos del negocio (solo se quedan en este sistema; no se mandan a nadie).
router.put('/datos', verificarToken, requiereRol(...ROLES_NEGOCIO), async (req, res) => {
  try {
    const { ok, datos, errores } = sol.normalizarDatos(req.body && req.body.datos);
    if (!ok) return res.status(400).json({ error: Object.values(errores)[0], campos: errores });
    const fila = await guardarDatosNegocio(datos);
    let aplicado = [];
    if (req.body && req.body.aplicar_ticket) aplicado = await aplicarATicket(sucursalDeLaPeticion(req), datos);
    await registrarBitacora(pool, {
      usuario_id: req.usuario.id, accion: 'licencia_datos_negocio', modulo: 'licencia', referencia_id: null,
      valor_nuevo: { completado: fila.completado, ticket: aplicado }
    });
    res.json({ ok: true, datos: datosDeFila(fila), completado: fila.completado, ticket_aplicado: aplicado });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron guardar los datos del negocio' });
  }
});

// "Más tarde" en la bienvenida: no se vuelve a mostrar en 2 días.
router.post('/datos/despues', verificarToken, requiereRol(...ROLES_NEGOCIO), async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO datos_negocio (id, bienvenida_vista_en) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET bienvenida_vista_en = EXCLUDED.bienvenida_vista_en`, [licencia.hoy()]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo guardar' });
  }
});

// ----- solicitud de licencia -----
function armarRespuestaSolicitud(fila) {
  const lectura = sol.leerCodigo(fila.codigo);
  const d = lectura.ok ? lectura.datos : {};
  const base = { tipo: fila.tipo, plan: fila.plan, sucursales: fila.sucursales, idEquipo: d.id_equipo || '', datos: d.negocio || {}, nota: d.nota || '', fecha: d.fecha || '', codigo: fila.codigo };
  const mensaje = sol.mensajeWhatsApp(base);
  return {
    id: fila.id,
    estado: fila.estado,                       // pendiente | enviada | rechazada | vencida
    tipo: fila.tipo, plan: fila.plan, sucursales: fila.sucursales,
    creada_en: fila.creada_en, enviada_en: fila.enviada_en,
    intentos: fila.intentos, error: fila.ultimo_error || null,
    correo_destino: envio.CORREO_DESTINO,
    codigo: fila.codigo,
    texto_whatsapp: mensaje,
    whatsapp_url: `https://wa.me/${WHATSAPP_COMPOINT}?text=${encodeURIComponent(mensaje)}`,
    texto_completo: sol.textoCompleto(base)
  };
}

const limitadorSolicitud = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Ya enviaste varias solicitudes. Espera un rato o comunícate por WhatsApp con Compoint.' }
});

// Pedir contratar o renovar: guarda los datos, arma el código de solicitud y lo manda por correo.
router.post('/solicitud', limitadorSolicitud, verificarToken, requiereRol(...ROLES_NEGOCIO), async (req, res) => {
  try {
    const b = req.body || {};
    if (!['local', 'nube'].includes(b.plan)) return res.status(400).json({ error: 'Elige si quieres el plan sin nube o con nube.' });
    if (b.acepto_privacidad !== true) return res.status(400).json({ error: 'Marca la casilla del aviso de privacidad para poder enviar tus datos a Compoint.' });
    const { ok, datos, errores } = sol.normalizarDatos(b.datos, { contratar: true });
    if (!ok) return res.status(400).json({ error: Object.values(errores)[0], campos: errores });
    const sucursales = Number(b.sucursales || datos.sucursales || 1);
    if (!Number.isInteger(sucursales) || sucursales < 1 || sucursales > 50) return res.status(400).json({ error: 'Las sucursales deben ser un número entre 1 y 50.' });
    datos.sucursales = sucursales;

    const est = await licencia.estado();
    const tipo = est.control && est.tipo !== 'demo' ? 'renovar' : 'contratar';
    const codigo = sol.construirCodigo({
      tipo, plan: b.plan, sucursales, idEquipo: est.id_equipo, datos, nota: b.nota,
      fecha: licencia.hoy(), app: VERSION_APP,
      pruebaDiasRestantes: est.control && est.tipo === 'demo' && est.dias != null ? Math.max(0, est.dias) : null
    });

    await guardarDatosNegocio(datos, { acepto: true });
    let aplicado = [];
    if (b.aplicar_ticket) aplicado = await aplicarATicket(sucursalDeLaPeticion(req), datos);

    await pool.query(`UPDATE licencia_solicitud SET estado = 'reemplazada' WHERE estado = 'pendiente'`);
    const ins = await pool.query(
      `INSERT INTO licencia_solicitud (tipo, plan, sucursales, codigo) VALUES ($1, $2, $3, $4) RETURNING *`,
      [tipo, b.plan, sucursales, codigo]);
    const fila = ins.rows[0];
    await registrarBitacora(pool, {
      usuario_id: req.usuario.id, accion: 'licencia_solicitud', modulo: 'licencia', referencia_id: fila.id,
      valor_nuevo: { tipo, plan: b.plan, sucursales }
    });

    // El envío ocurre aparte: la pantalla recibe la respuesta de inmediato y consulta cómo va.
    setImmediate(() => { envio.enviarUna(fila.id, { origen: origenInstalacion() }).catch((e) => console.error('Solicitud: error al enviar:', e.message)); });

    res.json({ ok: true, solicitud: armarRespuestaSolicitud(fila), ticket_aplicado: aplicado });
  } catch (err) {
    console.error('Error al crear la solicitud de licencia:', err.message);
    res.status(500).json({ error: 'No se pudo preparar tu solicitud. Intenta de nuevo.' });
  }
});

// Última solicitud y cómo va su envío (si sigue pendiente, aprovecha para reintentar).
router.get('/solicitud', verificarToken, requiereRol(...ROLES_NEGOCIO), async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM licencia_solicitud WHERE estado <> 'reemplazada' ORDER BY id DESC LIMIT 1`);
    const fila = r.rows[0];
    if (!fila) return res.json({ solicitud: null });
    if (fila.estado === 'pendiente') {
      const ultimo = fila.ultimo_intento ? new Date(fila.ultimo_intento).getTime() : 0;
      if (Date.now() - ultimo > 60 * 1000) setImmediate(() => { envio.procesarPendientes({ forzar: true, origen: origenInstalacion() }).catch(() => {}); });
    }
    res.json({ solicitud: armarRespuestaSolicitud(fila) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo consultar la solicitud' });
  }
});

// Reintentar ahora (botón "Reintentar envío").
router.post('/solicitud/reintentar', limitadorSolicitud, verificarToken, requiereRol(...ROLES_NEGOCIO), async (req, res) => {
  try {
    await envio.procesarPendientes({ forzar: true, origen: origenInstalacion() });
    const r = await pool.query(`SELECT * FROM licencia_solicitud WHERE estado <> 'reemplazada' ORDER BY id DESC LIMIT 1`);
    res.json({ solicitud: r.rows[0] ? armarRespuestaSolicitud(r.rows[0]) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo reintentar' });
  }
});

module.exports = router;
