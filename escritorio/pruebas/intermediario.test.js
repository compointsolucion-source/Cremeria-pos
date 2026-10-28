// Pruebas del intermediario de impresión por red (no necesitan base de datos ni impresora real).
// Se corren con:  cd escritorio && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const intermediario = require('../src/intermediario');
const { ipPrivada, puertoPermitido, origenDeEstaPc } = intermediario;

test('solo IPs de la red local, escritas con números', () => {
  for (const ip of ['192.168.1.100', '10.0.0.5', '172.16.0.1', '172.31.255.254', '127.0.0.1']) assert.equal(ipPrivada(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '169.254.169.254', '0.0.0.0', 'localhost', 'impresora.local', 'evil.com', '::1', '', null]) assert.equal(ipPrivada(ip), false, String(ip));
});

test('solo puertos de impresora', () => {
  for (const p of [9100, '9100', 9101, 9102]) assert.equal(puertoPermitido(p), true, String(p));
  for (const p of [22, 80, 443, 3000, 5432, 9103, '9100abc', 9100.5, null]) assert.equal(puertoPermitido(p), false, String(p));
});

test('esta misma computadora siempre puede', () => {
  assert.equal(origenDeEstaPc('http://localhost:3000'), true);
  assert.equal(origenDeEstaPc('http://127.0.0.1:3000'), true);
  assert.equal(origenDeEstaPc('file://'), true);
  assert.equal(origenDeEstaPc('null'), false);
  assert.equal(origenDeEstaPc('https://evil.com'), false);
  assert.equal(origenDeEstaPc('https://localhost.evil.com'), false);
});

function arrancar(origenPermitido) {
  return new Promise((ok) => {
    const srv = intermediario.iniciar(0, () => {}, { origenPermitido });
    srv.on('listening', () => ok('http://127.0.0.1:' + srv.address().port));
  });
}

test('páginas ajenas no pueden usarlo; las del sistema sí (con permiso de red privada)', async () => {
  const url = await arrancar((o) => o === 'https://cp1000.compoint.com.mx');
  try {
    let r = await fetch(url + '/', { headers: { Origin: 'https://evil.com' } });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('access-control-allow-origin'), null);

    r = await fetch(url + '/imprimir-red', { method: 'OPTIONS', headers: { Origin: 'https://evil.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('access-control-allow-private-network'), null);

    r = await fetch(url + '/imprimir-red', { method: 'OPTIONS', headers: { Origin: 'https://cp1000.compoint.com.mx', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://cp1000.compoint.com.mx');
    assert.equal(r.headers.get('access-control-allow-private-network'), 'true');

    r = await fetch(url + '/', { headers: { Origin: 'http://localhost:3000' } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  } finally { intermediario.detener(); }
});

test('no manda a IPs de internet ni a puertos que no son de impresora', async () => {
  const url = await arrancar(() => true);
  const mandar = (cuerpo) => fetch(url + '/imprimir-red', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }, body: JSON.stringify(cuerpo) });
  try {
    let r = await mandar({ ip: '8.8.8.8', puerto: 9100, datos: [1, 2] });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /red local/);
    r = await mandar({ ip: 'evil.com', puerto: 9100, datos: [1, 2] });
    assert.equal(r.status, 400);
    r = await mandar({ ip: '127.0.0.1', puerto: 5432, datos: [1, 2] });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /9100/);
    r = await mandar({ ip: '192.168.1.100', puerto: 9100 });
    assert.equal(r.status, 400);
  } finally { intermediario.detener(); }
});

test('imprime en una impresora de la red local (puerto 9100)', async (t) => {
  const recibido = [];
  const impresora = net.createServer((s) => s.on('data', (d) => recibido.push(...d)));
  const libre = await new Promise((ok) => { impresora.once('error', () => ok(false)); impresora.listen(9100, '127.0.0.1', () => ok(true)); });
  if (!libre) { t.skip('el puerto 9100 está ocupado en esta computadora'); return; }
  const url = await arrancar(() => false);
  try {
    const r = await fetch(url + '/imprimir-red', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' }, body: JSON.stringify({ ip: '127.0.0.1', puerto: 9100, datos: [27, 64, 65] }) });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    await new Promise((ok) => setTimeout(ok, 50));
    assert.deepEqual(recibido, [27, 64, 65]);
  } finally { intermediario.detener(); await new Promise((ok) => impresora.close(ok)); }
});
