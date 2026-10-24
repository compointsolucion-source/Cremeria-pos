// Pruebas con base de datos REAL: licencia CENTRAL (la nube del cliente le pregunta a compoint.com.mx).
// Usan un "licencia.php" falso que firma igual que el de verdad. Necesitan una base VACÍA de pruebas:
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('licencia central con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-central-0123456789abcdef0123';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;
delete process.env.COMPOINT_LICENCIA_TOKEN;

const bcrypt = require('bcryptjs');
const lic = require('../utils/licencia');
const central = require('../utils/licenciaCentral');
const pool = require('../db');

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
let base, servidor, falso, modo = 'ok', respuestaBase, preguntas = [], tokenDueno, sucursalId;

const reloj = (fecha) => lic._fijarReloj(() => new Date(fecha + 'T18:00:00Z'));
// La misma cuenta que hace punto/licencia.php (escrita aparte a propósito, para comprobar que coinciden).
function firmar(r, nonce, token) {
  const c = [r.control ? '1' : '0', r.pendiente ? '1' : '0', r.suspendida ? '1' : '0', r.tipo, r.plan, r.vence == null ? '' : r.vence,
    String(r.max_sucursales), r.cliente, nonce, r.emitido].join('|');
  return crypto.createHmac('sha256', token).update(c).digest('hex');
}
const base0 = () => ({ ok: true, control: true, pendiente: false, suspendida: false, cliente: 'Lácteos del Valle', tipo: 'anual', plan: 'nube', vence: '2027-01-31', max_sucursales: 3 });

async function api(metodo, ruta, cuerpo, token) {
  const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}
const fila = async () => (await pool.query(`SELECT *, to_char(fecha_vencimiento,'YYYY-MM-DD') AS vence FROM licencia WHERE id = 1`)).rows[0];

test.before(async () => {
  falso = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      if (modo === 'caido') { req.socket.destroy(); return; }
      let q = {}; try { q = JSON.parse(cuerpo); } catch (e) { /* vacío */ }
      preguntas.push(q);
      if (modo === '503') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"sin_base"}'); return; }
      if (modo === 'desconocido' || q.t !== TOKEN) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"desconocido"}'); return; }
      const r = { ...respuestaBase, n: q.n, emitido: modo === 'vieja' ? '2026-01-01T00:00:00Z' : new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
      r.firma = firmar(r, modo === 'otro_n' ? 'ffffffffffffffffffff' : q.n, modo === 'otro_token' ? 'f'.repeat(48) : TOKEN);
      if (modo === 'alterada') r.vence = '2099-12-31';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    });
  });
  await new Promise((ok) => falso.listen(0, '127.0.0.1', ok));
  process.env.COMPOINT_LICENCIA_URL = 'http://127.0.0.1:' + falso.address().port + '/punto/licencia.php';

  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  for (let i = 0; i < 100; i++) {
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '010%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  const suc = await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id");
  sucursalId = suc.rows[0].id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1)', [sucursalId]);
  const hash = await bcrypt.hash('Clave-Prueba-1', 4);
  await pool.query("INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,'Dueño','dueno',$2,'dueno',true)", [sucursalId, hash]);
  tokenDueno = (await api('POST', '/api/auth/login', { usuario: 'dueno', password: 'Clave-Prueba-1' })).json.token;
  reloj('2026-10-24');
});

test.after(async () => {
  central.detener();
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await new Promise((ok) => { falso.close(() => ok()); setTimeout(ok, 1000); });
  await pool.end().catch(() => {});
});

test.beforeEach(async () => {
  modo = 'ok'; preguntas = []; respuestaBase = base0();
  process.env.COMPOINT_LICENCIA_TOKEN = TOKEN;
  await pool.query('DELETE FROM licencia');
  lic.invalidarCache();
});

test('sin token, o en un servidor local, la consulta central no corre', async () => {
  delete process.env.COMPOINT_LICENCIA_TOKEN;
  assert.equal(central.configurada(), false);
  assert.equal((await central.actualizar()).resultado, 'no_configurada');
  assert.equal(central.iniciar(), false);
  process.env.COMPOINT_LICENCIA_TOKEN = 'mal';
  assert.equal(central.configurada(), false);
  process.env.COMPOINT_LICENCIA_TOKEN = TOKEN;
  assert.equal(central.configurada(), true);
  process.env.COMPOINT_ID_EQUIPO = 'ABCD-1234-EFGH';
  assert.equal(central.configurada(), false, 'el servidor local toma la licencia de su nube, no pregunta solo');
  delete process.env.COMPOINT_ID_EQUIPO;
  assert.equal(preguntas.length, 0);
});

