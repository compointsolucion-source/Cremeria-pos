// Códigos de activación firmados (licencia SIN internet).
//
// Un código es una "constancia" que Compoint firma con su llave privada
// (Ed25519). El programa solo trae la llave pública, así que puede COMPROBAR
// que el código es auténtico, pero nadie puede fabricar uno nuevo.
//
// Formato:  CPT1-XXXXX-XXXXX-...   (base32, grupos de 5; se pega, no se escribe)
//   bytes del contenido (20):
//     0      versión (1)
//     1      tipo: 1 = prueba, 2 = anual, 3 = permanente
//     2      plan: 1 = sin nube, 2 = con nube
//     3      máximo de sucursales (1 a 255)
//     4-5    fecha de emisión (días desde 2024-01-01, uint16 big-endian)
//     6-7    fecha de vencimiento (igual; 0xFFFF = no vence)
//     8-15   ID del equipo (60 bits, uint64 big-endian)
//     16-19  número de serie (uint32 big-endian)
//   + 64 bytes de firma Ed25519 sobre  "CPT1\0" + contenido
//
// El Activador Compoint (programa en Go) arma exactamente los mismos bytes:
// ver pruebas/licencia-codigo.test.js (hay un código de ejemplo fijo para comparar).
const crypto = require('crypto');

const PREFIJO = 'CPT1';
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: sin I, L, O, U
const LARGO_CONTENIDO = 20;
const LARGO_FIRMA = 64;
const LARGO_TOTAL = LARGO_CONTENIDO + LARGO_FIRMA;       // 84 bytes
const CARACTERES = Math.ceil((LARGO_TOTAL * 8) / 5);     // 135
const DIA_CERO = Date.UTC(2024, 0, 1);
const SIN_VENCIMIENTO = 0xFFFF;
const DOMINIO_FIRMA = Buffer.from(PREFIJO + '\0', 'latin1');

const TIPOS = { 1: 'demo', 2: 'anual', 3: 'permanente' };
const PLANES = { 1: 'local', 2: 'nube' };
const TIPO_NUM = { demo: 1, anual: 2, permanente: 3 };
const PLAN_NUM = { local: 1, nube: 2 };

// ---------- base32 ----------
function aBase32(buf) {
  let bits = 0, valor = 0, salida = '';
  for (const b of buf) {
    valor = (valor << 8) | b; bits += 8;
    while (bits >= 5) { salida += ALFABETO[(valor >>> (bits - 5)) & 31]; bits -= 5; }
    valor &= (1 << bits) - 1;
  }
  if (bits > 0) salida += ALFABETO[(valor << (5 - bits)) & 31];
  return salida;
}

// Devuelve { bytes, sobrantes } o null si hay un carácter inválido.
function deBase32(texto) {
  let bits = 0, valor = 0;
  const bytes = [];
  for (const c of texto) {
    const v = ALFABETO.indexOf(c);
    if (v < 0) return null;
    valor = (valor << 5) | v; bits += 5;
    if (bits >= 8) { bytes.push((valor >>> (bits - 8)) & 255); bits -= 8; }
    valor &= (1 << bits) - 1;
  }
  return { bytes: Buffer.from(bytes), bitsSobrantes: bits, valorSobrante: valor };
}

// ---------- fechas ----------
function fechaADias(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) throw new Error('Fecha no válida: ' + iso);
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - DIA_CERO) / 86400000);
}
function diasAFecha(dias) {
  return new Date(DIA_CERO + dias * 86400000).toISOString().slice(0, 10);
}

