// Recargas de tiempo aire y pago de servicios (luz, agua, teléfono, cable) desde Caja.
// Se dibuja solo (estilos y ventana) para poder usarlo en cualquier pantalla de cobro:
//   abrirRecargas()
// Reglas que cuida el servidor: turno abierto, permiso RECARGAS_VENDER, número válido,
// sin cobros dobles. Aquí solo se guía a la cajera paso a paso.
(function () {
  const est = { catalogo: [], estado: null, tab: 'recarga', compania: null, monto: null, metodo: 'efectivo', ocupado: false };
  const $ = (id) => document.getElementById(id);
  const din = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (t) => (typeof escHtml === 'function' ? escHtml(t) : String(t));
  const NOMBRES_ESTADO = { exitosa: '✅ Hecha', fallida: '❌ No pasó', pendiente: '⏳ Revisar' };

  function estilos() {
    if ($('rcEstilos')) return;
    const s = document.createElement('style');
    s.id = 'rcEstilos';
    s.textContent = `
    .rc-fondo { display:none; position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:900; align-items:center; justify-content:center; padding:12px; }
    .rc-fondo.abierto { display:flex; }
    .rc-caja { background:var(--surface,#fff); color:var(--text,#1F2023); border-radius:var(--radius,12px); width:100%; max-width:560px; max-height:94vh; overflow:auto; padding:16px; box-shadow:0 10px 40px rgba(0,0,0,.25); }
    .rc-cab { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:10px; }
    .rc-cab h3 { margin:0; font-size:19px; }
    .rc-prueba { background:#FFF3CD; color:#7A5B00; border:1px solid #F0D58A; border-radius:9px; padding:8px 10px; font-size:13.5px; margin-bottom:10px; }
    .rc-tabs { display:flex; gap:6px; margin-bottom:12px; }
    .rc-tabs button { flex:1; padding:9px 6px; border-radius:9px; border:1px solid var(--border,#E4E6E9); background:var(--campo-fondo,#fff); color:inherit; font-weight:600; cursor:pointer; font-size:14.5px; }
    .rc-tabs button.activo { background:var(--primary,#5FAE46); color:var(--on-primary,#fff); border-color:transparent; }
    .rc-paso { font-size:13px; color:var(--muted,#7A7D83); margin:12px 0 6px; font-weight:600; text-transform:uppercase; letter-spacing:.3px; }
    .rc-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(110px,1fr)); gap:7px; }
    .rc-grid.montos { grid-template-columns:repeat(auto-fill,minmax(74px,1fr)); }
    .rc-op { padding:11px 6px; border-radius:9px; border:2px solid var(--border,#E4E6E9); background:var(--campo-fondo,#fff); color:inherit; font-weight:700; font-size:15px; cursor:pointer; }
    .rc-op.activo { border-color:var(--primary,#5FAE46); background:rgba(95,174,70,.12); }
    .rc-campo { width:100%; padding:11px; font-size:19px; letter-spacing:1px; border:1px solid var(--border,#E4E6E9); border-radius:9px; background:var(--campo-fondo,#fff); color:inherit; box-sizing:border-box; }
    .rc-campo.mal { border-color:var(--danger,#C62828); }
    .rc-dos { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .rc-nota { font-size:12.5px; color:var(--muted,#7A7D83); margin-top:4px; min-height:16px; }
    .rc-nota.mal { color:var(--danger,#C62828); }
    .rc-resumen { margin-top:14px; border-top:1px dashed var(--border,#E4E6E9); padding-top:10px; font-size:15px; }
    .rc-resumen div { display:flex; justify-content:space-between; padding:2px 0; }
    .rc-resumen .tot { font-size:21px; font-weight:800; }
    .rc-cobrar { width:100%; margin-top:12px; padding:14px; font-size:18px; font-weight:800; border:0; border-radius:10px; background:var(--primary,#5FAE46); color:var(--on-primary,#fff); cursor:pointer; }
    .rc-cobrar:disabled { opacity:.45; cursor:not-allowed; }
    .rc-fin { text-align:center; padding:10px 0; }
    .rc-fin .ico { font-size:52px; }
    .rc-fin h4 { margin:6px 0; font-size:21px; }
    .rc-fin .det { color:var(--muted,#7A7D83); font-size:14.5px; }
    .rc-lista { width:100%; border-collapse:collapse; font-size:13.5px; }
    .rc-lista td { padding:7px 4px; border-bottom:1px solid var(--fila-borde,#F2F3F5); vertical-align:top; }
    .rc-lista small { color:var(--muted,#7A7D83); }
    .rc-chip { font-size:11.5px; padding:2px 6px; border-radius:6px; background:#FFF3CD; color:#7A5B00; margin-left:4px; }
    @media (max-width:480px) { .rc-dos { grid-template-columns:1fr; } }`;
    document.head.appendChild(s);
  }

  function ventana() {
    if ($('rcFondo')) return;
    estilos();
    const d = document.createElement('div');
    d.className = 'rc-fondo'; d.id = 'rcFondo';
    d.innerHTML = `<div class="rc-caja" role="dialog" aria-modal="true" aria-labelledby="rcTitulo">
      <div class="rc-cab"><h3 id="rcTitulo">📱 Recargas y servicios</h3><button class="btn btn-secondary" onclick="cerrarRecargas()">✕ Cerrar</button></div>
      <div id="rcAviso"></div>
      <div class="rc-tabs">
        <button data-tab="recarga" onclick="rcTab('recarga')">📱 Recargas</button>
        <button data-tab="servicio" onclick="rcTab('servicio')">💡 Servicios</button>
        <button data-tab="hoy" onclick="rcTab('hoy')">📋 Hoy</button>
      </div>
      <div id="rcCuerpo"></div></div>`;
    d.addEventListener('click', (e) => { if (e.target === d && !est.ocupado) cerrarRecargas(); });
    document.body.appendChild(d);
  }

  window.abrirRecargas = async function () {
    ventana();
    $('rcFondo').classList.add('abierto');
    $('rcCuerpo').innerHTML = '<p style="text-align:center;color:var(--muted)">Cargando…</p>';
    try {
      const [estado, catalogo] = await Promise.all([apiFetch('/recargas/estado'), apiFetch('/recargas/catalogo')]);
      est.estado = estado; est.catalogo = catalogo || [];
    } catch (e) {
      $('rcCuerpo').innerHTML = `<p class="rc-nota mal">${esc(e.message)}</p>`;
      return;
    }
    if (!est.estado.activo) {
      $('rcAviso').innerHTML = '';
      $('rcCuerpo').innerHTML = '<p>Las recargas están apagadas. El dueño o gerente las enciende en <b>Configuración → Recargas y servicios</b>.</p>';
      return;
    }
    $('rcAviso').innerHTML = est.estado.modo === 'prueba'
      ? '<div class="rc-prueba">🧪 <b>Modo prueba.</b> Todavía no hay proveedor conectado: no se manda saldo real y <b>no le cobres al cliente</b>. Estas ventas no cuentan en el corte.</div>'
      : '';
    rcTab(est.tab === 'hoy' ? 'recarga' : est.tab);
  };

  window.cerrarRecargas = function () {
    if (est.ocupado) return;
    const f = $('rcFondo'); if (f) f.classList.remove('abierto');
  };

  window.rcTab = function (tab) {
    est.tab = tab; est.compania = null; est.monto = null; est.metodo = 'efectivo';
    document.querySelectorAll('#rcFondo .rc-tabs button').forEach((b) => b.classList.toggle('activo', b.dataset.tab === tab));
    if (tab === 'hoy') return listaHoy();
    formulario();
  };

  function formulario() {
    const tipo = est.tab;
    const lista = est.catalogo.filter((c) => c.tipo === tipo);
    const esRec = tipo === 'recarga';
    $('rcCuerpo').innerHTML = `
      <div class="rc-paso">1. ${esRec ? 'Compañía' : 'Servicio'}</div>
      <div class="rc-grid">${lista.map((c) => `<button class="rc-op" data-c="${esc(c.codigo)}" onclick="rcCompania('${esc(c.codigo)}')">${esc(c.nombre)}</button>`).join('')}</div>
      <div id="rcResto"></div>`;
  }

  window.rcCompania = function (codigo) {
    est.compania = est.catalogo.find((c) => c.codigo === codigo) || null; est.monto = null;
    document.querySelectorAll('#rcCuerpo [data-c]').forEach((b) => b.classList.toggle('activo', b.dataset.c === codigo));
    const c = est.compania; if (!c) return;
    const esRec = c.tipo === 'recarga';
    $('rcResto').innerHTML = `
      <div class="rc-paso">2. ${esRec ? 'Número de celular' : esc(c.etiqueta || 'Número del recibo')}</div>
      ${esRec ? `<div class="rc-dos">
          <div><input id="rcNum" class="rc-campo" inputmode="numeric" maxlength="10" placeholder="10 dígitos" autocomplete="off" oninput="rcRevisar()"></div>
          <div><input id="rcNum2" class="rc-campo" inputmode="numeric" maxlength="10" placeholder="Escríbelo otra vez" autocomplete="off" oninput="rcRevisar()" onpaste="return false"></div>
        </div>`
        : `<input id="rcNum" class="rc-campo" maxlength="30" placeholder="Como viene en el recibo" autocomplete="off" oninput="rcRevisar()">`}
      <div class="rc-nota" id="rcNotaNum"></div>
      <div class="rc-paso">3. ${esRec ? 'Monto' : 'Monto a pagar del recibo'}</div>
      ${esRec ? `<div class="rc-grid montos">${c.montos.map((m) => `<button class="rc-op" data-m="${m}" onclick="rcMonto(${m})">$${m}</button>`).join('')}</div>`
        : `<input id="rcMonto" class="rc-campo" inputmode="decimal" placeholder="$0.00" oninput="rcRevisar()">`}
      <div class="rc-paso">4. Forma de pago</div>
      <div class="rc-grid montos" style="grid-template-columns:1fr 1fr">
        <button class="rc-op activo" data-p="efectivo" onclick="rcMetodo('efectivo')">💵 Efectivo</button>
        <button class="rc-op" data-p="tarjeta" onclick="rcMetodo('tarjeta')">💳 Tarjeta</button>
      </div>
      <div id="rcPagaCon" style="margin-top:8px"><input id="rcPaga" class="rc-campo" inputmode="decimal" placeholder="¿Con cuánto paga? (opcional)" oninput="rcRevisar()" style="font-size:16px"></div>
      <div class="rc-resumen" id="rcResumen"></div>
      <button class="rc-cobrar" id="rcBoton" disabled onclick="rcCobrar()">Cobrar</button>`;
    const n = $('rcNum'); if (n) n.focus();
    rcRevisar();
  };

  window.rcMonto = function (m) {
    est.monto = m;
    document.querySelectorAll('#rcResto [data-m]').forEach((b) => b.classList.toggle('activo', Number(b.dataset.m) === m));
    rcRevisar();
  };
  window.rcMetodo = function (m) {
    est.metodo = m;
    document.querySelectorAll('#rcResto [data-p]').forEach((b) => b.classList.toggle('activo', b.dataset.p === m));
    $('rcPagaCon').style.display = m === 'efectivo' ? '' : 'none';
    rcRevisar();
  };

  // Revisa todo y arma el resumen; solo deja cobrar cuando todo está bien.
  function datos() {
    const c = est.compania; if (!c) return null;
    const limpio = (v) => String(v || '').replace(/[\s-]/g, '');
    const num = limpio($('rcNum') && $('rcNum').value);
    const esRec = c.tipo === 'recarga';
    let nota = '', ok = true;
    if (esRec) {
      const num2 = limpio($('rcNum2') && $('rcNum2').value);
      if (!/^\d{10}$/.test(num)) { ok = false; if (num) nota = `Faltan ${10 - num.length > 0 ? 10 - num.length : 0} dígitos`; }
      else if (num2 !== num) { ok = false; nota = num2.length >= 10 ? '⚠️ Los dos números no son iguales' : 'Escribe el número otra vez para confirmar'; }
      else nota = '✓ Número confirmado';
    } else if (!/^[0-9A-Za-z]{6,30}$/.test(num)) { ok = false; if (num) nota = 'Revisa el número: solo números y letras'; }
    const monto = esRec ? est.monto : Number(String(($('rcMonto') && $('rcMonto').value) || '').replace(/[$,\s]/g, ''));
    if (!(monto > 0)) ok = false;
    const cargo = esRec ? 0 : Number(est.estado.cargo_servicio || 0);
    const total = Math.round(((monto || 0) + cargo) * 100) / 100;
    return { c, num, monto, cargo, total, ok, nota };
  }

  window.rcRevisar = function () {
    const d = datos(); if (!d) return;
    const nn = $('rcNotaNum');
    nn.textContent = d.nota; nn.classList.toggle('mal', /⚠️|Revisa/.test(d.nota));
    const paga = Number(String(($('rcPaga') && $('rcPaga').value) || '').replace(/[$,\s]/g, ''));
    const cambio = est.metodo === 'efectivo' && paga > 0 ? paga - d.total : null;
    $('rcResumen').innerHTML = d.monto > 0 ? `
      <div><span>${d.c.tipo === 'recarga' ? 'Recarga' : 'Recibo'} ${esc(d.c.nombre)}</span><span>${din(d.monto)}</span></div>
      ${d.cargo ? `<div><span>Comisión por el servicio</span><span>${din(d.cargo)}</span></div>` : ''}
      <div class="tot"><span>Total a cobrar</span><span>${din(d.total)}</span></div>
      ${cambio !== null ? `<div style="color:${cambio < 0 ? 'var(--danger)' : 'var(--ok-texto,#2E7D32)'}"><span>${cambio < 0 ? 'Le faltan' : 'Cambio'}</span><span>${din(Math.abs(cambio))}</span></div>` : ''}` : '';
    const b = $('rcBoton');
    b.disabled = !d.ok || (cambio !== null && cambio < 0);
    b.textContent = d.monto > 0 ? `Cobrar ${din(d.total)}` : 'Cobrar';
  };

  const nuevaClave = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'rc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));

  window.rcCobrar = async function () {
    const d = datos(); if (!d || !d.ok || est.ocupado) return;
    const turno = typeof asegurarTurnoAbierto === 'function' ? await asegurarTurnoAbierto() : await apiFetch('/turnos/actual');
    if (!turno) return;
    const cuerpo = { compania: d.c.codigo, referencia: d.num, monto: d.monto, metodo_pago: est.metodo, turno_id: turno.id, clave: nuevaClave() };
    est.ocupado = true;
    const b = $('rcBoton'); b.disabled = true; b.textContent = '⏳ Enviando… no cierres esta ventana';
    try {
      let r;
      try {
        r = await apiFetch('/recargas/vender', { method: 'POST', body: JSON.stringify(cuerpo) });
      } catch (e) {
        if (!e.repetida) throw e;
        est.ocupado = false;
        if (!(await confirmarAccion(e.message))) { rcRevisar(); return; }
        est.ocupado = true;
        r = await apiFetch('/recargas/vender', { method: 'POST', body: JSON.stringify({ ...cuerpo, confirmar_repetida: true }) });
      }
      resultado(r, d);
    } catch (e) {
      mostrarToast(e.message, 'error', 7000);
      rcRevisar();
    } finally {
      est.ocupado = false;
    }
  };

  function resultado(r, d) {
    const ok = r.estado === 'exitosa', pend = r.estado === 'pendiente';
    $('rcCuerpo').innerHTML = `<div class="rc-fin">
      <div class="ico">${ok ? '✅' : pend ? '⏳' : '❌'}</div>
      <h4>${ok ? (d.c.tipo === 'recarga' ? '¡Recarga hecha!' : '¡Pago hecho!') : pend ? 'La compañía no ha contestado' : 'No se pudo hacer'}</h4>
      <div class="det">${esc(d.c.nombre)} · ${esc(r.referencia)} · ${din(r.total)}</div>
      ${r.folio_proveedor ? `<div class="det">Folio: <b>${esc(r.folio_proveedor)}</b></div>` : ''}
      ${r.mensaje ? `<div class="det" style="margin-top:6px">${esc(r.mensaje)}</div>` : ''}
      <div class="det" style="margin-top:8px;font-weight:700;color:${ok ? 'var(--ok-texto,#2E7D32)' : 'var(--danger,#C62828)'}">
        ${ok ? (r.modo_prueba ? 'Es de prueba: no cobres.' : 'Cobra ' + din(r.total) + ' al cliente.') : pend ? 'NO cobres todavía. Revisa en la pestaña "Hoy" en unos minutos.' : 'No le cobres al cliente.'}</div>
      <div style="display:flex;gap:8px;margin-top:16px">
        ${ok ? '<button class="btn btn-secondary" style="flex:1" id="rcImprimir">🖨️ Imprimir ticket</button>' : ''}
        <button class="btn btn-primary" style="flex:1" onclick="rcTab('${d.c.tipo}')">➕ Otra</button>
      </div></div>`;
    if (ok) {
      const imp = () => imprimirTicketRecarga(r, d.c).catch((e) => mostrarToast('No se imprimió: ' + e.message, 'error'));
      $('rcImprimir').onclick = imp;
      imp();
    }
  }

  async function imprimirTicketRecarga(r, c) {
    if (typeof imprimirTextoPlanoTicket !== 'function') return;
    let cfg = null;
    try { cfg = typeof configuracionNegocioCaja !== 'undefined' ? configuracionNegocioCaja : null; } catch (e) { /* otra pantalla */ }
    if (!cfg || !cfg.nombre_negocio) cfg = await apiFetch('/configuracion').catch(() => null);
    const negocio = (cfg && cfg.nombre_negocio) || '';
    const f = new Date(r.fecha || Date.now());
    const L = [];
    if (negocio) L.push({ t: negocio, big: true });
    if (r.modo_prueba) L.push({ t: '*** PRUEBA - SIN VALOR ***', big: true });
    L.push(c.tipo === 'recarga' ? 'RECARGA DE TIEMPO AIRE' : 'PAGO DE SERVICIO');
    L.push(f.toLocaleString('es-MX'));
    L.push('--------------------------------');
    L.push('COMPANIA: ' + c.nombre.toUpperCase());
    L.push((c.tipo === 'recarga' ? 'NUMERO: ' : 'REFERENCIA: ') + r.referencia);
    L.push('MONTO: ' + din(r.monto));
    if (Number(r.cargo)) L.push('COMISION: ' + din(r.cargo));
    L.push({ t: 'TOTAL ' + din(r.total), big: true });
    L.push('PAGO: ' + (r.metodo_pago === 'tarjeta' ? 'TARJETA' : 'EFECTIVO'));
    if (r.folio_proveedor) L.push('FOLIO: ' + r.folio_proveedor);
    L.push('OPERACION: ' + r.id);
    L.push('--------------------------------');
    L.push('Conserve este comprobante.');
    if (c.tipo === 'servicio') L.push('El pago se refleja en 24 a 72 hrs.');
    await imprimirTextoPlanoTicket(L, { titulo: 'Recarga ' + r.id });
  }

  async function listaHoy() {
    $('rcCuerpo').innerHTML = '<p style="text-align:center;color:var(--muted)">Cargando…</p>';
    try {
      const filas = await apiFetch('/recargas/ventas');
      const nombre = (cod) => ((est.catalogo.find((c) => c.codigo === cod) || {}).nombre || cod);
      const reales = filas.filter((f) => f.estado === 'exitosa' && !f.modo_prueba);
      const suma = reales.reduce((x, f) => x + Number(f.total), 0);
      $('rcCuerpo').innerHTML = filas.length ? `
        <div style="margin-bottom:8px;font-size:14.5px">Hechas (reales): <b>${reales.length}</b> · Total: <b>${din(suma)}</b></div>
        <table class="rc-lista">${filas.map((f) => `<tr>
          <td>${esc(nombre(f.compania))}${f.modo_prueba ? '<span class="rc-chip">prueba</span>' : ''}<br><small>${esc(f.referencia)} · ${new Date(f.fecha).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}${f.cajero ? ' · ' + esc(f.cajero) : ''}</small></td>
          <td style="text-align:right;white-space:nowrap">${din(f.total)}<br><small>${NOMBRES_ESTADO[f.estado] || esc(f.estado)}</small></td></tr>`).join('')}</table>`
        : '<p style="text-align:center;color:var(--muted)">Todavía no hay recargas hoy.</p>';
    } catch (e) {
      $('rcCuerpo').innerHTML = `<p class="rc-nota mal">${esc(e.message)}</p>`;
    }
  }
})();
