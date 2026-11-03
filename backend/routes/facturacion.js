const express = require('express');
const crypto = require('crypto');
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
const limitadorDescarga = limite(15, 60, 'Demasiadas descargas. Espera unos minutos e intenta de nuevo.');

const MAX_FACTURA_BYTES = 3 * 1024 * 1024; // 3 MB por PDF o XML de factura

// Clave para el enlace de descarga que se le manda al cliente (sin letras que se confunden).
function nuevaClave() {
  const letras = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(10), (b) => letras[b % letras.length]).join('');
}

const limpiarNombre = (n, defecto) => String(n || defecto).replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 120);

// PDF de la factura: se revisa por contenido que de verdad sea PDF.
function procesarPdf(a) {
  if (!a || !a.base64) return null;
  const datos = Buffer.from(String(a.base64).replace(/^data:[^;]*;base64,/, ''), 'base64');
  if (!datos.length) return { error: 'El PDF está vacío' };
  if (datos.length > MAX_FACTURA_BYTES) return { error: 'El PDF pesa más de 3 MB' };
  if (datos.slice(0, 5).toString('latin1') !== '%PDF-') return { error: 'El archivo de la factura no es un PDF' };
  return { datos, nombre: limpiarNombre(a.nombre, 'factura.pdf') };
}

// XML de la factura (CFDI): se lee el folio fiscal (UUID), el RFC del cliente y el total.
function leerCfdi(texto) {
  const comprobante = (texto.match(/<(?:[\w-]+:)?Comprobante\b[^>]*>/) || [])[0];
  if (!comprobante) return null;
  const atributo = (etiqueta, nombre) => {
    const m = etiqueta && etiqueta.match(new RegExp('\\s' + nombre + '\\s*=\\s*"([^"]*)"'));
    return m ? m[1].trim() : null;
  };
  const receptor = (texto.match(/<(?:[\w-]+:)?Receptor\b[^>]*>/) || [])[0];
  const timbre = (texto.match(/<(?:[\w-]+:)?TimbreFiscalDigital\b[^>]*>/) || [])[0];
  const total = Number(atributo(comprobante, 'Total'));
  return {
    uuid: (atributo(timbre, 'UUID') || '').toUpperCase() || null,
    rfc: (atributo(receptor, 'Rfc') || '').toUpperCase().replace(/&AMP;/g, '&') || null,
    total: Number.isFinite(total) ? Math.round(total * 100) / 100 : null
  };
}

function procesarXml(a) {
  if (!a || !a.base64) return null;
  const datos = Buffer.from(String(a.base64).replace(/^data:[^;]*;base64,/, ''), 'base64');
  if (!datos.length) return { error: 'El XML está vacío' };
  if (datos.length > MAX_FACTURA_BYTES) return { error: 'El XML pesa más de 3 MB' };
  const cfdi = leerCfdi(datos.toString('utf8').replace(/^﻿/, ''));
  if (!cfdi) return { error: 'El archivo no es el XML de una factura (CFDI). Sube el .xml que te dio el SAT o tu programa.' };
  return { datos, nombre: limpiarNombre(a.nombre, 'factura.xml'), cfdi };
}

// Compara lo que dice el XML con la solicitud. Son avisos: el negocio decide si la guarda así.
function revisarCfdi(cfdi, solicitud) {
  const avisos = [];
  if (!cfdi.uuid) avisos.push('El XML no tiene folio fiscal: parece que la factura no está timbrada.');
  if (cfdi.rfc && cfdi.rfc !== solicitud.rfc) avisos.push(`El RFC del XML es ${cfdi.rfc} y el cliente pidió ${solicitud.rfc}.`);
  if (cfdi.total !== null && Math.abs(cfdi.total - Number(solicitud.total)) > 0.02) {
    avisos.push(`El total del XML es $${cfdi.total.toFixed(2)} y el ticket es $${Number(solicitud.total).toFixed(2)}.`);
  }
  return avisos;
}

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
        ? 'Este ticket ya fue facturado. Consúltala en «Consultar mi solicitud» con tu folio y tu RFC.'
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

