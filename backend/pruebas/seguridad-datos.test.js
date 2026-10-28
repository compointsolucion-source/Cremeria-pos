// Reglas de seguridad que no necesitan base de datos: imagen a subir, carpeta de Cloudinary,
// celdas del CSV y enlace de ubicación de una dirección.
const test = require('node:test');
const assert = require('node:assert/strict');

const imagenes = require('../routes/imagenes');
const reportes = require('../routes/reportes');
const { normalizarDireccion, enlaceSeguro } = require('../utils/pedidosUtil');

test('imagen: solo data:image/(jpeg|jpg|png|webp|gif);base64 y de máximo 5 MB', () => {
  const ok = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  assert.equal(imagenes._errorEnImagen(ok), null);
  assert.equal(imagenes._errorEnImagen('data:image/jpeg;base64,/9j/4AAQ'), null);
  for (const malo of [
    '/etc/passwd', 'https://evil.example/x.png', 'http://169.254.169.254/latest', 'file:///etc/passwd',
    'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGgxPg==', 'data:image/png;base64,abc$%', '', null, 123, { a: 1 }
  ]) {
    assert.ok(imagenes._errorEnImagen(malo), String(malo));
  }
  const grande = 'data:image/png;base64,' + 'A'.repeat(Math.ceil(5 * 1024 * 1024 * 4 / 3) + 8);
  assert.match(imagenes._errorEnImagen(grande), /demasiado grande/);
  const justo = 'data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024 / 3 * 3); // 3 MB
  assert.equal(imagenes._errorEnImagen(justo), null);
});

test('carpeta de Cloudinary: solo las que usa el sistema; lo demás va a "general"', () => {
  for (const c of ['productos', 'kits', 'logos', 'promos', 'general']) assert.equal(imagenes._carpetaSegura(c), c);
  for (const c of ['../secreto', 'otra', '', undefined, null, 'productos/../x', ['productos']]) assert.equal(imagenes._carpetaSegura(c), 'general');
});

test('CSV: celdas que Excel tomaría como fórmula llevan apóstrofo; comas y comillas van entre comillas', () => {
  const c = reportes._celdaCsv;
  assert.equal(c('=1+1'), "'=1+1");
  assert.equal(c('+52 33'), "'+52 33");
  assert.equal(c('-cmd'), "'-cmd");
  assert.equal(c('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(c('\tx'), "'\tx");
  assert.equal(c('\rx'), '"\'\rx"');
  assert.equal(c('Juan, Pérez'), '"Juan, Pérez"');
  assert.equal(c('dice "hola"'), '"dice ""hola"""');
  assert.equal(c('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(c('Normal'), 'Normal');
  assert.equal(c(125.5), '125.5');
  assert.equal(c(null), '');
});

test('enlace de ubicación: solo http(s); lo demás se guarda vacío', () => {
  assert.equal(enlaceSeguro('https://maps.app.goo.gl/abc'), 'https://maps.app.goo.gl/abc');
  assert.equal(enlaceSeguro('HTTP://maps.google.com/?q=1,2'), 'HTTP://maps.google.com/?q=1,2');
  for (const malo of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'maps.google.com', ' ', '', null, undefined, 'vbscript:x']) {
    assert.equal(enlaceSeguro(malo), null, String(malo));
  }
  const d = normalizarDireccion({ calle: 'Fontaneros 527', ubicacion_enlace: 'javascript:alert(document.cookie)' });
  assert.equal(d.error, undefined);
  assert.equal(d.ubicacion_enlace, null);
  assert.equal(normalizarDireccion({ calle: 'X 1', ubicacion_enlace: '  https://wa.me/x  ' }).ubicacion_enlace, 'https://wa.me/x');
});
