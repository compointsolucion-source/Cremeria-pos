// Caja: cobro de un pedido con anticipo (frontend/js/anticipo-cobro.js). No necesita base de datos.
const test = require('node:test');
const assert = require('node:assert/strict');

let AC = null;
try { AC = require('../../frontend/js/anticipo-cobro.js'); } catch (e) { /* el backend solo (sin la carpeta frontend) también debe poder probarse */ }
const conPantalla = (nombre, fn) => test(nombre, { skip: AC ? false : 'no está la carpeta frontend' }, fn);

const ticket = (anticipo, metodo) => ({ pedido_anticipo: anticipo, pedido_anticipo_metodo: metodo });

conPantalla('sin anticipo: se cobra el total y no hay desglose', () => {
  const d = AC.desglose({}, 1250);
  assert.equal(d.hay, false);
  assert.equal(AC.aCobrarAhora(d), 1250);
  assert.equal(AC.htmlDesglose(d), '');
});

conPantalla('anticipo $500 de $1250: se cobra $750 y el cambio es sobre $750 (el caso de la captura)', () => {
  const d = AC.desglose(ticket(500, 'efectivo'), 1250);
  assert.equal(d.hay, true);
  assert.equal(d.resta, 750);
  assert.equal(AC.aCobrarAhora(d), 750);
  assert.equal(AC.cambioDe(d, 1000), 250);   // paga con $1000 → cambio $250
  assert.equal(AC.cambioDe(d, 700), -50);    // falta $50
  const html = AC.htmlDesglose(d);
  assert.match(html, /Total del ticket/);
  assert.match(html, /−\$500\.00/);
  assert.match(html, /COBRAR AHORA/);
  assert.match(html, /\$750\.00/);
  assert.doesNotMatch(html, /Mixto/);        // ya no se le pide al cajero que haga cuentas
});

conPantalla('anticipo en efectivo + paga el resto en efectivo: el ticket se registra por el total en efectivo', () => {
  const d = AC.desglose(ticket(500, 'efectivo'), 1250);
  const r = AC.repartoCobro(d, 'efectivo');
  assert.deepEqual(r, { metodo_pago: 'efectivo', monto_efectivo: 1250, monto_tarjeta: 0 });
});

conPantalla('anticipo en transferencia + resto en efectivo: queda mixto (efectivo lo que falta, transferencia el anticipo)', () => {
  const d = AC.desglose(ticket(500, 'transferencia'), 1250);
  const r = AC.repartoCobro(d, 'efectivo');
  assert.deepEqual(r, { metodo_pago: 'mixto', monto_efectivo: 750, monto_tarjeta: 500 });
});

conPantalla('anticipo en efectivo + resto con tarjeta: mixto, y la comisión solo se cobra sobre lo que se paga con tarjeta', () => {
  const d = AC.desglose(ticket(500, 'efectivo'), 1250);
  const r = AC.repartoCobro(d, 'tarjeta', null, 3);
  assert.equal(r.metodo_pago, 'mixto');
  assert.equal(r.monto_efectivo, 500);
  assert.equal(r.monto_tarjeta, 772.5);      // 750 + 3 %
});

conPantalla('anticipo en tarjeta + resto con transferencia: todo no-efectivo, sin mixto', () => {
  const d = AC.desglose(ticket(200, 'tarjeta'), 1000);
  const r = AC.repartoCobro(d, 'transferencia');
  assert.deepEqual(r, { metodo_pago: 'transferencia', monto_efectivo: 0, monto_tarjeta: 1000 });
});

conPantalla('mixto: el cajero captura lo que falta y el anticipo se suma solo', () => {
  const d = AC.desglose(ticket(500, 'efectivo'), 1250);
  const r = AC.repartoCobro(d, 'mixto', { efectivo: 250, tarjeta: 500 });
  assert.equal(r.metodo_pago, 'mixto');
  assert.equal(r.monto_efectivo, 750);       // 250 + anticipo en efectivo
  assert.equal(r.monto_tarjeta, 500);
  assert.equal(r.monto_efectivo + r.monto_tarjeta, 1250);
});

conPantalla('ya pagó todo: cobrar ahora $0 y se cierra con el método del anticipo', () => {
  const dEf = AC.desglose(ticket(1250, 'efectivo'), 1250);
  assert.equal(dEf.pagoTodo, true);
  assert.equal(AC.aCobrarAhora(dEf), 0);
  assert.deepEqual(AC.repartoCobro(dEf, 'tarjeta'), { metodo_pago: 'efectivo', monto_efectivo: 1250, monto_tarjeta: 0 });
  const dTr = AC.desglose(ticket(1250, 'transferencia'), 1250);
  assert.deepEqual(AC.repartoCobro(dTr, 'efectivo'), { metodo_pago: 'transferencia', monto_efectivo: 0, monto_tarjeta: 1250 });
  assert.match(AC.htmlDesglose(dEf), /Ya pagó todo/);
});

conPantalla('un descuento que baja el total por debajo del anticipo no deja cobrar de más', () => {
  const d = AC.desglose(ticket(500, 'efectivo'), 450);
  assert.equal(d.anticipo, 450);
  assert.equal(d.resta, 0);
  assert.equal(d.pagoTodo, true);
});

conPantalla('el reparto siempre suma el total del ticket (sin centavos perdidos)', () => {
  for (const metodoAnt of ['efectivo', 'transferencia', 'tarjeta']) {
    for (const metodo of ['efectivo', 'transferencia', 'tarjeta']) {
      const d = AC.desglose(ticket(333.33, metodoAnt), 1000.01);
      const r = AC.repartoCobro(d, metodo, null, 0);
      assert.equal(AC.redondear(r.monto_efectivo + r.monto_tarjeta), 1000.01, `${metodoAnt}/${metodo}`);
    }
  }
});
