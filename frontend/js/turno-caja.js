// Turnos de caja: abrir turno al cobrar, declarar importes por forma de pago
// (con teclado numérico) e imprimir el corte de caja. Se usa desde Caja,
// Caja Avanzada y la pantalla de Corte de Caja.
// Requiere api.js, ui-components.js e impresora-termica.js ya cargados.

(function () {
  const estilo = document.createElement('style');
  estilo.textContent = `
  .decl-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:1100; align-items:center; justify-content:center; padding:10px; }
  .decl-overlay.abierto { display:flex; }
  .decl-caja { background: var(--surface, #fff); color: var(--text, #222); border-radius: 14px; width: min(760px, 100%); max-height: 96vh; overflow:auto; box-shadow: 0 10px 40px rgba(0,0,0,.35); }
  .decl-titulo { background: var(--primary, #5FAE46); color:#fff; padding: 12px 16px; font-weight:700; font-size:16px; border-radius: 14px 14px 0 0; }
  .decl-sub { padding: 10px 16px 0; font-size: 13px; color: #777; }
  .decl-cuerpo { display:flex; gap:14px; padding: 14px 16px; flex-wrap: wrap; }
  .decl-teclado { flex: 0 0 230px; max-width: 100%; margin: 0 auto; }
  .decl-pantalla { background:#FFF6D6; border:1px solid #d9c98a; border-radius:10px; padding:10px 12px; text-align:right; font-size:26px; font-weight:700; min-height:50px; color:#222; margin-bottom:8px; }
  .decl-pantalla small { display:block; text-align:left; font-size:11px; color:#8a7a3a; font-weight:600; letter-spacing:1px; }
  .decl-grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:6px; }
  .decl-grid button, .decl-acciones button { border:none; border-radius:10px; font-size:22px; font-weight:700; padding:12px 0; cursor:pointer; background:#EEF0F2; color:#222; }
  .decl-grid button:active { filter: brightness(.9); }
  .decl-grid .decl-enter { grid-column: span 3; background: var(--primary, #5FAE46); color:#fff; font-size:18px; }
  .decl-tabla { flex: 1 1 300px; min-width: 260px; }
  .decl-tabla table { width:100%; border-collapse: collapse; font-size:15px; }
  .decl-tabla th { text-align:left; font-size:12px; color:#777; padding:6px 8px; border-bottom:2px solid #ddd; }
  .decl-tabla td { padding:10px 8px; border-bottom:1px solid #eee; cursor:pointer; }
  .decl-tabla td.imp { text-align:right; font-variant-numeric: tabular-nums; font-weight:600; }
  .decl-tabla tr.sel td { background: #E3F2E0; }
  .decl-tabla tr.sel td.imp { outline: 2px solid var(--primary, #5FAE46); outline-offset:-2px; }
  .decl-total { display:flex; justify-content:space-between; padding:10px 8px; font-weight:700; }
  .decl-acciones { display:flex; gap:10px; padding: 0 16px 16px; }
  .decl-acciones button { flex:1; font-size:16px; padding:14px 0; }
  .decl-acciones .ok { background: var(--primary, #5FAE46); color:#fff; }
  .decl-acciones .no { background:#C62828; color:#fff; }
  `;
  document.head.appendChild(estilo);
})();

let _configTurno = null;
async function configNegocioTurno() {
  if (_configTurno) return _configTurno;
  try { _configTurno = await apiFetch('/configuracion'); } catch (e) { _configTurno = {}; }
  return _configTurno;
}

