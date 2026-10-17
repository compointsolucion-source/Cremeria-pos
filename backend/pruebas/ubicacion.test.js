// Enlaces de ubicación del pedido a domicilio (frontend/js/ubicacion.js): no necesitan base de datos.
const test = require('node:test');
const assert = require('node:assert/strict');

let UB = null;
try { UB = require('../../frontend/js/ubicacion.js'); } catch (e) { /* el backend solo (sin la carpeta frontend) también debe poder probarse */ }
const conPantalla = (nombre, fn) => test(nombre, { skip: UB ? false : 'no está la carpeta frontend' }, fn);

conPantalla('lee la ubicación de enlaces de Google Maps y de WhatsApp', () => {
  const ok = (texto, lat, lng) => assert.deepEqual(UB.extraerCoordenadas(texto), { latitud: lat, longitud: lng }, texto);
  ok('https://www.google.com/maps/@20.6736,-103.344,17z', 20.6736, -103.344);
  ok('https://www.google.com/maps/place/Casa/@20.7091234,-103.4123456,17z/data=!3m1', 20.7091234, -103.4123456);
  ok('https://maps.google.com/?q=20.7091,-103.4123', 20.7091, -103.4123);
  ok('https://www.google.com/maps?q=20.7091%2C-103.4123&z=17', 20.7091, -103.4123);
  ok('https://www.google.com/maps/search/?api=1&query=20.7091,-103.4123', 20.7091, -103.4123);
  ok('https://www.google.com/maps/place/X/data=!4m6!3m5!1s0x0:0x0!8m2!3d20.5555!4d-103.2222', 20.5555, -103.2222);
  ok('https://waze.com/ul?ll=20.7091,-103.4123&navigate=yes', 20.7091, -103.4123);
  ok('https://maps.apple.com/?ll=20.7091,-103.4123&q=Casa', 20.7091, -103.4123);
  ok('20.6736, -103.3440', 20.6736, -103.344);
  ok('Mi ubicación: 20.6736 -103.3440 gracias', 20.6736, -103.344);
  ok('  20.673612,-103.344011 ', 20.673612, -103.344011);
});

conPantalla('lo que no es una ubicación no inventa coordenadas', () => {
  for (const t of ['', null, undefined, 'Av. Patria 1234, Zapopan', 'https://www.google.com/', '123', '0,0', '95.5, -103.3', 'q=20,-103', '12.5 kg a 190']) {
    assert.equal(UB.extraerCoordenadas(t), null, String(t));
  }
  assert.equal(UB.esEnlaceCorto('https://maps.app.goo.gl/abc123'), true);
  assert.equal(UB.esEnlaceCorto('https://goo.gl/maps/xyz'), true);
  assert.equal(UB.esEnlaceCorto('https://www.google.com/maps/@20.6,-103.3,17z'), false);
});

conPantalla('enlaces de Waze y Google Maps: con ubicación exacta o con la dirección escrita', () => {
  const exacta = { calle: 'Av. Patria 1234', colonia: 'Jardines Universidad', latitud: 20.7, longitud: -103.4 };
  assert.equal(UB.urlWaze(exacta), 'https://waze.com/ul?ll=20.7,-103.4&navigate=yes');
  assert.equal(UB.urlGoogleMaps(exacta), 'https://www.google.com/maps/dir/?api=1&destination=20.7%2C-103.4&travelmode=driving');
  const escrita = { calle: 'Av. Patria 1234', colonia: 'Jardines Universidad', cp: '45110', ciudad: 'Zapopan' };
  assert.equal(UB.textoDireccion(escrita), 'Av. Patria 1234, Jardines Universidad, C.P. 45110, Zapopan');
  assert.equal(UB.urlWaze(escrita), 'https://waze.com/ul?q=' + encodeURIComponent('Av. Patria 1234, Jardines Universidad, C.P. 45110, Zapopan') + '&navigate=yes');
  assert.ok(UB.urlGoogleMaps(escrita).includes(encodeURIComponent('Av. Patria 1234')));
  // coordenadas como texto de la base de datos
  assert.equal(UB.urlWaze({ calle: 'x', latitud: '20.7000000', longitud: '-103.4000000' }), 'https://waze.com/ul?ll=20.7,-103.4&navigate=yes');
  // coordenadas absurdas se ignoran y se usa la dirección
  assert.ok(UB.urlWaze({ calle: 'Calle 1', latitud: 999, longitud: 1 }).includes('q=Calle%201'));
});

conPantalla('ruta con varias paradas', () => {
  const p = (n) => ({ calle: 'Calle ' + n, latitud: 20 + n / 100, longitud: -103 - n / 100 });
  assert.equal(UB.urlGoogleMapsRuta([]), null);
  const una = UB.urlGoogleMapsRuta([p(1)]);
  assert.ok(una.includes('destination=20.01%2C-103.01') && !una.includes('waypoints'));
  const tres = UB.urlGoogleMapsRuta([p(1), p(2), p(3)]);
  assert.ok(tres.includes('destination=20.03%2C-103.03'));
  assert.ok(tres.includes('waypoints=20.01%2C-103.01%7C20.02%2C-103.02'));
  const muchas = UB.urlGoogleMapsRuta(Array.from({ length: 15 }, (_, i) => p(i + 1)));
  assert.equal(muchas.split('%7C').length, 9); // máximo 9 intermedias
});

conPantalla('teléfonos: llamar y WhatsApp', () => {
  assert.equal(UB.telefonoInternacional('33 1234 5678'), '523312345678');
  assert.equal(UB.telefonoInternacional('+52 (33) 1234-5678'), '523312345678');
  assert.equal(UB.telefonoInternacional('521 33 1234 5678'), '523312345678');
  assert.equal(UB.telefonoInternacional(''), '');
  assert.equal(UB.urlLlamar('3312345678'), 'tel:+523312345678');
  assert.equal(UB.urlLlamar(null), null);
  assert.equal(UB.urlWhatsApp('3312345678', 'Hola, tu pedido va en camino'), 'https://wa.me/523312345678?text=Hola%2C%20tu%20pedido%20va%20en%20camino');
  assert.equal(UB.urlWhatsApp('3312345678'), 'https://wa.me/523312345678');
  assert.equal(UB.urlWhatsApp('', 'x'), null);
});
