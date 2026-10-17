// Venta a granel por IMPORTE ("dame $100 de queso"): las cuentas de la pantalla (frontend/js/granel.js)
// y las del servidor (backend/utils/importeExacto.js) tienen que dar SIEMPRE lo mismo.
// No necesitan base de datos.
const test = require('node:test');
const assert = require('node:assert/strict');
const exacto = require('../utils/importeExacto');

let GRANEL = null;
try { GRANEL = require('../../frontend/js/granel.js'); } catch (e) { /* el backend solo (sin la carpeta frontend) también debe poder probarse */ }
const conPantalla = (nombre, fn) => test(nombre, { skip: GRANEL ? false : 'no está la carpeta frontend' }, fn);

const queso = { id: 1, nombre: 'Queso Oaxaca', tipo_venta: 'peso', precio: '190.00', promociones: [] };
const conPromo = { ...queso, promociones: [{ cantidad_minima: '5', precio_promocional: '170.00' }, { cantidad_minima: '10', precio_promocional: '160.00' }] };

test('servidor: el importe exacto se respeta si es coherente con cantidad × precio', () => {
  // 0.526 kg × $190 = $99.94, pero el cliente pidió y pagó $100
  assert.equal(exacto.subtotalRenglon({ cantidad: 0.526, precio_unitario: 190, importe: 100 }), 100);
  assert.equal(exacto.subtotalRenglon({ cantidad: '0.526', precio_unitario: '190.00', importe: '100.00' }), 100);
});

test('servidor: un importe que no cuadra con cantidad × precio se ignora', () => {
  assert.equal(exacto.subtotalRenglon({ cantidad: 0.526, precio_unitario: 190, importe: 150 }), 99.94);
  assert.equal(exacto.subtotalRenglon({ cantidad: 0.526, precio_unitario: 190, importe: 0.01 }), 99.94);
  assert.equal(exacto.subtotalRenglon({ cantidad: 0.526, precio_unitario: 190, importe: 100.2 }), 99.94);
  assert.equal(exacto.subtotalRenglon({ cantidad: 0.526, precio_unitario: 190, importe: -100 }), 99.94);
  assert.equal(exacto.subtotalRenglon({ cantidad: 0.526, precio_unitario: 190, importe: 'abc' }), 99.94);
  assert.equal(exacto.subtotalRenglon({ cantidad: 0.526, precio_unitario: 190, importe: Infinity }), 99.94);
});

test('servidor: sin importe todo sigue como siempre (cantidad × precio a centavos)', () => {
  assert.equal(exacto.subtotalRenglon({ cantidad: 2, precio_unitario: 12.5 }), 25);
  assert.equal(exacto.subtotalRenglon({ cantidad: 0.35, precio_unitario: 139 }), 48.65);
  assert.equal(exacto.subtotalRenglon({ cantidad: 3, precio_unitario: 12, importe: null }), 36);
  assert.equal(exacto.subtotalRenglon({ cantidad: 3, precio_unitario: 12, importe: '' }), 36);
  assert.equal(exacto.subtotalRenglon({ cantidad: 3, precio_unitario: 12, importe: undefined }), 36);
});

conPantalla('pantalla: por importe calcula la cantidad y cobra el importe exacto', () => {
  const c = GRANEL.porImporte(queso, 100);
  assert.equal(c.cantidad, 0.526);
  assert.equal(c.importe, 100);
  assert.equal(c.precio_unitario, 190);
  assert.equal(c.por_importe, true);
  const r = GRANEL.renglon(queso, c);
  assert.equal(r.importe, 100);
  assert.equal(r.tipo_venta, 'peso');
  assert.equal(GRANEL.subtotal(r), 100);
  assert.equal(exacto.subtotalRenglon(r), 100);
});

conPantalla('pantalla: por cantidad no manda importe (se cobra cantidad × precio)', () => {
  const c = GRANEL.porCantidad(queso, 1.5);
  assert.equal(c.importe, 285);
  assert.equal(c.por_importe, false);
  const r = GRANEL.renglon(queso, c);
  assert.equal('importe' in r, false);
  assert.equal(GRANEL.subtotal(r), 285);
});

conPantalla('pantalla: precios por volumen (por cantidad y por importe)', () => {
  const a = GRANEL.porCantidad(conPromo, 5);
  assert.equal(a.precio_unitario, 170);
  assert.equal(a.importe, 850);
  assert.equal(a.promo, true);
  assert.equal(GRANEL.porCantidad(conPromo, 4.999).precio_unitario, 190);
  assert.equal(GRANEL.porCantidad(conPromo, 12).precio_unitario, 160);
  // $850 alcanzan 5 kg a $170 → se aplica el precio por volumen
  const b = GRANEL.porImporte(conPromo, 850);
  assert.equal(b.precio_unitario, 170);
  assert.equal(b.cantidad, 5);
  assert.equal(b.promo, true);
  // $800 no alcanzan los 5 kg: precio normal
  const c = GRANEL.porImporte(conPromo, 800);
  assert.equal(c.precio_unitario, 190);
  assert.equal(c.promo, false);
  // Caja Avanzada nunca aplicó precios por volumen: se pide sin promos
  assert.equal(GRANEL.porImporte(conPromo, 900, { promos: false }).precio_unitario, 190);
  assert.equal(GRANEL.porCantidad(conPromo, 12, { promos: false }).precio_unitario, 190);
});

conPantalla('pantalla: casos raros no truenan', () => {
  assert.equal(GRANEL.porImporte(queso, 0), null);
  assert.equal(GRANEL.porImporte(queso, ''), null);
  assert.equal(GRANEL.porCantidad(queso, 0), null);
  assert.deepEqual(GRANEL.porImporte({ ...queso, precio: '0' }, 50), { error: 'sin_precio' });
  assert.deepEqual(GRANEL.porImporte(queso, 0.01), { error: 'muy_pequeno' }); // menos de un gramo
});

