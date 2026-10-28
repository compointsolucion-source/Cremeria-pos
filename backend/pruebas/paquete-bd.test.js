// Paquete contratado (Básico / Negocio / Pro) con base de datos REAL: límite de usuarios y candado de
// servicio a domicilio / app del repartidor. Sin paquete asignado no se limita nada.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('paquete con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}
process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-paquete-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const lic = require('../utils/licencia');
const pool = require('../db');
const paquete = require('../utils/paquete');
const central = require('../utils/licenciaCentral');

let base, servidor, sucursalId, token, productoId;
async function api(metodo, ruta, cuerpo) {
  const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function ponerPaquete(p, maxU, dom) {
  await pool.query('UPDATE licencia SET paquete = $1, max_usuarios = $2, con_domicilio = $3 WHERE id = 1', [p, maxU, dom]);
  paquete.invalidar();
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
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '018%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2037-12-31', 'anual', 'nube')");
  lic.invalidarCache();
  sucursalId = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1)', [sucursalId]);
  const hash = await bcrypt.hash('Clave-Prueba-1', 4);
  await pool.query("INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,'Dueña','duena',$2,'dueno',true)", [sucursalId, hash]);
  const l = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: 'duena', password: 'Clave-Prueba-1' }) });
  token = (await l.json()).token;
  productoId = (await pool.query("INSERT INTO productos (sucursal_id, nombre, precio, tipo_venta, usa_inventario) VALUES ($1,'Queso',100,'unidad',false) RETURNING id", [sucursalId])).rows[0].id;
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
});

const empleado = (usuario, rol = 'cajero') => api('POST', '/api/usuarios', { nombre: usuario, usuario, password: 'Clave-123456', rol });
const pedido = (tipo) => api('POST', '/api/pedidos', { tipo, pago_modo: 'al_recibir', nombre_contacto: 'Ana', telefono: '3312345678',
  direccion: { calle: 'Uno', numero: '1', colonia: 'Centro' }, items: [{ tipo: 'producto', producto_id: productoId, nombre_producto: 'Queso', cantidad: 1, precio_unitario: 100 }] });

test('sin paquete asignado no se limita nada', async () => {
  assert.equal((await empleado('uno')).status, 200);
  const l = await api('GET', '/api/licencia');
  assert.equal(l.json.paquete.paquete, null);
});

test('Básico: máximo de usuarios (contando al dueño) y sin domicilio ni repartidor', async () => {
  await ponerPaquete('basico', 3, false);
  assert.equal((await empleado('dos')).status, 200, 'dueña + uno + dos = 3');
  const de_mas = await empleado('tres');
  assert.equal(de_mas.status, 403);
  assert.match(de_mas.json.error, /Básico incluye 3 usuarios/);
  await ponerPaquete('basico', 5, false);
  const rep = await empleado('memo', 'repartidor');
  assert.equal(rep.status, 403);
  assert.match(rep.json.error, /no incluye servicio a domicilio/);
  assert.equal((await pedido('domicilio')).status, 403, 'pedido a domicilio bloqueado');
  assert.equal((await api('GET', '/api/pedidos/repartidores')).status, 200, 'consultar no rompe la pantalla');
  const rec = await pedido('recoger');
  assert.notEqual(rec.status, 403, 'para recoger sí: ' + JSON.stringify(rec.json));
  const l = await api('GET', '/api/licencia');
  assert.equal(l.json.paquete.nombre, 'Básico');
  assert.equal(l.json.paquete.con_domicilio, false);
});

test('reactivar a alguien cuenta contra el límite', async () => {
  await ponerPaquete('basico', 3, false);
  const id = (await pool.query("SELECT id FROM usuarios WHERE usuario = 'uno'")).rows[0].id;
  await pool.query('UPDATE usuarios SET activo = false WHERE id = $1', [id]);
  assert.equal((await empleado('cuatro')).status, 200, 'se liberó un lugar');
  assert.equal((await api('PUT', `/api/usuarios/${id}`, { activo: true })).status, 403, 'ya no cabe al reactivarlo');
});

test('Negocio: sí domicilio y repartidor', async () => {
  await ponerPaquete('negocio', 10, true);
  assert.equal((await empleado('memo2', 'repartidor')).status, 200);
  assert.notEqual((await pedido('domicilio')).status, 403);
});

test('la consulta central aplica el paquete solo con su firma', async () => {
  const tk = 'ab'.repeat(24);
  const r = { firma: 'f'.repeat(64), paquete: 'basico', max_usuarios: 3, con_domicilio: false };
  r.firma2 = crypto.createHmac('sha256', tk).update([r.firma, 'basico', '3', '0'].join('|')).digest('hex');
  assert.equal(central.firmaPaqueteValida(r, tk), true);
  assert.equal(central.firmaPaqueteValida({ ...r, paquete: 'pro' }, tk), false, 'alterado: no vale');
  assert.equal(central.firmaPaqueteValida({ ...r, firma2: undefined }, tk), false, 'sin firma: no vale');
});
