// Cobro en Caja de un pedido que ya dejó ANTICIPO (o que ya pagó todo).
// Lo usan Caja y Caja Avanzada, para que las dos hagan exactamente lo mismo:
//   - muestran el total DESGLOSADO (Total − Anticipo = Cobrar ahora),
//   - calculan el cambio y el «Exacto» sobre lo que FALTA, no sobre el total,
//   - y al confirmar, reparten solas el cobro (el ticket se registra por el TOTAL).
// Es un archivo "puro": en el navegador queda en window.AnticipoCobro y en Node se puede probar.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.AnticipoCobro = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const dinero = (n) => '$' + redondear(n).toFixed(2);
  const METODOS_ANTICIPO = ['efectivo', 'transferencia', 'tarjeta'];
  // Métodos en los que el cliente paga dinero "de banco/no efectivo" (se guardan en monto_tarjeta).
  const NO_EFECTIVO = ['tarjeta', 'transferencia', 'dolares', 'cheque', 'vale_despensa'];

  // ticket = lo que devuelve /tickets/folio/:folio (trae pedido_anticipo y pedido_anticipo_metodo).
  function desglose(ticket, totalNeto) {
    const total = redondear(totalNeto);
    let anticipo = redondear(ticket && ticket.pedido_anticipo);
    if (!(anticipo > 0)) return { hay: false, anticipo: 0, metodo: 'efectivo', total, resta: total, pagoTodo: false };
    if (anticipo > total) anticipo = total;
    const metodo = METODOS_ANTICIPO.includes(ticket.pedido_anticipo_metodo) ? ticket.pedido_anticipo_metodo : 'efectivo';
    const resta = redondear(Math.max(0, total - anticipo));
    return { hay: true, anticipo, metodo, total, resta, pagoTodo: resta <= 0 };
  }

  // Lo que el cliente paga AHORA en el mostrador (con anticipo: lo que falta; sin anticipo: el total).
  function aCobrarAhora(d) { return d.hay ? d.resta : d.total; }

  // Cuánto se entrega de cambio / cuánto falta, según lo recibido.
  function cambioDe(d, recibido) { return redondear((Number(recibido) || 0) - aCobrarAhora(d)); }

  // Cómo se registra el cobro en el ticket (el ticket SIEMPRE se cobra por el total).
  //   metodo: lo que el cliente usa ahora (efectivo, tarjeta, transferencia, mixto, ...)
  //   mixto:  { efectivo, tarjeta } escritos por el cajero (deben sumar lo que falta)
  //   comisionPct: comisión de tarjeta (solo se cobra sobre lo que se paga ahora con tarjeta)
  // Devuelve { metodo_pago, monto_efectivo, monto_tarjeta }.
  function repartoCobro(d, metodo, mixto, comisionPct) {
    const aEf = d.metodo === 'efectivo' ? d.anticipo : 0;          // anticipo que ya está en la caja
    const aOtro = redondear(d.anticipo - aEf);                     // anticipo por transferencia/tarjeta
    let ef = 0, tj = 0;
    if (d.pagoTodo) {
      // Ya pagó todo: el ticket se cierra con el método del anticipo.
      if (d.metodo === 'efectivo') return { metodo_pago: 'efectivo', monto_efectivo: d.total, monto_tarjeta: 0 };
      return { metodo_pago: d.metodo, monto_efectivo: 0, monto_tarjeta: d.total };
    }
    const com = Number(comisionPct) || 0;
    if (metodo === 'efectivo') { ef = d.resta; }
    else if (metodo === 'tarjeta') { tj = d.resta * (1 + com / 100); }
    else if (metodo === 'mixto') { ef = Number(mixto && mixto.efectivo) || 0; tj = Number(mixto && mixto.tarjeta) || 0; }
    else { tj = d.resta; } // transferencia, dólares, cheque, vale
    ef = redondear(ef + aEf);
    tj = redondear(tj + aOtro);
    let metodoPago = metodo;
    if (ef > 0 && tj > 0) metodoPago = 'mixto';
    else if (ef > 0) metodoPago = 'efectivo';
    else if (tj > 0 && !NO_EFECTIVO.includes(metodo)) metodoPago = METODOS_ANTICIPO.includes(d.metodo) && d.metodo !== 'efectivo' ? d.metodo : 'tarjeta';
    return { metodo_pago: metodoPago, monto_efectivo: ef, monto_tarjeta: tj };
  }

  // Cuadro con el total desglosado (se pone encima del cobro).
  function htmlDesglose(d) {
    if (!d.hay) return '';
    const verde = 'var(--primary,#5FAE46)';
    const fila = 'display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:3px 0;';
    const titulo = d.pagoTodo
      ? `<div style="font-weight:800; color:#2E6B1F; margin-bottom:4px;">✅ Ya pagó todo por adelantado (${d.metodo})</div>`
      : '';
    const pie = d.pagoTodo
      ? `<div style="font-size:13px; color:#2E6B1F; margin-top:4px;">No le cobres nada: solo confirma para cerrar el ticket.</div>`
      : '';
    return `<div class="desglose-anticipo" style="background:rgba(95,174,70,.10); border:1px solid ${verde}; border-radius:12px; padding:10px 14px; margin:10px 0 6px; font-size:15px;">
      ${titulo}
      <div style="${fila}"><span>Total del ticket</span><b>${dinero(d.total)}</b></div>
      <div style="${fila} color:#2E6B1F;"><span>💰 Anticipo (${d.metodo})</span><b>−${dinero(d.anticipo)}</b></div>
      <div style="${fila} border-top:2px solid ${verde}; margin-top:4px; padding-top:6px;"><span style="font-weight:800;">COBRAR AHORA</span><b style="font-size:30px; color:${verde};">${dinero(d.resta)}</b></div>
      ${pie}
    </div>`;
  }

  return { desglose, aCobrarAhora, cambioDe, repartoCobro, htmlDesglose, redondear };
});