conPantalla('pantalla y servidor dan siempre lo mismo (miles de casos al azar)', () => {
  let semilla = 12345;
  const azar = () => { semilla = (semilla * 1103515245 + 12345) & 0x7fffffff; return semilla / 0x7fffffff; };
  for (let i = 0; i < 5000; i++) {
    const precio = Math.round((5 + azar() * 600) * 100) / 100;
    const cantidad = Math.round((0.001 + azar() * 20) * 1000) / 1000;
    const importe = azar() < 0.5 ? Math.round(cantidad * precio * 100) / 100 + (azar() < 0.5 ? 0 : (azar() - 0.5) * 2) : undefined;
    const it = { cantidad, precio_unitario: precio, importe };
    assert.equal(GRANEL.subtotal(it), exacto.subtotalRenglon(it), JSON.stringify(it));
  }
});

conPantalla('pantalla: lo que se captura por importe SIEMPRE lo acepta el servidor y cobra exacto', () => {
  const precios = [19.5, 38, 85, 139, 190, 233.33, 410.5];
  for (const precio of precios) {
    for (let importe = 1; importe <= 1000; importe += 0.5) {
      const prod = { id: 1, nombre: 'X', tipo_venta: 'peso', precio: String(precio), promociones: [] };
      const c = GRANEL.porImporte(prod, importe);
      if (c.error) continue; // importes menores a un gramo
      const r = GRANEL.renglon(prod, c);
      assert.equal(exacto.subtotalRenglon(r), importe, `precio ${precio} importe ${importe}`);
      assert.equal(GRANEL.subtotal(r), importe, `precio ${precio} importe ${importe}`);
    }
  }
});

conPantalla('pantalla: si cambia la cantidad o el precio, el importe exacto deja de aplicar', () => {
  const r = GRANEL.renglon(queso, GRANEL.porImporte(queso, 100));
  assert.equal(GRANEL.subtotal({ ...r, cantidad: 1 }), 190);
  assert.equal(GRANEL.subtotal({ ...r, precio_unitario: 170 }), 89.42);
  assert.equal(exacto.subtotalRenglon({ ...r, cantidad: 1 }), 190);
});

conPantalla('pantalla: texto del renglón en ticket y carrito', () => {
  assert.equal(GRANEL.detalle({ tipo: 'producto', tipo_venta: 'peso', cantidad: 0.526, precio_unitario: 190 }), '0.526 kg x $190.00/kg');
  assert.equal(GRANEL.detalle({ tipo: 'producto', tipo_venta: 'peso', cantidad: 2, precio_unitario: '139' }), '2 kg x $139.00/kg');
  assert.equal(GRANEL.detalle({ tipo: 'producto', tipo_venta: 'peso', cantidad: 1.5, precio_unitario: 190 }, '×'), '1.5 kg × $190.00/kg');
  assert.equal(GRANEL.detalle({ tipo: 'producto', tipo_venta: 'unidad', cantidad: 3, precio_unitario: 12 }), '3 x $12');
  assert.equal(GRANEL.detalle({ tipo: 'producto', cantidad: 3, precio_unitario: '12.00' }), '3 x $12.00'); // sin tipo_venta: como siempre
  assert.equal(GRANEL.detalle({ tipo: 'kit', cantidad: 1, precio_unitario: 99 }), 'Kit');
});

conPantalla('teclado de la computadora: qué hace cada tecla en la ventana de peso/piezas', () => {
  assert.deepEqual(GRANEL.accionTecla('7'), { accion: 'digito', valor: '7' });
  assert.deepEqual(GRANEL.accionTecla('0'), { accion: 'digito', valor: '0' });
  for (const t of ['.', ',', 'Decimal']) assert.deepEqual(GRANEL.accionTecla(t), { accion: 'punto' });
  assert.deepEqual(GRANEL.accionTecla('Backspace'), { accion: 'borrar' });
  assert.deepEqual(GRANEL.accionTecla('Delete'), { accion: 'limpiar' });
  assert.deepEqual(GRANEL.accionTecla('Enter'), { accion: 'confirmar' });
  for (const t of ['Tab', 'ArrowLeft', 'ArrowRight']) assert.deepEqual(GRANEL.accionTecla(t), { accion: 'cambiar' });
  assert.deepEqual(GRANEL.accionTecla('+'), { accion: 'mas' });
  assert.deepEqual(GRANEL.accionTecla('-'), { accion: 'menos' });
  assert.equal(GRANEL.accionTecla('a'), null);             // las demás teclas no se estorban
  assert.equal(GRANEL.accionTecla('F5'), null);
  assert.equal(GRANEL.accionTecla(undefined), null);
});

conPantalla('teclado de la computadora: piezas tecleadas (la primera tecla reemplaza, luego se suma, máximo 4 dígitos)', () => {
  assert.equal(GRANEL.cantidadUnidadTecleada(1, '5', true), 5);        // ventana recién abierta: reemplaza el 1
  assert.equal(GRANEL.cantidadUnidadTecleada(5, '2', false), 52);
  assert.equal(GRANEL.cantidadUnidadTecleada(52, '3', false), 523);
  assert.equal(GRANEL.cantidadUnidadTecleada(9999, '1', false), 9999); // no pasa de 4 dígitos
  assert.equal(GRANEL.cantidadUnidadTecleada(1, '0', true), 1);        // un 0 solo no deja la cantidad en cero
  assert.equal(GRANEL.cantidadUnidadTecleada(5, '0', false), 50);
});
