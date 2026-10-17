// Bajar la información de la nube a la computadora del negocio + tomar la licencia del cliente,
// con base de datos REAL. Necesita una base VACÍA de pruebas (se borra todo lo que tenga):
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('exportar y licencia de la nube: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-exportar-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;
delete process.env.SYNC_KEY;

const bcrypt = require('bcryptjs');
const codigo = require('../utils/licenciaCodigo');
const lic = require('../utils/licencia');
const pool = require('../db');

const SEMILLA = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const PRIVADA = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEMILLA]), format: 'der', type: 'pkcs8' });
const PUBLICA_HEX = crypto.createPublicKey(PRIVADA).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-exp-'));

let base, servidor, tokenDueno, tokenCajero, sucursalId;
const reloj = (fecha) => lic._fijarReloj(() => new Date(fecha + 'T18:00:00Z'));
async function api(metodo, ruta, cuerpo, token, extra = {}) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}
async function entrar(usuario, password) {
  const r = await api('POST', '/api/auth/login', { usuario, password });
  assert.equal(r.status, 200, 'login de ' + usuario + ': ' + JSON.stringify(r.json));
  return r.json.token;
}
const ID_NUBE = codigo.idEquipoDesde('nube-del-cliente-prueba');
const ID_OTRA_NUBE = codigo.idEquipoDesde('otra-nube-distinta');
const emitir = (cambios = {}, id = ID_NUBE) =>
  codigo.emitirCodigo({ tipo: 'anual', plan: 'nube', maxSucursales: 3, emitida: '2026-10-16', vence: '2027-10-16', idEquipo: id, serial: 1, ...cambios }, PRIVADA);
const limpiar = async () => { await pool.query('DELETE FROM licencia'); lic._reiniciar(); lic.invalidarCache(); };
// Ponerse en el papel de la computadora del negocio (servidor local)
function comoLocal() {
  process.env.COMPOINT_ID_EQUIPO = 'computadora-del-negocio-prueba';
  process.env.COMPOINT_MARCAS = JSON.stringify([path.join(TMP, 'm1', 'marca.json'), path.join(TMP, 'm2', 'marca.json')]);
  lic._reiniciar();
}
function comoNube() { delete process.env.COMPOINT_ID_EQUIPO; delete process.env.COMPOINT_MARCAS; lic._reiniciar(); }

test.before(async () => {
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
  await pool.query("INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,'Cajera','cajera',$2,'cajero',true)", [sucursalId, hash]);
  tokenDueno = await entrar('dueno', 'Clave-Prueba-1');
  tokenCajero = await entrar('cajera', 'Clave-Prueba-1');
  lic._usarClavePublica(PUBLICA_HEX);
  reloj('2026-10-16');
});

