// Pruebas de la licencia con una base de datos REAL de PostgreSQL y el servidor completo.
// Necesitan una base VACÍA de pruebas (se borra todo lo que tenga):
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
// Sin esa variable, estas pruebas se omiten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('licencia con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-licencia-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.MAX_SUCURSALES = '2';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const codigo = require('../utils/licenciaCodigo');
const lic = require('../utils/licencia');
const pool = require('../db');

const SEMILLA = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const PRIVADA = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEMILLA]), format: 'der', type: 'pkcs8' });
const PUBLICA_HEX = crypto.createPublicKey(PRIVADA).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-lic-'));
const MARCA1 = path.join(TMP, 'a', 'marca1.json');
const MARCA2 = path.join(TMP, 'b', 'marca2.json');

let base, tokenDueno, tokenCajero, tokenJefe, servidor;

const reloj = (fecha) => lic._fijarReloj(() => new Date(fecha + 'T18:00:00Z')); // 12:00 en Ciudad de México
async function api(metodo, ruta, cuerpo, token) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json, h: r.headers };
}
async function entrar(usuario, password) {
  const r = await api('POST', '/api/auth/login', { usuario, password });
  assert.equal(r.status, 200, 'login de ' + usuario + ': ' + JSON.stringify(r.json));
  return r.json.token;
}
const limpiar = async () => { await pool.query('DELETE FROM licencia'); lic.invalidarCache(); };
const emitir = async (cambios = {}, idEquipo) => {
  const id = idEquipo || (await lic.idEquipo()).texto;
  return codigo.emitirCodigo({ tipo: 'anual', plan: 'nube', maxSucursales: 3, emitida: '2026-10-16', vence: '2027-10-16', idEquipo: id, serial: 1, ...cambios }, PRIVADA);
};
const escribir = (token) => api('PUT', '/api/configuracion', { terminos: 'prueba ' + Math.random() }, token || tokenDueno);
const leerMarca = (ruta) => JSON.parse(fs.readFileSync(ruta, 'utf8'));

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  // el servidor aplica las migraciones al arrancar: esperar a que termine la 007
  for (let i = 0; i < 100; i++) {
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '007%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  const suc = await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id");
  const sid = suc.rows[0].id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1)', [sid]);
  const hash = await bcrypt.hash('Clave-Prueba-1', 4);
  await pool.query("INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,'Dueño','dueno',$2,'dueno',true)", [sid, hash]);
  await pool.query("INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,'Cajera','cajera',$2,'cajero',true)", [sid, hash]);
  await pool.query("INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES (NULL,'Jefe','jefe',$1,'jefe_general',true)", [hash]);
  tokenDueno = await entrar('dueno', 'Clave-Prueba-1');
  tokenCajero = await entrar('cajera', 'Clave-Prueba-1');
  tokenJefe = await entrar('jefe', 'Clave-Prueba-1');
  lic._usarClavePublica(PUBLICA_HEX);
  reloj('2026-10-16');
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ============ NUBE (sin variables del escritorio) ============

test('la migración 007 deja las columnas nuevas y no cambia lo que ya existía', async () => {
  const c = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'licencia'");
  const nombres = c.rows.map((r) => r.column_name);
  for (const col of ['cliente', 'fecha_inicio', 'fecha_vencimiento', 'tipo', 'plan', 'max_sucursales', 'codigo_activacion', 'serial', 'ultima_fecha_vista']) assert.ok(nombres.includes(col), col);
  // Una licencia anual creada al estilo anterior (alta-cliente) queda como anual con nube
  await pool.query("INSERT INTO licencia (id, cliente, fecha_inicio, fecha_vencimiento) VALUES (1,'Cliente viejo','2026-03-10','2027-03-10')");
  lic.invalidarCache();
  const e = await lic.estado();
  assert.deepEqual([e.control, e.tipo, e.plan, e.estado, e.dias, e.con_codigo], [true, 'anual', 'nube', 'activa', 145, false]);
  await limpiar();
});

