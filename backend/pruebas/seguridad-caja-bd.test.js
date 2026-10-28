// Seguridad de caja y sesiones con base de datos REAL (revisión de seguridad 2026-10-28):
// tickets cobrados que no se pueden editar, cobros que deben cuadrar y usar el turno propio,
// entradas/salidas solo en turno abierto, sesiones que se cierran al cambiar contraseña,
// avisos en tiempo real solo con sesión, y gerentes que no pueden tocar a otros gerentes.
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('seguridad de caja con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-seguridad-caja-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const lic = require('../utils/licencia');
const pool = require('../db');
const mw = require('../middleware/auth');

let base, servidor, suc1, suc2, productoId, productoOtra;
const T = {}; const U = {}; const TURNO = {};
const CLAVE = 'Clave-Prueba-1';

async function api(quien, metodo, ruta, cuerpo) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250),
      ...(quien && T[quien] ? { Authorization: 'Bearer ' + T[quien] } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const renglon = (extra = {}) => ({ tipo: 'producto', producto_id: productoId, nombre_producto: 'Queso', cantidad: 1, precio_unitario: 100, ...extra });
async function ticketNuevo(quien = 'mostrador') {
  const t = await api(quien, 'POST', '/api/tickets', { items: [renglon()] });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  return t.json;
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
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '017%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2037-12-31', 'anual', 'nube')");
  lic.invalidarCache();

  suc1 = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id")).rows[0].id;
  suc2 = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Otra', true) RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1), ($2)', [suc1, suc2]);
  const hash = await bcrypt.hash(CLAVE, 4);
  const crear = async (usuario, rol, sucursal) => {
    U[usuario] = (await pool.query(
      'INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,$2,$2,$3,$4,true) RETURNING id', [sucursal, usuario, hash, rol])).rows[0].id;
    const l = await api(null, 'POST', '/api/auth/login', { usuario, password: CLAVE });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    T[usuario] = l.json.token;
  };
  await crear('dueno', 'dueno', suc1);
  await crear('gerente', 'gerente', suc1);
  await crear('gerente2', 'gerente', suc1);
  await crear('cajero', 'cajero', suc1);
  await crear('cajero2', 'cajero', suc1);
  await crear('mostrador', 'mostrador', suc1);
  await crear('cajeroOtra', 'cajero', suc2);

  productoId = (await pool.query("INSERT INTO productos (sucursal_id, nombre, precio, tipo_venta, usa_inventario) VALUES ($1,'Queso Oaxaca',100,'unidad',false) RETURNING id", [suc1])).rows[0].id;
  productoOtra = (await pool.query("INSERT INTO productos (sucursal_id, nombre, precio, tipo_venta, usa_inventario) VALUES ($1,'De otra',10,'unidad',false) RETURNING id", [suc2])).rows[0].id;
  for (const [quien, s] of [['cajero', suc1], ['cajero2', suc1], ['cajeroOtra', suc2]]) {
    TURNO[quien] = (await pool.query('INSERT INTO turnos (sucursal_id, usuario_id, fondo_inicial) VALUES ($1,$2,500) RETURNING id', [s, U[quien]])).rows[0].id;
  }
  TURNO.cerrado = (await pool.query("INSERT INTO turnos (sucursal_id, usuario_id, fondo_inicial, estado) VALUES ($1,$2,0,'cerrado') RETURNING id", [suc1, U.cajero])).rows[0].id;
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
});

test('el nombre del renglón sale del catálogo y no se aceptan negativos ni productos de otra sucursal', async () => {
  const t = await api('mostrador', 'POST', '/api/tickets', { items: [renglon({ nombre_producto: '<img src=x onerror=alert(1)>' })] });
  assert.equal(t.status, 200);
  assert.equal(t.json.items[0].nombre_producto, 'Queso Oaxaca');
  const libre = await api('mostrador', 'POST', '/api/tickets', { items: [{ nombre_producto: '<script>x</script>Varios', cantidad: 1, precio_unitario: 5 }] });
  assert.equal(libre.status, 200);
  assert.ok(!/[<>]/.test(libre.json.items[0].nombre_producto));
  assert.equal((await api('mostrador', 'POST', '/api/tickets', { items: [renglon({ precio_unitario: -300 })] })).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/tickets', { items: [renglon({ cantidad: -1 })] })).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/tickets', { items: [renglon({ producto_id: productoOtra })] })).status, 400);
});

