// Arma el instalador FINAL que se le entrega al cliente: un solo .exe con la pantalla de Compoint
// (herramientas/instalador-escritorio) que lleva adentro el instalador del programa (el "paquete",
// que genera electron-builder).
//
//   [ instalador base (Go) ][ paquete ][ datos (JSON) ][ pie de 64 bytes ]
//   pie: 0-7 "CPTINST1" · 8-15 largo del paquete · 16-23 largo de los datos · 24-55 sha256 del paquete · 56-63 "CPTFIN01"
//
// Si algo falla (por ejemplo no se pudo compilar el instalador base), entrega el instalador clásico de
// Windows (con la barra lateral de Compoint), que también deja elegir la carpeta del programa.
//
// Variables: CLIENTE_NOMBRE, CLIENTE_URL, CLIENTE_ARCHIVO (las mismas de la construcción), INSTALADOR_BASE (opcional).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIA_INI = 'CPTINST1';
const MAGIA_FIN = 'CPTFIN01';
const TAM_PIE = 64;
const raiz = path.join(__dirname, '..');

function nombreArchivo(nombre) {
  return String(nombre || 'Compoint').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'Compoint';
}

function tamanoCarpeta(dir) {
  let total = 0;
  const pila = [dir];
  while (pila.length) {
    const d = pila.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) pila.push(p);
      else { try { total += fs.statSync(p).size; } catch (er) { /* se ignora */ } }
    }
  }
  return total;
}

function sha256Archivo(ruta, desde, largo) {
  const fd = fs.openSync(ruta, 'r');
  try {
    const h = crypto.createHash('sha256');
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let falta = largo, pos = desde;
    while (falta > 0) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, falta), pos);
      if (n <= 0) throw new Error('Se terminó el archivo antes de tiempo');
      h.update(buf.subarray(0, n));
      falta -= n; pos += n;
    }
    return h.digest();
  } finally { fs.closeSync(fd); }
}

/** Pega el paquete, los datos y el pie al final de una copia del instalador base. */
function armar({ base, paquete, meta, salida }) {
  const largo = fs.statSync(paquete).size;
  if (largo <= 0) throw new Error('El paquete está vacío');
  const datos = Buffer.from(JSON.stringify(meta), 'utf8');
  const suma = sha256Archivo(paquete, 0, largo);
  fs.mkdirSync(path.dirname(salida), { recursive: true });
  fs.copyFileSync(base, salida);
  const baseLargo = fs.statSync(salida).size;
  const fd = fs.openSync(salida, 'a');
  try {
    const entrada = fs.openSync(paquete, 'r');
    try {
      const buf = Buffer.alloc(4 * 1024 * 1024);
      let n;
      while ((n = fs.readSync(entrada, buf, 0, buf.length, null)) > 0) fs.writeSync(fd, buf, 0, n);
    } finally { fs.closeSync(entrada); }
    fs.writeSync(fd, datos);
    const pie = Buffer.alloc(TAM_PIE);
    pie.write(MAGIA_INI, 0, 'latin1');
    pie.writeBigUInt64LE(BigInt(largo), 8);
    pie.writeBigUInt64LE(BigInt(datos.length), 16);
    suma.copy(pie, 24);
    pie.write(MAGIA_FIN, 56, 'latin1');
    fs.writeSync(fd, pie);
  } finally { fs.closeSync(fd); }
  // Comprobación: se vuelve a leer lo escrito.
  const c = leerCarga(salida);
  if (c.inicio !== baseLargo || c.largo !== largo || !c.sha.equals(suma) || !sha256Archivo(salida, c.inicio, c.largo).equals(suma)) {
    throw new Error('El instalador armado no coincide con el paquete');
  }
  return c;
}

/** Lee el pie de un instalador armado (lo mismo que hace el instalador al abrir). */
function leerCarga(ruta) {
  const tam = fs.statSync(ruta).size;
  if (tam < TAM_PIE) throw new Error('Sin paquete');
  const fd = fs.openSync(ruta, 'r');
  try {
    const pie = Buffer.alloc(TAM_PIE);
    fs.readSync(fd, pie, 0, TAM_PIE, tam - TAM_PIE);
    if (pie.toString('latin1', 0, 8) !== MAGIA_INI || pie.toString('latin1', 56, 64) !== MAGIA_FIN) throw new Error('Sin paquete');
    const largo = Number(pie.readBigUInt64LE(8));
    const largoMeta = Number(pie.readBigUInt64LE(16));
    const inicio = tam - TAM_PIE - largoMeta - largo;
    if (inicio < 0) throw new Error('Paquete dañado');
    const m = Buffer.alloc(largoMeta);
    fs.readSync(fd, m, 0, largoMeta, inicio + largo);
    return { inicio, largo, largoMeta, sha: Buffer.from(pie.subarray(24, 56)), meta: JSON.parse(m.toString('utf8')) };
  } finally { fs.closeSync(fd); }
}

function main() {
  const dist = path.join(raiz, 'dist');
  const nombre = (process.env.CLIENTE_NOMBRE || 'Compoint Punto').trim() || 'Compoint Punto';
  const archivoCliente = process.env.CLIENTE_ARCHIVO || nombreArchivo(nombre);
  const paquete = path.join(dist, 'Payload-CompointPunto.exe');
  const base = process.env.INSTALADOR_BASE || path.join(dist, 'instalador-base.exe');
  const salida = path.join(dist, 'final', `Instalar-CompointPunto-${archivoCliente}.exe`);
  if (!fs.existsSync(paquete)) {
    console.error('No se encontró el instalador del programa: ' + paquete + '. Primero corre  node scripts/construir.js');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(salida), { recursive: true });
  try {
    if (!fs.existsSync(base)) throw new Error('No se encontró el instalador base: ' + base);
    const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
    const meta = {
      formato: 1, version: pkg.version, negocio: nombre, archivo: path.basename(paquete),
      tamanoInstalado: tamanoCarpeta(path.join(dist, 'win-unpacked')),
      conUrl: !!(process.env.CLIENTE_URL || '').trim()
    };
    const c = armar({ base, paquete, meta, salida });
    console.log(`Instalador con pantalla propia listo: ${salida}`);
    console.log(`  paquete ${(c.largo / 1048576).toFixed(1)} MB · programa instalado ~${Math.round(meta.tamanoInstalado / 1048576)} MB · negocio «${nombre}»`);
  } catch (e) {
    console.log('::warning::No se pudo armar el instalador con pantalla propia (' + e.message + '). Se entrega el instalador clásico de Windows.');
    try { fs.rmSync(salida, { force: true }); } catch (er) { /* se ignora */ }
    fs.copyFileSync(paquete, salida);
    console.log(`Instalador clásico listo: ${salida}`);
  }
}

if (require.main === module) main();
module.exports = { armar, leerCarga, nombreArchivo, tamanoCarpeta, MAGIA_INI, MAGIA_FIN, TAM_PIE };
