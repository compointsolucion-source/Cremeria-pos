// Equipo: editar nombre/usuario de un empleado y eliminarlo (se archiva, el historial se conserva),
// con base de datos REAL. Necesita una base VACÍA de pruebas (se borra todo lo que tenga):
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('equipo editar/eliminar con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-equipo-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const lic = require('../utils/licencia');
const pool = require('../db');

let base, servidor, sucursalId;
const T = {}; // tokens por usuario
const U = {}; // ids por usuario

async function api(quien, metodo, ruta, cuerpo) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(quien && T[quien] ? { Authorization: 'Bearer ' + T[quien] } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const crear = (quien, datos) => api(quien, 'POST', '/api/usuarios', { password: 'Clave-Nueva-1', rol: 'cajero', ...datos });
const lista = async () => (await api('dueno', 'GET', '/api/usuarios')).json;

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  for (let i = 0; i < 100; i++) {
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '013%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2037-12-31', 'anual', 'nube')");
  lic.invalidarCache();

  sucursalId = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1)', [sucursalId]);
  const hash = await bcrypt.hash('Clave-Prueba-1', 4);
  const usuario = async (nombre, user, rol) => {
    const id = (await pool.query(
      'INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,$2,$3,$4,$5,true) RETURNING id', [sucursalId, nombre, user, hash, rol])).rows[0].id;
    U[user] = id;
    T[user] = jwt.sign({ id, nombre, usuario: user, rol, sucursal_id: sucursalId, permisos: {} }, process.env.JWT_SECRET, { expiresIn: '1h' });
  };
  await usuario('Dueño', 'dueno', 'dueno');
  await usuario('Gerente Uno', 'gerente1', 'gerente');
  await usuario('Gerente Dos', 'gerente2', 'gerente');
  await usuario('Cajera', 'cajera', 'cajero');
  await usuario('Carlos Repartidor', 'carlos', 'repartidor');
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
});

const entrar = (usuario, password = 'Clave-Prueba-1') => api(null, 'POST', '/api/auth/login', { usuario, password });