test('un ticket cobrado ya no se puede modificar, ni desde otra sucursal', async () => {
  const t = await ticketNuevo();
  const itemId = (await pool.query('SELECT id FROM ticket_detalle WHERE ticket_id = $1', [t.id])).rows[0].id;
  assert.equal((await api('cajeroOtra', 'PUT', `/api/tickets/item/${itemId}`, { cantidad: 5 })).status, 404, 'otra sucursal');
  const pago = await api('cajero', 'POST', `/api/tickets/${t.id}/pagar`, { metodo_pago: 'efectivo', monto_efectivo: 100, turno_id: TURNO.cajero });
  assert.equal(pago.status, 200, JSON.stringify(pago.json));
  assert.equal((await api('cajero', 'PUT', `/api/tickets/item/${itemId}`, { cantidad: 500 })).status, 404, 'ya cobrado');
  assert.equal((await api('cajero', 'DELETE', `/api/tickets/item/${itemId}`)).status, 404, 'ya cobrado');
  const fila = (await pool.query('SELECT cantidad FROM ticket_detalle WHERE id = $1', [itemId])).rows[0];
  assert.equal(Number(fila.cantidad), 1);
});

test('cobrar: el monto debe cubrir el total, con forma de pago válida y en el turno abierto propio', async () => {
  const t = await ticketNuevo();
  const pagar = (quien, cuerpo) => api(quien, 'POST', `/api/tickets/${t.id}/pagar`, cuerpo);
  assert.equal((await pagar('cajero', { metodo_pago: 'efectivo', monto_efectivo: 0, turno_id: TURNO.cajero })).status, 400, 'cobro en cero');
  assert.equal((await pagar('cajero', { metodo_pago: 'zzz', monto_efectivo: 100, turno_id: TURNO.cajero })).status, 400, 'método inventado');
  assert.equal((await pagar('cajero', { metodo_pago: 'efectivo', monto_efectivo: -50, monto_tarjeta: 150, turno_id: TURNO.cajero })).status, 400, 'negativo');
  assert.equal((await pagar('cajero', { metodo_pago: 'efectivo', monto_efectivo: 100 })).status, 400, 'sin turno');
  assert.equal((await pagar('cajero', { metodo_pago: 'efectivo', monto_efectivo: 100, turno_id: TURNO.cerrado })).status, 409, 'turno cerrado');
  assert.equal((await pagar('cajero', { metodo_pago: 'efectivo', monto_efectivo: 100, turno_id: TURNO.cajero2 })).status, 403, 'turno de otro cajero');
  assert.equal((await pagar('mostrador', { metodo_pago: 'efectivo', monto_efectivo: 100, turno_id: TURNO.cajero })).status, 403, 'mostrador con turno ajeno');
  assert.equal((await pagar('cajeroOtra', { metodo_pago: 'efectivo', monto_efectivo: 100, turno_id: TURNO.cajeroOtra })).status, 409, 'ticket de otra sucursal');
  const ok = await pagar('dueno', { metodo_pago: 'mixto', monto_efectivo: 40, monto_tarjeta: 60, turno_id: TURNO.cajero2 });
  assert.equal(ok.status, 200, 'el dueño puede cobrar en un turno abierto de su sucursal');
});

test('cancelar solo tickets de la propia sucursal', async () => {
  const t = await ticketNuevo();
  await api('cajeroOtra', 'POST', `/api/tickets/${t.id}/cancelar`, { motivo: 'x' });
  assert.equal((await pool.query('SELECT estado FROM tickets WHERE id = $1', [t.id])).rows[0].estado, 'pendiente');
});

test('entradas y salidas de caja: solo en el turno abierto propio, con monto positivo', async () => {
  const mov = (quien, cuerpo) => api(quien, 'POST', '/api/movimientos', cuerpo);
  assert.equal((await mov('cajero', { turno_id: TURNO.cerrado, tipo: 'egreso', monto: 500 })).status, 409);
  assert.equal((await mov('cajero', { turno_id: TURNO.cajero2, tipo: 'egreso', monto: 500 })).status, 403);
  assert.equal((await mov('cajero', { turno_id: TURNO.cajeroOtra, tipo: 'egreso', monto: 500 })).status, 400);
  assert.equal((await mov('cajero', { turno_id: TURNO.cajero, tipo: 'egreso', monto: -5 })).status, 400);
  assert.equal((await mov('cajero', { turno_id: TURNO.cajero, tipo: 'egreso', monto: 50, concepto: 'Gas' })).status, 200);
  assert.equal((await api('cajeroOtra', 'GET', `/api/movimientos/turno/${TURNO.cajero}`)).json.length, 0, 'no ve movimientos de otra sucursal');
});

