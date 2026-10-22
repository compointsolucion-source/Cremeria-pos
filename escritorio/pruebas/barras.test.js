// Códigos de barras del ticket: se redibujan con barras de ancho exacto (se prueba sin abrir Electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const { dibujarBarras } = require('../src/barras');

const ANCHO = 576, ALTO = 120;
// Un patrón de ejemplo con zona blanca de 10 módulos a cada lado (1 = barra, 0 = espacio).
const NUCLEO = '11010010000' + '10110001110' + '11001011000' + '11010111000' + '11100010110' + '1100011101011';
const PATRON = '0'.repeat(10) + NUCLEO + '0'.repeat(10);

function lienzo(valor) {
  const buf = Buffer.alloc(ANCHO * ALTO * 4, 255);
  if (valor !== undefined) for (let i = 0; i < buf.length; i += 4) { buf[i] = buf[i + 1] = buf[i + 2] = valor; }
  return buf;
}
const negro = (buf, x, y) => buf[(y * ANCHO + x) * 4] === 0;
function corridasFila(buf, y) {
  const r = []; let actual = negro(buf, 0, y), n = 0;
  for (let x = 0; x < ANCHO; x++) {
    if (negro(buf, x, y) === actual) n++; else { r.push([actual, n]); actual = !actual; n = 1; }
  }
  r.push([actual, n]);
  return r;
}

test('cada módulo mide un número entero de puntos, aunque la imagen original saliera chueca', () => {
  const buf = lienzo();
  // Lo que dejaba el ticket: barras de 4.57 puntos pegadas a las orillas (aquí, a rayas desiguales)
  for (let x = 0; x < ANCHO; x++) if ((x * 7) % 13 < 6) for (let y = 20; y < 80; y++) { const i = (y * ANCHO + x) * 4; buf[i] = buf[i + 1] = buf[i + 2] = 0; }
  const M = PATRON.length; // 88 módulos
  const hechos = dibujarBarras(buf, ANCHO, ALTO, [{ x: 0, y: 20 / 1.9, w: ANCHO / 1.9, h: 60 / 1.9, patron: PATRON }], 1.9);
  assert.equal(hechos, 1);
  const fila = corridasFila(buf, 50);
  fila.forEach(([, n]) => assert.equal(n % 4 === 0 || n >= 100, true, 'corrida de ' + n + ' puntos'));
  // Lo que está fuera del recuadro (arriba y abajo) no se toca
  assert.equal(negro(buf, 3, 10), false);
});

test('queda centrado en su recuadro y con la zona blanca a los lados', () => {
  const buf = lienzo();
  const k = 3, M = PATRON.length, ancho = k * M;
  const izq = 100;
  const hechos = dibujarBarras(buf, ANCHO, ALTO, [{ x: izq, y: 10, w: ancho, h: 40, patron: PATRON }], 1);
  assert.equal(hechos, 1);
  // primera barra: después de 10 módulos en blanco
  const fila = 30;
  let primero = -1; for (let x = 0; x < ANCHO; x++) if (negro(buf, x, fila)) { primero = x; break; }
  assert.equal(primero, izq + 10 * k);
  let ultimo = -1; for (let x = ANCHO - 1; x >= 0; x--) if (negro(buf, x, fila)) { ultimo = x; break; }
  assert.equal(ultimo, izq + (M - 10) * k - 1);
  // 3 puntos por módulo exactos en todas las corridas negras
  corridasFila(buf, fila).filter(([c]) => c).forEach(([, n]) => assert.equal(n % k, 0));
});

test('cada barra tiene el alto del recuadro y no se pasa', () => {
  const buf = lienzo();
  dibujarBarras(buf, ANCHO, ALTO, [{ x: 100, y: 10, w: 3 * PATRON.length, h: 40, patron: PATRON }], 1);
  const col = 100 + 10 * 3; // primera barra
  assert.equal(negro(buf, col, 9), false);
  assert.equal(negro(buf, col, 10), true);
  assert.equal(negro(buf, col, 49), true);
  assert.equal(negro(buf, col, 50), false);
});

test('patrones raros o recuadros fuera de la imagen se ignoran sin romper nada', () => {
  const buf = lienzo(), copia = Buffer.from(buf);
  assert.equal(dibujarBarras(buf, ANCHO, ALTO, [{ x: 0, y: 0, w: 100, h: 20, patron: '' }], 1), 0);
  assert.equal(dibujarBarras(buf, ANCHO, ALTO, [{ x: 0, y: 0, w: 100, h: 20, patron: '10102x' + '1'.repeat(30) }], 1), 0);
  assert.equal(dibujarBarras(buf, ANCHO, ALTO, [{ x: 0, y: 500, w: 100, h: 20, patron: PATRON }], 1), 0);
  assert.equal(dibujarBarras(buf, ANCHO, ALTO, [{ x: 0, y: 0, w: 100, h: 20, patron: '1'.repeat(ANCHO + 5) }], 1), 0);
  assert.equal(dibujarBarras(buf, ANCHO, ALTO, [{ x: 0, y: 0, w: 100, h: 20, patron: PATRON }], 0), 0);
  assert.equal(dibujarBarras(null, ANCHO, ALTO, [], 1), 0);
  assert.deepEqual(buf, copia);
});
