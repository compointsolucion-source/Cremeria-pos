// Referencia de pago con base de datos REAL: el cajero escribe un comentario al cobrar con tarjeta,
// transferencia o pago mixto; se guarda con la venta y se ve en el historial. Solo control interno.
// Necesita una base VACÍA de pruebas (se borra todo lo que tenga):
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('referencia de pago con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-referencia-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const lic = require('../utils/licencia');
const pool = require('../db');

let base, servidor, token, sucursalId, usuarioId, turnoId, productoId;

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const item = () => ({ tipo: 'producto', producto_id: productoId, nombre_producto: 'Crema 200ml', cantidad: 2, precio_unitario: 50 });
// Crea un ticket de $100 y lo cobra con el método indicado; devuelve la respuesta del cobro.
async function cobrar(metodo, referencia, extra = {}) {
  const t = await api('POST', '/api/tickets', { items: [item()] });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  const montos = metodo === 'efectivo' ? { monto_efectivo: 100, efectivo_recibido: 100 }
    : metodo === 'mixto' ? { monto_efectivo: 40, monto_tarjeta: 60 }
    : { monto_tarjeta: 100 };
  const cuerpo = { metodo_pago: metodo, turno_id: turnoId, ...montos, ...extra };
  if (referencia !== undefined) cuerpo.referencia_pago = referencia;
  const r = await api('POST', `/api/tickets/${t.json.id}/pagar`, cuerpo);
  return { ticket: t.json, pago: r };
}
const enBd = async (id) => (await pool.query('SELECT referencia_pago FROM tickets WHERE id = $1', [id])).rows[0].referencia_pago;

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  for (let i = 0; i < 100; i++) { // espera a que las migraciones automáticas terminen (incluida la de la referencia)
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '014%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2027-12-31', 'anual', 'nube')");
  lic.invalidarCache();

  sucursalId = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1)', [sucursalId]);
  const hash = await bcrypt.hash('Clave-Prueba-1', 4);
  usuarioId = (await pool.query(
    "INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,'Dueño','dueno',$2,'dueno',true) RETURNING id", [sucursalId, hash]
  )).rows[0].id;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: 'dueno', password: 'Clave-Prueba-1' }) });
  assert.equal(login.status, 200);
  token = (await login.json()).token;

  productoId = (await pool.query(
    "INSERT INTO productos (sucursal_id, nombre, precio, tipo_venta, usa_inventario) VALUES ($1,'Crema 200ml',50,'unidad',true) RETURNING id", [sucursalId]
  )).rows[0].id;
  await pool.query('INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, 500)', [productoId]);
  turnoId = (await pool.query('INSERT INTO turnos (sucursal_id, usuario_id, fondo_inicial) VALUES ($1,$2,500) RETURNING id', [sucursalId, usuarioId])).rows[0].id;
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
});

test('la migración 014 crea la columna referencia_pago', async () => {
  const c = await pool.query("SELECT data_type, character_maximum_length FROM information_schema.columns WHERE table_name = 'tickets' AND column_name = 'referencia_pago'");
  assert.equal(c.rows.length, 1);
  assert.equal(c.rows[0].character_maximum_length, 100);
});

test('tarjeta y transferencia guardan la referencia que escribió el cajero', async () => {
  const a = await cobrar('tarjeta', 'Terminal Banorte');
  assert.equal(a.pago.status, 200, JSON.stringify(a.pago.json));
  assert.equal(a.pago.json.referencia_pago, 'Terminal Banorte');
  assert.equal(await enBd(a.ticket.id), 'Terminal Banorte');
  const b = await cobrar('transferencia', 'BBVA, Juan Pérez');
  assert.equal(b.pago.status, 200);
  assert.equal(await enBd(b.ticket.id), 'BBVA, Juan Pérez');
});

test('pago mixto también la guarda (va con la parte de tarjeta)', async () => {
  const m = await cobrar('mixto', 'Visa terminación 4821');
  assert.equal(m.pago.status, 200, JSON.stringify(m.pago.json));
  assert.equal(await enBd(m.ticket.id), 'Visa terminación 4821');
});

test('sin referencia, en blanco o con solo espacios: no se guarda nada', async () => {
  for (const ref of [undefined, '', '   ', null]) {
    const r = await cobrar('tarjeta', ref);
    assert.equal(r.pago.status, 200);
    assert.equal(await enBd(r.ticket.id), null, `referencia ${JSON.stringify(ref)}`);
  }
});

test('efectivo no guarda referencia aunque llegue una', async () => {
  const e = await cobrar('efectivo', 'esto no debe guardarse');
  assert.equal(e.pago.status, 200);
  assert.equal(await enBd(e.ticket.id), null);
});

test('se recorta a 100 caracteres, quita espacios de sobra y respeta lo que se escribió (acentos, comillas, símbolos)', async () => {
  const larga = 'x'.repeat(150);
  const r = await cobrar('tarjeta', larga);
  assert.equal(r.pago.status, 200);
  assert.equal((await enBd(r.ticket.id)).length, 100);
  const raro = await cobrar('transferencia', '   Ñandú  "López" <b>&   ');
  assert.equal(await enBd(raro.ticket.id), 'Ñandú "López" <b>&'); // se guarda tal cual (la pantalla es la que lo escapa al mostrarlo)
});

test('el detalle por folio y el historial del día traen la referencia', async () => {
  const r = await cobrar('transferencia', 'Ref historial 123');
  const folio = r.ticket.folio;
  const detalle = await api('GET', `/api/tickets/folio/${folio}`);
  assert.equal(detalle.status, 200);
  assert.equal(detalle.json.referencia_pago, 'Ref historial 123');
  const hoy = new Date().toISOString().split('T')[0];
  const hist = await api('GET', `/api/tickets/historial-dia?fecha=${hoy}`);
  assert.equal(hist.status, 200);
  const fila = hist.json.find((v) => v.folio === folio);
  assert.ok(fila, 'el ticket aparece en el historial');
  assert.equal(fila.referencia_pago, 'Ref historial 123');
  const ultimo = await api('GET', '/api/tickets/ultimo-pagado');
  assert.equal(ultimo.json.referencia_pago, 'Ref historial 123');
});

test('venta hecha sin internet: la referencia viaja con la venta al subirla', async () => {
  const r = await api('POST', '/api/tickets/venta-offline', {
    folio: 'OFF-REF1', fecha: new Date().toISOString(), metodo_pago: 'tarjeta', monto_tarjeta: 100, turno_id: turnoId,
    referencia_pago: '  Terminal BBVA  ', items: [item()]
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.referencia_pago, 'Terminal BBVA');
  const efec = await api('POST', '/api/tickets/venta-offline', {
    folio: 'OFF-REF2', fecha: new Date().toISOString(), metodo_pago: 'efectivo', monto_efectivo: 100, efectivo_recibido: 100, turno_id: turnoId,
    referencia_pago: 'no va', items: [item()]
  });
  assert.equal(efec.status, 200);
  assert.equal(efec.json.referencia_pago, null);
});