// Busca la solicitud del cliente por folio + RFC (lo que él sabe) o folio + clave (el enlace de WhatsApp).
async function solicitudPublica(folioTexto, rfcTexto, claveTexto) {
  const folio = String(folioTexto || '').trim().toUpperCase();
  const rfc = String(rfcTexto || '').trim().toUpperCase();
  const clave = String(claveTexto || '').trim().toUpperCase();
  if (!folio || (!rfc && !clave)) return null;
  const r = await pool.query(
    `SELECT id, folio, total, estado, nota_admin, uuid_factura, clave_descarga, creado_en, actualizado_en,
            factura_pdf_nombre, factura_xml_nombre,
            (factura_pdf IS NOT NULL) AS tiene_pdf, (factura_xml IS NOT NULL) AS tiene_xml
       FROM facturacion_solicitudes
      WHERE (UPPER(folio) = $1 OR REGEXP_REPLACE(UPPER(folio), '[^A-Z0-9]', '', 'g') = $2)
        AND ${rfc ? 'rfc = $3' : 'clave_descarga = $3'}
      ORDER BY creado_en DESC LIMIT 1`,
    [folio, folio.replace(/[^A-Z0-9]/g, ''), rfc || clave]
  );
  return r.rows[0] || null;
}

// Consultar cómo va una solicitud (folio + RFC, o folio + clave del enlace).
router.post('/publico/estado', limitadorEstado, async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.folio || '').trim() || (!String(b.rfc || '').trim() && !String(b.clave || '').trim())) {
      return res.status(400).json({ error: 'Escribe el folio y tu RFC' });
    }
    const s = await solicitudPublica(b.folio, b.rfc, b.clave);
    if (!s) return res.status(404).json({ error: b.clave ? 'El enlace no es válido. Consulta con tu folio y tu RFC.' : 'No encontramos una solicitud con ese folio y RFC.' });
    const lista = s.estado === 'facturada';
    res.json({
      estado: s.estado, nota: s.estado === 'rechazada' ? s.nota_admin : null, creado_en: s.creado_en, actualizado_en: s.actualizado_en,
      folio: s.folio, total: Number(s.total),
      uuid: lista ? s.uuid_factura : null,
      tiene_pdf: lista && s.tiene_pdf, tiene_xml: lista && s.tiene_xml,
      clave: lista && (s.tiene_pdf || s.tiene_xml) ? s.clave_descarga : null
    });
  } catch (err) {
    console.error('facturacion/estado:', err.message);
    res.status(500).json({ error: 'No se pudo consultar. Intenta de nuevo.' });
  }
});