test('nube sin fila de licencia: sin control, se puede escribir y no hay encabezados', async () => {
  const r = await api('GET', '/api/licencia', null, tokenDueno);
  assert.equal(r.status, 200);
  assert.equal(r.json.control, false);
  assert.match(r.json.id_equipo, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const w = await escribir();
  assert.equal(w.status, 200);
  assert.equal(w.h.get('x-licencia-estado'), null);
  assert.equal((await pool.query('SELECT count(*)::int n FROM licencia')).rows[0].n, 0, 'no se inventa una fila en la nube');
});

test('el ID del equipo es estable y no se copia al espejo de la nube', async () => {
  const a = await lic.idEquipo();
  lic._reiniciar();
  const b = await lic.idEquipo();
  assert.equal(a.texto, b.texto);
  const sync = require('fs').readFileSync(path.join(__dirname, '..', 'routes', 'sync.js'), 'utf8');
  assert.match(sync, /EXCLUIDAS = new Set\(\[[^\]]*'instalacion'/);
});

test('activar con un código válido (anual, con nube, 3 sucursales)', async () => {
  const r = await api('POST', '/api/licencia/activar', { codigo: 'Aquí va:\n' + await emitir() + '\n¡Gracias!' }, tokenDueno);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const e = r.json.estado;
  assert.deepEqual([e.control, e.estado, e.tipo, e.plan, e.vence, e.max_sucursales, e.con_codigo, e.dias], [true, 'activa', 'anual', 'nube', '2027-10-16', 3, true, 365]);
  assert.equal(r.json.limite_sucursales, 3);
  const get = await api('GET', '/api/licencia', null, tokenCajero);
  assert.equal(get.status, 200);
  assert.equal(get.json.serial, undefined, 'el número de serie no se muestra');
  assert.equal(get.json.codigo_activacion, undefined);
  const b = await pool.query("SELECT accion, valor_nuevo FROM bitacora WHERE accion = 'licencia_activar'");
  assert.equal(b.rows.length, 1);
  assert.equal(JSON.stringify(b.rows[0].valor_nuevo).includes('CPT1'), false, 'el código completo no se guarda en la bitácora');
});

test('los datos salen del CÓDIGO: cambiar las columnas a mano no sirve', async () => {
  await pool.query("UPDATE licencia SET fecha_vencimiento = '2099-12-31', tipo = 'permanente', max_sucursales = 200");
  lic.invalidarCache();
  const e = await lic.estado();
  assert.deepEqual([e.tipo, e.vence, e.max_sucursales], ['anual', '2027-10-16', 3]);
});

test('rechazos: otro equipo, código alterado, vencido, sin permiso, vacío', async () => {
  const otroId = codigo.idEquipoDesde('otra-pc');
  let r = await api('POST', '/api/licencia/activar', { codigo: await emitir({}, otroId) }, tokenDueno);
  assert.equal(r.status, 400);
  assert.equal(r.json.motivo, 'equipo');
  assert.ok(r.json.error.includes(otroId) && r.json.error.includes((await lic.idEquipo()).texto));

  const bueno = await emitir({ serial: 9 });
  const i = bueno.indexOf('ZC') + 1;
  const malo = bueno.slice(0, i) + (bueno[i] === 'A' ? 'B' : 'A') + bueno.slice(i + 1);
  r = await api('POST', '/api/licencia/activar', { codigo: malo }, tokenDueno);
  assert.deepEqual([r.status, r.json.motivo], [400, 'firma']);

  r = await api('POST', '/api/licencia/activar', { codigo: await emitir({ emitida: '2025-01-01', vence: '2026-01-01', serial: 2 }) }, tokenDueno);
  assert.deepEqual([r.status, r.json.motivo], [400, 'vencido']);

  r = await api('POST', '/api/licencia/activar', { codigo: bueno }, tokenCajero);
  assert.equal(r.status, 403);
  r = await api('POST', '/api/licencia/activar', { codigo: '   ' }, tokenDueno);
  assert.equal(r.status, 400);
  r = await api('POST', '/api/licencia/activar', { codigo: 'x'.repeat(5000) }, tokenDueno);
  assert.equal(r.status, 400);
  r = await api('POST', '/api/licencia/activar', { codigo: bueno });
  assert.equal(r.status, 401);
  assert.equal((await lic.estado()).serial, 1, 'nada de lo anterior cambió la licencia');
});

test('un código más viejo no pisa a uno más nuevo; el mismo código se puede repetir; el permanente sí lo reemplaza', async () => {
  let r = await api('POST', '/api/licencia/activar', { codigo: await emitir({ vence: '2027-04-01', serial: 5 }) }, tokenDueno);
  assert.deepEqual([r.status, r.json.motivo], [400, 'anterior']);
  r = await api('POST', '/api/licencia/activar', { codigo: await emitir() }, tokenDueno);
  assert.equal(r.status, 200);
  r = await api('POST', '/api/licencia/activar', { codigo: await emitir({ tipo: 'permanente', plan: 'local', maxSucursales: 1, vence: null, serial: 10 }) }, tokenDueno);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.estado.tipo, r.json.estado.plan, r.json.estado.vence, r.json.estado.dias, r.json.estado.estado], ['permanente', 'local', null, null, 'activa']);
  reloj('2060-01-01');
  assert.equal((await lic.estado()).estado, 'activa', 'la permanente nunca vence');
  reloj('2026-10-16');
  await limpiar();
});

