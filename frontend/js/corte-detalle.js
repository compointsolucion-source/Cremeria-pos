// Corte de caja desglosado (como el "Corte" de Eleventa): ventas totales, ganancia, dinero en caja, formas de pago,
// entradas y salidas, departamentos, pagos de créditos y clientes. Lo usan "corte-detalle.html" (un turno o el día
// completo) y "cortes-dia.html". Recibe el mismo resumen que devuelve /turnos/:id/resumen o /turnos/dia.

(function () {
  const estilo = document.createElement('style');
  estilo.textContent = `
  .cd{display:grid;gap:12px}
  .cd-cab{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 18px}
  .cd-cab h2{font-size:20px;margin:0}
  .cd-cab .sub{color:var(--muted,#7A7D83);font-size:13.5px;margin-top:2px}
  .cd-cab .acc{display:flex;gap:8px;flex-wrap:wrap}
  .chip-ok,.chip-av,.chip-mal{display:inline-block;border-radius:99px;padding:3px 11px;font-weight:700;font-size:12.5px;margin-left:8px;vertical-align:middle}
  .chip-ok{background:#E3F2E0;color:#2E6B22}.chip-av{background:#FFF1D6;color:#8A5200}.chip-mal{background:#FDE3E3;color:#B71C1C}
  [data-tema="oscuro"] .chip-ok{background:#24402A;color:#9BE08A}
  [data-tema="oscuro"] .chip-av{background:#44371A;color:#F3CF7A}
  [data-tema="oscuro"] .chip-mal{background:#4A2323;color:#F2A0A0}
  .cd-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
  .cd-col{display:grid;gap:12px;min-width:0}
  .cd-bloque{padding:14px 18px}
  .cd-bloque h3{font-size:15.5px;margin:0 0 8px;display:flex;align-items:center;gap:8px;color:var(--text)}
  .cd-bloque h3 .em{font-size:19px}
  .cd-big{display:flex;justify-content:space-between;align-items:baseline;padding:14px 18px;gap:10px}
  .cd-big .t{font-size:17px;font-weight:700;display:flex;gap:8px;align-items:center}
  .cd-big .v{font-size:28px;font-weight:800;font-variant-numeric:tabular-nums}
  .cd-big .v.azul{color:#1565C0}.cd-big .v.verde{color:var(--primary-dark,#4C9439)}
  [data-tema="oscuro"] .cd-big .v.azul{color:#6FB2F2}
  .cd-nota{color:var(--muted,#7A7D83);font-size:12.5px;padding:0 18px 12px;margin-top:-8px}
  .cd-t{width:100%;border-collapse:collapse;font-size:14.5px;font-variant-numeric:tabular-nums}
  .cd-t td{padding:6px 8px}.cd-t td:last-child{text-align:right;font-weight:600;white-space:nowrap}
  .cd-t tr:nth-child(odd){background:var(--tabla-cab,#F5F7F8)}
  .cd-t .mas{color:#2E7D32}.cd-t .menos{color:#C62828}
  [data-tema="oscuro"] .cd-t .mas{color:#7FD27A}[data-tema="oscuro"] .cd-t .menos{color:#F28B8B}
  .cd-t tr.total td{border-top:2px solid var(--border,#E4E6E9);font-weight:800;font-size:16px;background:transparent}
  .cd-t small{color:var(--muted,#7A7D83);font-weight:500}
  .cd-vacio{background:var(--tabla-cab,#F5F7F8);border-radius:10px;padding:9px;text-align:center;color:var(--muted,#7A7D83);font-size:13.5px}
  .cd-barra{height:7px;border-radius:4px;background:var(--border,#E4E6E9);margin-top:3px;overflow:hidden}
  .cd-barra i{display:block;height:100%;background:var(--primary,#5FAE46)}
  .cd-dep{display:flex;justify-content:space-between;gap:10px;font-size:14.5px;padding-top:6px}
  .cd-dif{display:flex;justify-content:space-between;padding:8px;font-size:14.5px}
  .cd-dif b{font-variant-numeric:tabular-nums}
  .cd-ok,.cd-av,.cd-mal{border-radius:10px;padding:9px;text-align:center;font-weight:700;margin-top:8px}
  .cd-ok{background:#E3F2E0;color:#2E6B22}.cd-av{background:#FFF1D6;color:#8A5200}.cd-mal{background:#FDE3E3;color:#B71C1C}
  [data-tema="oscuro"] .cd-ok{background:#24402A;color:#9BE08A}
  [data-tema="oscuro"] .cd-av{background:#44371A;color:#F3CF7A}
  [data-tema="oscuro"] .cd-mal{background:#4A2323;color:#F2A0A0}
  @media (max-width: 900px){.cd-cols{grid-template-columns:1fr}.cd-big .v{font-size:24px}}
  /* Cortes por día */
  .cdd-fil{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 18px}
  .cdd-fil .cp{border:1px solid var(--border,#E4E6E9);border-radius:99px;padding:6px 14px;font-weight:700;font-size:13.5px;background:var(--surface,#fff);color:inherit;cursor:pointer;font-family:inherit}
  .cdd-fil .cp.on{background:var(--primary,#5FAE46);color:#fff;border-color:var(--primary,#5FAE46)}
  .cdd-fil input[type=date]{width:auto;min-width:170px;flex:0 0 auto;border:1.5px solid var(--primary,#5FAE46);border-radius:10px;padding:7px 12px;font-weight:700;font-family:inherit;background:var(--surface,#fff);color:inherit}
  .cdd-fil .btn{width:auto;flex:0 0 auto}
  .cdd-fil label{flex:0 0 auto}
  .cdd-banner{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 18px}
  .cdd-banner .tot{display:flex;gap:26px;flex-wrap:wrap}
  .cdd-banner small{display:block;color:var(--muted,#7A7D83);font-size:12px}
  .cdd-banner b.g{font-size:21px;font-variant-numeric:tabular-nums}
  .cdd-tb{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
  .cdd-tb th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted,#7A7D83);background:var(--tabla-cab,#F5F7F8);padding:9px 10px}
  .cdd-tb td{padding:11px 10px;border-bottom:1px solid var(--border,#E4E6E9)}
  .cdd-tb td.n,.cdd-tb th.n{text-align:right}
  .cdd-tb .bt{display:inline-flex;gap:6px}
  .cdd-tb .bt button{border:1px solid var(--border,#E4E6E9);background:var(--surface,#fff);color:inherit;border-radius:8px;padding:6px 10px;font:inherit;font-weight:700;font-size:13px;cursor:pointer}
  .cdd-tb .ok{color:#2E7D32;font-weight:700}.cdd-tb .mal{color:#C62828;font-weight:700}
  .cdd-tb .ab{color:var(--muted,#7A7D83)}
  .cdd-scroll{overflow-x:auto}
  `;
  document.head.appendChild(estilo);
})();

