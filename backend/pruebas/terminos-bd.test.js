// Aceptación de los Términos y condiciones dentro del sistema, con base de datos REAL.
// Necesita una base VACÍA de pruebas (se borra todo lo que tenga):
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('términos con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-terminos-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const lic = require('../utils/licencia');
const pool = require('../db');
const T = require('../utils/terminos');

let base, servidor, sucursalId;
const TK = {};
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function api(quien, metodo, ruta, cuerpo) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'prueba-terminos', ...(quien ? { Authorization: 'Bearer ' + TK[quien] } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  for (let i = 0; i < 100; i++) {
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '016%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2037-12-31', 'anual', 'nube')");
  lic.invalidarCache();
  sucursalId = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Centro', true) RETURNING id")).rows[0].id;
  const hash = await bcrypt.hash('Clave-1', 4);
  for (const [user, rol, nombre] of [['rosa', 'dueno', 'Rosa Dueña'], ['caja', 'cajero', 'Cajera'], ['jefe', 'jefe_general', 'Jefe General']]) {
    const id = (await pool.query(
      'INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,$2,$3,$4,$5,true) RETURNING id',
      [rol === 'jefe_general' ? null : sucursalId, nombre, user, hash, rol])).rows[0].id;
    TK[user] = jwt.sign({ id, nombre, usuario: user, rol, sucursal_id: rol === 'jefe_general' ? null : sucursalId, permisos: {} }, process.env.JWT_SECRET, { expiresIn: '1h' });
  }
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
});

test('sin sesión no se puede consultar ni aceptar', async () => {
  assert.equal((await api(null, 'GET', '/api/terminos/estado')).status, 401);
  assert.equal((await api(null, 'POST', '/api/terminos/aceptar', { acepto: true, version: T.VERSION })).status, 401);
});

test('al inicio no están aceptados; el dueño puede aceptar y el cajero no', async () => {
  const d = await api('rosa', 'GET', '/api/terminos/estado');
  assert.equal(d.status, 200);
  assert.equal(d.json.aceptado, false);
  assert.equal(d.json.puede_aceptar, true);
  assert.equal(d.json.version, T.VERSION);
  assert.equal(d.json.resumen.length, 5);
  const c = await api('caja', 'GET', '/api/terminos/estado');
  assert.equal(c.json.puede_aceptar, false);
});

test('el cajero no puede aceptar por el dueño', async () => {
  const r = await api('caja', 'POST', '/api/terminos/aceptar', { acepto: true, version: T.VERSION });
  assert.equal(r.status, 403);
  assert.equal((await pool.query('SELECT count(*)::int n FROM terminos_aceptaciones')).rows[0].n, 0);
});

test('sin marcar la casilla o con versión vieja no se guarda', async () => {
  assert.equal((await api('rosa', 'POST', '/api/terminos/aceptar', { version: T.VERSION })).status, 400);
  assert.equal((await api('rosa', 'POST', '/api/terminos/aceptar', { acepto: true, version: '2020-01-01' })).status, 409);
  assert.equal((await pool.query('SELECT count(*)::int n FROM terminos_aceptaciones')).rows[0].n, 0);
});

test('el dueño acepta: queda la constancia completa y ya no se le vuelve a pedir', async () => {
  const r = await api('rosa', 'POST', '/api/terminos/aceptar', { acepto: true, version: T.VERSION });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const f = (await pool.query('SELECT * FROM terminos_aceptaciones')).rows;
  assert.equal(f.length, 1);
  assert.equal(f[0].version, T.VERSION);
  assert.equal(f[0].huella, T.huella());
  assert.equal(f[0].huella.length, 64);
  assert.equal(f[0].usuario_nombre, 'Rosa Dueña');
  assert.equal(f[0].usuario_rol, 'dueno');
  assert.equal(f[0].navegador, 'prueba-terminos');
  assert.equal(f[0].medio, 'nube');
  assert.ok(f[0].ip);
  const e = await api('caja', 'GET', '/api/terminos/estado');
  assert.equal(e.json.aceptado, true);
  assert.equal(e.json.aceptado_por, 'Rosa Dueña');
  const bit = (await pool.query("SELECT count(*)::int n FROM bitacora WHERE accion = 'terminos_aceptar'")).rows[0].n;
  assert.equal(bit, 1);
});

test('aceptar dos veces no duplica la constancia (y el jefe general también puede aceptar)', async () => {
  const r = await api('jefe', 'POST', '/api/terminos/aceptar', { acepto: true, version: T.VERSION });
  assert.equal(r.status, 200);
  assert.equal(r.json.ya_estaba, true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM terminos_aceptaciones')).rows[0].n, 1);
});

test('con la licencia vencida (solo consulta) sí se puede aceptar', async () => {
  await pool.query('DELETE FROM terminos_aceptaciones');
  await pool.query("UPDATE licencia SET fecha_vencimiento = '2020-01-01'");
  lic.invalidarCache();
  const r = await api('rosa', 'POST', '/api/terminos/aceptar', { acepto: true, version: T.VERSION });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await pool.query("UPDATE licencia SET fecha_vencimiento = '2037-12-31'");
  lic.invalidarCache();
});