// ---------- ID del equipo ----------
// A partir de un identificador interno (el GUID de Windows o el de la instalación)
// se saca un código corto de 60 bits que el cliente ve y le manda a Compoint.
function idEquipoValor(crudo) {
  const h = crypto.createHash('sha256').update('cpt-equipo-v1|' + String(crudo)).digest();
  return h.readBigUInt64BE(0) >> 4n; // 60 bits
}
function formatearIdEquipo(valor) {
  const v = BigInt(valor);
  let t = '';
  for (let i = 11n; i >= 0n; i--) t += ALFABETO[Number((v >> (5n * i)) & 31n)];
  return t.slice(0, 4) + '-' + t.slice(4, 8) + '-' + t.slice(8, 12);
}
function idEquipoDesde(crudo) { return formatearIdEquipo(idEquipoValor(crudo)); }

// Lee un ID escrito por una persona («7kq2 9xma-4tpl»). Devuelve BigInt o null.
function leerIdEquipo(texto) {
  const limpio = normalizar(String(texto || '').replace(/[\s-]/g, ''));
  if (limpio.length !== 12) return null;
  let v = 0n;
  for (const c of limpio) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) return null;
    v = v * 32n + BigInt(i);
  }
  return v;
}

function normalizar(t) {
  return t.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}

// ---------- llaves ----------
const PREFIJO_DER_PUBLICA = Buffer.from('302a300506032b6570032100', 'hex');

function llavePublicaDesdeHex(hex) {
  const limpio = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(limpio)) return null;
  return crypto.createPublicKey({ key: Buffer.concat([PREFIJO_DER_PUBLICA, Buffer.from(limpio, 'hex')]), format: 'der', type: 'spki' });
}

// ---------- emitir (lo usa el Activador de Compoint y las pruebas) ----------
function armarContenido(d) {
  const tipo = TIPO_NUM[d.tipo], plan = PLAN_NUM[d.plan];
  if (!tipo) throw new Error('Tipo no válido: ' + d.tipo);
  if (!plan) throw new Error('Plan no válido: ' + d.plan);
  const maxSuc = Number(d.maxSucursales);
  if (!Number.isInteger(maxSuc) || maxSuc < 1 || maxSuc > 255) throw new Error('Sucursales: de 1 a 255');
  const serial = Number(d.serial);
  if (!Number.isInteger(serial) || serial < 0 || serial > 0xFFFFFFFF) throw new Error('Serie no válida');
  const emitida = fechaADias(d.emitida);
  const vence = d.vence == null ? SIN_VENCIMIENTO : fechaADias(d.vence);
  if (emitida < 0 || emitida > 0xFFFE) throw new Error('Fecha de emisión fuera de rango');
  if (vence !== SIN_VENCIMIENTO && (vence < 0 || vence > 0xFFFE)) throw new Error('Fecha de vencimiento fuera de rango');
  if (d.tipo === 'permanente' && vence !== SIN_VENCIMIENTO) throw new Error('Un código permanente no lleva vencimiento');
  if (d.tipo !== 'permanente' && vence === SIN_VENCIMIENTO) throw new Error('Este tipo de código necesita fecha de vencimiento');
  const idv = typeof d.idEquipo === 'bigint' ? d.idEquipo : leerIdEquipo(d.idEquipo);
  if (idv == null || idv <= 0n) throw new Error('El ID del equipo no es válido');
  const b = Buffer.alloc(LARGO_CONTENIDO);
  b[0] = 1; b[1] = tipo; b[2] = plan; b[3] = maxSuc;
  b.writeUInt16BE(emitida, 4); b.writeUInt16BE(vence, 6);
  b.writeBigUInt64BE(idv, 8);
  b.writeUInt32BE(serial, 16);
  return b;
}

function agrupar(texto) { return texto.match(/.{1,5}/g).join('-'); }

// clavePrivada: KeyObject, o PEM (PKCS8) en texto.
function emitirCodigo(datos, clavePrivada) {
  const contenido = armarContenido(datos);
  const llave = typeof clavePrivada === 'string' ? crypto.createPrivateKey(clavePrivada) : clavePrivada;
  const firma = crypto.sign(null, Buffer.concat([DOMINIO_FIRMA, contenido]), llave);
  if (firma.length !== LARGO_FIRMA) throw new Error('La firma no mide lo esperado');
  return PREFIJO + '-' + agrupar(aBase32(Buffer.concat([contenido, firma])));
}

