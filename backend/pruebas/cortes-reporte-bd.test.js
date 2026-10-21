// Reporte de cortes por periodo (GET /api/turnos/reporte) con base de datos REAL.
// Necesita una base VACÍA de pruebas (se borra todo lo que tenga):
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('reporte de cortes con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-cortes-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const lic = require('../utils/licencia');
const pool = require('../db');

let base, servidor, sucursalId, otraSucursalId;
const T = {}; // tokens
const U = {}; // ids de usuario
const TURNO = {}; // ids de turno por nombre

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

// Las horas se pasan como instante absoluto (ISO con Z) y se guardan como las guarda el servidor
// (hora de pared de la zona de la base), así la prueba vale igual si la base corre en UTC o en hora local.
let folio = 0;
async function turno({ usuario, apertura, cierre, estado = 'cerrado', declaracion = null, contado = null, teorico = 0, sucursal }) {
  const r = await pool.query(
    `INSERT INTO turnos (sucursal_id, usuario_id, fondo_inicial, saldo_teorico, saldo_contado, estado, fecha_apertura, fecha_cierre, declaracion)
     VALUES ($1, $2, 500, $3, $4, $5, $6::timestamptz AT TIME ZONE current_setting('TimeZone'),
             CASE WHEN $7::text IS NULL THEN NULL ELSE $7::timestamptz AT TIME ZONE current_setting('TimeZone') END, $8) RETURNING id`,
    [sucursal || sucursalId, usuario, teorico, contado, estado, apertura, cierre, declaracion ? JSON.stringify(declaracion) : null]);
  return r.rows[0].id;
}
async function ticket(turnoId, { total, metodo, ef = 0, tj = 0, desc = 0, estado = 'pagado', descDetalle = 0, usuario }) {
  folio++;
  const id = (await pool.query(
    `INSERT INTO tickets (folio, sucursal_id, cajero_usuario_id, turno_id, estado, total, metodo_pago, monto_efectivo, monto_tarjeta, descuento_monto, fecha_pago)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()) RETURNING id`,
    ['T' + String(folio).padStart(5, '0'), sucursalId, usuario || U.cajera, turnoId, estado, total, metodo, ef, tj, desc])).rows[0].id;
  if (descDetalle > 0) {
    await pool.query(
      `INSERT INTO ticket_detalle (ticket_id, nombre_producto, cantidad, precio_unitario, subtotal, descuento_monto) VALUES ($1, 'Queso', 1, $2, $2, $3)`,
      [id, total, descDetalle]);
  }
  return id;
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
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '013%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2037-12-31', 'anual', 'nube')");
  lic.invalidarCache();

  sucursalId = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id")).rows[0].id;
  otraSucursalId = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Otra', true) RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1)', [sucursalId]);
  const hash = await bcrypt.hash('Clave-Prueba-1', 4);
  const usuario = async (nombre, user, rol, suc = sucursalId) => {
    const id = (await pool.query(
      'INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,$2,$3,$4,$5,true) RETURNING id', [suc, nombre, user, hash, rol])).rows[0].id;
    U[user] = id;
    T[user] = jwt.sign({ id, nombre, usuario: user, rol, sucursal_id: suc, permisos: {} }, process.env.JWT_SECRET, { expiresIn: '1h' });
  };
  await usuario('Dueño', 'dueno', 'dueno');
  await usuario('Gerente', 'gerente', 'gerente');
  await usuario('Cajera Uno', 'cajera', 'cajero');
  await usuario('Cajera Dos', 'cajera2', 'cajero');
  await usuario('Otro Dueño', 'dueno_otra', 'dueno', otraSucursalId);

  // Turno A: cajera, abrió el 20 oct a las 18:10 hora de México (= 21 oct 00:10 UTC) → su día es el 20.
  TURNO.A = await turno({ usuario: U.cajera, apertura: '2026-10-21T00:10:00Z', cierre: '2026-10-21T03:00:00Z', teorico: 1000, contado: 1030.5,
    declaracion: { diferencia: 30.5, total_declarado: 1030.5, total_esperado: 1000 } });
  await ticket(TURNO.A, { total: 100, metodo: 'efectivo', ef: 100 });
  await ticket(TURNO.A, { total: 200, metodo: 'tarjeta', tj: 200 });
  await ticket(TURNO.A, { total: 150, metodo: 'mixto', ef: 50, tj: 100 });
  await ticket(TURNO.A, { total: 80, metodo: 'transferencia', tj: 80 });
  await ticket(TURNO.A, { total: 60, metodo: 'dolares', tj: 60 });
  await ticket(TURNO.A, { total: 40, metodo: 'vale_despensa', tj: 40 });
  await ticket(TURNO.A, { total: 90, metodo: 'credito', desc: 10 });
  await ticket(TURNO.A, { total: 120, metodo: 'efectivo', ef: 100, descDetalle: 20 });
  await ticket(TURNO.A, { total: 999, metodo: 'efectivo', ef: 999, estado: 'cancelado' });

  // Turno B: cajera2, 5 oct, sin declaración guardada pero con saldo contado: 500 vs 520 teóricos → faltan 20.
  TURNO.B = await turno({ usuario: U.cajera2, apertura: '2026-10-05T15:00:00Z', cierre: '2026-10-05T23:00:00Z', teorico: 520, contado: 500 });
  await ticket(TURNO.B, { total: 300, metodo: 'efectivo', ef: 300, usuario: U.cajera2 });

  // Turno C: sigue abierto en octubre (no es un corte todavía).
  TURNO.C = await turno({ usuario: U.cajera, apertura: '2026-10-19T15:00:00Z', cierre: null, estado: 'abierto' });
  // Turno D: septiembre (fuera del periodo).
  TURNO.D = await turno({ usuario: U.cajera, apertura: '2026-09-15T15:00:00Z', cierre: '2026-09-15T23:00:00Z', declaracion: { diferencia: 0 }, contado: 0 });
  // Turno E: de otra sucursal, mismas fechas (no debe verse).
  TURNO.E = await turno({ usuario: U.dueno_otra, apertura: '2026-10-05T15:00:00Z', cierre: '2026-10-05T23:00:00Z', declaracion: { diferencia: 0 }, sucursal: otraSucursalId });
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
});

