// Facturación con base de datos REAL: el negocio sube el PDF y el XML de la factura que hizo
// en el SAT o en su programa; el sistema lee el XML y el cliente la descarga con su folio + RFC
// o con el enlace (folio + clave) que se le manda por WhatsApp.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('facturación con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}
process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-facturacion-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.NODE_ENV = 'test';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const lic = require('../utils/licencia');
const pool = require('../db');

let base, servidor, sucursalId, otraSucursal, token, solicitudId;
const RFC = 'AES180305KJ2';

async function api(metodo, ruta, cuerpo, sucursal) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Sucursal-Id': String(sucursal || sucursalId) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}
async function publico(ruta, cuerpo) {
  const r = await fetch(base + '/api/facturacion/publico' + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const b64 = (texto) => Buffer.from(texto).toString('base64');
const PDF = b64('%PDF-1.4\n% factura de prueba\n%%EOF');
const xml = ({ total = '1250.00', rfc = RFC, uuid = '6F2B9C41-7D0E-4A8B-9F12-3C5E8A7B1D20' } = {}) => b64(
  `<?xml version="1.0" encoding="UTF-8"?>\n<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" SubTotal="1077.59" Total="${total}" Moneda="MXN">` +
  `<cfdi:Emisor Rfc="EKU9003173C9" Nombre="ESCUELA KEMPER URGATE" RegimenFiscal="601"/>` +
  `<cfdi:Receptor Rfc="${rfc}" Nombre="ABARROTES LA ESPERANZA" UsoCFDI="G03"/>` +
  `<cfdi:Complemento>${uuid ? `<tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${uuid.toLowerCase()}"/>` : ''}</cfdi:Complemento>` +
  '</cfdi:Comprobante>');

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  for (let i = 0; i < 100; i++) {
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '021%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2037-12-31', 'anual', 'nube')");
  lic.invalidarCache();
  sucursalId = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id")).rows[0].id;
  otraSucursal = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Otra', true) RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO configuracion (sucursal_id, nombre_negocio) VALUES ($1, 'Cremería La Vaquita')", [sucursalId]);
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1)', [otraSucursal]);
  const hash = await bcrypt.hash('Clave-Prueba-1', 4);
  // Jefe general: sin sucursal fija, elige con cuál trabaja (así se prueba que otra sucursal no ve la solicitud).
  await pool.query("INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES (NULL,'Dueña','duena',$1,'jefe_general',true)", [hash]);
  const l = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: 'duena', password: 'Clave-Prueba-1' }) });
  token = (await l.json()).token;
  assert.ok(token);

  const t = (await pool.query(
    `INSERT INTO tickets (folio, sucursal_id, estado, total, metodo_pago, fecha_pago) VALUES ('S1PO6BY8', $1, 'pagado', 1250, 'tarjeta', NOW()) RETURNING id`,
    [sucursalId])).rows[0].id;
  await pool.query(`INSERT INTO ticket_detalle (ticket_id, nombre_producto, cantidad, precio_unitario, subtotal) VALUES ($1,'Queso Oaxaca 1 kg',2,280,560),($1,'Crema 1 L',3,230,690)`, [t]);
  const s = await publico('/solicitar', {
    folio: 'S1PO6BY8', total: '1250.00', rfc: RFC, razon_social: 'Abarrotes La Esperanza SA de CV', regimen_fiscal: '601',
    codigo_postal: '44100', uso_cfdi: 'G03', correo: 'compras@ejemplo.mx', telefono: '33 1234 5678'
  });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  solicitudId = s.json.solicitud;
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
});

