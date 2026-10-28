// Lista oficial de precios: copia del programa, validación y textos de la solicitud.
const test = require('node:test');
const assert = require('node:assert');
const precios = require('../utils/precios');
const sol = require('../utils/licenciaSolicitud');

test('la copia de precios es válida y cuadra: 6 meses = 5 meses, anual = 10 meses', () => {
  assert.ok(precios.listaValida(precios.COPIA));
  for (const p of Object.values(precios.COPIA.paquetes)) {
    assert.equal(p.semestral, p.mensual * 5, p.nombre);
    assert.equal(p.anual, p.mensual * 10, p.nombre);
  }
  assert.deepEqual([precios.COPIA.paquetes.basico.mensual, precios.COPIA.paquetes.negocio.mensual, precios.COPIA.paquetes.pro.mensual], [349, 499, 799]);
  assert.equal(precios.COPIA.sin_nube.pago_unico, 2990);
});

test('una lista rara de internet no se acepta', () => {
  assert.equal(precios.listaValida(null), false);
  assert.equal(precios.listaValida({ paquetes: { x: { nombre: 'X', mensual: -1, semestral: 1, anual: 1 } }, sin_nube: { pago_unico: 1 } }), false);
  assert.equal(precios.listaValida({ paquetes: {}, sin_nube: { pago_unico: 1 } }), false);
});

test('sin internet se usa la copia (nunca falla)', async () => {
  precios._reiniciar();
  const antes = global.fetch;
  global.fetch = async () => { throw new Error('sin red'); };
  try {
    const l = await precios.obtener({ forzar: true });
    assert.equal(l.origen, 'copia');
    assert.equal(l.paquetes.pro.anual, 7990);
  } finally { global.fetch = antes; precios._reiniciar(); }
});

test('la solicitud lleva paquete y periodo, y el texto dice el precio de lista', () => {
  const codigo = sol.construirCodigo({ tipo: 'contratar', plan: 'nube', paquete: 'negocio', periodo: 'semestral', sucursales: 2, idEquipo: 'ABCD-EFGH-JKMN', datos: { negocio: 'X' }, fecha: '2026-10-28' });
  const d = sol.leerCodigo(codigo).datos;
  assert.deepEqual([d.paquete, d.periodo], ['negocio', 'semestral']);
  const m = sol.mensajeWhatsApp({ tipo: 'contratar', plan: 'nube', paquete: 'negocio', periodo: 'semestral', sucursales: 2, idEquipo: 'A', datos: {}, codigo });
  assert.match(m, /Plan: Con nube · Negocio · 6 meses \(\$2,495\) · 2 sucursales/);
  // paquete inventado o plan sin nube: no se guarda
  const c2 = sol.construirCodigo({ tipo: 'contratar', plan: 'local', paquete: 'pro', periodo: 'anual', sucursales: 1, idEquipo: 'ABCD-EFGH-JKMN', datos: {}, fecha: '2026-10-28' });
  const d2 = sol.leerCodigo(c2).datos;
  assert.equal(d2.paquete, undefined);
  assert.equal(d2.periodo, undefined);
  const c3 = sol.construirCodigo({ tipo: 'contratar', plan: 'nube', paquete: 'gratis', periodo: 'siempre', sucursales: 1, idEquipo: 'ABCD-EFGH-JKMN', datos: {}, fecha: '2026-10-28' });
  assert.equal(sol.leerCodigo(c3).datos.paquete, undefined);
});
