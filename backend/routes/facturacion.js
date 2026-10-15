const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol, requiereSucursalId } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');
const { REGIMENES, USOS_CFDI } = require('../utils/catalogosSat');

const MAX_ARCHIVO_BYTES = 3 * 1024 * 1024; // 3 MB por constancia

const limite = (minutos, max, mensaje) => rateLimit({
  windowMs: minutos * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
  message: { error: mensaje }
});
const limitadorValidar = limite(15, 40, 'Demasiados intentos. Espera unos minutos e intenta de nuevo.');
const limitadorSolicitar = limite(60, 10, 'Demasiadas solicitudes desde este dispositivo. Intenta más tarde.');
const limitadorEstado = limite(15, 30, 'Demasiadas consultas. Espera unos minutos e intenta de nuevo.');

const MENSAJE_NO_ENCONTRADO = 'No encontramos un ticket pagado con ese folio y total. Revisa que coincidan exactamente con tu ticket.';

async function configuracionDeSucursal(sucursalId) {
  const r = await pool.query(
    `SELECT facturacion_activa, facturacion_dias_limite, tarjeta_comision_porcentaje FROM configuracion WHERE sucursal_id = $1`,
    [sucursalId]
  );
  const c = r.rows[0] || {};
  return {
    activa: c.facturacion_activa !== false,
    diasLimite: c.facturacion_dias_limite === undefined || c.facturacion_dias_limite === null ? 30 : Number(c.facturacion_dias_limite),
    comision: Number(c.tarjeta_comision_porcentaje || 0)
  };
}

// Busca un ticket PAGADO por folio y total (el total funciona como segundo
// dato de verificación: solo quien tiene el ticket en la mano lo conoce).
async function buscarTicketPagado(folio, total) {
  const r = await pool.query(
    `SELECT id, folio, total, metodo_pago, fecha_pago, sucursal_id FROM tickets
     WHERE (UPPER(folio) = $1 OR REGEXP_REPLACE(UPPER(folio), '[^A-Z0-9]', '', 'g') = $2) AND estado = 'pagado'
     ORDER BY fecha_pago DESC NULLS LAST LIMIT 5`,
    [String(folio).trim().toUpperCase(), String(folio).toUpperCase().replace(/[^A-Z0-9]/g, '')]
  );
  for (const t of r.rows) {
    const cfg = await configuracionDeSucursal(t.sucursal_id);
    const validos = [Number(t.total)];
    // El comprobante de tarjeta puede imprimirse con la comisión incluida.
    if (t.metodo_pago === 'tarjeta' && cfg.comision > 0) validos.push(Number(t.total) * (1 + cfg.comision / 100));
    if (validos.some(v => Math.abs(v - total) < 0.015)) return { ticket: t, cfg };
  }
  return null;
}

function revisarVigencia(ticket, cfg) {
  if (!cfg.activa) return 'La facturación en línea no está disponible por el momento. Pídela directamente en el negocio.';
  if (cfg.diasLimite > 0 && ticket.fecha_pago) {
    const dias = (Date.now() - new Date(ticket.fecha_pago).getTime()) / 86400000;
    if (dias > cfg.diasLimite) return `Ya pasó el plazo para facturar este ticket (${cfg.diasLimite} días). Comunícate con el negocio.`;
  }
  return null;
}

function leerTotal(v) {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Convierte la constancia (base64) en bytes, validando tamaño y tipo real por contenido.
function procesarConstancia(c) {
  if (!c || !c.base64) return { ok: true, vacia: true };
  const limpio = String(c.base64).replace(/^data:[^;]*;base64,/, '');
  const datos = Buffer.from(limpio, 'base64');
  if (datos.length === 0) return { ok: false, error: 'El archivo de la constancia está vacío' };
  if (datos.length > MAX_ARCHIVO_BYTES) return { ok: false, error: 'La constancia pesa más de 3 MB. Sube un archivo más ligero.' };
  let tipo = null;
  if (datos.slice(0, 4).toString('latin1') === '%PDF') tipo = 'application/pdf';
  else if (datos[0] === 0xFF && datos[1] === 0xD8 && datos[2] === 0xFF) tipo = 'image/jpeg';
  else if (datos.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]))) tipo = 'image/png';
  if (!tipo) return { ok: false, error: 'La constancia debe ser un PDF, JPG o PNG' };
  const nombre = String(c.nombre || 'constancia').replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 120);
  return { ok: true, datos, tipo, nombre };
}

// ===================== RUTAS PÚBLICAS (el cliente, sin iniciar sesión) =====================

router.get('/publico/catalogos', (req, res) => {
  res.json({ regimenes: REGIMENES, usos: USOS_CFDI });
});