test('el detalle trae el nombre del negocio y todavía sin factura', async () => {
  const r = await api('GET', `/api/facturacion/${solicitudId}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.negocio, 'Cremería La Vaquita');
  assert.equal(r.json.tiene_pdf, false);
  assert.equal(r.json.tiene_xml, false);
  assert.equal(r.json.clave_descarga, null);
  assert.equal(r.json.items.length, 2);
});

test('rechaza archivos que no son PDF ni XML de factura', async () => {
  assert.equal((await api('POST', `/api/facturacion/${solicitudId}/archivos`, {})).status, 400);
  assert.equal((await api('POST', `/api/facturacion/${solicitudId}/archivos`, { pdf: { nombre: 'x.pdf', base64: b64('hola') } })).status, 400);
  assert.equal((await api('POST', `/api/facturacion/${solicitudId}/archivos`, { xml: { nombre: 'x.xml', base64: b64('<html></html>') } })).status, 400);
  // Otra sucursal no puede tocarla
  assert.equal((await api('POST', `/api/facturacion/${solicitudId}/archivos`, { pdf: { nombre: 'f.pdf', base64: PDF } }, otraSucursal)).status, 404);
});

test('XML con otro total y otro RFC: se guarda pero avisa', async () => {
  const r = await api('POST', `/api/facturacion/${solicitudId}/archivos`, { xml: { nombre: 'mal.xml', base64: xml({ total: '1520.00', rfc: 'AES180305KJ9' }) } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.avisos.length, 2);
  assert.match(r.json.avisos.join(' '), /1520\.00/);
  assert.match(r.json.avisos.join(' '), /AES180305KJ9/);
  const d = await api('GET', `/api/facturacion/${solicitudId}`);
  assert.equal(d.json.avisos.length, 2);
});

test('XML sin timbre: avisa que no tiene folio fiscal', async () => {
  const r = await api('POST', `/api/facturacion/${solicitudId}/archivos`, { xml: { nombre: 'sin.xml', base64: xml({ uuid: '' }) } });
  assert.equal(r.status, 200);
  assert.match(r.json.avisos.join(' '), /folio fiscal/);
});

test('PDF y XML correctos: lee UUID, RFC y total, y crea la clave del enlace', async () => {
  const r = await api('POST', `/api/facturacion/${solicitudId}/archivos`, {
    pdf: { nombre: 'factura-A123.pdf', base64: PDF }, xml: { nombre: 'factura-A123.xml', base64: xml() }
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.avisos, []);
  assert.equal(r.json.lectura.uuid, '6F2B9C41-7D0E-4A8B-9F12-3C5E8A7B1D20');
  assert.equal(r.json.lectura.rfc, RFC);
  assert.equal(r.json.lectura.total, 1250);
  const d = await api('GET', `/api/facturacion/${solicitudId}`);
  assert.equal(d.json.tiene_pdf, true);
  assert.equal(d.json.tiene_xml, true);
  assert.equal(d.json.uuid_factura, '6F2B9C41-7D0E-4A8B-9F12-3C5E8A7B1D20');
  assert.match(d.json.clave_descarga, /^[A-Z2-9]{10}$/);
  assert.deepEqual(d.json.avisos, []);
  const ver = await fetch(`${base}/api/facturacion/${solicitudId}/archivos/pdf`, { headers: { Authorization: 'Bearer ' + token, 'X-Sucursal-Id': String(sucursalId) } });
  assert.equal(ver.status, 200);
  assert.match(Buffer.from(await ver.arrayBuffer()).toString('latin1'), /^%PDF-/);
});

test('antes de marcarla facturada el cliente no puede descargarla', async () => {
  const d = await api('GET', `/api/facturacion/${solicitudId}`);
  const e = await publico('/estado', { folio: 'S1PO6BY8', rfc: RFC });
  assert.equal(e.json.estado, 'pendiente');
  assert.equal(e.json.clave, null);
  const r = await fetch(`${base}/api/facturacion/publico/descargar?f=S1PO6BY8&c=${d.json.clave_descarga}&tipo=pdf`);
  assert.equal(r.status, 404);
});

test('ya facturada: el cliente la consulta con folio+RFC o con el enlace y la descarga', async () => {
  const g = await api('PUT', `/api/facturacion/${solicitudId}`, { estado: 'facturada', uuid_factura: '6F2B9C41-7D0E-4A8B-9F12-3C5E8A7B1D20' });
  assert.equal(g.status, 200);
  const e = await publico('/estado', { folio: 's1po6by8', rfc: RFC.toLowerCase() });
  assert.equal(e.status, 200);
  assert.equal(e.json.estado, 'facturada');
  assert.equal(e.json.tiene_pdf, true);
  assert.equal(e.json.tiene_xml, true);
  assert.equal(e.json.uuid, '6F2B9C41-7D0E-4A8B-9F12-3C5E8A7B1D20');
  const clave = e.json.clave;
  assert.match(clave, /^[A-Z2-9]{10}$/);

  const porEnlace = await publico('/estado', { folio: 'S1PO6BY8', clave });
  assert.equal(porEnlace.status, 200);
  assert.equal(porEnlace.json.clave, clave);
  assert.equal((await publico('/estado', { folio: 'S1PO6BY8', clave: 'AAAAAAAAAA' })).status, 404);

  const pdf = await fetch(`${base}/api/facturacion/publico/descargar?f=S1PO6BY8&c=${clave}&tipo=pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /attachment/);
  const x = await fetch(`${base}/api/facturacion/publico/descargar?f=S1PO6BY8&c=${clave}&tipo=xml`);
  assert.equal(x.status, 200);
  assert.match(await x.text(), /TimbreFiscalDigital/);
  assert.equal((await fetch(`${base}/api/facturacion/publico/descargar?f=S1PO6BY8&c=MALA234567&tipo=pdf`)).status, 404);
  assert.equal((await fetch(`${base}/api/facturacion/publico/descargar?f=S1PO6BY8&tipo=pdf`)).status, 404);
});

test('quitar el XML: ya no se descarga y la clave se conserva', async () => {
  const d0 = await api('GET', `/api/facturacion/${solicitudId}`);
  assert.equal((await api('DELETE', `/api/facturacion/${solicitudId}/archivos/xml`)).status, 200);
  const d = await api('GET', `/api/facturacion/${solicitudId}`);
  assert.equal(d.json.tiene_xml, false);
  assert.equal(d.json.tiene_pdf, true);
  assert.equal(d.json.clave_descarga, d0.json.clave_descarga);
  const x = await fetch(`${base}/api/facturacion/publico/descargar?f=S1PO6BY8&c=${d.json.clave_descarga}&tipo=xml`);
  assert.equal(x.status, 404);
  const bit = await pool.query("SELECT accion FROM bitacora WHERE modulo = 'facturacion' ORDER BY id");
  assert.ok(bit.rows.some((b) => b.accion === 'subir_factura'));
  assert.ok(bit.rows.some((b) => b.accion === 'quitar_factura'));
});
