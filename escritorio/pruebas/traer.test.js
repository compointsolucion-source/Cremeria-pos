// Traer la información de la nube a la computadora del negocio.
// - Las primeras pruebas usan una nube de mentira (servidor HTTP pequeño): no necesitan internet ni base de datos.
// - Las de base de datos necesitan una base VACÍA de pruebas (se borra todo lo que tenga):
//     TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
//   Sin esa variable, se omiten.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

// La nube de mentira vive en 127.0.0.1: eso solo se acepta en modo desarrollo.
process.env.COMPOINT_DEV = '1';
const { abrirSesionNube, traerDeNube, mensajeAmable } = require('../src/servidor/traer');

// Nube de mentira: `rutas` es una función (método, ruta con consulta, cuerpo, encabezados) → { status, datos }.
function nubeFalsa(rutas) {
  const llamadas = [];
  const srv = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      let json = {}; try { json = JSON.parse(cuerpo || '{}'); } catch (e) { /* vacío */ }
      llamadas.push({ metodo: req.method, ruta: req.url, auth: req.headers.authorization || '', cuerpo: json });
      const r = rutas(req.method, req.url, json, req.headers);
      if (!r) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<pre>Cannot ' + req.method + ' ' + req.url + '</pre>'); }
      res.writeHead(r.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.datos || {}));
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({
    url: 'http://127.0.0.1:' + srv.address().port, api: 'http://127.0.0.1:' + srv.address().port + '/api', llamadas, cerrar: () => new Promise((r) => srv.close(r))
  })));
}

const ESTRUCTURA = {
  ok: true, version: 1, total: 5, orden: ['sucursales', 'usuarios'],
  tablas: {
    sucursales: { pk: 'id', cols: ['id', 'nombre'], filas: 1 },
    usuarios: { pk: 'id', cols: ['id', 'nombre', 'usuario', 'password_hash', 'rol'], filas: 4 }
  }
};
const loginOk = (rol = 'dueno') => ({ datos: { token: 'tok-1', usuario: { id: 1, nombre: 'Juan', rol } } });

test('abrirSesionNube: entra con el dueño, revisa la nube y trae la licencia; la contraseña solo va al inicio de sesión', async () => {
  const n = await nubeFalsa((m, r) => {
    if (m === 'POST' && r === '/api/auth/login') return loginOk();
    if (m === 'GET' && r === '/api/sync/exportar/estructura') return { datos: { ...ESTRUCTURA, tablas: { ...ESTRUCTURA.tablas, productos: { pk: 'id', cols: ['id'], filas: 120 }, tickets: { pk: 'id', cols: ['id'], filas: 3400 } } } };
    if (m === 'GET' && r === '/api/sync/licencia') return { datos: { ok: true, control: true, cliente: 'La Vaquita', tipo: 'anual', vence: '2027-10-16' } };
    return null;
  });
  try {
    const s = await abrirSesionNube({ texto: n.url, usuario: ' juan ', password: 'Clave-123' });
    assert.equal(s.api, n.api);
    assert.equal(s.token, 'tok-1');
    assert.deepEqual([s.resumen.productos, s.resumen.ventas, s.resumen.usuarios], [120, 3400, 4]);
    assert.deepEqual([s.licencia.cliente, s.licencia.tipo], ['La Vaquita', 'anual']);
    const login = n.llamadas.find((x) => x.ruta === '/api/auth/login');
    assert.deepEqual(login.cuerpo, { usuario: 'juan', password: 'Clave-123' });
    assert.equal(JSON.stringify(n.llamadas.filter((x) => x !== login)).includes('Clave-123'), false, 'la contraseña no se manda a ninguna otra ruta');
    assert.equal(n.llamadas.find((x) => x.ruta.endsWith('/exportar/estructura')).auth, 'Bearer tok-1');
  } finally { await n.cerrar(); }
});

test('abrirSesionNube: si la nube no entrega licencia, igual sigue (licencia = null)', async () => {
  const n = await nubeFalsa((m, r) => {
    if (r === '/api/auth/login') return loginOk();
    if (r === '/api/sync/exportar/estructura') return { datos: ESTRUCTURA };
    return null; // /sync/licencia → 404
  });
  try {
    const s = await abrirSesionNube({ texto: n.url, usuario: 'juan', password: 'x' });
    assert.equal(s.licencia, null);
    assert.equal(s.resumen.usuarios, 4);
  } finally { await n.cerrar(); }
});

test('abrirSesionNube: nube sin la actualización (sin rutas de exportar) → mensaje claro', async () => {
  const n = await nubeFalsa((m, r) => (r === '/api/auth/login' ? loginOk() : null));
  try {
    await assert.rejects(abrirSesionNube({ texto: n.url, usuario: 'juan', password: 'x' }), (e) => e.http === 404 && e.sinActualizar === true && /todavía no tiene la actualización para bajar la información/.test(e.message));
  } finally { await n.cerrar(); }
});