const dineroTurno = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Diálogo de declaración con teclado numérico. Devuelve una promesa con
// { efectivo, tarjeta, transferencia, dolares_usd, cheque, vales } o null si se cancela.
async function declararImportes({ titulo = 'Declaración de caja', subtitulo = '', soloEfectivo = false } = {}) {
  const cfg = await configNegocioTurno();
  const filas = [{ k: 'efectivo', clave: 'EF', nombre: 'EFECTIVO' }];
  if (!soloEfectivo) {
    if (cfg.tarjeta_habilitado !== false) filas.push({ k: 'tarjeta', clave: 'TC', nombre: 'TARJETA' });
    if (cfg.transferencia_habilitado !== false) filas.push({ k: 'transferencia', clave: 'TR', nombre: (cfg.transferencia_etiqueta || 'TRANSFERENCIA').toUpperCase() });
    if (cfg.dolares_habilitado) filas.push({ k: 'dolares_usd', clave: 'USD', nombre: 'DÓLARES (US$)' });
    if (cfg.cheque_habilitado) filas.push({ k: 'cheque', clave: 'CH', nombre: 'CHEQUE' });
    if (cfg.vales_habilitado) filas.push({ k: 'vales', clave: 'VAL', nombre: 'VALES' });
  }

  return new Promise((resolve) => {
    const valores = {}; filas.forEach(f => { valores[f.k] = 0; });
    let sel = 0, buffer = '';

    const overlay = document.createElement('div');
    overlay.className = 'decl-overlay abierto';
    overlay.innerHTML = `
      <div class="decl-caja" role="dialog" aria-modal="true">
        <div class="decl-titulo">${titulo}</div>
        ${subtitulo ? `<div class="decl-sub">${subtitulo}</div>` : ''}
        <div class="decl-cuerpo">
          <div class="decl-teclado">
            <div class="decl-pantalla"><small>CANTIDAD CAPTURADA</small><span id="declPantalla">0</span></div>
            <div class="decl-grid">
              ${['7','8','9','4','5','6','1','2','3','0','.','⌫'].map(t => `<button type="button" data-t="${t}">${t}</button>`).join('')}
              <button type="button" class="decl-enter" data-t="ENTER">ENTER</button>
            </div>
          </div>
          <div class="decl-tabla">
            <table><thead><tr><th>Clave</th><th>Descripción</th><th style="text-align:right">Importe</th></tr></thead><tbody id="declFilas"></tbody></table>
            ${soloEfectivo ? '' : '<div class="decl-total"><span>TOTAL DECLARADO (sin dólares)</span><span id="declTotal">$0.00</span></div>'}
          </div>
        </div>
        <div class="decl-acciones">
          <button type="button" class="ok" id="declAceptar">✔ ACEPTAR</button>
          <button type="button" class="no" id="declCancelar">✖ CANCELAR</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const fmt = (f, v) => (f.k === 'dolares_usd' ? 'US$' + Number(v).toFixed(2) : dineroTurno(v));
    const pintar = () => {
      overlay.querySelector('#declPantalla').textContent = buffer === '' ? '0' : buffer;
      overlay.querySelector('#declFilas').innerHTML = filas.map((f, i) => {
        const v = i === sel && buffer !== '' ? (parseFloat(buffer) || 0) : valores[f.k];
        return `<tr data-i="${i}" class="${i === sel ? 'sel' : ''}"><td>${f.clave}</td><td>${f.nombre}</td><td class="imp">${fmt(f, v)}</td></tr>`;
      }).join('');
      const tot = overlay.querySelector('#declTotal');
      if (tot) tot.textContent = dineroTurno(filas.filter(f => f.k !== 'dolares_usd').reduce((a, f) => a + valores[f.k], 0));
    };
    const aplicarBuffer = () => { if (buffer !== '') { valores[filas[sel].k] = parseFloat(buffer) || 0; buffer = ''; } };
    const cerrar = (res) => { document.removeEventListener('keydown', teclas, true); overlay.remove(); resolve(res); };
    const tecla = (t) => {
      if (t === 'ENTER') { aplicarBuffer(); if (sel < filas.length - 1) sel++; }
      else if (t === '⌫') buffer = buffer.slice(0, -1);
      else if (t === '.') { if (!buffer.includes('.')) buffer = (buffer === '' ? '0' : buffer) + '.'; }
      else if (/^\d$/.test(t)) { if (buffer.replace('.', '').length < 9) buffer = (buffer === '0' ? '' : buffer) + t; }
      pintar();
    };
    const aceptar = () => {
      aplicarBuffer();
      const r = { efectivo: valores.efectivo };
      filas.forEach(f => { r[f.k] = valores[f.k]; });
      cerrar(r);
    };
    function teclas(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar(null); return; }
      if (/^[0-9.]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); tecla(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); tecla('⌫'); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (e.ctrlKey) aceptar(); else tecla('ENTER'); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); aplicarBuffer(); sel = Math.min(filas.length - 1, sel + 1); pintar(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); aplicarBuffer(); sel = Math.max(0, sel - 1); pintar(); }
    }
    document.addEventListener('keydown', teclas, true);
    overlay.querySelectorAll('.decl-grid button').forEach(b => b.addEventListener('click', () => tecla(b.dataset.t)));
    overlay.querySelector('#declFilas').addEventListener('click', (e) => {
      const tr = e.target.closest('tr'); if (!tr) return;
      aplicarBuffer(); sel = parseInt(tr.dataset.i, 10); pintar();
    });
    overlay.querySelector('#declAceptar').addEventListener('click', aceptar);
    overlay.querySelector('#declCancelar').addEventListener('click', () => cerrar(null));
    pintar();
  });
}

// Abre un turno pidiendo el efectivo que hay en caja. Devuelve el turno o null.
async function abrirTurnoConDeclaracion() {
  const declarado = await declararImportes({
    titulo: '🔓 Abrir turno — efectivo que hay en caja',
    subtitulo: 'Cuenta el efectivo con el que inicia la caja (fondo inicial).',
    soloEfectivo: true
  });
  if (!declarado) return null;
  try {
    return await apiFetch('/turnos/abrir', { method: 'POST', body: JSON.stringify({ fondo_inicial: declarado.efectivo }) });
  } catch (err) {
    // Si otro equipo lo abrió justo antes, se usa ese turno.
    const existente = await apiFetch('/turnos/actual').catch(() => null);
    if (existente) return existente;
    mostrarToast(err.message, 'error');
    return null;
  }
}

// Devuelve el turno abierto; si no hay, ofrece abrirlo en ese momento.
async function asegurarTurnoAbierto() {
  const turno = await apiFetch('/turnos/actual');
  // Se guarda una copia del turno para poder seguir cobrando si luego se va el internet.
  const guardar = (t) => { if (t && typeof guardarCacheOffline === 'function') guardarCacheOffline('turno', t); };
  if (turno) { guardar(turno); return turno; }
  const quiere = await confirmarAccion('No hay un turno de caja abierto. Para cobrar hay que abrir uno y declarar el efectivo que hay en caja. ¿Abrirlo ahora?');
  if (!quiere) return null;
  const nuevo = await abrirTurnoConDeclaracion();
  if (nuevo) { guardar(nuevo); mostrarToast('Turno abierto. ¡Ya puedes cobrar!', 'exito'); }
  return nuevo;
}

// ---------- Impresión del corte de caja ----------
function _fechaCorte(f) {
  const d = f ? new Date(f) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  let h = d.getHours(); const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(h)}:${p(d.getMinutes())}:${p(d.getSeconds())} ${ampm}`;
}

// Columnas con las que se arma el corte: en letra grande caben menos.
function columnasCorte(ancho) {
  const modo = localStorage.getItem('modo_impresion') || 'directo';
  if (modo === 'sistema') return ancho === '58mm' ? 26 : 34;
  return ancho === '58mm' ? 32 : 48;
}

// Arma el texto del corte (X si el turno sigue abierto, Z si ya cerró) con la
// declaración del cajero y el sobrante/faltante cuando existe.
function lineasCorteCaja(c, { columnas = 48, negocio = '' } = {}) {
  const L = [];
  const igual = '='.repeat(columnas), guion = '-'.repeat(columnas);
  const centrar = (t) => { t = String(t); return ' '.repeat(Math.max(0, Math.floor((columnas - t.length) / 2))) + t; };
  const fila = (izq, der) => { izq = String(izq); der = String(der); const esp = columnas - izq.length - der.length; return izq.slice(0, Math.max(0, columnas - der.length - 1)) + ' '.repeat(Math.max(1, esp)) + der; };
  const m = dineroTurno;

  const corto = columnas < 40; // papel angosto o letra grande: etiquetas abreviadas
  const t = (largo, abreviado) => (corto ? abreviado : largo);
  const fecha2 = (f) => { const x = _fechaCorte(f); return corto ? [x.slice(0, 10), x.slice(11)] : [x]; };

  const cerrado = c.turno.estado === 'cerrado';
  if (negocio) L.push({ t: negocio, big: true });
  L.push({ t: 'CORTE DE CAJA', big: true });
  L.push({ t: cerrado ? 'Z - CIERRE' : 'X - PARCIAL', big: true });
  const dRango = (rot, f) => corto ? [rot + ' ' + fecha2(f)[0], '   ' + fecha2(f)[1]] : [rot + ' ' + fecha2(f)[0]];
  dRango('DEL', c.turno.fecha_apertura).forEach(x => L.push(x));
  dRango('AL ', c.turno.fecha_cierre).forEach(x => L.push(x));
  L.push(`TURNO: ${c.turno.id}`);
  L.push(`CAJERO: ${(c.turno.cajero || '').toUpperCase()}`.slice(0, columnas));
  L.push(igual);

  L.push('CAJA');
  L.push(fila(t('+EFECTIVO INICIAL:', '+EFEC. INICIAL:'), m(c.caja.fondo_inicial)));
  L.push(fila(t('+VENTAS EN EFECTIVO:', '+VTA EFECTIVO:'), m(c.caja.efectivo_ventas)));
  L.push(fila(t('+DEPOSITOS EFECTIVO:', '+DEPOSITOS:'), m(c.caja.depositos)));
  L.push(fila(t('-RETIROS EFECTIVO:', '-RETIROS:'), m(c.caja.retiros)));
  L.push('_'.repeat(Math.min(columnas, 14)));
  L.push(fila(t('=SALDO EFECTIVO:', '=SALDO EFEC.:'), m(c.caja.saldo_efectivo)));
  L.push(igual);

  L.push(t('FORMA DE PAGO VENTAS', 'VENTAS POR PAGO'));
  L.push(guion);
  const nombres = { efectivo: 'EFECTIVO', tarjeta: 'TARJETA', transferencia: t('TRANSFERENCIA', 'TRANSFER.'), dolares: 'DOLARES', cheque: 'CHEQUE', vales: 'VALES', credito: t('CREDITO (FIADO)', 'FIADO') };
  Object.keys(nombres).forEach(k => { if (k === 'efectivo' || k === 'tarjeta' || (c.formas[k] || 0) !== 0) L.push(fila(nombres[k] + ':', m(c.formas[k]))); });
  L.push(fila(t('TOTAL FORMAS DE PAGO', 'TOTAL:'), m(c.total_formas)));
  L.push(igual);

  L.push(t('VENTA POR DEPARTAMENTO', 'POR DEPARTAMENTO'));
  if (c.ventas.por_departamento.length === 0) L.push('(sin ventas)');
  c.ventas.por_departamento.forEach(d => L.push(fila(String(d.nombre).toUpperCase() + ':', m(d.monto))));
  L.push('_'.repeat(Math.min(columnas, 14)));
  L.push(fila('SUBTOTAL:', m(c.ventas.subtotal)));
  L.push(fila('-DESCUENTOS:', m(c.ventas.descuentos)));
  L.push(fila('VENTA NETA:', m(c.ventas.venta_neta)));
  L.push(igual);

  L.push(fila(t('TICKETS PAGADOS:', 'PAGADOS:'), c.cuentas.normales));
  L.push(fila(t('TICKETS CANCELADOS:', 'CANCELADOS:'), c.cuentas.canceladas));
  L.push(fila(t('TICKETS CON DESCUENTO:', 'CON DESCUENTO:'), c.cuentas.con_descuento));
  L.push(fila(t('TICKET PROMEDIO:', 'PROMEDIO:'), m(c.cuentas.promedio)));
  L.push(fila('FOLIO INICIAL:', c.cuentas.folio_inicial || '-'));
  L.push(fila('FOLIO FINAL:', c.cuentas.folio_final || '-'));

  if (c.movimientos.length) {
    L.push(igual);
    L.push('MOVIMIENTOS DE CAJA');
    c.movimientos.forEach(mv => L.push(fila((mv.tipo === 'ingreso' ? '+' : '-') + (mv.concepto || (mv.tipo === 'ingreso' ? 'Ingreso' : 'Egreso')).slice(0, columnas - 14), m(mv.monto))));
  }

  const d = c.declaracion;
  if (d) {
    L.push(igual);
    L.push(t('DECLARACION DE CAJERO', 'DECLARACION'));
    const decl = d.importes || {};
    const etiqueta = { efectivo: 'EFECTIVO', tarjeta: 'TARJETA', transferencia: t('TRANSFERENCIA', 'TRANSFER.'), dolares: 'DOLARES', cheque: 'CHEQUE', vales: 'VALES' };
    Object.keys(etiqueta).forEach(k => {
      const usd = k === 'dolares' && d.dolares_usd ? ` (US$${Number(d.dolares_usd).toFixed(2)})` : '';
      if (k === 'efectivo' || k === 'tarjeta' || (decl[k] || 0) !== 0 || ((d.esperado || {})[k] || 0) !== 0) L.push(fila(etiqueta[k] + usd + ':', m(decl[k])));
    });
    L.push('-'.repeat(Math.min(columnas, 15)));
    L.push(fila(t('TOTAL DECLARADO:', 'DECLARADO:'), m(d.total_declarado)));
    L.push(fila(t('TOTAL ESPERADO:', 'ESPERADO:'), m(d.total_esperado)));
    L.push(fila(t('SOBRANTE/FALTANTE:', 'SOBRA/FALTA:'), (d.diferencia >= 0 ? '+' : '-') + m(Math.abs(d.diferencia))));
    const dif = Object.keys(etiqueta).filter(k => Math.abs((d.diferencias || {})[k] || 0) > 0.004);
    if (dif.length) {
      L.push(t('DIFERENCIA POR FORMA DE PAGO:', 'DIF. POR FORMA:'));
      dif.forEach(k => L.push(fila('  ' + etiqueta[k] + ':', (d.diferencias[k] >= 0 ? '+' : '-') + m(Math.abs(d.diferencias[k])))));
    }
  } else {
    L.push(igual);
    L.push(centrar(t('(Corte parcial: aun sin declaracion)', '(Parcial: sin declarar)')));
  }

  L.push('', '');
  L.push('_'.repeat(Math.min(columnas, 24)));
  L.push('GERENTE');
  L.push('', '');
  L.push('_'.repeat(Math.min(columnas, 24)));
  L.push(('CAJERO: ' + (c.turno.cerrado_por || c.turno.cajero || '').toUpperCase()).slice(0, columnas));
  return L;
}

// Imprime el corte de un turno (abierto o cerrado). Lanza error si falla la impresión.
async function imprimirCorteTurno(turnoId, opts = {}) {
  const [corte, cfg] = await Promise.all([apiFetch(`/turnos/${turnoId}/resumen`), configNegocioTurno()]);
  // opts.columnas (buscador de cortes) fuerza el ancho en columnas; si no, el del dispositivo.
  const ancho = opts.columnas ? (opts.columnas <= 34 ? '58mm' : '80mm') : obtenerAnchoTicketDispositivo(cfg);
  const columnas = opts.columnas || columnasCorte(ancho);
  const lineas = lineasCorteCaja(corte, { columnas, negocio: cfg.nombre_negocio || '' });
  await imprimirTextoPlanoTicket(lineas, { titulo: `Corte de caja - turno ${corte.turno.id}`, ancho_ticket: ancho });
  return corte;
}
