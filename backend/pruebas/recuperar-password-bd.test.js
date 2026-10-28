// Recuperar contraseña desde el login (código por correo) + información pública del login,
// con base de datos REAL y un "servicio de correo" falso (el verdadero es recuperar.php en compoint.com.mx).
// Necesita una base VACÍA de pruebas (se borra todo lo que tenga):
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('recuperar contraseña con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-recuperar-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const lic = require('../utils/licencia');
const pool = require('../db');
const recuperacion = require('../utils/recuperacion');

let base, servidor, correoSrv, sucursalId;
const correos = [];            // lo que "recibió" el servicio de correo
let correoModo = 'ok';         // 'ok' | 'falla'
const U = {}; const T = {};
let ipN = 10;
const nuevaIp = () => '10.9.8.' + (ipN++);

async function api(quien, metodo, ruta, cuerpo, ip) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || nuevaIp(), ...(quien && T[quien] ? { Authorization: 'Bearer ' + T[quien] } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const pedir = (usuario) => api(null, 'POST', '/api/auth/recuperar/solicitar', { usuario });
const ultimoCodigo = () => correos[correos.length - 1].codigo;
const quitarEspera = (usuarioId) => pool.query("UPDATE recuperacion_codigos SET creado_en = creado_en - interval '5 minutes' WHERE usuario_id = $1", [usuarioId]);
const entrar = (usuario, password) => api(null, 'POST', '/api/auth/login', { usuario, password });

test.before(async () => {
  correoSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (correoModo === 'falla') { res.statusCode = 500; return res.end('{"ok":false}'); }
      correos.push(JSON.parse(b)); res.end('{"ok":true}');
    });
  });
  await new Promise((ok) => correoSrv.listen(0, '127.0.0.1', ok));
  process.env.COMPOINT_RECUPERAR_URL = 'http://127.0.0.1:' + correoSrv.address().port + '/recuperar.php';

  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  for (let i = 0; i < 100; i++) {
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '015%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2037-12-31', 'anual', 'nube')");
  lic.invalidarCache();

  sucursalId = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Centro', true) RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO configuracion (sucursal_id, nombre_negocio) VALUES ($1, 'Abarrotes La Esperanza')", [sucursalId]);
  const hash = await bcrypt.hash('Clave-Vieja-1', 4);
  const usuario = async (nombre, user, rol, correo) => {
    const id = (await pool.query(
      'INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo, correo) VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id', [sucursalId, nombre, user, hash, rol, correo || null])).rows[0].id;
    U[user] = id;
    T[user] = jwt.sign({ id, nombre, usuario: user, rol, sucursal_id: sucursalId, permisos: {} }, process.env.JWT_SECRET, { expiresIn: '1h' });
  };
  await usuario('Rosa Dueña', 'rosa', 'dueno', 'rosa@abarrotesesperanza.com');
  await usuario('Cajera Sin Correo', 'cajera', 'cajero', null);
  // Solo el dueño recupera por correo; estos dos son «dueños» extra solo para poder probar varios casos con usuarios distintos.
  await usuario('Dueño B', 'gerente', 'dueno', 'gerente@ejemplo.com');
  await usuario('Dueño C', 'mostrador', 'dueno', 'mostrador@ejemplo.com');
  await usuario('Empleado Con Correo', 'empleado', 'gerente', 'empleado@ejemplo.com');
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await new Promise((ok) => { correoSrv.close(() => ok()); setTimeout(ok, 1000); });
  await pool.end().catch(() => {});
});

// ---------------------------------------------------------------- información pública del login
test('info-login: sin iniciar sesión muestra negocio, sucursal, licencia y versión (nada sensible)', async () => {
  const r = await api(null, 'GET', '/api/auth/info-login');
  assert.equal(r.status, 200);
  assert.equal(r.json.negocio, 'Abarrotes La Esperanza');
  assert.equal(r.json.sucursal, 'Centro');
  assert.equal(r.json.licencia.estado, 'activa');
  assert.ok(r.json.version);
  const texto = JSON.stringify(r.json);
  assert.ok(!/serial|hash|password|usuario/i.test(texto), 'no filtra datos sensibles: ' + texto);
});