test.after(async () => {
  comoNube();
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ============ la migración ============
test('la migración 010 agrega las columnas de licencia desde la nube', async () => {
  const c = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'licencia'");
  const n = c.rows.map((r) => r.column_name);
  assert.ok(n.includes('desde_nube') && n.includes('nube_id_equipo'));
});

// ============ exportar: quién puede ============
test('exportar: sin sesión 401, cajero 403, dueño 200', async () => {
  assert.equal((await api('GET', '/api/sync/exportar/estructura')).status, 401);
  assert.equal((await api('GET', '/api/sync/exportar/estructura', null, tokenCajero)).status, 403);
  assert.equal((await api('GET', '/api/sync/exportar/estructura', null, tokenDueno)).status, 200);
  assert.equal((await api('GET', '/api/sync/licencia', null, tokenCajero)).status, 403);
});

test('exportar/estructura: tablas, llaves, columnas y conteos; sin licencia ni claves de la nube', async () => {
  const r = await api('GET', '/api/sync/exportar/estructura', null, tokenDueno);
  assert.equal(r.json.ok, true);
  const t = r.json.tablas;
  assert.ok(t.usuarios && t.sucursales && t.configuracion && t.productos);
  assert.equal(t.usuarios.filas, 2);
  assert.equal(t.usuarios.pk, 'id');
  assert.ok(t.usuarios.cols.includes('password_hash'));
  for (const prohibida of ['licencia', 'instalacion', 'datos_negocio', 'licencia_solicitud', 'schema_migrations', 'sync_vinculo']) {
    assert.equal(t[prohibida], undefined, prohibida + ' no debe bajar');
  }
  assert.equal(r.json.total, Object.values(t).reduce((a, x) => a + x.filas, 0));
  // el orden pone a las tablas "padre" antes que a las que dependen de ellas
  const o = r.json.orden;
  assert.ok(o.indexOf('sucursales') < o.indexOf('usuarios'));
  assert.ok(o.indexOf('usuarios') < o.indexOf('tickets'));
});

// ============ exportar: los datos ============
test('exportar/:tabla: por pedazos con ?desde, trae todo y respeta las fechas tal cual', async () => {
  await pool.query("UPDATE usuarios SET creado_en = '2026-03-04 10:20:30' WHERE usuario = 'dueno'").catch(() => {});
  const todos = [];
  let desde = '';
  let vueltas = 0;
  do {
    const r = await api('GET', '/api/sync/exportar/usuarios?limite=1' + (desde ? '&desde=' + encodeURIComponent(desde) : ''), null, tokenDueno);
    assert.equal(r.status, 200);
    todos.push(...r.json.filas);
    desde = r.json.siguiente;
    vueltas++;
  } while (desde && vueltas < 10);
  assert.equal(todos.length, 2);
  assert.ok(vueltas >= 2, 'con límite 1 son varias vueltas');
  assert.deepEqual(todos.map((u) => u.usuario).sort(), ['cajera', 'dueno']);
  assert.match(todos[0].password_hash, /^\$2[aby]\$/, 'baja la contraseña ya cifrada, para entrar con la misma clave');
  const dueno = todos.find((u) => u.usuario === 'dueno');
  if (dueno.creado_en !== undefined) assert.equal(dueno.creado_en, '2026-03-04T10:20:30', 'sin cambiar de zona horaria');
});

test('exportar/:tabla: tabla desconocida o excluida → 404', async () => {
  assert.equal((await api('GET', '/api/sync/exportar/no_existe', null, tokenDueno)).status, 404);
  assert.equal((await api('GET', '/api/sync/exportar/licencia', null, tokenDueno)).status, 404);
  assert.equal((await api('GET', '/api/sync/exportar/sync_vinculo', null, tokenDueno)).status, 404);
  assert.equal((await api('GET', '/api/sync/exportar/usuarios;DROP', null, tokenDueno)).status, 404);
});

test('con la clave de sincronización (X-Sync-Key) también se puede bajar; con otra no', async () => {
  const v = await api('POST', '/api/sync/vincular', null, tokenDueno);
  assert.equal(v.status, 200);
  const clave = v.json.clave;
  assert.equal((await api('GET', '/api/sync/exportar/estructura', null, null, { 'X-Sync-Key': clave })).status, 200);
  assert.equal((await api('GET', '/api/sync/licencia', null, null, { 'X-Sync-Key': clave })).status, 200);
  assert.equal((await api('GET', '/api/sync/exportar/estructura', null, null, { 'X-Sync-Key': 'clave-equivocada-0123456789' })).status, 401);
  await pool.query('DELETE FROM sync_vinculo');
});

// ============ licencia que entrega la nube ============
test('GET /api/sync/licencia: nube sin licencia → sin control', async () => {
  comoNube(); await limpiar();
  const r = await api('GET', '/api/sync/licencia', null, tokenDueno);
  assert.equal(r.status, 200);
  assert.equal(r.json.control, false);
  assert.match(r.json.id_equipo, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(r.json.codigo, undefined);
});

test('GET /api/sync/licencia: con código firmado lo entrega; con fila a mano entrega datos sin código', async () => {
  comoNube(); await limpiar();
  const miId = (await lic.idEquipo()).texto;
  const act = await api('POST', '/api/licencia/activar', { codigo: emitir({}, miId) }, tokenDueno);
  assert.equal(act.status, 200, JSON.stringify(act.json));
  let r = await api('GET', '/api/sync/licencia', null, tokenDueno);
  assert.equal(r.json.control, true);
  assert.deepEqual([r.json.tipo, r.json.plan, r.json.vence, r.json.estado, r.json.id_equipo], ['anual', 'nube', '2027-10-16', 'activa', miId]);
  assert.match(r.json.codigo, /^CPT1-/);
  assert.equal(r.json.serial, undefined);

  await limpiar();
  await pool.query("INSERT INTO licencia (id, cliente, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1,'Cremería La Vaquita','2026-05-01','2027-05-01','anual','nube')");
  lic.invalidarCache();
  r = await api('GET', '/api/sync/licencia', null, tokenDueno);
  assert.deepEqual([r.json.control, r.json.cliente, r.json.vence, r.json.codigo], [true, 'Cremería La Vaquita', '2027-05-01', null]);
  await limpiar();
});

// ============ adoptar la licencia de la nube (lado computadora del negocio) ============
test('local en prueba + código firmado de la nube → se quita la prueba y queda la licencia del cliente', async () => {
  comoLocal(); await limpiar();
  const antes = await lic.estado();
  assert.equal(antes.tipo, 'demo');
  const r = await lic.adoptarDeNube({ control: true, cliente: 'Cremería La Vaquita', tipo: 'anual', plan: 'nube', vence: '2027-10-16', codigo: emitir(), id_equipo: ID_NUBE });
  assert.equal(r.adoptada, true, JSON.stringify(r));
  const e = await lic.estado();
  assert.deepEqual([e.tipo, e.estado, e.vence, e.max_sucursales, e.con_codigo, e.desde_nube, e.cliente, e.codigo_invalido, e.puede_vender],
    ['anual', 'activa', '2027-10-16', 3, true, 'codigo', 'Cremería La Vaquita', null, true]);
  assert.equal(e.mensaje, '');
  assert.equal(e.id_equipo, codigo.formatearIdEquipo(codigo.idEquipoValor('computadora-del-negocio-prueba')), 'sigue siendo el ID de ESTA computadora');
});

test('código de otra nube, alterado, vencido o de prueba → NO se adopta y la prueba sigue', async () => {
  comoLocal(); await limpiar();
  await lic.estado();
  const base = { control: true, cliente: 'X', tipo: 'anual', plan: 'nube', vence: '2027-10-16', id_equipo: ID_NUBE };
  let r = await lic.adoptarDeNube({ ...base, codigo: emitir({}, ID_OTRA_NUBE) });
  assert.deepEqual([r.adoptada, r.motivo], [false, 'codigo_de_otra_nube']);
  const bueno = emitir();
  r = await lic.adoptarDeNube({ ...base, codigo: bueno.slice(0, -3) + (bueno.endsWith('AAA') ? 'BBB' : 'AAA') });
  assert.deepEqual([r.adoptada, r.motivo], [false, 'codigo_invalido']);
  r = await lic.adoptarDeNube({ ...base, codigo: emitir({ emitida: '2025-01-10', vence: '2026-01-10' }) });
  assert.deepEqual([r.adoptada, r.motivo], [false, 'vencida']);
  r = await lic.adoptarDeNube({ ...base, codigo: emitir({ tipo: 'demo', vence: '2026-11-10' }) });
  assert.equal(r.adoptada, false);
  assert.equal((await lic.estado()).tipo, 'demo', 'la prueba sigue como estaba');
});

test('nube sin control de licencia (sistema propio) → la computadora queda sin prueba, permanente', async () => {
  comoLocal(); await limpiar();
  await lic.estado();
  const r = await lic.adoptarDeNube({ control: false, cliente: null, id_equipo: ID_NUBE });
  assert.equal(r.adoptada, true);
  const e = await lic.estado();
  assert.deepEqual([e.tipo, e.estado, e.permanente, e.desde_nube, e.puede_vender], ['permanente', 'activa', true, 'sin_control', true]);
});

test('licencia puesta a mano en la nube (sin código) → se copia tipo, plan y vigencia', async () => {
  comoLocal(); await limpiar();
  await lic.estado();
  const r = await lic.adoptarDeNube({ control: true, cliente: 'Cremería La Vaquita', tipo: 'anual', plan: 'local', vence: '2027-05-01', max_sucursales: 2, codigo: null, id_equipo: ID_NUBE });
  assert.equal(r.adoptada, true);
  const e = await lic.estado();
  assert.deepEqual([e.tipo, e.plan, e.vence, e.max_sucursales, e.desde_nube, e.con_codigo, e.estado], ['anual', 'local', '2027-05-01', 2, 'fila', false, 'activa']);
});

test('nube que también está en prueba, vencida o con datos raros → no se adopta', async () => {
  comoLocal(); await limpiar();
  await lic.estado();
  const casos = [
    [{ control: true, tipo: 'demo', vence: '2026-11-10', id_equipo: ID_NUBE }, 'sin_licencia_de_cliente'],
    [{ control: true, tipo: 'anual', vence: '2026-01-01', id_equipo: ID_NUBE }, 'vencida'],
    [{ control: true, tipo: 'anual', vence: 'mañana', id_equipo: ID_NUBE }, 'datos_invalidos'],
    [null, 'sin_datos'],
    [{ control: true, id_equipo: ID_NUBE }, 'sin_licencia_de_cliente']
  ];
  for (const [info, motivo] of casos) {
    const r = await lic.adoptarDeNube(info);
    assert.deepEqual([r.adoptada, r.motivo], [false, motivo], JSON.stringify(info));
  }
  assert.equal((await lic.estado()).tipo, 'demo');
});

test('no se baja de categoría: una licencia propia más larga se respeta; una renovación sí se toma', async () => {
  comoLocal(); await limpiar();
  await lic.estado();
  // propia (activada con código para ESTA computadora) vence 2028
  const propio = codigo.emitirCodigo({ tipo: 'anual', plan: 'local', maxSucursales: 1, emitida: '2026-10-16', vence: '2028-10-16', idEquipo: (await lic.idEquipo()).texto, serial: 5 }, PRIVADA);
  const act = await lic.activar(propio);
  assert.equal(act.estado.vence, '2028-10-16');
  let r = await lic.adoptarDeNube({ control: true, tipo: 'anual', plan: 'nube', vence: '2027-10-16', codigo: emitir(), id_equipo: ID_NUBE });
  assert.deepEqual([r.adoptada, r.motivo], [false, 'ya_tiene_licencia_propia']);
  assert.equal((await lic.estado()).vence, '2028-10-16');

  // de la nube: primero 2027, luego renovación a 2028-12 (se toma), luego una más corta (no)
  await limpiar(); comoLocal(); await lic.estado();
  await lic.adoptarDeNube({ control: true, tipo: 'anual', plan: 'nube', vence: '2027-10-16', codigo: emitir(), id_equipo: ID_NUBE });
  r = await lic.adoptarDeNube({ control: true, tipo: 'anual', plan: 'nube', vence: '2028-12-01', codigo: emitir({ vence: '2028-12-01', serial: 2 }), id_equipo: ID_NUBE });
  assert.equal(r.adoptada, true);
  assert.equal((await lic.estado()).vence, '2028-12-01');
  r = await lic.adoptarDeNube({ control: true, tipo: 'anual', plan: 'nube', vence: '2027-10-16', codigo: emitir(), id_equipo: ID_NUBE });
  assert.deepEqual([r.adoptada, r.motivo], [false, 'ya_tiene_una_mas_larga']);
  assert.equal((await lic.estado()).vence, '2028-12-01');
});

test('si la nube estaba "sin control" y luego Compoint le pone licencia, la computadora la toma (aunque sea más corta)', async () => {
  comoLocal(); await limpiar(); reloj('2026-10-16');
  await lic.estado();
  await lic.adoptarDeNube({ control: false, id_equipo: ID_NUBE });
  assert.equal((await lic.estado()).desde_nube, 'sin_control');
  let r = await lic.adoptarDeNube({ control: true, cliente: 'Cremería La Vaquita', tipo: 'anual', plan: 'nube', vence: '2027-03-01', codigo: emitir({ vence: '2027-03-01' }), id_equipo: ID_NUBE });
  assert.equal(r.adoptada, true, JSON.stringify(r));
  let e = await lic.estado();
  assert.deepEqual([e.tipo, e.vence, e.desde_nube, e.cliente], ['anual', '2027-03-01', 'codigo', 'Cremería La Vaquita']);
  // una licencia "a mano" (sin código) sigue lo que diga la nube, hacia arriba o hacia abajo
  await limpiar(); await lic.estado();
  await lic.adoptarDeNube({ control: true, tipo: 'anual', plan: 'nube', vence: '2027-10-01', id_equipo: ID_NUBE });
  r = await lic.adoptarDeNube({ control: true, tipo: 'anual', plan: 'nube', vence: '2027-06-01', id_equipo: ID_NUBE });
  assert.equal(r.adoptada, true);
  assert.equal((await lic.estado()).vence, '2027-06-01');
});

test('nube con licencia ya vencida: con prueba vigente se ignora; sin nada vigente se toma para mostrar el aviso correcto', async () => {
  comoLocal(); await limpiar(); reloj('2026-10-16');
  await lic.estado();
  const vencida = { control: true, cliente: 'Cremería La Vaquita', tipo: 'anual', plan: 'nube', vence: '2026-09-01', id_equipo: ID_NUBE };
  let r = await lic.adoptarDeNube(vencida);
  assert.deepEqual([r.adoptada, r.motivo], [false, 'vencida'], 'la prueba vigente es mejor que una licencia vencida');
  // la prueba termina: ya no hay nada vigente
  reloj('2026-12-31'); lic.invalidarCache();
  assert.equal((await lic.estado()).estado, 'solo_consulta');
  r = await lic.adoptarDeNube(vencida);
  assert.equal(r.adoptada, true);
  const e = await lic.estado();
  assert.deepEqual([e.tipo, e.estado, e.puede_vender], ['anual', 'solo_consulta', false]);
  assert.match(e.mensaje, /Tu licencia venció el 01\/09\/2026/);
  reloj('2026-10-16');
});

test('licencia de la nube que vence: gracia y luego solo consulta, igual que una activada aquí', async () => {
  comoLocal(); await limpiar(); reloj('2026-10-16');
  await lic.estado();
  await lic.adoptarDeNube({ control: true, tipo: 'anual', plan: 'nube', vence: '2027-10-16', codigo: emitir(), id_equipo: ID_NUBE });
  reloj('2027-10-18'); lic.invalidarCache();
  let e = await lic.estado();
  assert.deepEqual([e.estado, e.en_gracia, e.puede_vender], ['gracia', true, true]);
  reloj('2027-10-30'); lic.invalidarCache();
  e = await lic.estado();
  assert.deepEqual([e.estado, e.solo_consulta, e.puede_vender], ['solo_consulta', true, false]);
  reloj('2026-10-16');
});

test('activar un código propio después de adoptar de la nube deja de marcarla "desde la nube"', async () => {
  comoLocal(); await limpiar(); reloj('2026-10-16');
  await lic.estado();
  await lic.adoptarDeNube({ control: true, tipo: 'anual', plan: 'nube', vence: '2027-10-16', codigo: emitir(), id_equipo: ID_NUBE });
  assert.equal((await lic.estado()).desde_nube, 'codigo');
  const propio = codigo.emitirCodigo({ tipo: 'anual', plan: 'local', maxSucursales: 2, emitida: '2026-10-16', vence: '2028-01-01', idEquipo: (await lic.idEquipo()).texto, serial: 9 }, PRIVADA);
  await lic.activar(propio);
  const e = await lic.estado();
  assert.deepEqual([e.desde_nube, e.vence, e.codigo_invalido], [null, '2028-01-01', null]);
  const fila = (await pool.query('SELECT desde_nube, nube_id_equipo FROM licencia WHERE id = 1')).rows[0];
  assert.deepEqual([fila.desde_nube, fila.nube_id_equipo], [null, null]);
});

test('GET /api/licencia muestra desde_nube y no revela el serial', async () => {
  comoNube(); await limpiar();
  const r0 = await api('GET', '/api/licencia', null, tokenCajero);
  assert.equal(r0.json.control, false);
  const miId = (await lic.idEquipo()).texto;
  await api('POST', '/api/licencia/activar', { codigo: emitir({}, miId) }, tokenDueno);
  const r = await api('GET', '/api/licencia', null, tokenCajero);
  assert.equal(r.json.control, true);
  assert.equal(r.json.desde_nube, null);
  assert.equal(r.json.serial, undefined);
  await limpiar();
});
