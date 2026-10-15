const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { armar, leerCarga, nombreArchivo, tamanoCarpeta } = require('../scripts/empaquetar-instalador');

function carpetaTemporal() { return fs.mkdtempSync(path.join(os.tmpdir(), 'empaq-')); }

test('arma el instalador y se puede volver a leer', () => {
  const d = carpetaTemporal();
  const base = path.join(d, 'base.exe'); fs.writeFileSync(base, Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(5000)]));
  const paquete = path.join(d, 'Payload.exe'); const bytes = crypto.randomBytes(9 * 1024 * 1024 + 123); fs.writeFileSync(paquete, bytes);
  const salida = path.join(d, 'final', 'Instalar.exe');
  const meta = { formato: 1, version: '1.2.3', negocio: 'Cremería Ñandú', archivo: 'Payload.exe', tamanoInstalado: 450 * 1048576, conUrl: true };
  const c = armar({ base, paquete, meta, salida });
  assert.strictEqual(c.largo, bytes.length);
  assert.strictEqual(c.inicio, fs.statSync(base).size);
  const otra = leerCarga(salida);
  assert.deepStrictEqual(otra.meta, meta);
  const sacado = fs.readFileSync(salida).subarray(otra.inicio, otra.inicio + otra.largo);
  assert.ok(sacado.equals(bytes), 'el paquete incluido es idéntico');
  assert.ok(fs.readFileSync(salida).subarray(0, otra.inicio).equals(fs.readFileSync(base)), 'el instalador base queda intacto al inicio');
});

test('un archivo sin paquete no se confunde', () => {
  const d = carpetaTemporal();
  const f = path.join(d, 'solo.exe'); fs.writeFileSync(f, crypto.randomBytes(500));
  assert.throws(() => leerCarga(f), /Sin paquete/);
});

test('nombre de archivo del cliente', () => {
  assert.strictEqual(nombreArchivo('Cremería La Vaquita'), 'Cremeria-La-Vaquita');
  assert.strictEqual(nombreArchivo('  '), 'Compoint');
  assert.strictEqual(nombreArchivo('Ñoño & Hijos, S.A.'), 'Nono-Hijos-S-A');
});

test('tamaño de una carpeta', () => {
  const d = carpetaTemporal();
  fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(d, 'x.bin'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(d, 'a', 'b', 'y.bin'), Buffer.alloc(234));
  assert.strictEqual(tamanoCarpeta(d), 1234);
  assert.strictEqual(tamanoCarpeta(path.join(d, 'no-existe')), 0);
});