// Paso 1: ¿el folio y el total corresponden a un ticket pagado y facturable?
router.post('/publico/validar', limitadorValidar, async (req, res) => {
  try {
    const total = leerTotal(req.body.total);
    const folio = String(req.body.folio || '').trim();
    if (!folio || !total) return res.status(400).json({ error: 'Escribe el folio y el total de tu ticket' });

    const hallado = await buscarTicketPagado(folio, total);
    if (!hallado) return res.status(404).json({ error: MENSAJE_NO_ENCONTRADO });

    const motivo = revisarVigencia(hallado.ticket, hallado.cfg);
    if (motivo) return res.status(403).json({ error: motivo });

    const previa = await pool.query(
      `SELECT estado FROM facturacion_solicitudes WHERE ticket_id = $1 AND estado <> 'rechazada' LIMIT 1`,
      [hallado.ticket.id]
    );
    if (previa.rows.length) {
      return res.status(409).json({ error: previa.rows[0].estado === 'facturada'
        ? 'Este ticket ya fue facturado. Revisa tu correo.'
        : 'Ya recibimos tu solicitud de factura para este ticket. Estamos trabajando en ella.' });
    }
    res.json({ ok: true, folio: hallado.ticket.folio, total: Number(hallado.ticket.total), fecha_pago: hallado.ticket.fecha_pago });
  } catch (err) {
    console.error('facturacion/validar:', err.message);
    res.status(500).json({ error: 'No se pudo revisar el ticket. Intenta de nuevo.' });
  }
});

// Paso 2: guardar la solicitud con los datos fiscales y la constancia.
router.post('/publico/solicitar', limitadorSolicitar, async (req, res) => {
  try {
    const b = req.body || {};
    const total = leerTotal(b.total);
    const folio = String(b.folio || '').trim();
    if (!folio || !total) return res.status(400).json({ error: 'Faltan el folio y el total del ticket' });

    const rfc = String(b.rfc || '').trim().toUpperCase();
    const razon = String(b.razon_social || '').trim().replace(/\s+/g, ' ');
    const regimen = String(b.regimen_fiscal || '').trim();
    const cp = String(b.codigo_postal || '').trim();
    const uso = String(b.uso_cfdi || '').trim().toUpperCase();
    const correo = String(b.correo || '').trim();
    const telefono = String(b.telefono || '').trim();

    if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) return res.status(400).json({ error: 'El RFC no es válido (12 o 13 caracteres, sin espacios)' });
    if (razon.length < 3 || razon.length > 200) return res.status(400).json({ error: 'Escribe tu nombre o razón social tal como aparece en tu constancia' });
    if (!REGIMENES[regimen]) return res.status(400).json({ error: 'Elige tu régimen fiscal' });
    if (!/^\d{5}$/.test(cp)) return res.status(400).json({ error: 'El código postal fiscal debe tener 5 números' });
    if (!USOS_CFDI[uso]) return res.status(400).json({ error: 'Elige el uso de la factura' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo) || correo.length > 150) return res.status(400).json({ error: 'El correo no es válido' });
    if (telefono.length > 20) return res.status(400).json({ error: 'El teléfono es muy largo' });

    const archivo = procesarConstancia(b.constancia);
    if (!archivo.ok) return res.status(400).json({ error: archivo.error });

    const hallado = await buscarTicketPagado(folio, total);
    if (!hallado) return res.status(404).json({ error: MENSAJE_NO_ENCONTRADO });
    const motivo = revisarVigencia(hallado.ticket, hallado.cfg);
    if (motivo) return res.status(403).json({ error: motivo });

    const t = hallado.ticket;
    try {
      const r = await pool.query(
        `INSERT INTO facturacion_solicitudes
           (ticket_id, sucursal_id, folio, total, rfc, razon_social, regimen_fiscal, codigo_postal, uso_cfdi, correo, telefono,
            constancia_nombre, constancia_tipo, constancia_datos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, creado_en`,
        [t.id, t.sucursal_id, t.folio, t.total, rfc, razon, regimen, cp, uso, correo, telefono || null,
         archivo.vacia ? null : archivo.nombre, archivo.vacia ? null : archivo.tipo, archivo.vacia ? null : archivo.datos]
      );
      const io = req.app.get('io');
      if (io) io.to(`sucursal_${t.sucursal_id}`).emit('nueva_solicitud_factura', { folio: t.folio });
      res.json({ ok: true, solicitud: r.rows[0].id, folio: t.folio });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Este ticket ya tiene una solicitud de factura registrada.' });
      }
      throw err;
    }
  } catch (err) {
    console.error('facturacion/solicitar:', err.message);
    res.status(500).json({ error: 'No se pudo guardar tu solicitud. Intenta de nuevo.' });
  }
});