test('venta sin internet: no enseña tickets de otra sucursal y pide permiso para descuentos', async () => {
  const t = await ticketNuevo();
  const otra = await api('cajeroOtra', 'POST', '/api/tickets/venta-offline', { folio: t.folio, metodo_pago: 'efectivo', monto_efectivo: 10, items: [{ nombre_producto: 'x', cantidad: 1, precio_unitario: 10 }] });
  assert.equal(otra.status, 409);
  const desc = await api('cajero', 'POST', '/api/tickets/venta-offline', { folio: 'OFF12345', metodo_pago: 'efectivo', monto_efectivo: 1, descuento_monto: 99, turno_id: TURNO.cajero, items: [renglon()] });
  assert.equal(desc.status, 403);
  const corto = await api('cajero', 'POST', '/api/tickets/venta-offline', { folio: 'OFF12346', metodo_pago: 'efectivo', monto_efectivo: 1, turno_id: TURNO.cajero, items: [renglon()] });
  assert.equal(corto.status, 400, 'lo cobrado no cubre la venta');
  const bien = await api('cajero', 'POST', '/api/tickets/venta-offline', { folio: 'OFF12347', metodo_pago: 'efectivo', monto_efectivo: 100, turno_id: TURNO.cajero, items: [renglon()] });
  assert.equal(bien.status, 200, JSON.stringify(bien.json));
});

test('sesión: un cambio de rol aplica de inmediato y al restablecer la contraseña se cierran sus sesiones', async () => {
  // le quitan al cajero el permiso de devolver: aplica sin que vuelva a entrar
  await pool.query(`UPDATE usuarios SET permisos = '{"VENTAS_CANCELAR": false}' WHERE id = $1`, [U.cajero2]);
  mw._limpiarMemoriaActivos();
  const t = await ticketNuevo();
  assert.equal((await api('cajero2', 'POST', `/api/tickets/${t.id}/cancelar`, {})).status, 403);
  // el dueño le restablece la contraseña: la sesión vieja deja de servir
  assert.equal((await api('dueno', 'PUT', `/api/usuarios/${U.cajero2}/restablecer-password`, { password_nueva: 'Otra-Clave-9' })).status, 200);
  assert.equal((await api('cajero2', 'GET', '/api/turnos/actual')).status, 401);
  // y cambiar la propia contraseña devuelve una sesión nueva que sí sirve
  const r = await api('cajero', 'PUT', '/api/auth/cambiar-password', { password_actual: CLAVE, password_nueva: 'Nueva-Clave-7' });
  assert.equal(r.status, 200);
  assert.equal((await api('cajero', 'GET', '/api/turnos/actual')).status, 401, 'la sesión vieja ya no');
  T.cajero = r.json.token;
  assert.equal((await api('cajero', 'GET', '/api/turnos/actual')).status, 200, 'la nueva sí');
});

test('un gerente no puede crear, editar ni restablecer a otro gerente', async () => {
  assert.equal((await api('gerente', 'POST', '/api/usuarios', { nombre: 'G3', usuario: 'g3', password: 'Clave-123456', rol: 'gerente' })).status, 403);
  assert.equal((await api('gerente', 'PUT', `/api/usuarios/${U.gerente2}`, { activo: false })).status, 403);
  assert.equal((await api('gerente', 'PUT', `/api/usuarios/${U.gerente2}/restablecer-password`, { password_nueva: 'Clave-123456' })).status, 403);
  assert.equal((await api('dueno', 'PUT', `/api/usuarios/${U.gerente2}`, { nombre: 'Gerente Dos' })).status, 200);
});

test('avisos en tiempo real (socket.io): sin sesión no se conecta', async () => {
  const conectar = async (token) => {
    const abrir = await (await fetch(base + '/socket.io/?EIO=4&transport=polling')).text();
    const sid = JSON.parse(abrir.slice(1)).sid;
    const u = base + '/socket.io/?EIO=4&transport=polling&sid=' + sid;
    await fetch(u, { method: 'POST', body: '40' + (token ? JSON.stringify({ token }) : ''), headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
    return (await fetch(u)).text();
  };
  assert.match(await conectar(null), /^44/, 'sin token: rechazado');
  assert.match(await conectar('basura'), /^44/, 'token falso: rechazado');
  assert.match(await conectar(T.dueno), /^40/, 'con sesión: conecta');
});

test('encabezados de seguridad presentes', async () => {
  const r = await fetch(base + '/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('x-powered-by'), null);
  const grande = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: 'x', password: 'y'.repeat(3 * 1024 * 1024) }) });
  assert.equal(grande.status, 413, 'el login no acepta cuerpos enormes');
});