test('ciclo completo de vencimiento: activa → por vencer → gracia → solo consulta → renovar', async () => {
  const cod = await emitir({ vence: '2026-11-01', serial: 20 });
  assert.equal((await api('POST', '/api/licencia/activar', { codigo: cod }, tokenDueno)).status, 200);

  reloj('2026-10-20'); // faltan 12
  let w = await escribir();
  assert.equal(w.status, 200);
  assert.equal(w.h.get('x-licencia-estado'), null, 'sin barra mientras falten más de 7 días');

  reloj('2026-10-26'); // faltan 6
  w = await escribir();
  assert.equal(w.status, 200);
  assert.deepEqual([w.h.get('x-licencia-estado'), w.h.get('x-licencia-dias'), w.h.get('x-licencia-vence'), w.h.get('x-licencia-tipo')], ['por_vencer', '6', '2026-11-01', 'anual']);

  reloj('2026-11-01'); // último día
  assert.equal((await escribir()).status, 200);

  reloj('2026-11-04'); // 3 días vencida: gracia, todavía se vende
  w = await escribir();
  assert.equal(w.status, 200);
  assert.deepEqual([w.h.get('x-licencia-estado'), w.h.get('x-licencia-dias')], ['gracia', '-3']);

  reloj('2026-11-06'); // quinto y último día de gracia
  assert.equal((await escribir()).status, 200);

  reloj('2026-11-07'); // se acabó la gracia
  w = await escribir();
  assert.equal(w.status, 402);
  assert.equal(w.json.solo_consulta, true);
  assert.equal(w.json.licencia_vencida, true);
  assert.match(w.json.error, /solo consulta/);
  assert.match(w.json.error, /33 25 90 70 90/);
  assert.equal(w.h.get('x-licencia-estado'), 'solo_consulta');

  // En solo consulta SÍ se puede: ver, respaldar, entrar, cerrar el turno, pedir/activar licencia
  assert.equal((await api('GET', '/api/configuracion', null, tokenDueno)).status, 200);
  assert.equal((await api('GET', '/api/backups/exportar', null, tokenDueno)).status, 200);
  assert.equal((await api('GET', '/api/licencia', null, tokenDueno)).json.solo_consulta, true);
  assert.equal((await api('POST', '/api/auth/login', { usuario: 'dueno', password: 'Clave-Prueba-1' })).status, 200);
  assert.notEqual((await api('POST', '/api/turnos/999/cerrar', {}, tokenDueno)).status, 402);
  assert.equal((await api('POST', '/api/auth/logout', {}, tokenDueno)).status, 200);
  // ...y NO se puede registrar nada
  for (const [m, ruta] of [['POST', '/api/tickets'], ['POST', '/api/movimientos'], ['PUT', '/api/configuracion'], ['POST', '/api/turnos/abrir'], ['POST', '/api/inventario/ajuste'], ['DELETE', '/api/productos/1'], ['POST', '/api/sistema/reinicio-fabrica']]) {
    const r = await api(m, ruta, {}, tokenDueno);
    assert.equal(r.status, 402, m + ' ' + ruta);
  }

  // Renovar con un código nuevo lo deja todo funcionando al instante
  const r = await api('POST', '/api/licencia/activar', { codigo: await emitir({ vence: '2027-11-01', serial: 21 }) }, tokenDueno);
  assert.equal(r.status, 200);
  assert.equal(r.json.estado.estado, 'activa');
  assert.equal((await escribir()).status, 200);
  reloj('2026-10-16');
  await limpiar();
});