// Descargar el PDF o XML de una factura ya lista (folio + clave del enlace).
router.get('/publico/descargar', limitadorDescarga, async (req, res) => {
  try {
    const tipo = req.query.tipo === 'xml' ? 'xml' : 'pdf';
    const s = await solicitudPublica(req.query.f, null, req.query.c);
    if (!s || s.estado !== 'facturada') return res.status(404).json({ error: 'No encontramos esa factura' });
    const r = await pool.query(`SELECT factura_${tipo} AS datos FROM facturacion_solicitudes WHERE id = $1`, [s.id]);
    if (!r.rows[0] || !r.rows[0].datos) return res.status(404).json({ error: `Esta factura no tiene ${tipo.toUpperCase()}` });
    const nombre = s[`factura_${tipo}_nombre`] || `factura-${s.folio}.${tipo}`;
    res.setHeader('Content-Type', tipo === 'pdf' ? 'application/pdf' : 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(nombre)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.send(r.rows[0].datos);
  } catch (err) {
    console.error('facturacion/descargar:', err.message);
    res.status(500).json({ error: 'No se pudo descargar. Intenta de nuevo.' });
  }
});

// ===================== RUTAS DE ADMINISTRACIÓN (requieren sesión) =====================

router.use(verificarToken, requiereSucursalId, requiereRol('jefe_general', 'dueno', 'gerente'));

const COLUMNAS_LISTA = `id, ticket_id, folio, total, rfc, razon_social, regimen_fiscal, codigo_postal, uso_cfdi, correo, telefono,
  estado, nota_admin, uuid_factura, constancia_nombre, (constancia_datos IS NOT NULL) AS tiene_constancia, creado_en, actualizado_en,
  factura_pdf_nombre, factura_xml_nombre, (factura_pdf IS NOT NULL) AS tiene_pdf, (factura_xml IS NOT NULL) AS tiene_xml,
  factura_rfc, factura_total, factura_subida_en, clave_descarga`;

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
    const neg = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(c.nombre_negocio), ''), su.nombre) AS negocio
         FROM sucursales su LEFT JOIN configuracion c ON c.sucursal_id = su.id WHERE su.id = $1`, [req.sucursalId]);
    const solicitud = { ...s.rows[0] };
    // Si ya hay factura subida, se revisa otra vez contra la solicitud (para mostrar los avisos al abrirla).
    solicitud.avisos = solicitud.factura_subida_en && (solicitud.factura_rfc || solicitud.factura_total !== null)
      ? revisarCfdi({ uuid: solicitud.uuid_factura, rfc: solicitud.factura_rfc, total: solicitud.factura_total === null ? null : Number(solicitud.factura_total) }, solicitud)
      : [];
    res.json({ ...solicitud, negocio: (neg.rows[0] && neg.rows[0].negocio) || null, ticket: t.rows[0] || null, items: items.rows });
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

// Subir la factura que el negocio hizo en el SAT o en su programa (PDF y/o XML).
router.post('/:id(\\d+)/archivos', async (req, res) => {
  try {
    const b = req.body || {};
    const pdf = procesarPdf(b.pdf);
    const xml = procesarXml(b.xml);
    if (!pdf && !xml) return res.status(400).json({ error: 'Elige el PDF o el XML de la factura' });
    if (pdf && pdf.error) return res.status(400).json({ error: pdf.error });
    if (xml && xml.error) return res.status(400).json({ error: xml.error });

    const actual = await pool.query(
      'SELECT id, folio, total, rfc, clave_descarga FROM facturacion_solicitudes WHERE id = $1 AND sucursal_id = $2',
      [req.params.id, req.sucursalId]);
    if (!actual.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
    const s = actual.rows[0];

    const sets = ['factura_subida_en = NOW()', 'actualizado_en = NOW()'];
    const valores = [];
    const poner = (columna, valor) => { valores.push(valor); sets.push(`${columna} = $${valores.length}`); };
    if (pdf) { poner('factura_pdf', pdf.datos); poner('factura_pdf_nombre', pdf.nombre); }
    if (xml) {
      poner('factura_xml', xml.datos); poner('factura_xml_nombre', xml.nombre);
      poner('factura_rfc', xml.cfdi.rfc); poner('factura_total', xml.cfdi.total);
      if (xml.cfdi.uuid) poner('uuid_factura', xml.cfdi.uuid);
    }
    if (!s.clave_descarga) poner('clave_descarga', nuevaClave());
    valores.push(s.id);
    await pool.query(`UPDATE facturacion_solicitudes SET ${sets.join(', ')} WHERE id = $${valores.length}`, valores);

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id, accion: 'subir_factura', modulo: 'facturacion', referencia_id: s.id,
      valor_nuevo: { folio: s.folio, pdf: !!pdf, xml: !!xml, uuid: xml ? xml.cfdi.uuid : undefined }
    });
    res.json({
      ok: true,
      lectura: xml ? xml.cfdi : null,
      avisos: xml ? revisarCfdi(xml.cfdi, s) : []
    });
  } catch (err) {
    console.error('facturacion/archivos:', err.message);
    res.status(500).json({ error: 'No se pudo guardar la factura' });
  }
});

// Ver el PDF o XML subido (el negocio).
router.get('/:id(\\d+)/archivos/:tipo(pdf|xml)', async (req, res) => {
  try {
    const tipo = req.params.tipo;
    const r = await pool.query(
      `SELECT folio, factura_${tipo} AS datos, factura_${tipo}_nombre AS nombre FROM facturacion_solicitudes WHERE id = $1 AND sucursal_id = $2`,
      [req.params.id, req.sucursalId]);
    if (!r.rows.length || !r.rows[0].datos) return res.status(404).json({ error: `Esta solicitud no tiene ${tipo.toUpperCase()}` });
    res.setHeader('Content-Type', tipo === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r.rows[0].nombre || 'factura.' + tipo)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(r.rows[0].datos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo abrir el archivo' });
  }
});

// Quitar el PDF o XML (si se subió uno equivocado).
router.delete('/:id(\\d+)/archivos/:tipo(pdf|xml)', async (req, res) => {
  try {
    const tipo = req.params.tipo;
    const extra = tipo === 'xml' ? ', factura_rfc = NULL, factura_total = NULL' : '';
    const r = await pool.query(
      `UPDATE facturacion_solicitudes SET factura_${tipo} = NULL, factura_${tipo}_nombre = NULL${extra}, actualizado_en = NOW()
        WHERE id = $1 AND sucursal_id = $2 RETURNING id, folio`, [req.params.id, req.sucursalId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
    await registrarBitacora(pool, {
      usuario_id: req.usuario.id, accion: 'quitar_factura', modulo: 'facturacion', referencia_id: r.rows[0].id,
      valor_nuevo: { folio: r.rows[0].folio, tipo }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo quitar el archivo' });
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