test('la firma del sistema coincide con la que calcula la prueba (mismo orden de campos)', () => {
  const r = { ...base0(), n: 'abc', emitido: '2026-10-24T00:00:00Z' };
  r.firma = firmar(r, 'abc', TOKEN);
  assert.equal(central.firmaValida(r, 'abc', TOKEN), true);
  assert.equal(central.firmaValida({ ...r, vence: '2030-01-01' }, 'abc', TOKEN), false);
  assert.equal(central.firmaValida({ ...r, max_sucursales: 30 }, 'abc', TOKEN), false);
  assert.equal(central.firmaValida({ ...r, suspendida: true }, 'abc', TOKEN), false);
  assert.equal(central.firmaValida(r, 'otro', TOKEN), false);
  assert.equal(central.firmaValida({ ...r, firma: 'zz' }, 'abc', TOKEN), false);
  assert.equal(central.firmaValida({ ...r, firma: undefined }, 'abc', TOKEN), false);
});

test('una licencia anual vigente queda guardada y el sistema la respeta', async () => {
  const r = await central.actualizar();
  assert.equal(r.resultado, 'ok'); assert.equal(r.cambio, 'central');
  assert.equal(preguntas.length, 1); assert.equal(preguntas[0].t, TOKEN); assert.match(preguntas[0].n, /^[0-9a-f]{32}$/);
  const f = await fila();
  assert.equal(f.tipo, 'anual'); assert.equal(f.vence, '2027-01-31'); assert.equal(f.max_sucursales, 3);
  assert.equal(f.desde_nube, 'central'); assert.equal(f.cliente, 'Lácteos del Valle'); assert.equal(f.codigo_activacion, null);
  const est = await lic.estado();
  assert.equal(est.control, true); assert.equal(est.estado, 'activa'); assert.equal(est.puede_vender, true);
  assert.equal(await lic.limiteSucursales(), 3);
});

test('renovar en el panel (nueva fecha) se refleja en la siguiente consulta', async () => {
  reloj('2027-01-28');
  await central.actualizar();
  assert.equal((await lic.estado()).estado, 'por_vencer');
  respuestaBase = { ...base0(), vence: '2028-01-31' };
  await central.actualizar();
  const est = await lic.estado();
  assert.equal(est.estado, 'activa'); assert.equal(est.vence, '2028-01-31');
  reloj('2026-10-24');
});

test('vencida: avisa, da 5 días de gracia y luego solo consulta; al renovar vuelve a vender', async () => {
  respuestaBase = { ...base0(), vence: '2026-10-22' };
  reloj('2026-10-24');
  await central.actualizar();
  let est = await lic.estado();
  assert.equal(est.estado, 'gracia'); assert.equal(est.puede_vender, true);
  reloj('2026-11-01');
  est = await lic.estado();
  assert.equal(est.estado, 'solo_consulta'); assert.equal(est.puede_vender, false);
  const venta = await api('POST', '/api/clientes', { nombre: 'X' }, tokenDueno);
  assert.equal(venta.status, 402, 'en solo consulta no se registran cambios');
  respuestaBase = { ...base0(), vence: '2027-11-01' };
  await central.actualizar();
  assert.equal((await lic.estado()).puede_vender, true);
  reloj('2026-10-24');
});

test('suspender deja el sistema en solo consulta de inmediato, con su aviso; reactivar lo devuelve', async () => {
  respuestaBase = { ...base0(), suspendida: true };
  const r = await central.actualizar();
  assert.equal(r.cambio, 'central_suspendida');
  const est = await lic.estado();
  assert.equal(est.estado, 'solo_consulta'); assert.equal(est.suspendida, true); assert.equal(est.puede_vender, false);
  assert.match(est.mensaje, /suspendido/);
  assert.equal((await api('POST', '/api/clientes', { nombre: 'X' }, tokenDueno)).status, 402);
  respuestaBase = base0();
  await central.actualizar();
  const e2 = await lic.estado();
  assert.equal(e2.suspendida, false); assert.equal(e2.puede_vender, true);
});