test('el tope de sucursales lo da la licencia (y sin licencia, la variable MAX_SUCURSALES)', async () => {
  assert.equal(await lic.limiteSucursales(), 2); // variable de entorno
  let r = await api('POST', '/api/sucursales', { nombre: 'Segunda' }, tokenJefe);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await api('POST', '/api/sucursales', { nombre: 'Tercera' }, tokenJefe);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /máximo de 2 sucursales/);

  await api('POST', '/api/licencia/activar', { codigo: await emitir({ maxSucursales: 3, serial: 30 }) }, tokenDueno);
  assert.equal(await lic.limiteSucursales(), 3);
  r = await api('POST', '/api/sucursales', { nombre: 'Tercera' }, tokenJefe);
  assert.equal(r.status, 200);
  const lista = await api('GET', '/api/sucursales', null, tokenJefe);
  assert.equal(lista.json.tope, 3);
  r = await api('POST', '/api/sucursales', { nombre: 'Cuarta' }, tokenJefe);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /máximo de 3/);
  await limpiar();
});

test('sin llave pública en el programa no se aceptan códigos, pero todo lo demás sigue igual', async () => {
  lic._usarClavePublica('');
  const r = await api('POST', '/api/licencia/activar', { codigo: await emitir() }, tokenDueno);
  assert.deepEqual([r.status, r.json.motivo], [400, 'sinllave']);
  assert.equal((await api('GET', '/api/licencia', null, tokenDueno)).json.tiene_llave, false);
  lic._usarClavePublica(PUBLICA_HEX);
});

// ============ SERVIDOR LOCAL DEL CLIENTE (prueba de 30 días) ============

function modoLocal(guid = 'GUID-PC-DEL-CLIENTE') {
  process.env.COMPOINT_ID_EQUIPO = guid;
  process.env.COMPOINT_MARCAS = JSON.stringify([MARCA1, MARCA2]);
  lic._reiniciar();
}

test('servidor local: la primera vez empieza una prueba de 30 días y deja marcas', async () => {
  fs.rmSync(path.join(TMP, 'a'), { recursive: true, force: true });
  fs.rmSync(path.join(TMP, 'b'), { recursive: true, force: true });
  await pool.query('DELETE FROM instalacion');
  modoLocal();
  await limpiar();
  reloj('2026-10-16');
  const r = await api('GET', '/api/licencia', null, tokenDueno);
  const e = r.json;
  assert.deepEqual([e.control, e.estado, e.tipo, e.dias, e.vence, e.inicio, e.local, e.puede_vender], [true, 'demo', 'demo', 30, '2026-11-15', '2026-10-16', true, true]);
  assert.match(e.mensaje, /te quedan 30 días/);
  assert.equal(r.h.get('x-licencia-estado'), 'demo');
  assert.equal(r.h.get('x-licencia-dias'), '30');
  assert.deepEqual([leerMarca(MARCA1).i, leerMarca(MARCA2).i], ['2026-10-16', '2026-10-16']);
  // El ID viene de la computadora (no de la base de datos)
  assert.equal(e.id_equipo, codigo.idEquipoDesde('GUID-PC-DEL-CLIENTE'));
});

test('la prueba es totalmente funcional y avisa con la cuenta regresiva', async () => {
  reloj('2026-11-10');
  let w = await escribir();
  assert.equal(w.status, 200);
  assert.deepEqual([w.h.get('x-licencia-estado'), w.h.get('x-licencia-dias')], ['demo', '5']);
  assert.equal((await lic.estado()).por_vencer, true);
  reloj('2026-11-15');
  assert.equal((await escribir()).status, 200);
  assert.match((await lic.estado()).mensaje, /último día/);
});

test('al día 31 la prueba pasa a solo consulta (sin gracia) y avisa que es la prueba', async () => {
  reloj('2026-11-16');
  const w = await escribir();
  assert.equal(w.status, 402);
  assert.match(w.json.error, /Tu prueba de 30 días terminó el 15\/11\/2026/);
  assert.equal((await api('GET', '/api/configuracion', null, tokenDueno)).status, 200);
});