const reporte = (quien, q = 'desde=2026-10-01&hasta=2026-10-31') => api(quien, 'GET', '/api/turnos/reporte?' + q);

test('el dueño ve los cortes cerrados del periodo, sin turnos abiertos, de otros meses ni de otra sucursal', async () => {
  const r = await reporte('dueno');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.turnos.map((t) => t.id).sort(), [TURNO.A, TURNO.B].sort());
  assert.equal(r.json.abiertos, 1, 'avisa que hay un turno abierto sin cortar');
  assert.equal(r.json.desde, '2026-10-01');
  assert.equal(r.json.hasta, '2026-10-31');
});

test('los totales de cada turno coinciden con el corte del turno (resumen)', async () => {
  const r = await reporte('dueno');
  for (const id of [TURNO.A, TURNO.B]) {
    const fila = r.json.turnos.find((t) => t.id === id);
    const res = (await api('dueno', 'GET', `/api/turnos/${id}/resumen`)).json;
    assert.equal(fila.efectivo, res.formas.efectivo, `efectivo del turno ${id}`);
    assert.equal(fila.tarjeta, res.formas.tarjeta, `tarjeta del turno ${id}`);
    assert.equal(fila.transferencia, res.formas.transferencia, `transferencia del turno ${id}`);
    assert.equal(fila.credito, res.formas.credito, `crédito del turno ${id}`);
    assert.equal(fila.otros, Math.round((res.formas.dolares + res.formas.cheque + res.formas.vales) * 100) / 100, `otros del turno ${id}`);
    assert.equal(fila.venta_neta, res.ventas.venta_neta, `venta neta del turno ${id}`);
    assert.equal(fila.descuentos, res.ventas.descuentos, `descuentos del turno ${id}`);
    assert.equal(fila.tickets, res.cuentas.normales, `tickets del turno ${id}`);
  }
});

test('el turno A trae los números esperados (cada forma de pago, descuentos y cancelados fuera)', async () => {
  const a = (await reporte('dueno')).json.turnos.find((t) => t.id === TURNO.A);
  assert.equal(a.efectivo, 250);        // 100 + 50 (mixto) + 100
  assert.equal(a.tarjeta, 300);         // 200 + 100 (mixto)
  assert.equal(a.transferencia, 80);
  assert.equal(a.otros, 100);           // dólares 60 + vales 40
  assert.equal(a.credito, 80);          // 90 - 10 de descuento
  assert.equal(a.descuentos, 30);       // 10 del ticket + 20 del renglón
  assert.equal(a.venta_neta, 810);      // 100+200+150+80+60+40+90+120 = 840 − 30
  assert.equal(a.tickets, 8, 'el ticket cancelado no cuenta');
  assert.equal(a.cajero, 'Cajera Uno');
  assert.equal(a.declarado, true);
  assert.equal(a.diferencia, 30.5);
});