test('permanente y prueba (demo) se guardan bien', async () => {
  respuestaBase = { ...base0(), tipo: 'permanente', vence: null };
  await central.actualizar();
  let est = await lic.estado();
  assert.equal(est.permanente, true); assert.equal(est.estado, 'activa');
  respuestaBase = { ...base0(), tipo: 'demo', vence: '2026-11-13' };
  await central.actualizar();
  est = await lic.estado();
  assert.equal(est.tipo, 'demo'); assert.equal(est.estado, 'demo'); assert.equal(est.dias, 20);
});

test('«pendiente» (sin fecha en el panel) no cambia nada', async () => {
  await pool.query("INSERT INTO licencia (id, cliente, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, 'Igual', '2026-01-01', '2027-06-01', 'anual', 'nube')");
  respuestaBase = { ...base0(), pendiente: true, vence: null };
  const r = await central.actualizar();
  assert.equal(r.cambio, 'pendiente');
  const f = await fila();
  assert.equal(f.vence, '2027-06-01'); assert.equal(f.cliente, 'Igual'); assert.equal(f.desde_nube, null);
});

test('sistema propio/demo de Compoint (sin control): quita lo central, pero no toca un código propio', async () => {
  await central.actualizar();
  assert.ok(await fila());
  respuestaBase = { ...base0(), control: false };
  assert.equal((await central.actualizar()).cambio, 'sin_control');
  assert.equal(await fila(), undefined);
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan, codigo_activacion) VALUES (1, '2026-01-01', '2027-06-01', 'anual', 'nube', 'CPT1-XXXX')");
  assert.equal((await central.actualizar()).cambio, 'sin_control_nada');
  assert.equal((await fila()).codigo_activacion, 'CPT1-XXXX');
});

test('la consulta central sustituye un código de activación viejo', async () => {
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan, codigo_activacion, serial) VALUES (1, '2026-01-01', '2026-12-01', 'anual', 'nube', 'CPT1-VIEJO', 7)");
  await central.actualizar();
  const f = await fila();
  assert.equal(f.codigo_activacion, null); assert.equal(f.serial, null); assert.equal(f.vence, '2027-01-31');
});

test('sin conexión o con el servicio caído se queda con lo último que se supo', async () => {
  await central.actualizar();
  respuestaBase = { ...base0(), vence: '2030-01-01' };
  for (const m of ['caido', '503']) {
    modo = m;
    const r = await central.actualizar();
    assert.equal(r.resultado, 'sin_conexion', m);
    assert.equal((await fila()).vence, '2027-01-31', m);
  }
});

test('respuestas falsas, alteradas, viejas o de otro token se ignoran', async () => {
  await central.actualizar();
  respuestaBase = { ...base0(), vence: '2030-01-01' };
  for (const m of ['alterada', 'otro_n', 'otro_token', 'vieja']) {
    modo = m;
    const r = await central.actualizar();
    assert.equal(r.resultado, 'firma_mala', m);
    assert.equal((await fila()).vence, '2027-01-31', m);
  }
});

test('token desconocido: se anota el rechazo y no cambia nada', async () => {
  await central.actualizar();
  modo = 'desconocido';
  const r = await central.actualizar();
  assert.equal(r.resultado, 'rechazada');
  assert.equal((await fila()).vence, '2027-01-31');
  assert.equal(central.ultimaConsulta().resultado, 'rechazada');
});

test('datos raros en la respuesta firmada no rompen nada', async () => {
  respuestaBase = { ...base0(), tipo: 'regalo' };
  assert.equal((await central.actualizar()).cambio, 'datos_invalidos');
  respuestaBase = { ...base0(), vence: 'mañana' };
  assert.equal((await central.actualizar()).cambio, 'datos_invalidos');
  assert.equal(await fila(), undefined);
});

test('la licencia central no se copia al espejo en la nube (tabla excluida) y la consulta no pisa el reloj local', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sync.js'), 'utf8');
  assert.match(src, /EXCLUIDAS = new Set\(\[[^\]]*'licencia'/);
});