test('abrirSesionNube: una dirección equivocada (404 desde el inicio de sesión) NO se confunde con «nube sin actualizar»', async () => {
  const n = await nubeFalsa(() => null);
  try {
    await assert.rejects(abrirSesionNube({ texto: n.url, usuario: 'juan', password: 'x' }), (e) => e.sinActualizar !== true);
  } finally { await n.cerrar(); }
});

test('abrirSesionNube: contraseña mala, usuario que no es dueño y datos vacíos', async () => {
  let n = await nubeFalsa((m, r) => (r === '/api/auth/login' ? { status: 401, datos: { error: 'mal' } } : null));
  await assert.rejects(abrirSesionNube({ texto: n.url, usuario: 'juan', password: 'x' }), (e) => e.http === 401 && /incorrectos/.test(e.message));
  await n.cerrar();
  n = await nubeFalsa((m, r) => (r === '/api/auth/login' ? loginOk('cajero') : null));
  await assert.rejects(abrirSesionNube({ texto: n.url, usuario: 'caja', password: 'x' }), (e) => e.http === 403 && /no es el dueño/.test(e.message));
  await n.cerrar();
  await assert.rejects(abrirSesionNube({ texto: 'http://127.0.0.1:9', usuario: '', password: '' }), /Escribe el usuario/);
  n = await nubeFalsa((m, r) => (r === '/api/auth/login' ? loginOk() : (r === '/api/sync/exportar/estructura' ? { datos: { ok: true } } : null)));
  await assert.rejects(abrirSesionNube({ texto: n.url, usuario: 'juan', password: 'x' }), (e) => e.http === 502 && /no devolvió la lista/.test(e.message));
  await n.cerrar();
});

test('mensajeAmable: errores de la nube se dicen tal cual; los de red, en palabras sencillas', () => {
  const conHttp = new Error('Usuario o contraseña incorrectos.'); conHttp.http = 401;
  assert.equal(mensajeAmable(conHttp), 'Usuario o contraseña incorrectos.');
  assert.match(mensajeAmable(new TypeError('fetch failed')), /No hay conexión con la nube/);
  assert.match(mensajeAmable(new Error('The operation was aborted due to timeout')), /~1 minuto/);
  assert.equal(mensajeAmable(new Error('algo raro')), 'algo raro');
});

