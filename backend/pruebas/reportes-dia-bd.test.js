// Reportes y «hoy» del inicio: cada día va de medianoche a medianoche en México (TZ_NEGOCIO),
// sin importar la zona horaria de la base ni la del programa. Antes, en la nube, el día iba de 6 pm
// a 6 pm y las ventas de la noche salían al día siguiente (y la prueba del CSV fallaba de noche).
// Necesita TEST_DATABASE_URL (BORRA y vuelve a crear el esquema de esa base).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('reportes por día del negocio: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-reportes-dia-0123456789abcdef0123';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.TZ_NEGOCIO = 'America/Mexico_City';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const lic = require('../utils/licencia');
const pool = require('../db');
const { rangoDelNegocio } = require('../utils/diaNegocio');

let base, servidor, sucA, sucB;
const T = {};
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const uno = async (sql, v) => (await pool.query(sql, v)).rows[0];

async function api(quien, ruta) {
  const r = await fetch(base + ruta, { headers: { Authorization: 'Bearer ' + T[quien] } });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch (e) { /* no es JSON */ }
  return { status: r.status, json, texto };
}

// Hora "de pared" de la base para una hora local de México (así la guarda NOW() en ese servidor).
const enBase = (horaMexico) => `(('${horaMexico}'::timestamp AT TIME ZONE 'America/Mexico_City') AT TIME ZONE current_setting('TimeZone'))`;
let folioN = 0;
async function ticket(sucursal, total, fechaSql, estado = 'pagado') {
  const folio = 'DIA-' + (++folioN);
  await pool.query(
    `INSERT INTO tickets (folio, sucursal_id, estado, total, metodo_pago, fecha_creacion, fecha_pago)
     VALUES ($1, $2, $3, $4, 'efectivo', ${fechaSql}, ${estado === 'pagado' ? fechaSql : 'NULL'})`,
    [folio, sucursal, estado, total]
  );
  return folio;
}

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  const totalMigraciones = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).length;
  for (let i = 0; i < 200; i++) {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations').catch(() => ({ rows: [{ n: 0 }] }));
    if (r.rows[0].n >= totalMigraciones) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2037-12-31', 'anual', 'nube')");
  lic.invalidarCache();
  sucA = (await uno("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id")).id;
  sucB = (await uno("INSERT INTO sucursales (nombre, activo) VALUES ('Hoy', true) RETURNING id")).id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1), ($2)', [sucA, sucB]);
  for (const [clave, suc] of [['duenoA', sucA], ['duenoB', sucB]]) {
    const id = (await uno(
      "INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo, permisos) VALUES ($1, $2, $2, 'x', 'dueno', true, '{}') RETURNING id",
      [suc, clave])).id;
    T[clave] = jwt.sign({ id, nombre: clave, usuario: clave, rol: 'dueno', sucursal_id: suc, permisos: {}, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  }
});

test.after(async () => {
  if (servidor) await new Promise((ok) => servidor.close(ok));
  await pool.end();
});

test('el día del negocio es de medianoche a medianoche en México con la base en UTC o en hora de México', async () => {
  for (const [zona, desde, hasta] of [['UTC', '2026-11-24 06:00:00', '2026-11-25 06:00:00'], ['America/Mexico_City', '2026-11-24 00:00:00', '2026-11-25 00:00:00']]) {
    const db = new Pool({ connectionString: URL_BD, options: `-c TimeZone=${zona}` });
    try {
      const r = await rangoDelNegocio({ desde: '2026-11-24', hasta: '2026-11-25' }, db);
      assert.deepEqual([r.desde, r.hasta, r.diaDesde, r.diaHasta, r.dias], [desde, hasta, '2026-11-24', '2026-11-25', 1], zona);
    } finally { await db.end(); }
  }
});

test('reporte de ventas: las ventas de la noche cuentan en su día (no en el siguiente)', async () => {
  await ticket(sucA, 3, enBase('2026-11-23 23:30'));
  await ticket(sucA, 100, enBase('2026-11-24 08:00'));
  await ticket(sucA, 50, enBase('2026-11-24 19:30')); // después de las 6 pm: antes se iba al día siguiente
  await ticket(sucA, 7, enBase('2026-11-25 00:30'));
  const r = await api('duenoA', '/api/reportes/ventas?desde=2026-11-24&hasta=2026-11-25');
  assert.equal(r.status, 200);
  assert.equal(Number(r.json.total_general.total), 150);
  assert.equal(Number(r.json.total_general.num_tickets), 2);
  assert.deepEqual(r.json.rango, { desde: '2026-11-24', hasta: '2026-11-25' });
  const dia25 = await api('duenoA', '/api/reportes/ventas?desde=2026-11-25&hasta=2026-11-26');
  assert.equal(Number(dia25.json.total_general.total), 7);
});

test('CSV de ventas: trae las ventas del día completo, también las de la noche', async () => {
  const r = await api('duenoA', '/api/reportes/ventas/exportar-csv?desde=2026-11-24&hasta=2026-11-25');
  assert.equal(r.status, 200);
  const filas = r.texto.trim().split('\n').slice(1);
  assert.equal(filas.length, 2);
  assert.match(r.texto, /\n50(\.00)?,|,50(\.00)?,/);
});

test('fechas mal escritas: 400 con un mensaje, no error del servidor', async () => {
  for (const q of ['desde=abc&hasta=2026-11-25', 'desde=2026-11-24&hasta=25/11/2026']) {
    const r = await api('duenoA', '/api/reportes/ventas?' + q);
    assert.equal(r.status, 400, q);
    assert.match(r.json.error, /Fechas no válidas/);
  }
});

test('pérdidas: una cancelación de la noche cae en su día y en su hora de México', async () => {
  await ticket(sucA, 40, enBase('2026-11-24 20:15'), 'cancelado');
  const r = await api('duenoA', '/api/reportes/perdidas?desde=2026-11-24&hasta=2026-11-25');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.serie.map((f) => f.clave), ['2026-11-24']);
  assert.equal(r.json.serie[0].cancelaciones, 1);
  assert.equal(r.json.serie[0].ventas, 150);
  assert.equal(r.json.por_hora[20].cancelaciones, 1);
});

test('inicio: «ventas de hoy» es el día de México y la hora de cada venta es la de México', async () => {
  await ticket(sucB, 11, 'NOW()');
  const ayerNoche = (await uno("SELECT to_char((NOW() AT TIME ZONE 'America/Mexico_City')::date - 1, 'YYYY-MM-DD') || ' 23:00' AS h")).h;
  await ticket(sucB, 5, enBase(ayerNoche));
  const r = await api('duenoB', '/api/dashboard/resumen');
  assert.equal(r.status, 200);
  assert.equal(Number(r.json.ventas_hoy.total), 11);
  const horaMx = Number((await uno("SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE 'America/Mexico_City') AS h")).h);
  assert.deepEqual(r.json.ventas_por_hora.map((f) => Number(f.hora)), [horaMx]);
});