test('info-login: con varias sucursales no dice cuál (se escoge después de entrar)', async () => {
  const id2 = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Norte', true) RETURNING id")).rows[0].id;
  const r = await api(null, 'GET', '/api/auth/info-login');
  assert.equal(r.json.sucursal, null);
  await pool.query('DELETE FROM sucursales WHERE id = $1', [id2]);
});

// ---------------------------------------------------------------- pedir el código
test('usuario sin correo o que no existe: misma respuesta (nadie averigua usuarios) y no se manda nada', async () => {
  const antes = correos.length;
  const a = await pedir('cajera');
  const b = await pedir('no-existe');
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.deepEqual(a.json, { ok: true, sin_correo: true });
  assert.deepEqual(b.json, a.json);
  assert.equal(correos.length, antes);
});

test('pedir el código: llega al correo del usuario, la respuesta NO trae el código y el correo va enmascarado', async () => {
  const r = await pedir('rosa');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.enviado, true);
  assert.match(r.json.correo, /^ro.+@abarrotesesperanza\.com$/);
  assert.ok(!r.json.correo.includes('rosa@'), 'el correo va enmascarado');
  const m = correos[correos.length - 1];
  assert.equal(m.correo, 'rosa@abarrotesesperanza.com');
  assert.match(m.codigo, /^\d{6}$/);
  assert.equal(m.nombre, 'Rosa Dueña');
  assert.equal(m.negocio, 'Abarrotes La Esperanza');
  assert.equal(m.minutos, 15);
  assert.ok(!JSON.stringify(r.json).includes(m.codigo), 'el código no viaja en la respuesta');
  const fila = (await pool.query('SELECT codigo_hash FROM recuperacion_codigos WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1', [U.rosa])).rows[0];
  assert.notEqual(fila.codigo_hash, m.codigo, 'el código no se guarda en claro');
  assert.equal(fila.codigo_hash.length, 64);
});

test('pedir otro código antes de un minuto se rechaza', async () => {
  const r = await pedir('rosa');
  assert.equal(r.status, 429);
  assert.match(r.json.error, /minuto/);
});

// ---------------------------------------------------------------- verificar y restablecer
test('un código equivocado no sirve y uno de otro formato tampoco', async () => {
  const mal = ultimoCodigo() === '123456' ? '654321' : '123456';
  assert.equal((await api(null, 'POST', '/api/auth/recuperar/verificar', { usuario: 'rosa', codigo: mal })).status, 400);
  assert.equal((await api(null, 'POST', '/api/auth/recuperar/verificar', { usuario: 'rosa', codigo: 'abcdef' })).status, 400);
  assert.equal((await api(null, 'POST', '/api/auth/recuperar/verificar', { usuario: 'otro', codigo: ultimoCodigo() })).status, 400);
});

test('el código de un usuario no sirve en otro usuario', async () => {
  await pedir('gerente');
  const codGerente = ultimoCodigo();
  const r = await api(null, 'POST', '/api/auth/recuperar/restablecer', { usuario: 'rosa', codigo: codGerente, password_nueva: 'Hackeada-1' });
  assert.equal(r.status, 400);
  assert.equal((await entrar('rosa', 'Clave-Vieja-1')).status, 200, 'la contraseña de Rosa sigue igual');
});

