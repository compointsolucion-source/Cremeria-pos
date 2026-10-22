// Abrir el cajón por la impresora de Windows (se prueba sin abrir Electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const { COMANDO_CAJON, resolverImpresoraCajon } = require('../src/cajon');

const instaladas = [
  { name: 'Microsoft Print to PDF', isDefault: false },
  { name: 'POS-80', isDefault: true },
  { name: 'EPSON TM-T20', isDefault: false }
];

test('el comando es ESC @ y luego ESC p (pulso) por los dos pines', () => {
  assert.deepEqual([...COMANDO_CAJON], [0x1B, 0x40, 0x1B, 0x70, 0x00, 0x19, 0xFA, 0x1B, 0x70, 0x01, 0x19, 0xFA]);
});

test('sin impresora elegida usa la predeterminada de Windows', () => {
  assert.deepEqual(resolverImpresoraCajon(instaladas, ''), { destino: 'POS-80' });
  assert.deepEqual(resolverImpresoraCajon(instaladas, undefined), { destino: 'POS-80' });
});

test('con impresora elegida usa esa, si está instalada', () => {
  assert.deepEqual(resolverImpresoraCajon(instaladas, 'EPSON TM-T20'), { destino: 'EPSON TM-T20' });
});

test('si la elegida ya no está instalada, lo dice con su nombre', () => {
  const r = resolverImpresoraCajon(instaladas, 'TICKETERA-VIEJA');
  assert.match(r.error, /"TICKETERA-VIEJA" no está instalada/);
});

test('si Windows no tiene predeterminada, explica qué hacer', () => {
  const r = resolverImpresoraCajon([{ name: 'POS-80', isDefault: false }], '');
  assert.match(r.error, /predeterminada/);
  assert.match(r.error, /Configuración/);
  assert.match(resolverImpresoraCajon(null, '').error, /predeterminada/);
});
