// Pruebas de «conectar con el usuario dueño» (vincular el servidor del negocio con la nube).
// Usan una nube de mentira (un servidor HTTP pequeño), así que no necesitan internet ni base de datos.
// Se corren con:  cd escritorio && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { vincularConUsuario, resolverApi } = require('../src/servidor/sync');

// Nube de mentira. `comportamiento` decide qué responde cada ruta.
function nubeFalsa(comportamiento = {}) {
  const llamadas = [];
  const srv = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(cuerpo || '{}'); } catch (e) { /* vacío */ }
      llamadas.push({ metodo: req.method, ruta: req.url, auth: req.headers.authorization || '', cuerpo: json });
      const f = comportamiento[req.method + ' ' + req.url];
      if (!f) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<pre>Cannot ' + req.method + ' ' + req.url + '</pre>'); }
      const { status = 200, datos = {} } = f(json, req);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(datos));
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({
    api: 'http://127.0.0.1:' + srv.address().port + '/api', llamadas, cerrar: () => new Promise((r) => srv.close(r))
  })));
}
const loginOk = (rol = 'dueno') => () => ({ datos: { token: 'tok-123', usuario: { id: 1, nombre: 'Juan', rol } } });

test('vincular: con usuario dueño entrega la clave y no manda la contraseña a ningún otro lado', async () => {
  const n = await nubeFalsa({
    'POST /api/auth/login': loginOk('dueno'),
    'POST /api/sync/vincular': () => ({ datos: { ok: true, clave: 'a'.repeat(48), reemplazo: false } })
  });
  try {
    const r = await vincularConUsuario(n.api, '  juan ', 'Clave-123');
    assert.equal(r.clave, 'a'.repeat(48));
    assert.equal(r.reemplazo, false);
    assert.equal(n.llamadas.length, 2);
    assert.deepEqual(n.llamadas[0].cuerpo, { usuario: 'juan', password: 'Clave-123' });
    assert.equal(n.llamadas[1].ruta, '/api/sync/vincular');
    assert.equal(n.llamadas[1].auth, 'Bearer tok-123');
    assert.equal(JSON.stringify(n.llamadas[1].cuerpo).includes('Clave-123'), false, 'la contraseña solo se manda al iniciar sesión');
  } finally { await n.cerrar(); }
});

test('vincular: jefe general también puede', async () => {
  const n = await nubeFalsa({
    'POST /api/auth/login': loginOk('jefe_general'),
    'POST /api/sync/vincular': () => ({ datos: { ok: true, clave: 'b'.repeat(48), reemplazo: true } })
  });
  try {
    const r = await vincularConUsuario(n.api, 'jefe', 'x');
    assert.equal(r.reemplazo, true);
  } finally { await n.cerrar(); }
});

test('vincular: sin usuario o sin contraseña no llega a la nube', async () => {
  const n = await nubeFalsa({});
  try {
    for (const [u, p] of [['', ''], ['juan', ''], ['', 'x']]) {
      await assert.rejects(() => vincularConUsuario(n.api, u, p), (e) => e.http === 400 && /usuario y la contraseña/.test(e.message));
    }
    assert.equal(n.llamadas.length, 0);
  } finally { await n.cerrar(); }
});

test('vincular: contraseña incorrecta', async () => {
  const n = await nubeFalsa({ 'POST /api/auth/login': () => ({ status: 401, datos: { error: 'Usuario o contraseña incorrectos' } }) });
  try {
    await assert.rejects(() => vincularConUsuario(n.api, 'juan', 'mala'), (e) => e.http === 401 && /incorrectos/.test(e.message) && /dueño/.test(e.message));
    assert.equal(n.llamadas.length, 1, 'no se pide clave si no hubo sesión');
  } finally { await n.cerrar(); }
});

test('vincular: demasiados intentos usa el mensaje de la nube', async () => {
  const n = await nubeFalsa({ 'POST /api/auth/login': () => ({ status: 429, datos: { error: 'Demasiados intentos de inicio de sesión. Espera unos minutos e intenta de nuevo.' } }) });
  try {
    await assert.rejects(() => vincularConUsuario(n.api, 'juan', 'x'), (e) => e.http === 429 && /Demasiados intentos/.test(e.message));
  } finally { await n.cerrar(); }
});

test('vincular: usuario que no es dueño (cajero) se rechaza antes de pedir clave', async () => {
  const n = await nubeFalsa({ 'POST /api/auth/login': loginOk('cajero') });
  try {
    await assert.rejects(() => vincularConUsuario(n.api, 'cajera', 'x'), (e) => e.http === 403 && /no es el dueño/.test(e.message));
    assert.equal(n.llamadas.length, 1);
  } finally { await n.cerrar(); }
});

test('vincular: nube sin la actualización (sin la ruta de vincular)', async () => {
  const n = await nubeFalsa({ 'POST /api/auth/login': loginOk('dueno') });
  try {
    await assert.rejects(() => vincularConUsuario(n.api, 'juan', 'x'), (e) => e.http === 404 && /todavía no tiene la actualización/.test(e.message));
  } finally { await n.cerrar(); }
});

test('vincular: dirección que no es el sistema (no existe /auth/login)', async () => {
  const n = await nubeFalsa({});
  try {
    await assert.rejects(() => vincularConUsuario(n.api, 'juan', 'x'), (e) => e.http === 404 && /No se encontró el sistema/.test(e.message));
  } finally { await n.cerrar(); }
});

test('vincular: la nube responde algo raro (sin clave o sin sesión)', async () => {
  let n = await nubeFalsa({ 'POST /api/auth/login': () => ({ datos: { hola: 1 } }) });
  try { await assert.rejects(() => vincularConUsuario(n.api, 'juan', 'x'), (e) => e.http === 502); } finally { await n.cerrar(); }
  n = await nubeFalsa({ 'POST /api/auth/login': loginOk('dueno'), 'POST /api/sync/vincular': () => ({ datos: { ok: true, clave: 'corta' } }) });
  try { await assert.rejects(() => vincularConUsuario(n.api, 'juan', 'x'), (e) => e.http === 502 && /clave válida/.test(e.message)); } finally { await n.cerrar(); }
});

test('vincular: sin conexión el error no trae código http (así el panel dice «no hay conexión»)', async () => {
  const n = await nubeFalsa({});
  const api = n.api;
  await n.cerrar(); // ya nadie escucha en ese puerto
  await assert.rejects(() => vincularConUsuario(api, 'juan', 'x'), (e) => !e.http);
});

test('resolverApi: acepta la dirección del servidor con o sin /api, y exige https fuera de localhost', async () => {
  assert.equal(await resolverApi('http://127.0.0.1:3000/api'), 'http://127.0.0.1:3000/api');
  assert.equal(await resolverApi('https://minegocio-pos.onrender.com/api/'), 'https://minegocio-pos.onrender.com/api');
  await assert.rejects(() => resolverApi('http://minegocio.com'), /https/);
  await assert.rejects(() => resolverApi(''), /Escribe la dirección/);
});