test('código correcto: verifica, cambia la contraseña, entra con la nueva y el código no se puede reusar', async () => {
  await quitarEspera(U.rosa);
  await pedir('rosa');
  const cod = ultimoCodigo();
  assert.equal((await api(null, 'POST', '/api/auth/recuperar/verificar', { usuario: 'rosa', codigo: cod })).status, 200);
  assert.equal((await api(null, 'POST', '/api/auth/recuperar/restablecer', { usuario: 'rosa', codigo: cod, password_nueva: '123' })).status, 400, 'muy corta');
  const r = await api(null, 'POST', '/api/auth/recuperar/restablecer', { usuario: 'rosa', codigo: cod, password_nueva: 'Clave-Nueva-9' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // Al cambiar la contraseña, las sesiones que ya estaban abiertas se cierran.
  require('../middleware/auth')._limpiarMemoriaActivos();
  assert.equal((await api('rosa', 'GET', '/api/auth/mi-correo')).status, 401, 'la sesión vieja ya no sirve');
  const nueva = await entrar('rosa', 'Clave-Nueva-9');
  assert.equal(nueva.status, 200, 'entra con la nueva');
  T.rosa = nueva.json.token;
  assert.equal((await entrar('rosa', 'Clave-Vieja-1')).status, 401, 'la vieja ya no');
  const otra = await api(null, 'POST', '/api/auth/recuperar/restablecer', { usuario: 'rosa', codigo: cod, password_nueva: 'Otra-Clave-1' });
  assert.equal(otra.status, 400, 'el código ya se usó');
  const bit = await pool.query("SELECT 1 FROM bitacora WHERE accion = 'recuperar_password' AND usuario_id = $1", [U.rosa]);
  assert.equal(bit.rows.length, 1, 'queda en la bitácora');
});

test('a los 5 intentos fallidos el código se anula, aunque después se escriba el correcto', async () => {
  await quitarEspera(U.gerente);
  await pedir('gerente');
  const cod = ultimoCodigo();
  const mal = cod === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) {
    assert.equal((await api(null, 'POST', '/api/auth/recuperar/verificar', { usuario: 'gerente', codigo: mal })).status, 400);
  }
  assert.equal((await api(null, 'POST', '/api/auth/recuperar/verificar', { usuario: 'gerente', codigo: cod })).status, 400, 'ya no sirve');
});

test('un código vencido (más de 15 minutos) no sirve', async () => {
  await quitarEspera(U.mostrador);
  await pedir('mostrador');
  const cod = ultimoCodigo();
  await pool.query("UPDATE recuperacion_codigos SET expira_en = NOW() - interval '1 minute' WHERE usuario_id = $1", [U.mostrador]);
  assert.equal((await api(null, 'POST', '/api/auth/recuperar/verificar', { usuario: 'mostrador', codigo: cod })).status, 400);
});

test('un código nuevo anula el anterior', async () => {
  await quitarEspera(U.mostrador);
  await pedir('mostrador'); const viejo = ultimoCodigo();
  await quitarEspera(U.mostrador);
  await pedir('mostrador'); const nuevo = ultimoCodigo();
  if (viejo !== nuevo) assert.equal((await api(null, 'POST', '/api/auth/recuperar/verificar', { usuario: 'mostrador', codigo: viejo })).status, 400, 'el viejo ya no');
  assert.equal((await api(null, 'POST', '/api/auth/recuperar/verificar', { usuario: 'mostrador', codigo: nuevo })).status, 200);
});

test('si el servicio de correo falla: se avisa, y ese código queda anulado', async () => {
  await quitarEspera(U.gerente);
  correoModo = 'falla';
  const r = await pedir('gerente');
  correoModo = 'ok';
  assert.equal(r.status, 502);
  assert.match(r.json.error, /correo|WhatsApp/);
  const vivos = await pool.query('SELECT 1 FROM recuperacion_codigos WHERE usuario_id = $1 AND usado = false AND expira_en > NOW()', [U.gerente]);
  assert.equal(vivos.rows.length, 0);
});

test('un usuario desactivado o eliminado no puede recuperar', async () => {
  await pool.query('UPDATE usuarios SET activo = false WHERE id = $1', [U.gerente]);
  const antes = correos.length;
  const r = await pedir('gerente');
  assert.deepEqual(r.json, { ok: true, sin_correo: true });
  assert.equal(correos.length, antes);
  await pool.query('UPDATE usuarios SET activo = true WHERE id = $1', [U.gerente]);
});

test('frena el abuso: más de 5 códigos por IP en 15 minutos se rechazan', async () => {
  const ip = '10.77.77.77';
  let ultimo;
  for (let i = 0; i < 7; i++) ultimo = await api(null, 'POST', '/api/auth/recuperar/solicitar', { usuario: 'no-existe' }, ip);
  assert.equal(ultimo.status, 429);
});

// ---------------------------------------------------------------- correo en Equipo y en "mi correo"
test('Equipo: ya no se guarda correo de empleados (solo el dueño recupera por correo)', async () => {
  const ok = await api('rosa', 'POST', '/api/usuarios', { nombre: 'Nuevo', usuario: 'nuevo1', password: 'Clave-Nueva-1', rol: 'cajero', correo: 'nuevo@ejemplo.com' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.correo, undefined);
  const fila = (await pool.query('SELECT correo FROM usuarios WHERE usuario = $1', ['nuevo1'])).rows[0];
  assert.equal(fila.correo, null);
  const mod = await api('rosa', 'PUT', `/api/usuarios/${U.cajera}`, { correo: 'cajera@ejemplo.com', telefono: '33 1111 2222' });
  assert.equal(mod.status, 200, JSON.stringify(mod.json));
  assert.equal((await pool.query('SELECT correo FROM usuarios WHERE id = $1', [U.cajera])).rows[0].correo, null);
});

test('un empleado (no dueño) NO puede recuperar su contraseña por correo, aunque tenga correo guardado', async () => {
  const antes = correos.length;
  const a = await pedir('empleado');
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, { ok: true, sin_correo: true }, 'misma respuesta que un usuario que no existe');
  assert.equal(correos.length, antes, 'no se mandó ningún correo');
  // aunque alguien meta un código válido a mano en la base, no sirve para un empleado
  const codigo = '123456';
  await pool.query('INSERT INTO recuperacion_codigos (usuario_id, codigo_hash, expira_en) VALUES ($1,$2, NOW() + interval \'10 minutes\')', [U.empleado, recuperacion.huella(codigo, U.empleado)]);
  const v = await api(null, 'POST', '/api/auth/recuperar/verificar', { usuario: 'empleado', codigo });
  assert.equal(v.status, 400);
  const r = await api(null, 'POST', '/api/auth/recuperar/restablecer', { usuario: 'empleado', codigo, password_nueva: 'Otra-Clave-77' });
  assert.equal(r.status, 400);
  const sigue = await api(null, 'POST', '/api/auth/login', { usuario: 'empleado', password: 'Clave-Vieja-1' });
  assert.equal(sigue.status, 200, 'su contraseña no cambió');
});

test('sesión: dura un año (no se vence sola) y deja de servir si desactivan al usuario', async () => {
  const login = await api(null, 'POST', '/api/auth/login', { usuario: 'empleado', password: 'Clave-Vieja-1' });
  const d = JSON.parse(Buffer.from(login.json.token.split('.')[1], 'base64').toString());
  assert.ok((d.exp - d.iat) / 86400 >= 364, 'sesión de ~365 días');
  const uid = U.empleado;
  const tok = login.json.token;
  T.empleado_sesion = tok;
  const llamar = () => api('empleado_sesion', 'GET', '/api/auth/mi-correo');
  assert.notEqual((await llamar()).status, 401, 'activo: la sesión sirve (403 por no ser dueño, pero no 401)');
  await pool.query('UPDATE usuarios SET activo = false WHERE id = $1', [uid]);
  const mw = require('../middleware/auth');
  mw._limpiarMemoriaActivos && mw._limpiarMemoriaActivos();
  assert.equal((await llamar()).status, 401, 'desactivado: ya no entra');
  await pool.query('UPDATE usuarios SET activo = true WHERE id = $1', [uid]);
  mw._limpiarMemoriaActivos && mw._limpiarMemoriaActivos();
});

test('mi correo: el dueño guarda el suyo con su contraseña actual; los demás no pueden', async () => {
  const sinPass = await api('rosa', 'PUT', '/api/auth/mi-correo', { correo: 'rosa2@ejemplo.com' });
  assert.equal(sinPass.status, 400);
  const mal = await api('rosa', 'PUT', '/api/auth/mi-correo', { correo: 'rosa2@ejemplo.com', password_actual: 'incorrecta' });
  assert.equal(mal.status, 400);
  const feo = await api('rosa', 'PUT', '/api/auth/mi-correo', { correo: 'no-correo', password_actual: 'Clave-Nueva-9' });
  assert.equal(feo.status, 400);
  const ok = await api('rosa', 'PUT', '/api/auth/mi-correo', { correo: 'Rosa2@Ejemplo.com', password_actual: 'Clave-Nueva-9' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await api('rosa', 'GET', '/api/auth/mi-correo')).json.correo, 'rosa2@ejemplo.com');
  assert.equal((await api(null, 'GET', '/api/auth/mi-correo')).status, 401, 'sin sesión no se puede');
  assert.equal((await api('cajera', 'GET', '/api/auth/mi-correo')).status, 403, 'un empleado no');
  assert.equal((await api('cajera', 'PUT', '/api/auth/mi-correo', { correo: 'x@ejemplo.com', password_actual: 'Clave-Vieja-1' })).status, 403);
});