// ---------- comprobar ----------
// Saca los 135 caracteres del código aunque venga con texto alrededor (un mensaje de WhatsApp),
// guiones, espacios o saltos de línea. Devuelve el texto limpio o null.
function extraerCaracteres(texto) {
  const t = String(texto || '').toUpperCase();
  const m = /CPT[1IL]-/.exec(t); // el 1 a veces se lee como I o L
  const desde = m ? m.index + m[0].length : -1;
  if (desde < 0) return { error: 'prefijo' };
  let salida = '';
  for (let k = desde; k < t.length && salida.length < CARACTERES; k++) {
    const c = t[k];
    if (c === '-' || c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ' ') continue;
    const n = normalizar(c);
    if (ALFABETO.indexOf(n) < 0) break; // aquí terminó el código
    salida += n;
  }
  if (salida.length < CARACTERES) return { error: 'incompleto' };
  return { texto: salida };
}

const MENSAJES = {
  prefijo: 'No encontré un código de activación. Debe empezar con CPT1- y copiarse completo.',
  incompleto: 'El código está incompleto. Cópialo completo, tal como te lo mandó Compoint (empieza con CPT1-).',
  formato: 'El código no tiene el formato correcto. Cópialo completo, tal como te lo mandó Compoint.',
  sinllave: 'Esta versión del programa todavía no puede comprobar códigos. Avisa a Compoint para que te mande la actualización.',
  firma: 'Este código no es auténtico. Revisa que lo copiaste completo; si sigue igual, pide a Compoint que te lo mande otra vez.',
  version: 'Este código es de una versión más nueva del programa. Actualiza el programa e intenta de nuevo.'
};

// Devuelve { ok:true, datos } o { ok:false, motivo, mensaje }.
function verificarCodigo(texto, llavePublica) {
  const falla = (motivo) => ({ ok: false, motivo, mensaje: MENSAJES[motivo] });
  const llave = typeof llavePublica === 'string' ? llavePublicaDesdeHex(llavePublica) : llavePublica;
  if (!llave) return falla('sinllave');
  const ex = extraerCaracteres(texto);
  if (ex.error) return falla(ex.error);
  const d = deBase32(ex.texto);
  if (!d || d.bytes.length < LARGO_TOTAL || d.valorSobrante !== 0) return falla('formato');
  const bytes = d.bytes.subarray(0, LARGO_TOTAL);
  const contenido = bytes.subarray(0, LARGO_CONTENIDO);
  const firma = bytes.subarray(LARGO_CONTENIDO);
  let ok = false;
  try { ok = crypto.verify(null, Buffer.concat([DOMINIO_FIRMA, contenido]), llave, firma); } catch (e) { ok = false; }
  if (!ok) return falla('firma');
  if (contenido[0] !== 1) return falla('version');
  const tipo = TIPOS[contenido[1]], plan = PLANES[contenido[2]];
  if (!tipo || !plan || contenido[3] < 1) return falla('formato');
  const vence = contenido.readUInt16BE(6);
  return {
    ok: true,
    datos: {
      version: contenido[0], tipo, plan,
      maxSucursales: contenido[3],
      emitida: diasAFecha(contenido.readUInt16BE(4)),
      vence: vence === SIN_VENCIMIENTO ? null : diasAFecha(vence),
      idEquipo: formatearIdEquipo(contenido.readBigUInt64BE(8)),
      idEquipoValor: contenido.readBigUInt64BE(8),
      serial: contenido.readUInt32BE(16)
    }
  };
}

module.exports = {
  PREFIJO, CARACTERES, LARGO_TOTAL, SIN_VENCIMIENTO,
  aBase32, deBase32, fechaADias, diasAFecha,
  idEquipoValor, formatearIdEquipo, idEquipoDesde, leerIdEquipo,
  llavePublicaDesdeHex, emitirCodigo, verificarCodigo
};
