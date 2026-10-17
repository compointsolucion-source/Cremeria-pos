// Mostrador: PEDIDOS POR PREPARAR.
//   1. Un pedido que se envía a preparar aparece aquí al instante (aviso amarillo arriba + lista).
//   2. "Aceptar" abre una ventana con SOLO lo que hay que preparar (productos, cantidades, notas, hora).
//   3. "Pedido listo" lo marca listo e IMPRIME el ticket con los datos del cliente en letra grande.
//      (Ya no se imprime nada al tomar el pedido.)
// Las funciones de arriba (sin pantalla) también se prueban con Node: backend/pruebas/mostrador-pedidos.test.js
(function (raiz) {
  'use strict';

  // ------------------------------------------------------------------ piezas sin pantalla
  const pad = (n) => String(n).padStart(2, '0');
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const lleno = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  const esc = (t) => String(t === undefined || t === null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const primerNombre = (n) => String(n || '').trim().split(/\s+/)[0] || '';

  function hoyISO(ahora) {
    const a = ahora || new Date();
    return `${a.getFullYear()}-${pad(a.getMonth() + 1)}-${pad(a.getDate())}`;
  }
  // 'YYYY-MM-DD...' -> 'hoy' | 'mañana' | '18 oct'
  function diaTexto(iso, ahora) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return '';
    const dia = `${m[1]}-${m[2]}-${m[3]}`;
    const a = ahora || new Date();
    if (dia === hoyISO(a)) return 'hoy';
    if (dia === hoyISO(new Date(a.getFullYear(), a.getMonth(), a.getDate() + 1))) return 'mañana';
    return `${Number(m[3])} ${MESES[Number(m[2]) - 1]}`;
  }
  // 'YYYY-MM-DDTHH:MM' -> '14:30'
  function hora24(ts) {
    const m = /(\d{2}):(\d{2})/.exec(String(ts || ''));
    return m ? `${m[1]}:${m[2]}` : '';
  }
  // Minutos que faltan para la hora de entrega (negativo = ya pasó). null si el pedido no tiene hora.
  function minutosPara(programado, ahora) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(programado || ''));
    if (!m) return null;
    const f = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    return Math.round((f.getTime() - (ahora || new Date()).getTime()) / 60000);
  }
  function duracion(min) {
    const n = Math.abs(Math.round(min));
    if (n < 60) return `${n} min`;
    const h = Math.floor(n / 60), r = n % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }
  // Marca de tiempo del servidor -> minutos que han pasado (0 si no se puede saber)
  function minutosDesde(ts, ahora) {
    if (!ts) return null;
    const t = new Date(ts).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, Math.floor(((ahora || new Date()).getTime() - t) / 60000));
  }
  const haceTexto = (min) => (min === null ? '' : min < 1 ? 'hace un momento' : `hace ${duracion(min)}`);

  function numeroCantidad(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }
  // Cantidad de un renglón para el que prepara: { num: '1.500', unidad: 'kg' }
  function textoCantidad(it) {
    const n = Number(it.cantidad) || 0;
    if (it.tipo === 'kit') return { num: numeroCantidad(n), unidad: n === 1 ? 'kit' : 'kits' };
    if (it.tipo_venta === 'peso') return { num: n.toFixed(3), unidad: 'kg' };
    return { num: numeroCantidad(n), unidad: n === 1 ? 'pza' : 'pzas' };
  }

  // Cuándo se entrega (o se recoge) el pedido.
  function textoEntrega(p, ahora) {
    const recoger = p.tipo === 'recoger';
    if (!lleno(p.programado_para)) {
      return { etiqueta: recoger ? 'LO RECOGEN' : 'ENTREGAR', valor: 'LO ANTES POSIBLE', hora: '', dia: '' };
    }
    const dia = diaTexto(p.programado_para, ahora);
    const hora = hora24(p.programado_para);
    const cuando = dia === 'hoy' ? 'HOY' : dia === 'mañana' ? 'MAÑANA' : `EL ${dia.toUpperCase()}`;
    return {
      etiqueta: `${recoger ? 'LO RECOGEN' : 'ENTREGAR'} ${cuando} A LAS`,
      valor: hora, hora, dia
    };
  }

  // En qué columna de la lista va cada pedido.
  function clasificar(lista) {
    const todos = Array.isArray(lista) ? lista : [];
    const preparando = todos.filter((p) => p.estado === 'preparando');
    return {
      nuevos: preparando.filter((p) => !p.aceptado_en),
      enPreparacion: preparando.filter((p) => p.aceptado_en),
      listos: todos.filter((p) => p.estado === 'listo')
        .sort((a, b) => String(b.listo_en || '').localeCompare(String(a.listo_en || ''))).slice(0, 6)
    };
  }

  const dinero2 = (n) => (Number(n) || 0).toFixed(2);

  // Recuadro de cobro del ticket (o null si no hay nada que decir).
  function textoCobro(p) {
    const total = p.total_neto !== null && p.total_neto !== undefined ? p.total_neto : p.ticket_total;
    if (p.ticket_estado === 'pagado' || p.pago_modo === 'pagado') return { titulo: 'YA PAGADO', monto: null, detalle: 'No cobrar' };
    if (p.pago_modo === 'credito') return { titulo: 'A CREDITO DEL CLIENTE', monto: null, detalle: 'Se carga a su cuenta' };
    if (p.tipo === 'domicilio') {
      const pagaCon = Number(p.paga_con);
      const detalle = pagaCon > 0 ? `Paga con $${dinero2(pagaCon)} - Cambio $${dinero2(Math.max(0, pagaCon - Number(total)))}` : '';
      return { titulo: 'COBRAR AL RECIBIR', monto: dinero2(total), detalle };
    }
    return { titulo: 'COBRAR EN CAJA AL RECOGER', monto: dinero2(total), detalle: '' };
  }

  // El ticket que se imprime cuando el pedido queda LISTO (lo imprime imprimirTicket() de mostrador.js).
  function armarTicketPedido(p, { ahora, quien } = {}) {
    const hoy = ahora || new Date();
    const total = p.total_neto !== null && p.total_neto !== undefined ? p.total_neto : p.ticket_total;
    const ent = textoEntrega(p, hoy);
    const mayus = (t) => String(t || '').trim().toUpperCase();

    const datos = [];
    const cliente = [];
    if (lleno(p.nombre_contacto)) cliente.push(mayus(p.nombre_contacto));
    if (lleno(p.telefono)) cliente.push('TEL: ' + String(p.telefono).trim());
    if (cliente.length) datos.push({ etiqueta: 'CLIENTE', lineas: cliente, grande: true });
    if (p.tipo === 'domicilio') {
      const dir = [];
      if (lleno(p.calle)) dir.push(mayus(p.calle));
      if (lleno(p.colonia)) dir.push(mayus(p.colonia));
      const cpCiudad = [lleno(p.cp) ? 'CP ' + String(p.cp).trim() : '', p.ciudad].filter(lleno).join(' ');
      if (lleno(cpCiudad)) dir.push(mayus(cpCiudad));
      if (dir.length) datos.push({ etiqueta: 'DIRECCION', lineas: dir, grande: true });
      if (lleno(p.referencias)) datos.push({ etiqueta: 'REFERENCIAS', lineas: [String(p.referencias).trim()], grande: false });
      if (lleno(p.zona_nombre)) datos.push({ etiqueta: 'ZONA', lineas: [String(p.zona_nombre).trim()], grande: false });
    }

    const listoEn = lleno(p.listo_en) && !isNaN(new Date(p.listo_en).getTime()) ? new Date(p.listo_en) : hoy;
    const nombreQuien = lleno(p.aceptado_por_nombre) ? p.aceptado_por_nombre : (quien || '');
    const pie = [`Pedido ${p.etiqueta} - Ticket ${p.folio}`, `Listo: ${pad(listoEn.getHours())}:${pad(listoEn.getMinutes())}${lleno(nombreQuien) ? ' - Preparó: ' + primerNombre(nombreQuien) : ''}`];

    const cobro = textoCobro(p);
    const pieCuerpo = cobro.monto === null ? (cobro.titulo === 'YA PAGADO' ? 'Pedido ya pagado.' : 'Gracias por su preferencia') : 'Gracias por su preferencia';

    return {
      folio: p.folio,
      total,
      pie_pagina: pieCuerpo,
      items: (p.items || []).map((i) => ({
        nombre_producto: i.nombre_producto, tipo: i.tipo, tipo_venta: i.tipo_venta, cantidad: i.cantidad,
        precio_unitario: i.precio_unitario, importe: i.importe, subtotal: i.subtotal,
        ...(i.es_envio ? { detalle: '' } : {})
      })),
      pedido: {
        titulo: `PEDIDO ${p.etiqueta}`,
        subtitulo: p.tipo === 'recoger' ? 'PARA RECOGER' : 'A DOMICILIO',
        entrega: { etiqueta: ent.etiqueta, valor: ent.valor },
        datos,
        cobro,
        notas: lleno(p.notas) ? String(p.notas).trim() : '',
        pie
      }
    };
  }

  const PURO = { diaTexto, hora24, minutosPara, duracion, minutosDesde, haceTexto, textoCantidad, textoEntrega, clasificar, textoCobro, armarTicketPedido, esc };
  if (typeof module !== 'undefined' && module.exports) { module.exports = PURO; return; }
  raiz.MostradorPedidos = PURO;
  if (typeof document === 'undefined') return;

  // ------------------------------------------------------------------ pantalla
  const $ = (id) => document.getElementById(id);
  const IC = { domicilio: '🛵', recoger: '🏪' };
  const ETQ_TIPO = { domicilio: 'A domicilio', recoger: 'Para recoger' };
  const S = {
    lista: [], c: { nuevos: [], enPreparacion: [], listos: [] }, vistos: null, drawer: false,
    prep: null,          // { p, marcados:Set, confirmando, enviando } mientras está abierta la ventana de preparar
    cargando: false
  };
  let usuario = null;
  try { usuario = getUsuario(); } catch (e) { usuario = null; }

  function beep() {
    try {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      const c = new C();
      [0, 260].forEach((retraso) => setTimeout(() => {
        try {
          const o = c.createOscillator(), g = c.createGain();
          o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.12; o.connect(g); g.connect(c.destination);
          o.start(); setTimeout(() => o.stop(), 200);
        } catch (e) { /* sin sonido */ }
      }, retraso));
      setTimeout(() => c.close(), 900);
    } catch (e) { /* sin sonido */ }
  }

  const marcasKey = (id) => 'mp_marcados_' + id;
  function leerMarcas(id) {
    try { return new Set(JSON.parse(localStorage.getItem(marcasKey(id)) || '[]')); } catch (e) { return new Set(); }
  }
  function guardarMarcas(id, set) {
    try { localStorage.setItem(marcasKey(id), JSON.stringify([...set])); } catch (e) { /* sin guardado */ }
  }
  function borrarMarcas(id) { try { localStorage.removeItem(marcasKey(id)); } catch (e) { /* nada */ } }

  const itemsDe = (p) => (p.items || []).filter((i) => !i.es_envio);
  const nProductos = (p) => Number(p.n_items || 0);
  const textoProductos = (p) => `${nProductos(p)} producto${nProductos(p) === 1 ? '' : 's'}`;
  function cuandoCorto(p) {
    const e = textoEntrega(p);
    if (!e.hora) return p.tipo === 'recoger' ? 'lo recogen lo antes posible' : 'entrega lo antes posible';
    const d = e.dia === 'hoy' ? '' : e.dia + ' ';
    return `${p.tipo === 'recoger' ? 'recogen' : 'entrega'} ${d}${e.hora}`;
  }

  // ---- aviso amarillo de arriba + botón de la barra
  function pintarAviso() {
    const { nuevos, enPreparacion } = S.c;
    const boton = $('btnPedidosPrep');
    if (boton) {
      const n = nuevos.length + enPreparacion.length;
      boton.querySelector('.mp-n').textContent = String(n);
      boton.querySelector('.mp-n').style.display = n ? '' : 'none';
      boton.querySelector('.mp-n').classList.toggle('azul', nuevos.length === 0);
      boton.classList.toggle('pulsa', nuevos.length > 0);
    }
    const av = $('avisoPedidos');
    if (av) {
      if (!nuevos.length) { av.style.display = 'none'; av.innerHTML = ''; }
      else {
        const p = nuevos[0];
        av.style.display = 'flex';
        av.innerHTML = `<span class="mp-av-ico">🔔</span>
          <div class="mp-av-txt"><b>¡Pedido nuevo por preparar! &nbsp;${esc(p.etiqueta)} · ${IC[p.tipo] || ''} ${esc(ETQ_TIPO[p.tipo] || '')}</b>
            <small>${esc(textoProductos(p))} · ${esc(cuandoCorto(p))} · llegó ${esc(haceTexto(minutosDesde(p.creado_en)))}</small></div>
          <button type="button" class="btn btn-primary mp-av-btn" data-aceptar="${p.id}">Aceptar</button>
          <a href="#" class="mp-av-mas" data-lista="1">${nuevos.length > 1 ? `Ver los ${nuevos.length} pedidos →` : 'Ver la lista →'}</a>`;
      }
    }
    try { document.title = (nuevos.length ? `(${nuevos.length}) ` : '') + String(document.title).replace(/^\(\d+\)\s/, ''); } catch (e) { /* título */ }
  }

  // ---- lista lateral
  function tarjeta(p, clase, tag, sub, accion) {
    return `<div class="mp-ped ${clase}"><span class="mp-ic">${IC[p.tipo] || '📦'}</span>
      <div class="mp-d"><b>${esc(p.etiqueta)}</b>${tag}<small>${esc(sub)}</small></div>${accion}</div>`;
  }
  function pintarLista() {
    const cont = $('drawerPedidos');
    if (!cont) return;
    cont.classList.toggle('abierto', S.drawer);
    if (!S.drawer) return;
    const { nuevos, enPreparacion, listos } = S.c;
    const secc = (titulo, n, html) => `<h4>${titulo} (${n})</h4>${html || '<div class="mp-vacio">Nada por aquí.</div>'}`;
    const hNuevos = nuevos.map((p) => tarjeta(p, '', '<span class="mp-tag">NUEVO</span>',
      `${textoProductos(p)} · ${cuandoCorto(p)} · ${haceTexto(minutosDesde(p.creado_en))}`,
      `<button type="button" class="btn btn-primary" data-aceptar="${p.id}">Aceptar</button>`)).join('');
    const hPrep = enPreparacion.map((p) => tarjeta(p, 'en', `<span class="mp-tag az">LO PREPARA ${esc(primerNombre(p.aceptado_por_nombre).toUpperCase() || 'ALGUIEN')}</span>`,
      `${textoProductos(p)} · ${cuandoCorto(p)} · aceptado ${haceTexto(minutosDesde(p.aceptado_en))}`,
      `<button type="button" class="btn btn-secondary" data-abrir="${p.id}">Abrir</button>`)).join('');
    const hListos = listos.map((p) => {
      const t = new Date(p.listo_en);
      const hh = isNaN(t.getTime()) ? '' : `${pad(t.getHours())}:${pad(t.getMinutes())}`;
      return tarjeta(p, 'li', '', `Listo ${hh ? 'a las ' + hh : ''} · ${ETQ_TIPO[p.tipo] || ''}`,
        `<button type="button" class="btn btn-secondary" data-reimprimir="${p.id}">🖨 Reimprimir</button>`);
    }).join('');
    cont.innerHTML = `<div class="mp-fondo" data-cerrar-lista="1"></div><aside class="mp-panel">
      <div class="mp-cab"><span>📦 Pedidos por preparar</span><button type="button" class="pd-x" data-cerrar-lista="1" aria-label="Cerrar">✕</button></div>
      <div class="mp-cuerpo">${secc('Nuevos · sin aceptar', nuevos.length, hNuevos)}${secc('Ya aceptados · se están preparando', enPreparacion.length, hPrep)}${secc('Listos hace poco', listos.length, hListos)}</div></aside>`;
  }

  // ---- ventana de preparar (solo lo que hay que preparar)
  function restante(p) {
    const min = minutosPara(p.programado_para);
    if (min === null) return { et: 'LLEGÓ', val: haceTexto(minutosDesde(p.creado_en)) || 'ahora', tarde: false };
    return min >= 0 ? { et: 'FALTAN', val: duracion(min), tarde: false } : { et: 'ATRASADO', val: duracion(min), tarde: true };
  }
  function pintarPrep() {
    let ov = $('ovPrepPedido');
    if (!S.prep) { if (ov) ov.remove(); document.body.classList.remove('mp-abierto'); return; }
    if (!ov) { ov = document.createElement('div'); ov.id = 'ovPrepPedido'; ov.className = 'mp-ov'; document.body.appendChild(ov); }
    document.body.classList.add('mp-abierto');
    const { p, marcados, confirmando, enviando } = S.prep;
    const items = itemsDe(p);
    const e = textoEntrega(p);
    const r = restante(p);
    const faltan = items.filter((i) => !marcados.has(i.id)).length;
    const cancelado = p.estado === 'cancelado';
    const yaListo = p.estado !== 'preparando' && !cancelado;
    const filas = items.map((i) => {
      const c = textoCantidad(i);
      const ok = marcados.has(i.id);
      return `<div class="mp-lin ${ok ? 'ok' : ''}" data-marcar="${i.id}"><span class="mp-chk">${ok ? '✓' : ''}</span>
        <span class="mp-cant">${esc(c.num)} <small>${esc(c.unidad)}</small></span><span class="mp-nom">${esc(i.nombre_producto)}</span></div>`;
    }).join('');
    let pie;
    if (cancelado) {
      pie = `<button type="button" class="btn btn-secondary" data-prep="cerrar">Cerrar</button>`;
    } else if (confirmando) {
      pie = `<div class="mp-conf"><b>¿Ya está todo el pedido ${esc(p.etiqueta)}?</b> Faltan ${faltan} producto${faltan === 1 ? '' : 's'} por marcar.</div>
        <button type="button" class="btn btn-secondary" data-conf="no">Volver a revisar</button>
        <button type="button" class="btn btn-primary" data-conf="si" ${enviando ? 'disabled' : ''}>Sí, ya está todo</button>`;
    } else {
      pie = `<button type="button" class="btn btn-secondary" data-prep="cerrar">Cerrar · seguir después</button><span style="flex:1"></span>
        <button type="button" class="btn btn-primary" data-prep="listo" ${enviando ? 'disabled' : ''}>${yaListo ? '🖨 Imprimir ticket' : '✓ Pedido listo · imprimir ticket'}</button>`;
    }
    ov.innerHTML = `<div class="mp-win" role="dialog" aria-modal="true">
      <div class="mp-wcab"><h2>📦 Preparar pedido ${esc(p.etiqueta)} <span class="mp-chip">${IC[p.tipo] || ''} ${esc(ETQ_TIPO[p.tipo] || '')}</span></h2>
        <button type="button" class="pd-x" data-prep="cerrar" aria-label="Cerrar">✕</button></div>
      ${yaListo ? '<div class="mp-ya">Este pedido ya se marcó como listo en otra pantalla. Puedes imprimir su ticket.</div>' : ''}
      ${cancelado ? '<div class="mp-ya cancelado">Este pedido fue CANCELADO. Ya no hay que prepararlo.</div>' : ''}
      <div class="mp-hora"><div><small>${esc(e.hora ? e.etiqueta : e.etiqueta + ' · LO ANTES POSIBLE')}</small>${e.hora ? `<div class="g">${e.dia === 'hoy' ? 'Hoy' : esc(e.dia)} ${esc(e.hora)}</div>` : ''}</div>
        <div style="text-align:right" class="${r.tarde ? 'tarde' : ''}"><small>${esc(r.et)}</small><div class="g">${esc(r.val)}</div></div></div>
      <div class="mp-lista">${filas || '<div class="mp-vacio">Este pedido no trae productos.</div>'}</div>
      ${lleno(p.notas) ? `<div class="mp-nota"><b>Notas del pedido</b>${esc(p.notas)}</div>` : ''}
      <div class="mp-prog">Marcados ${items.length - faltan} de ${items.length} (puedes ir palomeando conforme lo preparas)</div>
      <div class="mp-pie">${pie}</div></div>`;
  }

  // ---- acciones
  async function cargar() {
    if (S.cargando) return;
    S.cargando = true;
    try {
      const lista = await apiFetch('/pedidos?estado=preparando,listo&limit=200');
      S.lista = Array.isArray(lista) ? lista : [];
      S.c = clasificar(S.lista);
      const ids = new Set(S.c.nuevos.map((p) => p.id));
      if (S.vistos === null) S.vistos = ids;           // la primera vez no suena: solo se aprende lo que ya había
      else {
        const llegaron = S.c.nuevos.filter((p) => !S.vistos.has(p.id));
        llegaron.forEach((p) => S.vistos.add(p.id));
        if (llegaron.length) {
          beep();
          mostrarToast(`📦 Pedido nuevo por preparar: ${llegaron.map((p) => p.etiqueta).join(', ')}`, 'info', 6000);
        }
      }
      // si la ventana de preparar está abierta, se actualiza su estado (por si lo marcaron listo en otra pantalla)
      if (S.prep) {
        let ahora = S.lista.find((p) => p.id === S.prep.p.id);
        if (!ahora) { try { ahora = await apiFetch(`/pedidos/${S.prep.p.id}`); } catch (e) { ahora = null; } }   // ya salió de la lista: se consulta su estado real
        if (ahora && S.prep) {
          S.prep.p = { ...S.prep.p, estado: ahora.estado, aceptado_por_nombre: ahora.aceptado_por_nombre, aceptado_en: ahora.aceptado_en, listo_en: ahora.listo_en };
          pintarPrep();
        }
      }
    } catch (err) {
      /* sin conexión un momento: se queda lo último que se vio y se reintenta solo */
    } finally {
      S.cargando = false;
      pintarAviso();
      pintarLista();
    }
  }

  async function aceptar(id) {
    try {
      const p = await apiFetch(`/pedidos/${id}/aceptar`, { method: 'POST', body: '{}' });
      S.drawer = false; pintarLista();
      abrirPrep(p);
    } catch (err) {
      mostrarToast(err.message || 'No se pudo aceptar el pedido', 'error');
    }
    cargar();
  }
  async function abrir(id) {
    try { abrirPrep(await apiFetch(`/pedidos/${id}`)); S.drawer = false; pintarLista(); }
    catch (err) { mostrarToast(err.message || 'No se pudo abrir el pedido', 'error'); }
  }
  function abrirPrep(p) {
    S.prep = { p, marcados: leerMarcas(p.id), confirmando: false, enviando: false };
    pintarPrep();
  }
  function cerrarPrep() { S.prep = null; pintarPrep(); }

  async function imprimirPedido(p) {
    if (typeof imprimirTicket !== 'function') { mostrarToast('Esta pantalla no tiene impresora configurada', 'error'); return; }
    let completo = p;
    if (!Array.isArray(p.items)) completo = await apiFetch(`/pedidos/${p.id}`);
    await imprimirTicket(armarTicketPedido(completo, { quien: usuario && usuario.nombre }));
  }
  async function reimprimir(id) {
    try { await imprimirPedido({ id }); } catch (err) { mostrarToast(err.message || 'No se pudo imprimir', 'error'); }
  }

  async function terminar() {
    const prep = S.prep;
    if (!prep || prep.enviando) return;
    prep.enviando = true; prep.confirmando = false; pintarPrep();
    let p = prep.p;
    try {
      if (p.estado === 'preparando') {
        const fresco = await apiFetch(`/pedidos/${p.id}/estado`, { method: 'POST', body: JSON.stringify({ estado: 'listo' }) });
        p = { ...fresco, items: fresco.items || p.items };
      }
    } catch (err) {
      mostrarToast(err.message || 'No se pudo marcar como listo', 'error');
      prep.enviando = false; pintarPrep();
      return;
    }
    borrarMarcas(p.id);
    cerrarPrep();
    mostrarToast(`Pedido ${p.etiqueta} listo`, 'exito');
    try { await imprimirPedido(p); } catch (err) { mostrarToast('El pedido quedó listo, pero no se pudo imprimir: ' + (err.message || err) + '. Puedes reimprimirlo desde la lista.', 'error', 7000); }
    cargar();
  }

  // ---- clics (todo con un solo escuchador)
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest ? ev.target.closest('[data-aceptar],[data-abrir],[data-reimprimir],[data-cerrar-lista],[data-lista],[data-marcar],[data-prep],[data-conf],#btnPedidosPrep') : null;
    if (!t) return;
    if (t.id === 'btnPedidosPrep') { S.drawer = !S.drawer; pintarLista(); if (S.drawer) cargar(); return; }
    if (t.dataset.aceptar) { aceptar(Number(t.dataset.aceptar)); return; }
    if (t.dataset.abrir) { abrir(Number(t.dataset.abrir)); return; }
    if (t.dataset.reimprimir) { reimprimir(Number(t.dataset.reimprimir)); return; }
    if (t.dataset.lista) { ev.preventDefault(); S.drawer = true; pintarLista(); return; }
    if (t.dataset.cerrarLista) { S.drawer = false; pintarLista(); return; }
    if (t.dataset.marcar && S.prep) {
      const id = Number(t.dataset.marcar);
      if (S.prep.marcados.has(id)) S.prep.marcados.delete(id); else S.prep.marcados.add(id);
      guardarMarcas(S.prep.p.id, S.prep.marcados);
      pintarPrep();
      return;
    }
    if (t.dataset.prep === 'cerrar') { cerrarPrep(); return; }
    if (t.dataset.prep === 'listo' && S.prep) {
      const faltan = itemsDe(S.prep.p).filter((i) => !S.prep.marcados.has(i.id)).length;
      if (S.prep.p.estado === 'preparando' && faltan > 0) { S.prep.confirmando = true; pintarPrep(); } else terminar();
      return;
    }
    if (t.dataset.conf === 'no' && S.prep) { S.prep.confirmando = false; pintarPrep(); return; }
    if (t.dataset.conf === 'si') { terminar(); }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (S.prep) cerrarPrep(); else if (S.drawer) { S.drawer = false; pintarLista(); }
  });

  // ---- tiempo real: el aviso llega al instante; además se revisa cada rato por si se cayó la conexión
  let temporizador = null;
  const refrescarSuave = () => { clearTimeout(temporizador); temporizador = setTimeout(cargar, 350); };
  function iniciarSocket() {
    if (typeof io !== 'function' || !usuario || typeof API_URL === 'undefined') return;
    try {
      const socket = io(API_URL.replace('/api', ''));
      socket.on('connect', () => { socket.emit('unirse_sucursal', usuario.sucursal_id); refrescarSuave(); });
      socket.on('pedido_actualizado', refrescarSuave);
    } catch (e) { /* sin tiempo real: queda la revisión cada rato */ }
  }

  function iniciar() {
    if (!usuario) return;
    iniciarSocket();
    cargar();
    setInterval(cargar, 45000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) cargar(); });
    window.addEventListener('online', cargar);
    // los "hace N min" y "faltan N min" se refrescan cada minuto
    setInterval(() => { pintarAviso(); pintarLista(); if (S.prep) pintarPrep(); }, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})(typeof window !== 'undefined' ? window : this);