const cdEsc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cdDin = (n) => { const v = Number(n) || 0; return (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const cdRed = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const cdHora = (f) => new Date(f).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
function cdFechaLarga(f) {
  const d = typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) ? new Date(+f.slice(0, 4), +f.slice(5, 7) - 1, +f.slice(8, 10)) : new Date(f);
  const t = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function cdEsSupervisor() { const u = getUsuario(); return !!u && ['jefe_general', 'dueno', 'gerente'].includes(u.rol); }

// Total de ventas del corte (lo cobrado por cualquier forma de pago menos devoluciones).
function cdVentasTotales(c) { return cdRed((c.total_formas || 0) - ((c.ventas && c.ventas.devoluciones) || 0)); }

function corteDetalleHTML(c, { ganancia = false } = {}) {
  const caja = c.caja || {};
  const dev = (c.ventas && c.ventas.devoluciones) || 0;
  const esDia = !!(c.turno && c.turno.dia);
  const salidas = caja.salidas !== undefined ? caja.salidas : caja.retiros;
  const entradas = (c.movimientos || []).filter((m) => m.tipo === 'ingreso');
  const salidasLista = (c.movimientos || []).filter((m) => m.tipo === 'egreso' && !m.es_devolucion);
  const pagos = c.pagos_creditos || [];
  const cerrado = c.turno.estado === 'cerrado';
  const d = c.declaracion;

  // Estado de la caja según lo declarado por el cajero
  let chip = cerrado ? '' : '<span class="chip-av">Turno abierto (corte parcial)</span>', bloqueDecl = '';
  if (d) {
    const dif = cdRed(d.diferencia);
    const cls = Math.abs(dif) < 0.005 ? ['ok', 'chip-ok', '✔ Caja cuadrada'] : dif > 0 ? ['av', 'chip-av', `Sobrante ${cdDin(dif)}`] : ['mal', 'chip-mal', `Faltante ${cdDin(Math.abs(dif))}`];
    chip = `<span class="${cls[1]}">${esDia ? 'Todos cerrados · ' : ''}${cls[2]}</span>`;
    const decEf = d.importes && d.importes.efectivo !== undefined ? d.importes.efectivo : null;
    const difEf = d.diferencias && d.diferencias.efectivo !== undefined ? d.diferencias.efectivo : null;
    const otras = Object.keys(d.diferencias || {}).filter((k) => k !== 'efectivo' && Math.abs(d.diferencias[k]) > 0.004);
    bloqueDecl = `${decEf !== null ? `<div class="cd-dif"><span>Contado por ${esDia ? 'los cajeros' : 'el cajero'} (efectivo)</span><b>${cdDin(decEf)}</b></div>` : ''}
      <div class="cd-dif"><span>Diferencia${decEf !== null ? ' en efectivo' : ''}</span><b>${cdDin(difEf !== null ? difEf : dif)}</b></div>
      ${otras.map((k) => `<div class="cd-dif"><span>Diferencia en ${cdEsc(k)}</span><b>${cdDin(d.diferencias[k])}</b></div>`).join('')}
      <div class="cd-${cls[0]}">${cls[2]}${cls[0] === 'ok' ? '' : ' en el total'}</div>`;
  } else if (!esDia) {
    bloqueDecl = '<div class="cd-vacio" style="margin-top:8px">Corte parcial: el cajero aún no declara el dinero.</div>';
  }

  const filaMov = (m) => `<tr><td>${cdHora(m.fecha)} · ${cdEsc(m.concepto || (m.tipo === 'ingreso' ? 'Ingreso' : 'Egreso'))}${m.cajero ? ` <small>(${cdEsc(m.cajero)})</small>` : ''}</td><td>${cdDin(m.monto)}</td></tr>`;
  const lista = (arr, vacio) => arr.length ? `<table class="cd-t">${arr.map(filaMov).join('')}</table>` : `<div class="cd-vacio">${vacio}</div>`;

  const formas = c.formas || {};
  const filasFormas = [['En efectivo', formas.efectivo, true], ['Con tarjeta', formas.tarjeta, true], ['Con transferencia', formas.transferencia],
    ['A crédito (fiado)', formas.credito, true], ['Con vales de despensa', formas.vales, true], ['En dólares', formas.dolares], ['Con cheque', formas.cheque]]
    .filter((x) => x[2] || x[1] > 0);

  const deptos = (c.ventas && c.ventas.por_departamento) || [];
  const sumaDep = deptos.reduce((x, y) => x + y.monto, 0) || 1;

  const titulo = esDia ? `Corte del día · ${cdEsc(cdFechaLarga(c.turno.dia))}` : `Corte de ${cdEsc(c.turno.cajero || '')}`;
  const horario = esDia
    ? `${c.turno.turnos} turno${c.turno.turnos === 1 ? '' : 's'} · ${cdEsc(c.turno.cajero)}`
    : `${cdEsc(cdFechaLarga(c.turno.fecha_apertura))} · de las ${cdHora(c.turno.fecha_apertura)}${c.turno.fecha_cierre ? ' a las ' + cdHora(c.turno.fecha_cierre) : ' (sigue abierto)'} · Turno #${cdEsc(c.turno.id)}`;
  const cu = c.cuentas || {};

  return `<div class="cd">
  <div class="caja cd-cab"><div><h2>${titulo}${chip}</h2>
    <div class="sub">${horario} · ${cu.normales || 0} venta${cu.normales === 1 ? '' : 's'}${cu.folio_inicial ? ` · folios ${cdEsc(cu.folio_inicial)} al ${cdEsc(cu.folio_final)}` : ''}</div></div>
    <div class="acc" id="cdAcciones"></div></div>
  <div class="cd-cols">
   <div class="cd-col">
    <div class="caja cd-big"><span class="t">💲 Ventas totales</span><span class="v azul">${cdDin(cdVentasTotales(c))}</span></div>
    <div class="caja cd-bloque"><h3><span class="em">🧮</span> Dinero en caja</h3>
      <table class="cd-t"><tr><td>Fondo de caja</td><td>${cdDin(caja.fondo_inicial)}</td></tr>
        <tr><td>Ventas en efectivo</td><td class="mas">+ ${cdDin(caja.efectivo_ventas)}</td></tr>
        <tr><td>Abonos en efectivo</td><td class="mas">+ ${cdDin(caja.abonos_efectivo || 0)}</td></tr>
        <tr><td>Entradas</td><td class="mas">+ ${cdDin(caja.depositos)}</td></tr>
        <tr><td>Salidas</td><td class="menos">− ${cdDin(salidas)}</td></tr>
        <tr><td>Devoluciones en efectivo</td><td class="menos">− ${cdDin(caja.devoluciones_efectivo || 0)}</td></tr>
        <tr class="total"><td>${cerrado ? 'Total en caja' : 'Debe haber en caja'}</td><td>${cdDin(caja.saldo_efectivo)}</td></tr></table>
      ${bloqueDecl}</div>
    <div class="caja cd-bloque"><h3><span class="em">⬇️</span> Entradas de efectivo</h3>${lista(entradas, 'No hubo entradas de efectivo')}</div>
    <div class="caja cd-bloque"><h3><span class="em">⬆️</span> Salidas de efectivo</h3>${lista(salidasLista, 'No hubo salidas de efectivo')}</div>
    <div class="caja cd-bloque"><h3><span class="em">👥</span> Pagos de créditos</h3>${pagos.length
      ? `<table class="cd-t">${pagos.map((p) => `<tr><td>${cdEsc(p.cliente)} · ${cdEsc(p.metodo)}${p.cajero ? ` <small>(${cdEsc(p.cajero)})</small>` : ''}</td><td>${cdDin(p.monto)}</td></tr>`).join('')}</table>`
      : '<div class="cd-vacio">No se recibieron pagos de créditos</div>'}</div>
   </div>
   <div class="cd-col">
    ${ganancia ? `<div class="caja cd-big"><span class="t">📈 Ganancia</span><span class="v verde">${cdDin(c.ventas.ganancia)}</span></div>
      ${c.ventas.ganancia_sin_costo ? `<div class="caja cd-nota" style="padding-top:10px">⚠️ ${c.ventas.ganancia_sin_costo} renglón${c.ventas.ganancia_sin_costo === 1 ? '' : 'es'} vendido${c.ventas.ganancia_sin_costo === 1 ? '' : 's'} sin costo capturado no suma${c.ventas.ganancia_sin_costo === 1 ? '' : 'n'} ganancia.</div>` : ''}` : ''}
    <div class="caja cd-bloque"><h3><span class="em">🛒</span> Ventas por forma de pago</h3>
      <table class="cd-t">${filasFormas.map((x) => `<tr><td>${x[0]}</td><td class="mas">+ ${cdDin(x[1])}</td></tr>`).join('')}
        <tr><td>Devoluciones de ventas</td><td class="menos">− ${cdDin(dev)}</td></tr>
        <tr class="total"><td>Total</td><td>${cdDin(cdVentasTotales(c))}</td></tr></table></div>
    <div class="caja cd-bloque"><h3><span class="em">🗂️</span> Ventas por departamento</h3>${deptos.length
      ? deptos.map((x) => `<div class="cd-dep"><span>${cdEsc(x.nombre)}</span><b>${cdDin(x.monto)}</b></div><div class="cd-barra"><i style="width:${Math.max(2, Math.round((x.monto / sumaDep) * 100))}%"></i></div>`).join('')
      : '<div class="cd-vacio">No se registró ninguna venta</div>'}</div>
    <div class="caja cd-bloque"><h3><span class="em">🏆</span> Clientes con más ventas</h3>${(c.clientes_top || []).length
      ? `<table class="cd-t">${c.clientes_top.map((x) => `<tr><td>${cdEsc(x.nombre)} · ${x.ventas} venta${x.ventas === 1 ? '' : 's'}</td><td>${cdDin(x.monto)}</td></tr>`).join('')}</table>
         <div style="color:var(--muted,#7A7D83);font-size:12px;margin-top:6px">Las ventas de mostrador sin cliente no se cuentan aquí.</div>`
      : '<div class="cd-vacio">No hubo ventas a clientes registrados</div>'}</div>
   </div>
  </div></div>`;
}

// Descarga el corte como CSV (abre en Excel).
function descargarCorteDetalleCSV(c, { ganancia = false } = {}) {
  // Si un texto empieza con = + - @ (o tabulador/enter), Excel lo toma como fórmula: se le pone un ' adelante
  // para que se vea como texto. Los números normales (ej. -150.00) se dejan igual.
  const sinFormula = (t) => (/^[=+\-@\t\r]/.test(t) && !/^[-+]?\d+(\.\d+)?$/.test(t) ? "'" + t : t);
  const f = (v) => '"' + sinFormula(String(v === null || v === undefined ? '' : v)).replace(/"/g, '""') + '"';
  const caja = c.caja || {}, dev = (c.ventas && c.ventas.devoluciones) || 0;
  const esDia = !!(c.turno && c.turno.dia);
  const filas = [['Concepto', 'Importe']];
  filas.push([esDia ? 'Corte del día' : 'Turno', esDia ? c.turno.dia : c.turno.id], ['Estado', c.turno.estado], ['Cajero', c.turno.cajero],
    ['Apertura', c.turno.fecha_apertura], ['Cierre', c.turno.fecha_cierre || '']);
  filas.push(['', ''], ['VENTAS TOTALES', cdVentasTotales(c)]);
  if (ganancia) filas.push(['GANANCIA', c.ventas.ganancia]);
  filas.push(['', ''], ['DINERO EN CAJA', ''], ['Fondo de caja', caja.fondo_inicial], ['Ventas en efectivo', caja.efectivo_ventas],
    ['Abonos en efectivo', caja.abonos_efectivo || 0], ['Entradas', caja.depositos], ['Salidas', caja.salidas !== undefined ? caja.salidas : caja.retiros],
    ['Devoluciones en efectivo', caja.devoluciones_efectivo || 0], ['Total en caja', caja.saldo_efectivo]);
  filas.push(['', ''], ['VENTAS POR FORMA DE PAGO', '']);
  Object.entries(c.formas || {}).forEach(([k, v]) => filas.push([k, v]));
  filas.push(['Devoluciones de ventas', -dev], ['Total', cdVentasTotales(c)], ['', ''], ['DEPARTAMENTOS', '']);
  ((c.ventas && c.ventas.por_departamento) || []).forEach((x) => filas.push([x.nombre, x.monto]));
  filas.push(['', ''], ['ENTRADAS DE EFECTIVO', '']);
  (c.movimientos || []).filter((m) => m.tipo === 'ingreso').forEach((m) => filas.push([`${m.fecha} ${m.concepto || ''}`, m.monto]));
  filas.push(['', ''], ['SALIDAS DE EFECTIVO', '']);
  (c.movimientos || []).filter((m) => m.tipo === 'egreso' && !m.es_devolucion).forEach((m) => filas.push([`${m.fecha} ${m.concepto || ''}`, m.monto]));
  filas.push(['', ''], ['PAGOS DE CREDITOS', '']);
  (c.pagos_creditos || []).forEach((p) => filas.push([`${p.cliente} (${p.metodo})`, p.monto]));
  filas.push(['', ''], ['CLIENTES CON MAS VENTAS', '']);
  (c.clientes_top || []).forEach((x) => filas.push([`${x.nombre} (${x.ventas})`, x.monto]));
  if (c.declaracion) filas.push(['', ''], ['DECLARACION', ''], ['Total declarado', c.declaracion.total_declarado], ['Total esperado', c.declaracion.total_esperado], ['Diferencia', c.declaracion.diferencia]);
  const csv = '﻿' + filas.map((r) => r.map(f).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = esDia ? `corte-dia-${c.turno.dia}.csv` : `corte-turno-${c.turno.id}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
}
