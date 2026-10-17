// Pruebas de los códigos de activación firmados y del cálculo de estados de la licencia.
// No necesitan base de datos.   Se corren con:  cd backend && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const c = require('../utils/licenciaCodigo');
const { calcularEstado, GRACIA_PAGO } = require('../utils/licencia');

// Llave de PRUEBA con semilla fija (bytes 0..31). Solo sirve para estas pruebas:
// la llave real de Compoint nunca está en el código.
const SEMILLA = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const PRIVADA = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEMILLA]), format: 'der', type: 'pkcs8' });
const PUBLICA_HEX = crypto.createPublicKey(PRIVADA).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
const ID = c.idEquipoDesde('maquina-de-prueba');

// Códigos de ejemplo FIJOS: el Activador Compoint (programa en Go) debe producir exactamente estos mismos.
const EJEMPLO_ANUAL = 'CPT1-04104-0R3ZC-2PG12-JGXNS-0RDKM-W0000-07KP7-HDSD7-YJ3MR-F02T0-WD5M1-ZBVME-HXZNC-ZSYT9-VRYKC-7CHTG-6WN2G-ER744-H903Y-BW5ZW-ZXGSP-Y8TGZ-A8AT2-XB8MT-S7C7H-0WF2A-SJW3G';
const EJEMPLO_PERMANENTE = 'CPT1-041G2-083ZF-ZZY12-JGXNS-0RDKM-W0000-08R32-N9RRY-PPJ7X-E5VGC-XCF2D-0T1J2-J15JM-M92F8-SM1ZM-5YSFV-JMA75-FRR99-VZ0EF-D7282-7YJF8-KFYV4-V7VE7-K2XCB-7FPZM-5AZH0-EXW3R';

const base = { tipo: 'anual', plan: 'nube', maxSucursales: 3, emitida: '2026-10-16', vence: '2027-10-16', idEquipo: ID, serial: 7 };

test('la llave de prueba y el ID de equipo son estables (el Activador usa las mismas cuentas)', () => {
  assert.equal(PUBLICA_HEX, '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8');
  assert.equal(ID, '8MM7-DE86-3CX7');
});

test('códigos de ejemplo fijos: se arman idénticos y se comprueban', () => {
  assert.equal(c.emitirCodigo(base, PRIVADA), EJEMPLO_ANUAL);
  assert.equal(c.emitirCodigo({ ...base, tipo: 'permanente', plan: 'local', maxSucursales: 1, vence: null, serial: 8 }, PRIVADA), EJEMPLO_PERMANENTE);
  const r = c.verificarCodigo(EJEMPLO_ANUAL, PUBLICA_HEX);
  assert.equal(r.ok, true);
  assert.deepEqual({ ...r.datos, idEquipoValor: undefined }, { version: 1, tipo: 'anual', plan: 'nube', maxSucursales: 3, emitida: '2026-10-16', vence: '2027-10-16', idEquipo: ID, idEquipoValor: undefined, serial: 7 });
  const p = c.verificarCodigo(EJEMPLO_PERMANENTE, PUBLICA_HEX);
  assert.equal(p.ok, true);
  assert.equal(p.datos.tipo, 'permanente');
  assert.equal(p.datos.vence, null);
});

