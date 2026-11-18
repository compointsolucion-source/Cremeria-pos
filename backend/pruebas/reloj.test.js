// Hora de la computadora mal puesta: se detecta contra la hora de internet y se avisa en cada respuesta.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

let srv, desfaseInternetMs = 0;
test.before(async () => {
  srv = http.createServer((req, res) => {
    res.setHeader('Date', new Date(Date.now() - desfaseInternetMs).toUTCString());
    res.end();
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  process.env.COMPOINT_URL_HORA = 'http://127.0.0.1:' + srv.address().port + '/';
});
test.after(() => srv.close());

function cabeceras(reloj) {
  const puestas = {};
  reloj.avisoEnRespuesta({}, { set: (k, v) => { puestas[k] = v; } }, () => {});
  return puestas;
}

test('hora bien: no hay aviso; adelantada 2 horas: avisa +120; corregida: el aviso se quita', async () => {
  const reloj = require('../utils/reloj');
  desfaseInternetMs = 0;
  await reloj.revisar();
  assert.equal(reloj._desfase(), 0);
  assert.deepEqual(cabeceras(reloj), {});

  desfaseInternetMs = 2 * 60 * 60 * 1000; // internet va 2 h "atrás" = esta computadora va 2 h adelantada
  await reloj.revisar();
  assert.equal(reloj._desfase(), 120);
  assert.deepEqual(cabeceras(reloj), { 'X-Reloj-Desfase': '120' });

  desfaseInternetMs = 2 * 60 * 1000; // 2 minutos: dentro de la tolerancia
  await reloj.revisar();
  assert.equal(reloj._desfase(), 0);
  assert.deepEqual(cabeceras(reloj), {});
});

test('sin internet no se cambia lo último que se supo', async () => {
  process.env.COMPOINT_URL_HORA = 'http://127.0.0.1:1/';
  delete require.cache[require.resolve('../utils/reloj')];
  const reloj = require('../utils/reloj');
  reloj._poner(-450);
  await reloj.revisar();
  assert.equal(reloj._desfase(), -450);
});