// ============================ con base de datos ============================
const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('traer de la nube con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}
const { Client } = require('pg');
const { baseVacia, vaciarBase, prepararBase } = require('../src/servidor/negocio');
const { importar } = require('../src/servidor/traer');
const DIR_SERVIDOR = path.resolve(__dirname, '..', '..'); // carpeta que tiene backend/
const sql = async (q, p) => { const c = new Client({ connectionString: URL_BD }); await c.connect(); try { return await c.query(q, p); } finally { await c.end(); } };

// Una nube de mentira con datos: sirve estructura y tablas por pedazos (?limite y ?desde), como la real.
function nubeConDatos({ tablas, estructura }) {
  return nubeFalsa((m, r) => {
    const u = new URL(r, 'http://x');
    if (u.pathname === '/api/auth/login') return loginOk();
    if (u.pathname === '/api/sync/exportar/estructura') return { datos: estructura };
    const mt = /^\/api\/sync\/exportar\/(.+)$/.exec(u.pathname);
    if (mt && tablas[mt[1]]) {
      const lim = Number(u.searchParams.get('limite')) || 1000; const desde = u.searchParams.get('desde');
      const todas = tablas[mt[1]].filter((f) => desde === null || f.id > Number(desde));
      const filas = todas.slice(0, lim);
      return { datos: { ok: true, filas, siguiente: filas.length === lim ? String(filas[filas.length - 1].id) : null } };
    }
    return null;
  });
}

const DATOS = {
  sucursales: [{ id: 7, nombre: 'Cremería La Vaquita', activo: true, columna_del_futuro: 1 }],
  usuarios: [
    { id: 11, sucursal_id: 7, nombre: 'Juan', usuario: 'juan', password_hash: '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', rol: 'dueno', activo: true, columna_del_futuro: 'x' },
    { id: 12, sucursal_id: 7, nombre: 'Luis', usuario: 'luis', password_hash: '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', rol: 'cajero', activo: true },
    { id: 13, sucursal_id: 7, nombre: 'Ana', usuario: 'ana', password_hash: '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', rol: 'cajero', activo: false }
  ],
  tabla_del_futuro: [{ id: 1 }],
  licencia: [{ id: 1 }]
};
const EST_DB = {
  ok: true, version: 1, total: 5, orden: ['sucursales', 'usuarios', 'tabla_del_futuro', 'licencia'],
  tablas: {
    sucursales: { pk: 'id', cols: ['id', 'nombre', 'activo', 'columna_del_futuro'], filas: 1 },
    usuarios: { pk: 'id', cols: ['id', 'sucursal_id', 'nombre', 'usuario', 'password_hash', 'rol', 'activo', 'columna_del_futuro'], filas: 3 },
    tabla_del_futuro: { pk: 'id', cols: ['id'], filas: 1 },
    licencia: { pk: 'id', cols: ['id'], filas: 1 }
  }
};

test('importar: baja por pedazos, ignora lo que esta versión no conoce, no toca la licencia y deja los contadores listos', async () => {
  await vaciarBase(URL_BD);
  await prepararBase(URL_BD, DIR_SERVIDOR);
  await sql("INSERT INTO sucursales (nombre) VALUES ('Sucursal que ya existía')");
  const n = await nubeConDatos({ tablas: DATOS, estructura: EST_DB });
  try {
    const sesion = await abrirSesionNube({ texto: n.url, usuario: 'juan', password: 'x' });
    const avisos = [];
    const r = await importar({ url: URL_BD, sesion, avisar: (t) => avisos.push(t), lote: 1 });
    assert.equal(r.registros, 4, 'solo sucursales y usuarios (la tabla y la licencia que no corresponden se ignoran)');
    assert.deepEqual((await sql('SELECT id, nombre FROM sucursales ORDER BY id')).rows, [{ id: 7, nombre: 'Cremería La Vaquita' }]);
    const u = (await sql('SELECT id, usuario, rol, activo FROM usuarios ORDER BY id')).rows;
    assert.deepEqual(u.map((x) => [x.id, x.usuario, x.rol, x.activo]), [[11, 'juan', 'dueno', true], [12, 'luis', 'cajero', true], [13, 'ana', 'cajero', false]]);
    assert.equal((await sql("SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name = 'tabla_del_futuro'")).rows[0].n, 0);
    assert.equal((await sql('SELECT COUNT(*)::int n FROM licencia')).rows[0].n, 0, 'la licencia no se copia como datos');
    // el siguiente alta no choca con los ids que vinieron de la nube
    const nueva = await sql("INSERT INTO sucursales (nombre) VALUES ('Nueva') RETURNING id");
    assert.ok(nueva.rows[0].id > 7);
    assert.ok(avisos.some((a) => /%/.test(a)));
  } finally { await n.cerrar(); }
});

test('importar: si la nube no trae al dueño, se deshace todo y lo que había queda igual', async () => {
  await vaciarBase(URL_BD);
  await prepararBase(URL_BD, DIR_SERVIDOR);
  await sql("INSERT INTO sucursales (id, nombre) VALUES (1, 'La de antes')");
  const sinDueno = { ...DATOS, usuarios: DATOS.usuarios.map((x) => ({ ...x, rol: 'cajero' })) };
  const n = await nubeConDatos({ tablas: sinDueno, estructura: EST_DB });
  try {
    const sesion = await abrirSesionNube({ texto: n.url, usuario: 'juan', password: 'x' });
    await assert.rejects(importar({ url: URL_BD, sesion }), /no trae al usuario dueño/);
    assert.deepEqual((await sql('SELECT nombre FROM sucursales')).rows, [{ nombre: 'La de antes' }]);
  } finally { await n.cerrar(); }
});

test('traerDeNube: si falla en una computadora nueva, la base queda vacía; en una con datos, queda como estaba', async () => {
  const caida = await nubeFalsa((m, r) => {
    if (r === '/api/auth/login') return loginOk();
    if (r === '/api/sync/exportar/estructura') return { datos: EST_DB };
    return { status: 500, datos: { error: 'La nube se cayó' } }; // cualquier tabla falla
  });
  try {
    const sesion = await abrirSesionNube({ texto: caida.url, usuario: 'juan', password: 'x' });
    await vaciarBase(URL_BD);
    await assert.rejects(traerDeNube({ url: URL_BD, dirServidor: DIR_SERVIDOR, sesion }), (e) => /No se pudo traer la información de la nube: La nube se cayó/.test(e.message) && /No se guardó nada/.test(e.message));
    assert.equal(await baseVacia(URL_BD), true, 'computadora nueva: queda vacía para volver a intentar');

    await prepararBase(URL_BD, DIR_SERVIDOR);
    await sql("INSERT INTO sucursales (id, nombre) VALUES (1, 'La de antes')");
    await assert.rejects(traerDeNube({ url: URL_BD, dirServidor: DIR_SERVIDOR, sesion, prepararAntes: false, limpiarSiFalla: false }), /quedó como estaba/);
    assert.deepEqual((await sql('SELECT nombre FROM sucursales')).rows, [{ nombre: 'La de antes' }]);
  } finally { await caida.cerrar(); await vaciarBase(URL_BD); }
});