test('el ID de equipo se puede escribir con minúsculas, espacios o letras confundibles', () => {
  const v = c.idEquipoValor('maquina-de-prueba');
  assert.equal(c.leerIdEquipo(ID), v);
  assert.equal(c.leerIdEquipo('8mm7 de86 3cx7'), v);
  assert.equal(c.leerIdEquipo('8MM7DE863CX7'), v);
  assert.equal(c.leerIdEquipo('8MM7-DE86'), null);
  assert.equal(c.leerIdEquipo('8MM7-DE86-3CXU'), null); // la U no existe
  assert.match(c.idEquipoDesde('otra'), /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.notEqual(c.idEquipoDesde('otra'), ID);
});

test('el código se acepta pegado con texto alrededor, en minúsculas, con saltos de línea y espacios', () => {
  const partido = EJEMPLO_ANUAL.toLowerCase().replace(/-/g, '-\n');
  for (const texto of [
    `Hola, tu código es:\n${EJEMPLO_ANUAL}\nGracias por tu compra`,
    partido,
    '  ' + EJEMPLO_ANUAL.replace(/-/g, ' - ') .replace('CPT1 - ', 'CPT1-') + '  ',
    EJEMPLO_ANUAL.replace(/0/g, 'O').replace(/1/g, 'I') // O e I se leen como 0 y 1
  ]) {
    const r = c.verificarCodigo(texto, PUBLICA_HEX);
    assert.equal(r.ok, true, texto.slice(0, 60));
    assert.equal(r.datos.serial, 7);
  }
});

test('un código incompleto, alterado o de otra llave se rechaza con el motivo correcto', () => {
  assert.equal(c.verificarCodigo('', PUBLICA_HEX).motivo, 'prefijo');
  assert.equal(c.verificarCodigo('hola, no hay código', PUBLICA_HEX).motivo, 'prefijo');
  assert.equal(c.verificarCodigo(EJEMPLO_ANUAL.slice(0, -12), PUBLICA_HEX).motivo, 'incompleto');
  // Cambiar un solo carácter rompe la firma
  const i = EJEMPLO_ANUAL.indexOf('ZC') + 1;
  const alterado = EJEMPLO_ANUAL.slice(0, i) + (EJEMPLO_ANUAL[i] === 'A' ? 'B' : 'A') + EJEMPLO_ANUAL.slice(i + 1);
  assert.equal(c.verificarCodigo(alterado, PUBLICA_HEX).motivo, 'firma');
  // Cambiar la fecha (intentar alargar la licencia) también
  const otra = crypto.generateKeyPairSync('ed25519');
  const deOtro = c.emitirCodigo(base, otra.privateKey);
  assert.equal(c.verificarCodigo(deOtro, PUBLICA_HEX).motivo, 'firma');
  // Sin llave pública en el programa no se puede comprobar nada
  assert.equal(c.verificarCodigo(EJEMPLO_ANUAL, '').motivo, 'sinllave');
  assert.equal(c.verificarCodigo(EJEMPLO_ANUAL, 'zz').motivo, 'sinllave');
});

test('no se pueden emitir códigos incoherentes', () => {
  assert.throws(() => c.emitirCodigo({ ...base, tipo: 'permanente' }, PRIVADA), /no lleva vencimiento/);
  assert.throws(() => c.emitirCodigo({ ...base, vence: null }, PRIVADA), /necesita fecha/);
  assert.throws(() => c.emitirCodigo({ ...base, maxSucursales: 0 }, PRIVADA), /Sucursales/);
  assert.throws(() => c.emitirCodigo({ ...base, maxSucursales: 300 }, PRIVADA), /Sucursales/);
  assert.throws(() => c.emitirCodigo({ ...base, plan: 'otro' }, PRIVADA), /Plan/);
  assert.throws(() => c.emitirCodigo({ ...base, idEquipo: 'corto' }, PRIVADA), /ID del equipo/);
  assert.throws(() => c.emitirCodigo({ ...base, vence: '2027-13-40x' }, PRIVADA), /Fecha/);
});

test('un código de prueba (30 días) se distingue del anual y del permanente', () => {
  const demo = c.emitirCodigo({ ...base, tipo: 'demo', plan: 'nube', maxSucursales: 1, vence: '2026-11-15' }, PRIVADA);
  const r = c.verificarCodigo(demo, PUBLICA_HEX);
  assert.equal(r.datos.tipo, 'demo');
  assert.equal(r.datos.vence, '2026-11-15');
});

// ---------- estados ----------
const E = (tipo, vence, hoy) => calcularEstado({ tipo, vence }, hoy);

test('estados de una licencia anual: activa → por vencer → gracia → solo consulta', () => {
  assert.equal(GRACIA_PAGO, 5);
  const v = '2027-03-10';
  assert.deepEqual([E('anual', v, '2026-10-16').estado, E('anual', v, '2027-03-02').estado], ['activa', 'activa']); // faltan 8
  const a = E('anual', v, '2027-03-03');                  // faltan 7
  assert.deepEqual([a.estado, a.dias, a.por_vencer], ['por_vencer', 7, true]);
  assert.equal(E('anual', v, '2027-03-10').estado, 'por_vencer');   // el día del vencimiento todavía vale
  assert.equal(E('anual', v, '2027-03-10').dias, 0);
  const g1 = E('anual', v, '2027-03-11');
  assert.deepEqual([g1.estado, g1.dias, g1.en_gracia, g1.gracia_restante, g1.solo_consulta], ['gracia', -1, true, 4, false]);
  const g5 = E('anual', v, '2027-03-15');
  assert.deepEqual([g5.estado, g5.gracia_restante], ['gracia', 0]);   // último día de gracia
  const s = E('anual', v, '2027-03-16');
  assert.deepEqual([s.estado, s.dias, s.solo_consulta, s.en_gracia], ['solo_consulta', -6, true, false]);
});

test('la prueba de 30 días no tiene gracia: pasa directo a solo consulta', () => {
  const v = '2026-11-15';
  assert.equal(E('demo', v, '2026-10-16').estado, 'demo');
  assert.equal(E('demo', v, '2026-11-08').por_vencer, true);
  assert.equal(E('demo', v, '2026-11-07').por_vencer, false);
  assert.equal(E('demo', v, '2026-11-15').estado, 'demo');         // último día
  assert.equal(E('demo', v, '2026-11-16').estado, 'solo_consulta');
});

test('la licencia permanente nunca vence', () => {
  const p = E('permanente', null, '2099-01-01');
  assert.deepEqual([p.estado, p.dias, p.solo_consulta], ['activa', null, false]);
});

test('fin de mes y año bisiesto no rompen el conteo de días', () => {
  assert.equal(E('anual', '2028-03-01', '2028-02-28').dias, 2);   // 2028 es bisiesto
  assert.equal(E('anual', '2027-03-01', '2027-02-28').dias, 1);
  assert.equal(E('anual', '2027-01-02', '2026-12-31').dias, 2);
});
