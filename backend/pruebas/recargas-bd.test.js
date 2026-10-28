// Recargas y pago de servicios con base de datos REAL: turno obligatorio, validaciones,
// sin cobros dobles, modo prueba fuera del corte y ventas reales dentro del corte.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('recargas con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}
process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-recargas-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.NODE_ENV = 'test';
delete process.env.RECARGAS_API_KEY;
delete process.env.RECARGAS_API_SECRET;
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const lic = require('../utils/licencia');
const pool = require('../db');

let base, servidor, sucursalId;
const tk = {};
async function api(quien, metodo, ruta, cuerpo) {
  const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk[quien] }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function entrar(usuario) {
  const l = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario, password: 'Clave-Prueba-1' }) });
  tk[usuario] = (await l.json()).token;
}
let turnoCaja, turnoOtra;

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  for (let i = 0; i < 100; i++) {
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '019%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2037-12-31', 'anual', 'nube')");
  lic.invalidarCache();
  sucursalId = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1)', [sucursalId]);
  const hash = await bcrypt.hash('Clave-Prueba-1', 4);
  for (const [u, rol] of [['duena', 'dueno'], ['caja', 'cajero'], ['otra', 'cajero'], ['mostra', 'mostrador']]) {
    await pool.query('INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,$2,$2,$3,$4,true)', [sucursalId, u, hash, rol]);
    await entrar(u);
  }
  turnoCaja = (await api('caja', 'POST', '/api/turnos/abrir', { fondo_inicial: 500 })).json.id;
  turnoOtra = (await api('otra', 'POST', '/api/turnos/abrir', { fondo_inicial: 0 })).json.id;
  assert.ok(turnoCaja && turnoOtra);
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
});

const recarga = (extra = {}) => ({ compania: 'telcel', referencia: '3312345678', monto: 50, metodo_pago: 'efectivo', turno_id: turnoCaja, ...extra });

test('sin proveedor el módulo trabaja en modo prueba', async () => {
  const r = await api('caja', 'GET', '/api/recargas/estado');
  assert.equal(r.status, 200);
  assert.equal(r.json.modo, 'prueba');
  assert.equal(r.json.activo, true);
  assert.equal(r.json.cargo_servicio, 10);
  const c = await api('caja', 'GET', '/api/recargas/catalogo');
  assert.ok(c.json.find((x) => x.codigo === 'telcel' && x.montos.includes(50)));
});

test('sin turno, con turno ajeno o sin permiso no se vende', async () => {
  assert.equal((await api('caja', 'POST', '/api/recargas/vender', recarga({ turno_id: undefined }))).status, 400);
  assert.equal((await api('caja', 'POST', '/api/recargas/vender', recarga({ turno_id: turnoOtra }))).status, 403);
  assert.equal((await api('mostra', 'POST', '/api/recargas/vender', recarga())).status, 403);
});

test('valida número, monto, compañía y forma de pago', async () => {
  assert.equal((await api('caja', 'POST', '/api/recargas/vender', recarga({ referencia: '331234567' }))).status, 400);
  assert.equal((await api('caja', 'POST', '/api/recargas/vender', recarga({ monto: 55 }))).status, 400);
  assert.equal((await api('caja', 'POST', '/api/recargas/vender', recarga({ compania: 'patito' }))).status, 400);
  assert.equal((await api('caja', 'POST', '/api/recargas/vender', recarga({ metodo_pago: 'credito' }))).status, 400);
  assert.equal((await api('caja', 'POST', '/api/recargas/vender', { compania: 'cfe', referencia: '<script>', monto: 100, turno_id: turnoCaja })).status, 400);
  assert.equal((await api('caja', 'POST', '/api/recargas/vender', { compania: 'cfe', referencia: '123456789012', monto: 99999, turno_id: turnoCaja })).status, 400);
});

test('recarga de prueba: se guarda, sale con folio PRUEBA y un doble clic no la duplica', async () => {
  const cuerpo = recarga({ clave: 'clave-prueba-0001' });
  const a = await api('caja', 'POST', '/api/recargas/vender', cuerpo);
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.estado, 'exitosa');
  assert.equal(a.json.modo_prueba, true);
  assert.match(a.json.folio_proveedor, /^PRUEBA-/);
  const b = await api('caja', 'POST', '/api/recargas/vender', cuerpo);
  assert.equal(b.status, 200);
  assert.equal(b.json.id, a.json.id);
  const n = await pool.query("SELECT COUNT(*)::int AS n FROM recargas_ventas WHERE clave = 'clave-prueba-0001'");
  assert.equal(n.rows[0].n, 1);
});