test('desinstalar y volver a instalar NO da otra prueba: las marcas recuerdan la fecha', async () => {
  await limpiar();
  await pool.query('DELETE FROM instalacion');
  lic._reiniciar();
  reloj('2026-11-16');
  const e = await lic.estado();
  assert.deepEqual([e.estado, e.inicio, e.vence], ['solo_consulta', '2026-10-16', '2026-11-15']);

  // aunque se borre una de las dos marcas
  fs.rmSync(MARCA1);
  await limpiar();
  assert.equal((await lic.estado()).estado, 'solo_consulta');

  // una marca alterada a mano no se cree (y la buena sí)
  const alterada = leerMarca(MARCA2); alterada.i = '2026-11-16'; alterada.v = '2026-11-16';
  fs.writeFileSync(MARCA2, JSON.stringify(alterada));
  assert.equal((await lic.estado()).estado, 'solo_consulta');
  assert.equal(leerMarca(MARCA1).i, '2026-10-16', 'la marca borrada se vuelve a escribir sola');
  fs.rmSync(MARCA1);
  await limpiar();
  await pool.query('DELETE FROM instalacion');
  lic._reiniciar();
  const nuevo = await lic.estado();
  assert.equal(nuevo.estado, 'demo', 'sin ninguna marca buena, la prueba arranca otra vez (límite conocido: borrar todo la reinicia)');
  // ...pero la marca copiada de otra computadora tampoco sirve
  modoLocal('GUID-OTRA-COMPU');
  fs.writeFileSync(MARCA1, JSON.stringify({ i: '2026-01-01', v: '2026-01-02', h: 'a'.repeat(32) }));
  await limpiar();
  assert.equal((await lic.estado()).inicio, '2026-11-16');
});

test('atrasar el reloj no regala días (queda el avance más reciente)', async () => {
  fs.rmSync(path.join(TMP, 'a'), { recursive: true, force: true });
  fs.rmSync(path.join(TMP, 'b'), { recursive: true, force: true });
  modoLocal();
  await limpiar();
  await pool.query('DELETE FROM instalacion');
  reloj('2026-10-16');
  assert.equal((await lic.estado()).dias, 30);
  reloj('2026-11-10');
  assert.equal((await lic.estado()).dias, 5);
  reloj('2026-10-20'); // alguien regresa la fecha de la computadora
  const e = await lic.estado();
  assert.deepEqual([e.dias, e.reloj_atrasado, e.estado], [5, true, 'demo']);
  // aunque además borre la fecha guardada en la base y las marcas, la última venta lo delata
  await pool.query("INSERT INTO tickets (folio, sucursal_id, estado, total, fecha_creacion) VALUES ('T-FUTURO', (SELECT min(id) FROM sucursales), 'pagado', 10, '2026-11-20 10:00')");
  await pool.query('UPDATE licencia SET ultima_fecha_vista = NULL');
  fs.rmSync(path.join(TMP, 'a'), { recursive: true, force: true });
  fs.rmSync(path.join(TMP, 'b'), { recursive: true, force: true });
  lic.invalidarCache();
  const e2 = await lic.estado();
  assert.deepEqual([e2.estado, e2.reloj_atrasado], ['solo_consulta', true]);
  await pool.query("DELETE FROM tickets WHERE folio = 'T-FUTURO'");
});

test('activar en el servidor local: queda activa y la prueba deja de contar', async () => {
  fs.rmSync(path.join(TMP, 'a'), { recursive: true, force: true });
  fs.rmSync(path.join(TMP, 'b'), { recursive: true, force: true });
  modoLocal();
  await limpiar();
  await pool.query('DELETE FROM instalacion');
  reloj('2026-11-20'); // la prueba empezó hoy
  await lic.estado();
  reloj('2026-12-25'); // y ya terminó
  assert.equal((await lic.estado()).estado, 'solo_consulta');
  assert.equal((await escribir()).status, 402);
  const id = codigo.idEquipoDesde('GUID-PC-DEL-CLIENTE');
  const r = await api('POST', '/api/licencia/activar', { codigo: await emitir({ plan: 'local', maxSucursales: 1, emitida: '2026-12-25', vence: '2027-12-25', serial: 40 }, id) }, tokenDueno);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.estado.estado, r.json.estado.plan, r.json.estado.dias], ['activa', 'local', 365]);
  assert.equal((await escribir()).status, 200);
});

test('copiar la base de datos a otra computadora: el código ya no corresponde y queda solo consulta', async () => {
  modoLocal('GUID-OTRA-COMPUTADORA');
  lic.invalidarCache();
  const e = await lic.estado();
  assert.deepEqual([e.estado, e.codigo_invalido, e.solo_consulta], ['solo_consulta', 'equipo', true]);
  assert.match(e.mensaje, /no corresponde a este equipo/);
  assert.equal((await escribir()).status, 402);
  // Con un código hecho para la computadora nueva se arregla
  const r = await api('POST', '/api/licencia/activar', { codigo: await emitir({ plan: 'local', maxSucursales: 1, emitida: '2026-12-26', vence: '2027-12-25', serial: 41 }, codigo.idEquipoDesde('GUID-OTRA-COMPUTADORA')) }, tokenDueno);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await escribir()).status, 200);
});