// Consultar cómo va una solicitud (folio + RFC).
router.post('/publico/estado', limitadorEstado, async (req, res) => {
  try {
    const folio = String(req.body.folio || '').trim().toUpperCase();
    const rfc = String(req.body.rfc || '').trim().toUpperCase();
    if (!folio || !rfc) return res.status(400).json({ error: 'Escribe el folio y tu RFC' });
    const r = await pool.query(
      `SELECT estado, nota_admin, creado_en, actualizado_en FROM facturacion_solicitudes
       WHERE (UPPER(folio) = $1 OR REGEXP_REPLACE(UPPER(folio), '[^A-Z0-9]', '', 'g') = $3) AND rfc = $2 ORDER BY creado_en DESC LIMIT 1`,
      [folio, rfc, folio.replace(/[^A-Z0-9]/g, '')]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No encontramos una solicitud con ese folio y RFC.' });
    const s = r.rows[0];
    res.json({ estado: s.estado, nota: s.estado === 'rechazada' ? s.nota_admin : null, creado_en: s.creado_en, actualizado_en: s.actualizado_en });
  } catch (err) {
    console.error('facturacion/estado:', err.message);
    res.status(500).json({ error: 'No se pudo consultar. Intenta de nuevo.' });
  }
});

// ===================== RUTAS DE ADMINISTRACIÓN (requieren sesión) =====================

router.use(verificarToken, requiereSucursalId, requiereRol('jefe_general', 'dueno', 'gerente'));

const COLUMNAS_LISTA = `id, ticket_id, folio, total, rfc, razon_social, regimen_fiscal, codigo_postal, uso_cfdi, correo, telefono,
  estado, nota_admin, uuid_factura, constancia_nombre, (constancia_datos IS NOT NULL) AS tiene_constancia, creado_en, actualizado_en`;

router.get('/', async (req, res) => {
  try {
    const params = [req.sucursalId];
    let filtros = 'WHERE sucursal_id = $1';
    if (['pendiente', 'facturada', 'rechazada'].includes(req.query.estado)) {
      params.push(req.query.estado);
      filtros += ` AND estado = $${params.length}`;
    }
    const q = String(req.query.q || '').trim();
    if (q) {
      params.push(`%${q}%`);
      filtros += ` AND (folio ILIKE $${params.length} OR rfc ILIKE $${params.length} OR razon_social ILIKE $${params.length} OR correo ILIKE $${params.length})`;
    }
    const lista = await pool.query(
      `SELECT ${COLUMNAS_LISTA} FROM facturacion_solicitudes ${filtros}
       ORDER BY (estado = 'pendiente') DESC, creado_en DESC LIMIT 300`, params);
    const conteos = await pool.query(
      `SELECT estado, COUNT(*)::int AS n FROM facturacion_solicitudes WHERE sucursal_id = $1 GROUP BY estado`, [req.sucursalId]);
    const resumen = { pendiente: 0, facturada: 0, rechazada: 0 };
    conteos.rows.forEach(c => { resumen[c.estado] = c.n; });
    res.json({ solicitudes: lista.rows, resumen });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las solicitudes de factura' });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const s = await pool.query(`SELECT ${COLUMNAS_LISTA} FROM facturacion_solicitudes WHERE id = $1 AND sucursal_id = $2`, [req.params.id, req.sucursalId]);
    if (!s.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
    const t = await pool.query(`SELECT folio, total, metodo_pago, fecha_pago, descuento_monto FROM tickets WHERE id = $1`, [s.rows[0].ticket_id]);
    const items = await pool.query(
      `SELECT nombre_producto, cantidad, precio_unitario, subtotal FROM ticket_detalle WHERE ticket_id = $1 ORDER BY id`, [s.rows[0].ticket_id]);
    res.json({ ...s.rows[0], ticket: t.rows[0] || null, items: items.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la solicitud' });
  }
});

router.get('/:id(\\d+)/constancia', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT constancia_nombre, constancia_tipo, constancia_datos FROM facturacion_solicitudes WHERE id = $1 AND sucursal_id = $2`,
      [req.params.id, req.sucursalId]);
    if (!r.rows.length || !r.rows[0].constancia_datos) return res.status(404).json({ error: 'Esta solicitud no tiene constancia' });
    const c = r.rows[0];
    res.setHeader('Content-Type', c.constancia_tipo);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(c.constancia_nombre || 'constancia')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(c.constancia_datos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la constancia' });
  }
});

router.put('/:id(\\d+)', async (req, res) => {
  try {
    const { estado } = req.body;
    if (!['pendiente', 'facturada', 'rechazada'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const nota = String(req.body.nota_admin || '').trim().slice(0, 500);
    const uuid = String(req.body.uuid_factura || '').trim().slice(0, 60);
    if (estado === 'rechazada' && !nota) return res.status(400).json({ error: 'Escribe el motivo del rechazo (el cliente lo podrá ver)' });

    const r = await pool.query(
      `UPDATE facturacion_solicitudes
          SET estado = $1, nota_admin = $2, uuid_factura = $3, atendido_por = $4, actualizado_en = NOW()
        WHERE id = $5 AND sucursal_id = $6 RETURNING ${COLUMNAS_LISTA}`,
      [estado, nota || null, uuid || null, req.usuario.id, req.params.id, req.sucursalId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'actualizar_solicitud_factura',
      modulo: 'facturacion',
      referencia_id: r.rows[0].id,
      valor_nuevo: { folio: r.rows[0].folio, estado }
    });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Este ticket ya tiene otra solicitud vigente (el cliente volvió a pedirla). Atiende esa solicitud en lugar de reabrir la rechazada.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar la solicitud' });
  }
});

module.exports = router;