test('sin declaración guardada, la diferencia sale de saldo contado menos teórico', async () => {
  const b = (await reporte('dueno')).json.turnos.find((t) => t.id === TURNO.B);
  assert.equal(b.diferencia, -20);
  assert.equal(b.venta_neta, 300);
});

test('el día de un turno es el día LOCAL en que abrió (18:10 en México = 00:10 UTC del día siguiente)', async () => {
  const a = (await reporte('dueno')).json.turnos.find((t) => t.id === TURNO.A);
  assert.equal(a.dia, '2026-10-20');
  const dia20 = await reporte('dueno', 'desde=2026-10-20&hasta=2026-10-20');
  assert.deepEqual(dia20.json.turnos.map((t) => t.id), [TURNO.A]);
  const dia21 = await reporte('dueno', 'desde=2026-10-21&hasta=2026-10-21');
  assert.equal(dia21.json.turnos.length, 0, 'ese turno no se cuela en el día 21');
  const hasta19 = await reporte('dueno', 'desde=2026-10-06&hasta=2026-10-19');
  assert.equal(hasta19.json.turnos.length, 0);
});

test('el buscador de cortes (historial) también cuenta ese turno en el día 20', async () => {
  const h = await api('dueno', 'GET', '/api/turnos/historial?desde=2026-10-20&hasta=2026-10-20');
  assert.deepEqual(h.json.map((t) => t.id), [TURNO.A]);
  const h21 = await api('dueno', 'GET', '/api/turnos/historial?desde=2026-10-21&hasta=2026-10-21');
  assert.equal(h21.json.length, 0);
});

test('cada cajera solo ve sus propios cortes', async () => {
  const uno = await reporte('cajera');
  assert.deepEqual(uno.json.turnos.map((t) => t.id), [TURNO.A]);
  const dos = await reporte('cajera2');
  assert.deepEqual(dos.json.turnos.map((t) => t.id), [TURNO.B]);
  // aunque pida el de otra persona con usuario_id, no se le hace caso
  const intento = await reporte('cajera2', `desde=2026-10-01&hasta=2026-10-31&usuario_id=${U.cajera}`);
  assert.deepEqual(intento.json.turnos.map((t) => t.id), [TURNO.B]);
});

test('el gerente ve todos y puede filtrar por cajero', async () => {
  const todos = await reporte('gerente');
  assert.equal(todos.json.turnos.length, 2);
  const solo = await reporte('gerente', `desde=2026-10-01&hasta=2026-10-31&usuario_id=${U.cajera2}`);
  assert.deepEqual(solo.json.turnos.map((t) => t.id), [TURNO.B]);
});

test('otra sucursal tiene su propio reporte', async () => {
  const r = await reporte('dueno_otra');
  assert.deepEqual(r.json.turnos.map((t) => t.id), [TURNO.E]);
});

test('fechas mal puestas se rechazan y sin fechas usa el mes actual', async () => {
  assert.equal((await reporte('dueno', 'desde=2026-10-31&hasta=2026-10-01')).status, 400);
  assert.equal((await reporte('dueno', 'desde=2020-01-01&hasta=2026-10-01')).status, 400, 'más de un año');
  const sinFechas = await reporte('dueno', '');
  assert.equal(sinFechas.status, 200);
  assert.match(sinFechas.json.desde, /^\d{4}-\d{2}-01$/);
  assert.match(sinFechas.json.hasta, /^\d{4}-\d{2}-\d{2}$/);
  const raras = await reporte('dueno', 'desde=' + encodeURIComponent("x'; DROP TABLE turnos;--") + '&hasta=hoy');
  assert.equal(raras.status, 200, 'fechas inválidas se ignoran, no rompen');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM turnos')).rows[0].n, 5, 'la tabla sigue completa');
});

test('sin sesión no se puede ver el reporte', async () => {
  assert.equal((await api(null, 'GET', '/api/turnos/reporte')).status, 401);
});