// ---------------------------------------------------------------- editar nombre y usuario
test('el dueño cambia el nombre y el usuario; entra con el nuevo y el viejo ya no sirve', async () => {
  const r = await api('dueno', 'PUT', `/api/usuarios/${U.carlos}`, { nombre: 'Carlos Mendoza', usuario: 'cmendoza' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.nombre, 'Carlos Mendoza');
  assert.equal(r.json.usuario, 'cmendoza');
  assert.equal((await entrar('cmendoza')).status, 200, 'entra con el usuario nuevo');
  assert.notEqual((await entrar('carlos')).status, 200, 'el usuario viejo ya no entra');
  const fila = (await lista()).find((u) => u.id === U.carlos);
  assert.equal(fila.nombre, 'Carlos Mendoza');
  assert.equal(fila.usuario, 'cmendoza');
  assert.equal(fila.rol, 'repartidor', 'el rol no se movió');
  const bit = await pool.query("SELECT valor_nuevo FROM bitacora WHERE accion = 'editar_empleado' AND referencia_id = $1 ORDER BY id DESC LIMIT 1", [U.carlos]);
  assert.equal(bit.rows[0].valor_nuevo.usuario, 'cmendoza');
});

test('editar solo el teléfono o los permisos no cambia el nombre ni el usuario', async () => {
  const r = await api('dueno', 'PUT', `/api/usuarios/${U.carlos}`, { telefono: '33 9999 0000' });
  assert.equal(r.status, 200);
  assert.equal(r.json.nombre, 'Carlos Mendoza');
  assert.equal(r.json.usuario, 'cmendoza');
});

test('nombre/usuario vacíos, con espacios, con ~ o repetidos se rechazan', async () => {
  assert.equal((await api('dueno', 'PUT', `/api/usuarios/${U.carlos}`, { nombre: '   ' })).status, 400);
  assert.equal((await api('dueno', 'PUT', `/api/usuarios/${U.carlos}`, { usuario: '' })).status, 400);
  assert.equal((await api('dueno', 'PUT', `/api/usuarios/${U.carlos}`, { usuario: 'mi usuario' })).status, 400);
  assert.equal((await api('dueno', 'PUT', `/api/usuarios/${U.carlos}`, { usuario: 'x~eliminado~9' })).status, 400);
  assert.equal((await api('dueno', 'PUT', `/api/usuarios/${U.carlos}`, { usuario: 'a'.repeat(31) })).status, 400);
  const repetido = await api('dueno', 'PUT', `/api/usuarios/${U.carlos}`, { usuario: 'cajera' });
  assert.equal(repetido.status, 400);
  assert.match(repetido.json.error, /ya está en uso/);
  const fila = (await lista()).find((u) => u.id === U.carlos);
  assert.equal(fila.usuario, 'cmendoza', 'nada se cambió');
});

test('al dueño no se le puede cambiar el nombre ni el usuario', async () => {
  const r = await api('gerente1', 'PUT', `/api/usuarios/${U.dueno}`, { usuario: 'otro' });
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------- eliminar
test('eliminar: sale de la lista, ya no entra, su usuario queda libre y su historial se conserva', async () => {
  const c = await crear('dueno', { nombre: 'Laura Prueba', usuario: 'laura' });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const id = c.json.id;
  // Laura ya hizo una venta (historial que NO debe perderse)
  await pool.query("INSERT INTO tickets (folio, sucursal_id, cajero_usuario_id, estado, total) VALUES ('T-LAURA-1', $1, $2, 'pagado', 120)", [sucursalId, id]);
  assert.equal((await entrar('laura', 'Clave-Nueva-1')).status, 200);

  const r = await api('dueno', 'DELETE', `/api/usuarios/${id}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));

  assert.ok(!(await lista()).find((u) => u.id === id), 'ya no sale en Equipo');
  assert.notEqual((await entrar('laura', 'Clave-Nueva-1')).status, 200, 'ya no puede entrar');
  const fila = (await pool.query('SELECT activo, eliminado_en, usuario, nombre FROM usuarios WHERE id = $1', [id])).rows[0];
  assert.equal(fila.activo, false);
  assert.ok(fila.eliminado_en, 'queda marcado como eliminado');
  assert.equal(fila.nombre, 'Laura Prueba', 'su nombre queda para los reportes');
  const venta = await pool.query("SELECT cajero_usuario_id FROM tickets WHERE folio = 'T-LAURA-1'");
  assert.equal(venta.rows[0].cajero_usuario_id, id, 'la venta sigue ligada a ella');

  // El usuario queda libre: otra persona puede usar «laura»
  const otra = await crear('dueno', { nombre: 'Laura Nueva', usuario: 'laura' });
  assert.equal(otra.status, 200, JSON.stringify(otra.json));
  assert.notEqual(otra.json.id, id);

  const bit = await pool.query("SELECT valor_anterior FROM bitacora WHERE accion = 'eliminar_empleado' AND referencia_id = $1", [id]);
  assert.equal(bit.rows.length, 1, 'queda en la bitácora');
  assert.equal(bit.rows[0].valor_anterior.usuario, 'laura');
});

test('un empleado ya eliminado no se puede editar, restablecer ni eliminar otra vez', async () => {
  const c = await crear('dueno', { nombre: 'Temp Uno', usuario: 'temp1' });
  await api('dueno', 'DELETE', `/api/usuarios/${c.json.id}`);
  assert.equal((await api('dueno', 'PUT', `/api/usuarios/${c.json.id}`, { activo: true })).status, 404);
  assert.equal((await api('dueno', 'PUT', `/api/usuarios/${c.json.id}/restablecer-password`, { password_nueva: 'Otra-Clave-1' })).status, 404);
  assert.equal((await api('dueno', 'DELETE', `/api/usuarios/${c.json.id}`)).status, 404);
});

test('no se puede eliminar al dueño, a uno mismo, ni a un gerente siendo gerente', async () => {
  const dueno = await api('gerente1', 'DELETE', `/api/usuarios/${U.dueno}`);
  assert.equal(dueno.status, 403);
  const yo = await api('gerente1', 'DELETE', `/api/usuarios/${U.gerente1}`);
  assert.equal(yo.status, 400);
  assert.match(yo.json.error, /tu propia cuenta/);
  const colega = await api('gerente1', 'DELETE', `/api/usuarios/${U.gerente2}`);
  assert.equal(colega.status, 403);
  // el dueño sí puede eliminar a un gerente
  const g = await crear('dueno', { nombre: 'Gerente Temporal', usuario: 'gtemp', rol: 'gerente' });
  assert.equal((await api('dueno', 'DELETE', `/api/usuarios/${g.json.id}`)).status, 200);
  // un gerente sí puede eliminar a un cajero
  const cj = await crear('gerente1', { nombre: 'Cajero Temporal', usuario: 'ctemp' });
  assert.equal((await api('gerente1', 'DELETE', `/api/usuarios/${cj.json.id}`)).status, 200);
});

test('un cajero no puede eliminar a nadie', async () => {
  const r = await api('cajera', 'DELETE', `/api/usuarios/${U.carlos}`);
  assert.equal(r.status, 403);
});

test('no se elimina a quien tiene un turno de caja abierto', async () => {
  const c = await crear('dueno', { nombre: 'Turno Abierto', usuario: 'turnoab' });
  const turno = (await pool.query('INSERT INTO turnos (sucursal_id, usuario_id, fondo_inicial) VALUES ($1,$2,500) RETURNING id', [sucursalId, c.json.id])).rows[0].id;
  const bloqueado = await api('dueno', 'DELETE', `/api/usuarios/${c.json.id}`);
  assert.equal(bloqueado.status, 409);
  assert.match(bloqueado.json.error, /turno de caja abierto/);
  assert.ok((await lista()).find((u) => u.id === c.json.id), 'sigue en la lista');
  await pool.query("UPDATE turnos SET estado = 'cerrado', fecha_cierre = NOW() WHERE id = $1", [turno]);
  assert.equal((await api('dueno', 'DELETE', `/api/usuarios/${c.json.id}`)).status, 200);
});

test('no se elimina a un repartidor con pedidos pendientes; ya entregados no estorban', async () => {
  const r = await crear('dueno', { nombre: 'Repa Temporal', usuario: 'repatemp', rol: 'repartidor' });
  const ticket = async (folio) => (await pool.query("INSERT INTO tickets (folio, sucursal_id, estado, total) VALUES ($1, $2, 'pendiente', 100) RETURNING id", [folio, sucursalId])).rows[0].id;
  const t1 = await ticket('T-REPA-1');
  const pedido = (await pool.query("INSERT INTO pedidos (sucursal_id, ticket_id, estado, repartidor_id) VALUES ($1, $2, 'en_camino', $3) RETURNING id", [sucursalId, t1, r.json.id])).rows[0].id;
  const bloqueado = await api('dueno', 'DELETE', `/api/usuarios/${r.json.id}`);
  assert.equal(bloqueado.status, 409);
  assert.match(bloqueado.json.error, /pedidos pendientes/);
  await pool.query("UPDATE pedidos SET estado = 'entregado' WHERE id = $1", [pedido]);
  assert.equal((await api('dueno', 'DELETE', `/api/usuarios/${r.json.id}`)).status, 200);
  // el pedido entregado conserva su repartidor para los reportes
  assert.equal((await pool.query('SELECT repartidor_id FROM pedidos WHERE id = $1', [pedido])).rows[0].repartidor_id, r.json.id);
});

test('un repartidor eliminado ya no sale para asignar pedidos', async () => {
  const r = await crear('dueno', { nombre: 'Repa Fuera', usuario: 'repafuera', rol: 'repartidor' });
  const antes = await api('dueno', 'GET', '/api/pedidos/repartidores');
  if (antes.status === 200 && Array.isArray(antes.json)) {
    assert.ok(antes.json.find((x) => x.id === r.json.id));
    await api('dueno', 'DELETE', `/api/usuarios/${r.json.id}`);
    const despues = await api('dueno', 'GET', '/api/pedidos/repartidores');
    assert.ok(!despues.json.find((x) => x.id === r.json.id));
  } else {
    await api('dueno', 'DELETE', `/api/usuarios/${r.json.id}`);
  }
});