test('la misma recarga al mismo número en menos de 3 minutos pide confirmar', async () => {
  const r = await api('caja', 'POST', '/api/recargas/vender', recarga());
  assert.equal(r.status, 409);
  assert.equal(r.json.repetida, true);
  const ok = await api('caja', 'POST', '/api/recargas/vender', recarga({ confirmar_repetida: true }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.estado, 'exitosa');
});

test('un número rechazado queda como fallida', async () => {
  const r = await api('caja', 'POST', '/api/recargas/vender', recarga({ referencia: '3312340000' }));
  assert.equal(r.status, 200);
  assert.equal(r.json.estado, 'fallida');
});

test('pago de servicio suma la comisión del negocio', async () => {
  const r = await api('caja', 'POST', '/api/recargas/vender', { compania: 'cfe', referencia: '1234 5678 9012', monto: 350.5, metodo_pago: 'efectivo', turno_id: turnoCaja });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.referencia, '123456789012');
  assert.equal(Number(r.json.cargo), 10);
  assert.equal(Number(r.json.total), 360.5);
});

test('las de prueba NO entran al corte; las reales sí (efectivo a la caja, tarjeta a lo esperado)', async () => {
  let c = (await api('caja', 'GET', `/api/turnos/${turnoCaja}/resumen`)).json;
  assert.equal(c.caja.saldo_efectivo, 500);
  assert.equal(c.recargas.cantidad, 0);
  // Se simulan dos ventas reales (como si ya hubiera proveedor conectado).
  await pool.query(
    `INSERT INTO recargas_ventas (sucursal_id, turno_id, usuario_id, tipo, compania, referencia, monto, cargo, total, metodo_pago, estado, modo_prueba)
     VALUES ($1, $2, NULL, 'recarga', 'telcel', '3311111111', 100, 0, 100, 'efectivo', 'exitosa', FALSE),
            ($1, $2, NULL, 'servicio', 'cfe', '999999999999', 200, 10, 210, 'tarjeta', 'exitosa', FALSE),
            ($1, $2, NULL, 'recarga', 'att', '3322222222', 50, 0, 50, 'efectivo', 'fallida', FALSE)`,
    [sucursalId, turnoCaja]
  );
  c = (await api('caja', 'GET', `/api/turnos/${turnoCaja}/resumen`)).json;
  assert.equal(c.caja.recargas_efectivo, 100);
  assert.equal(c.caja.saldo_efectivo, 600);
  assert.equal(c.recargas.cantidad, 2);
  assert.equal(c.recargas.tarjeta, 210);
  assert.equal(c.recargas.cargos, 10);
  // Al cerrar, lo esperado en tarjeta incluye el servicio cobrado con tarjeta.
  const cierre = await api('caja', 'POST', `/api/turnos/${turnoCaja}/cerrar`, { declaracion: { efectivo: 600, tarjeta: 210 } });
  assert.equal(cierre.status, 200, JSON.stringify(cierre.json));
  const d = (await api('caja', 'GET', `/api/turnos/${turnoCaja}/resumen`)).json.declaracion;
  assert.equal(d.esperado.tarjeta, 210);
  assert.equal(d.diferencia, 0);
});

test('con el turno cerrado ya no se puede vender en él', async () => {
  const r = await api('caja', 'POST', '/api/recargas/vender', recarga({ referencia: '3399999999' }));
  assert.equal(r.status, 409);
});

test('solo dueño/gerente cambian los ajustes; apagado no se vende', async () => {
  assert.equal((await api('caja', 'PUT', '/api/recargas/config', { activo: false })).status, 403);
  assert.equal((await api('duena', 'PUT', '/api/recargas/config', { cargo_servicio: 500 })).status, 400);
  const ok = await api('duena', 'PUT', '/api/recargas/config', { activo: false, cargo_servicio: 12 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.cargo_servicio, 12);
  const r = await api('otra', 'POST', '/api/recargas/vender', recarga({ turno_id: turnoOtra, referencia: '3388888888' }));
  assert.equal(r.status, 403);
  await api('duena', 'PUT', '/api/recargas/config', { activo: true });
});

test('la cajera solo ve sus recargas; la dueña ve todas', async () => {
  const otra = await api('otra', 'GET', '/api/recargas/ventas');
  assert.equal(otra.status, 200);
  assert.equal(otra.json.length, 0);
  const duena = await api('duena', 'GET', '/api/recargas/ventas');
  assert.ok(duena.json.length >= 4);
});
