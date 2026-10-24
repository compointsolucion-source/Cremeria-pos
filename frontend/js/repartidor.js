// Pantalla del repartidor (celular): sus entregas, abrir la dirección en Waze o Google Maps,
// avisar "salí / llegué", entregar y cobrar (con foto o firma si el negocio las pide) y ver su corte.
// Usa solo /api/pedidos/repartidor/* y /api/auth/*: el repartidor no puede ver nada más del sistema.
requiereLogin();

const REP = (function () {
  'use strict';

  const usuario = getUsuario() || {};
  // Esta pantalla es solo para usuarios con rol «Repartidor». El dueño y el gerente asignan y corrigen entregas
  // desde Pedidos; si llegan aquí, se les regresa a Pedidos (así nunca quedan registrados como repartidores).
  if (['dueno', 'gerente', 'jefe_general'].includes(usuario.rol)) { window.location.replace('pedidos.html'); return {}; }
  if (usuario.rol !== 'repartidor') window.location.replace('login.html');

  // ------------------------------------------------------------------ utilidades
  const esc = (t) => String(t === undefined || t === null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dinero = (n) => { const v = Number(n) || 0; return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const $ = (id) => document.getElementById(id);
  const lleno = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  const primerNombre = (n) => String(n || '').trim().split(/\s+/)[0] || '';
  const cant = (n) => (typeof GRANEL !== 'undefined' && GRANEL.formatoCantidad ? GRANEL.formatoCantidad(n) : String(n));
  const U = window.UBICACION;

  function hora12(ts) {
    const m = /(\d{2}):(\d{2})/.exec(String(ts || ''));
    if (!m) return '';
    const h = Number(m[1]);
    return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'pm' : 'am'}`;
  }
  // Marcas del servidor (NOW()) -> hora de este celular
  function horaLocal(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' }).replace(/\s?([ap])\.?\s?m\.?/i, (x, a) => ' ' + a.toLowerCase() + 'm');
  }
  const esDeConexion = (err) => /No se pudo conectar/i.test((err && err.message) || '');

  // ------------------------------------------------------------------ estado
  const CLAVE_CACHE = 'repartidor_cache_' + (usuario.id || '0');
  const E = { vista: 'entregas', id: null, datos: null, corte: null, corteError: null, sinConexion: false, errorMsg: null, cargando: true, fresco: false, cacheDe: null, enviando: false, pila: 0, vistaClave: '' };

  function leerCache() {
    try { const c = JSON.parse(localStorage.getItem(CLAVE_CACHE) || 'null'); return c && c.d ? c : null; } catch (e) { return null; }
  }

  async function cargar(silencioso) {
    try {
      const d = await apiFetch('/pedidos/repartidor/mis-pedidos');
      if (E.fresco) detectarNuevos(d);
      E.datos = d; E.sinConexion = false; E.errorMsg = null; E.fresco = true; E.cacheDe = null;
      try { localStorage.setItem(CLAVE_CACHE, JSON.stringify({ d, t: Date.now() })); } catch (e) { /* sin guardar */ }
    } catch (err) {
      if (esDeConexion(err)) {
        E.sinConexion = true;
        if (!E.datos) { const c = leerCache(); if (c) { E.datos = c.d; E.cacheDe = c.t; } }
      } else {
        E.errorMsg = err.message || 'No se pudieron cargar tus entregas';
      }
      if (!silencioso && !E.sinConexion) mostrarToast(E.errorMsg, 'error');
    }
    E.cargando = false;
    pintar();
  }

  let temporizador = null;
  function refrescarSuave() {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => { cargar(true); if (E.vista === 'corte') cargarCorte(true); }, 350);
  }

  // Avisa cuando la tienda le manda un pedido nuevo (o hay uno libre para tomar).
  function detectarNuevos(d) {
    if (!E.datos) return;
    const antes = new Set([...(E.datos.pendientes || []), ...(E.datos.disponibles || [])].map((p) => p.id));
    const nuevos = [...(d.pendientes || []), ...(d.disponibles || [])].filter((p) => !antes.has(p.id));
    if (!nuevos.length) return;
    const mios = nuevos.filter((p) => p.repartidor_id === usuario.id).length;
    mostrarToast(mios ? '🛵 Te asignaron un pedido nuevo' : '🛵 Hay un pedido listo para tomar', 'info', 5000);
    beep();
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) { /* no se puede vibrar */ }
  }
  let audio = null;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.connect(g); g.connect(audio.destination);
      o.frequency.value = 880; g.gain.value = 0.08;
      o.start(); o.stop(audio.currentTime + 0.25);
    } catch (e) { /* sin sonido */ }
  }

  async function cargarCorte(silencioso) {
    if (!silencioso) { E.corte = null; E.corteError = null; pintar(); }
    try {
      E.corte = await apiFetch('/pedidos/repartidor/mi-corte');
      E.corteError = null;
    } catch (err) {
      E.corteError = esDeConexion(err) ? 'Sin internet: no se pudo armar tu corte. Intenta cuando tengas señal.' : err.message;
    }
    pintar();
  }

  // ------------------------------------------------------------------ ayudas de datos
  const mios = () => (E.datos ? E.datos.pendientes : []);
  const rutaLista = () => {
    const l = mios();
    return [...l.filter((p) => p.estado === 'en_camino'), ...l.filter((p) => p.estado === 'listo')];
  };
  const enPreparacion = () => mios().filter((p) => p.estado === 'preparando');
  function buscar(id) {
    if (!E.datos) return null;
    return [...E.datos.pendientes, ...E.datos.disponibles, ...E.datos.hechos_hoy].find((p) => p.id === Number(id)) || null;
  }
  // por_cobrar es un sí/no (true cuando el cliente paga al recibir y el ticket sigue sin cobrarse); el monto es el total del pedido.
  // Lo que el repartidor cobra en la puerta es la RESTA (el total menos el anticipo que el cliente ya dejó).
  const montoCobrar = (p) => (p.resta !== undefined && p.resta !== null ? Number(p.resta) : Number(p.total_neto)) || 0;
  const esCobro = (p) => p.pago_modo === 'al_recibir' && p.por_cobrar !== false && p.estado_cobro !== 'pagado';
  // Aviso cuando NO cobra: «ya está pagado» solo si de verdad ya se pagó; si se cobra en Caja lo dice tal cual.
  const sinCobro = (p) => p.estado_cobro === 'credito' || p.pago_modo === 'credito'
    ? { clase: 'cred', c1: 'A crédito del cliente', c3: 'Queda en su cuenta de la tienda' }
    : p.estado_cobro === 'pagado' ? { clase: 'ok', c1: 'Ya está pagado', c3: 'Solo entrégalo' }
    : { clase: 'ok', c1: 'No cobres nada', c3: 'Se cobra en Caja' };
  const fueCobrado = (p) => p.monto_cobrado !== null && p.monto_cobrado !== undefined && p.monto_cobrado !== '';
  const tieneDireccion = (p) => lleno(p.calle) || (U && U.tieneCoordenadas(p));
  const telefonoOk = (p) => lleno(p.telefono) && U && U.telefonoInternacional(p.telefono);

  function badgeCobro(p) {
    if (esCobro(p)) return `<span class="rp-badge rp-b-cobrar">COBRAR ${dinero(montoCobrar(p))}</span>`;
    if (p.pago_modo === 'credito') return '<span class="rp-badge rp-b-credito">A CRÉDITO</span>';
    if (p.estado_cobro === 'en_caja') return '<span class="rp-badge rp-b-pagado">SE COBRA EN CAJA</span>';
    return '<span class="rp-badge rp-b-pagado">PAGADO</span>';
  }
  const horaTxt = (p) => (p.programado_para ? hora12(p.programado_para) : 'Lo antes posible');
  const badgeRetraso = (p) => (Number(p.retraso_min) > 0 && ['listo', 'preparando', 'en_camino'].includes(p.estado) ? `<span class="rp-badge rp-b-rojo">+${Number(p.retraso_min)} MIN</span>` : '');

  // ------------------------------------------------------------------ pintar
  function pintar() {
    const clave = E.vista + ':' + (E.id || '');
    const cuerpo = $('cuerpo');
    const arriba = cuerpo.scrollTop;
    document.querySelectorAll('#barra button').forEach((b) => b.classList.toggle('on', b.dataset.v === (E.vista === 'detalle' ? 'entregas' : E.vista)));

    // Aviso de conexión
    const av = $('aviso');
    if (E.sinConexion) {
      av.className = 'rp-aviso ver';
      av.textContent = '📵 Sin internet — se muestra lo último guardado' + (E.cacheDe ? ' (' + horaLocal(E.cacheDe) + ')' : '') + '. Para registrar entregas necesitas señal.';
    } else if (E.cargando && E.cacheDe) {
      av.className = 'rp-aviso ver';
      av.textContent = '⏳ Actualizando… mientras tanto se ve lo último guardado (' + horaLocal(E.cacheDe) + ').';
    } else { av.className = 'rp-aviso'; av.textContent = ''; }

    if (E.vista === 'detalle') pintarDetalle();
    else if (E.vista === 'corte') pintarCorte();
    else if (E.vista === 'yo') pintarYo();
    else pintarLista();

    cuerpo.scrollTop = clave === E.vistaClave ? arriba : 0;
    E.vistaClave = clave;
  }

  function cabecera(titulo, sub, extra) {
    $('cab').innerHTML = `<div class="rp-hola"><span>${titulo}</span>${extra || ''}</div><div class="rp-sub">${sub || ''}</div>`;
  }
  function pie(html) { const p = $('pie'); p.style.display = html ? '' : 'none'; p.innerHTML = html || ''; }

  // ---- lista de entregas
  function pintarLista() {
    pie('');
    const d = E.datos;
    const nombre = primerNombre((d && d.repartidor && d.repartidor.nombre) || usuario.nombre);
    const hechas = d ? d.hechos_hoy.length : 0;
    const total = d ? d.pendientes.length + hechas : 0;
    cabecera(`Hola, ${esc(nombre)}`, !d ? 'Cargando…' : total ? `Hoy: ${total} ${total === 1 ? 'entrega' : 'entregas'} · ${hechas} ${hechas === 1 ? 'hecha' : 'hechas'}` : 'Hoy todavía no tienes entregas',
      '<button class="rp-refrescar" aria-label="Actualizar" onclick="REP.refrescar()">↻</button>');
    const cuerpo = $('cuerpo');
    if (!d) {
      cuerpo.innerHTML = E.errorMsg
        ? `<div class="rp-vacio"><b>⚠️</b>${esc(E.errorMsg)}<br><br><button class="rp-btn rp-pri" onclick="REP.refrescar()">Intentar de nuevo</button></div>`
        : E.sinConexion
          ? '<div class="rp-vacio"><b>📵</b>No hay internet y todavía no hay nada guardado.<br>Cuando tengas señal se cargan tus entregas.<br><br><button class="rp-btn rp-pri" onclick="REP.refrescar()">Intentar de nuevo</button></div>'
          : '<div class="rp-vacio"><b>🛵</b>Cargando tus entregas…<br><small>Si tarda, el servidor está despertando (hasta 50 segundos).</small></div>';
      return;
    }
    $('cab').querySelector('.rp-prog') || $('cab').insertAdjacentHTML('beforeend', '<div class="rp-prog"><i></i></div>');
    const barra = $('cab').querySelector('.rp-prog i');
    if (barra) barra.style.width = (total ? Math.round((hechas / total) * 100) : 0) + '%';

    const ruta = rutaLista(), prep = enPreparacion();
    let h = '';
    if (ruta.length) {
      h += '<div class="rp-sec">Siguiente</div>' + tarjeta(ruta[0], 1, 'sig');
      if (ruta.length > 1) h += '<div class="rp-sec">Después</div>' + ruta.slice(1).map((p, i) => tarjeta(p, i + 2, 'normal')).join('');
    }
    if (prep.length) h += '<div class="rp-sec">Se están preparando en la tienda</div>' + prep.map((p) => tarjeta(p, null, 'prep')).join('');
    if (d.disponibles.length) h += '<div class="rp-sec">Listos para que alguien los tome</div>' + d.disponibles.map((p) => tarjeta(p, null, 'libre')).join('');
    if (!ruta.length && !prep.length && !d.disponibles.length) {
      h += `<div class="rp-vacio"><b>${hechas ? '🎉' : '😌'}</b>${hechas ? '¡Terminaste tus entregas de hoy!<br>Pasa por <b>Mi corte</b> para ver el dinero que debes entregar en Caja.' : 'No tienes entregas por ahora.<br>Aquí aparecen en cuanto la tienda te asigne una.'}</div>`;
    }
    if (hechas) h += `<div class="rp-sec">Ya entregados hoy (${hechas})</div>` + d.hechos_hoy.map(tarjetaHecha).join('');
    cuerpo.innerHTML = h;
  }

  function tarjeta(p, n, tipo) {
    const dir = [p.colonia, p.ciudad].filter(lleno).join(', ') || p.calle || 'Sin dirección';
    const prods = (p.n_items || (p.items || []).length) ? `${p.n_items || p.items.length} ${(p.n_items || p.items.length) === 1 ? 'producto' : 'productos'}` : '';
    const estadoTag = p.estado === 'en_camino' ? '<span class="rp-badge rp-b-camino">EN CAMINO</span>' : p.estado === 'preparando' ? '<span class="rp-badge rp-b-gris">PREPARANDO</span>' : '';
    const accion = tipo === 'libre'
      ? `<button class="rp-btn rp-pri" style="margin-top:10px" onclick="event.stopPropagation(); REP.tomar(${p.id})">✋ Tomar este pedido</button>`
      : `<div class="rp-m"><span style="font-size:14px;color:var(--muted)">${esc(prods)}</span>${tipo === 'prep' ? '' : '<span class="btn btn-primary" style="min-height:38px;padding:4px 16px">Abrir</span>'}</div>`;
    return `<div class="rp-ent ${tipo === 'sig' ? 'sig' : ''} ${tipo === 'prep' ? 'apagada' : ''}" onclick="REP.abrir(${p.id})">
      <div class="rp-fl"><span class="rp-h">${n ? `<span class="rp-num">${n}</span>` : ''}${esc(horaTxt(p))} ${badgeRetraso(p)} ${estadoTag}</span>${badgeCobro(p)}</div>
      <div class="rp-n" ${tipo === 'sig' ? '' : 'style="font-size:17.5px"'}>${esc(p.nombre_contacto)}</div>
      <div class="rp-d">📍 ${esc(dir)}</div>
      ${accion}</div>`;
  }

  function tarjetaHecha(p) {
    if (p.estado === 'no_entregado') {
      return `<div class="rp-ent apagada" style="padding:10px 14px" onclick="REP.abrir(${p.id})"><span class="rp-h" style="font-size:15px">✖ ${esc(p.nombre_contacto)} <span class="rp-badge rp-b-rojo">NO ENTREGADO</span></span><div class="rp-d">${esc(p.motivo_no_entrega || '')}</div></div>`;
    }
    const cobro = fueCobrado(p) ? ` · cobrado ${dinero(p.monto_cobrado || p.total_neto)}${p.metodo_cobro && p.metodo_cobro !== 'efectivo' ? ' (' + esc(p.metodo_cobro) + ')' : ''}` : '';
    return `<div class="rp-ent apagada" style="padding:10px 14px" onclick="REP.abrir(${p.id})"><span class="rp-h" style="font-size:15px;font-weight:700">✔ ${esc(p.nombre_contacto)}${cobro} <small style="color:var(--muted);font-weight:600">${esc(horaLocal(p.entregado_en))}</small></span></div>`;
  }

  // ---- detalle de una entrega
  function pintarDetalle() {
    const p = buscar(E.id);
    if (!p) {
      if (E.datos) { mostrarToast('Ese pedido ya no está en tu lista', 'info'); setTimeout(() => REP.ir('entregas'), 0); }
      else $('cuerpo').innerHTML = '<div class="rp-vacio"><b>🛵</b>Cargando…</div>';
      pie('');
      return;
    }
    const ruta = rutaLista();
    const pos = ruta.findIndex((x) => x.id === p.id);
    cabecera(`<span class="rp-detalle-cab"><button class="rp-atras" onclick="REP.atras()">← Atrás</button></span>`,
      pos >= 0 ? `Entrega ${pos + 1} de ${ruta.length} · <b>${esc(horaTxt(p))}</b>` : `${esc(p.etiqueta || '')} · <b>${esc(horaTxt(p))}</b>`);

    const miPedido = p.repartidor_id === usuario.id;
    const hecho = ['entregado', 'no_entregado'].includes(p.estado);
    const libre = !p.repartidor_id && p.estado === 'listo';
    let h = '';

    if (p.estado === 'preparando') h += '<div class="rp-nota azul">👨‍🍳 <div>La tienda todavía lo está preparando. Cuando esté listo te sale aquí el botón para salir.</div></div>';
    if (p.estado === 'entregado') h += `<div class="rp-nota azul" style="background:#E4F3DE;color:#2f6b1f">✔ <div><b>Entregado</b> a las ${esc(horaLocal(p.entregado_en))}${fueCobrado(p) ? ` · cobraste ${dinero(p.monto_cobrado || p.total_neto)} (${esc(p.metodo_cobro || 'efectivo')})` : ''}</div></div>`;
    if (p.estado === 'no_entregado') h += `<div class="rp-nota" style="background:#FDE4E4;color:#B71C1C">✖ <div><b>No se pudo entregar.</b> ${esc(p.motivo_no_entrega || '')}<br>El pedido regresa a la tienda.</div></div>`;

    h += `<div class="rp-n" style="font-size:24px;line-height:1.1;margin-top:10px">${esc(p.nombre_contacto)}</div>`;
    if (tieneDireccion(p)) {
      h += `<div style="font-size:18px;margin:6px 0 2px;line-height:1.3">${p.calle ? `<b>${esc(p.calle)}</b><br>` : ''}${esc([p.colonia, lleno(p.cp) ? 'C.P. ' + p.cp : '', p.ciudad].filter(lleno).join(', '))}</div>`;
    } else {
      h += '<div class="rp-nota">⚠️ <div>Este pedido no tiene dirección escrita. Llama al cliente para preguntarla.</div></div>';
    }
    if (lleno(p.referencias)) h += `<div class="rp-nota">📍 <div><b>Referencias:</b> ${esc(p.referencias)}</div></div>`;
    if (lleno(p.notas)) h += `<div class="rp-nota azul">📝 <div><b>Nota del pedido:</b> ${esc(p.notas)}</div></div>`;

    if (!hecho) {
      if (tieneDireccion(p)) {
        h += `<div class="rp-fila2" style="margin-top:6px">
          <a class="rp-btn rp-waze" target="_blank" rel="noopener" href="${esc(U.urlWaze(p))}">🧭 Waze</a>
          <a class="rp-btn rp-gmap" target="_blank" rel="noopener" href="${esc(U.urlGoogleMaps(p))}">🗺 Google Maps</a></div>`;
        if (U.tieneCoordenadas(p)) h += '<div style="font-size:13px;color:var(--muted);margin-top:6px;text-align:center">✓ Con la ubicación exacta que mandó el cliente</div>';
      }
      if (lleno(p.ubicacion_enlace) && /^https?:\/\//i.test(String(p.ubicacion_enlace).trim())) {
        h += `<a class="rp-btn rp-sec-btn" target="_blank" rel="noopener" href="${esc(String(p.ubicacion_enlace).trim())}">📌 Abrir la ubicación que mandó el cliente</a>`;
      }
      if (telefonoOk(p)) {
        const msg = p.estado === 'en_camino'
          ? `Hola ${primerNombre(p.nombre_contacto)}, soy ${primerNombre(usuario.nombre)}${E.datos && E.datos.negocio ? ' de ' + E.datos.negocio : ''}. Ya voy en camino con su pedido.`
          : `Hola ${primerNombre(p.nombre_contacto)}, soy ${primerNombre(usuario.nombre)}${E.datos && E.datos.negocio ? ' de ' + E.datos.negocio : ''}, el repartidor de su pedido.`;
        h += `<div class="rp-fila2"><a class="rp-btn rp-sec-btn" href="${esc(U.urlLlamar(p.telefono))}">📞 Llamar</a>
          <a class="rp-btn rp-sec-btn" target="_blank" rel="noopener" href="${esc(U.urlWhatsApp(p.telefono, msg))}">💬 WhatsApp</a></div>`;
      } else if (lleno(p.telefono)) {
        h += `<div class="rp-d" style="margin-top:8px">📞 ${esc(p.telefono)}</div>`;
      }
    }

    // Cobro
    if (!hecho) {
      if (esCobro(p)) {
        const monto = montoCobrar(p);
        const paga = Number(p.paga_con) || 0;
        const cambio = paga > monto ? (Number(p.cambio) > 0 ? Number(p.cambio) : Math.round((paga - monto) * 100) / 100) : 0;
        h += `<div class="rp-cobrar"><div class="c1">Cobra al entregar</div><div class="c2">${dinero(monto)}</div>
          <div class="c3">${Number(p.anticipo) > 0 ? `Total ${dinero(p.total_neto)} · ya dejó <b>${dinero(p.anticipo)}</b> de anticipo<br>` : ''}${paga > monto ? `Paga con ${dinero(paga)} · lleva cambio de <b>${dinero(cambio)}</b>` : paga ? 'Paga exacto' : 'No se anotó con cuánto paga'}</div></div>`;
      } else {
        const sc = sinCobro(p);
        h += `<div class="rp-cobrar ${sc.clase}"><div class="c1">${sc.c1}</div><div class="c2">${sc.c1 === 'No cobres nada' ? 'Solo entrégalo' : 'No cobres nada'}</div><div class="c3">${sc.c3}</div></div>`;
      }
    }

    // Productos
    const items = p.items || [];
    if (items.length) {
      h += `<div class="rp-sec" style="margin-top:14px">Productos (${items.length})</div><div class="rp-tarj">` +
        items.map((i) => `<div class="rp-lin"><span>${esc(i.nombre)}</span><b>${i.tipo_venta === 'peso' ? esc(cant(i.cantidad)) + ' kg' : esc(cant(i.cantidad)) + ' ×'}</b></div>`).join('') + '</div>';
    }
    $('cuerpo').innerHTML = h;

    // Botones de abajo
    let bt = '';
    if (!hecho) {
      if (libre) bt = `<button class="rp-btn rp-pri" onclick="REP.tomar(${p.id})">✋ Tomar este pedido</button>`;
      else if (miPedido && p.estado === 'listo') bt = `<button class="rp-btn rp-pri" onclick="REP.salir(${p.id})">🛵 Ya salí con el pedido</button>`;
      else if (miPedido && p.estado === 'en_camino') {
        bt = `<button class="rp-btn rp-pri" onclick="REP.abrirEntrega(${p.id})">✔ Entregado${esCobro(p) ? ' y cobrado' : ''}</button>
          <div class="rp-fila2">${p.llego_en ? `<div class="rp-btn rp-sec-btn" style="opacity:.7">📍 Llegaste ${esc(horaLocal(p.llego_en))}</div>` : `<button class="rp-btn rp-sec-btn" onclick="REP.llegue(${p.id})">📍 Ya llegué</button>`}
          <button class="rp-btn rp-peligro" onclick="REP.abrirNoEntregado(${p.id})">No pude entregar</button></div>`;
      }
    }
    pie(bt);
  }

  // ---- mi corte
  function pintarCorte() {
    pie('');
    const hoy = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
    cabecera('Mi corte', esc(hoy.charAt(0).toUpperCase() + hoy.slice(1)),
      '<button class="rp-refrescar" aria-label="Actualizar" onclick="REP.refrescar()">↻</button>');
    const cuerpo = $('cuerpo'), c = E.corte;
    if (!c) {
      cuerpo.innerHTML = E.corteError
        ? `<div class="rp-vacio"><b>⚠️</b>${esc(E.corteError)}<br><br><button class="rp-btn rp-pri" onclick="REP.refrescar()">Intentar de nuevo</button></div>`
        : '<div class="rp-vacio"><b>💵</b>Armando tu corte…</div>';
      return;
    }
    const r = c.resumen || {};
    const lineas = [
      ['Entregas hechas', `${c.entregadas}`],
      c.no_entregadas ? ['No se pudieron entregar', `${c.no_entregadas}`] : null,
      ['Pagadas antes (tarjeta / transferencia)', dinero(r.pagados_antes)],
      Number(r.credito) ? ['Cobradas a crédito del cliente', dinero(r.credito)] : null,
      Number(r.ya_cobrados_en_caja) ? ['Ya cobradas en Caja', dinero(r.ya_cobrados_en_caja)] : null,
      Number(r.transferencia) ? ['Cobradas por transferencia', dinero(r.transferencia)] : null,
      Number(r.tarjeta) ? ['Cobradas con tarjeta', dinero(r.tarjeta)] : null,
      ['Cobradas en efectivo', dinero(r.efectivo)]
    ].filter(Boolean);
    let h = `<div class="rp-tarj">${lineas.map((l) => `<div class="rp-lin"><span>${l[0]}</span><b>${l[1]}</b></div>`).join('')}</div>`;
    const debe = Number(c.debe_entregar_efectivo) || 0;
    h += `<div class="rp-cobrar rp-corte-total ${debe > 0 ? '' : 'ok'}"><div class="c1">${debe > 0 ? 'Debes entregar en Caja' : 'No debes dinero en Caja'}</div><div class="c2">${dinero(debe)}</div><div class="c3">${r.n_efectivo ? `${r.n_efectivo} ${r.n_efectivo === 1 ? 'entrega' : 'entregas'} en efectivo` : 'Sin entregas en efectivo pendientes'}</div></div>`;
    const efe = (c.pedidos || []).filter((p) => p.cobro === 'efectivo');
    if (efe.length) {
      h += '<div class="rp-sec" style="margin-top:14px">Detalle en efectivo</div><div class="rp-tarj">' +
        efe.map((p) => `<div class="rp-lin"><span>${esc(p.etiqueta || '')} · ${esc(p.nombre_contacto)}</span><b>${dinero(p.total_neto)}</b></div>`).join('') + '</div>';
    }
    h += '<div class="rp-nota azul">🔒 <div>El cajero cuenta tu dinero y lo recibe en su pantalla. Queda registrado quién lo entregó y a qué hora. Después de eso, tu corte se pone en ceros.</div></div>';
    cuerpo.innerHTML = h;
  }

  // ---- yo
  function pintarYo() {
    pie('');
    cabecera('Mi cuenta', esc(E.datos && E.datos.negocio ? E.datos.negocio : ''));
    const esRep = usuario.rol === 'repartidor';
    $('cuerpo').innerHTML = `<div class="rp-tarj">
        <div class="rp-lin"><span>Nombre</span><b>${esc(usuario.nombre || '')}</b></div>
        <div class="rp-lin"><span>Puesto</span><b>${esRep ? 'Repartidor' : esc(usuario.rol)}</b></div></div>
      ${esRep ? '' : '<div class="rp-nota azul">ℹ️ <div>Estás viendo esta pantalla como administrador: solo salen los pedidos asignados a tu usuario. Así la ve un repartidor.</div></div><a class="rp-btn rp-sec-btn" href="pedidos.html">← Volver al tablero de Pedidos</a>'}
      <button class="rp-btn rp-sec-btn" onclick="REP.refrescar()">↻ Actualizar mis entregas</button>
      <button class="rp-btn rp-sec-btn" onclick="var b=document.getElementById('botonTema'); if(b) b.click();">🌓 Cambiar tema (claro / oscuro / automático)</button>
      <div class="rp-nota azul" style="margin-top:14px">📱 <div><b>Tip:</b> en el menú de tu navegador elige <b>"Agregar a pantalla de inicio"</b> y esta pantalla se abre como una app.</div></div>
      <button class="rp-btn rp-peligro" style="margin-top:14px" onclick="salirDelSistema()">Cerrar sesión</button>`;
  }

  // ------------------------------------------------------------------ navegación
  function leerHash() {
    const h = (location.hash || '').slice(1);
    const m = /^p(\d+)$/.exec(h);
    if (m) { E.vista = 'detalle'; E.id = Number(m[1]); }
    else if (h === 'corte' || h === 'yo') { E.vista = h; E.id = null; }
    else { E.vista = 'entregas'; E.id = null; }
    if (E.vista === 'corte') cargarCorte();
    else pintar();
  }
  function ir(v) {
    E.pila = 0;
    history.replaceState(null, '', '#' + v);
    leerHash();
  }
  function abrir(id) { E.pila += 1; location.hash = 'p' + id; }
  function atras() {
    if (E.pila > 0) { E.pila -= 1; history.back(); } else ir('entregas');
  }
  function refrescar() {
    if (E.vista === 'corte') cargarCorte();
    cargar(false);
  }

  // ------------------------------------------------------------------ acciones
  async function accion(ruta, cuerpo, okMsg) {
    if (E.enviando) return null;
    E.enviando = true;
    try {
      const r = await apiFetch(`/pedidos/repartidor/${ruta}`, { method: 'POST', body: JSON.stringify(cuerpo || {}) });
      if (okMsg) mostrarToast(okMsg, 'exito');
      await cargar(true);
      return r || true;
    } catch (err) {
      mostrarToast(err.message || 'No se pudo completar', 'error', 5000);
      await cargar(true);
      return null;
    } finally { E.enviando = false; }
  }
  async function tomar(id) { if (await accion(`${id}/tomar`, {}, '✋ Pedido tomado, es tuyo')) abrir(id); }
  async function salir(id) { await accion(`${id}/salir`, {}, '🛵 ¡Buen viaje!'); }
  async function llegue(id) { await accion(`${id}/llegue`, {}, '📍 Anotado: ya llegaste'); }

  // ---- ventanas de abajo
  function hoja(html) {
    const velo = document.createElement('div');
    velo.className = 'rp-velo';
    velo.innerHTML = `<div class="rp-hoja" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(velo);
    const api = { el: velo, q: (s) => velo.querySelector(s), cerrar() { velo.remove(); } };
    velo.addEventListener('click', (e) => { if (e.target === velo) api.cerrar(); });
    return api;
  }

  // Foto: se reduce antes de mandarla (el servidor solo guarda imágenes pequeñas).
  function reducirFoto(archivo) {
    return new Promise((ok, mal) => {
      const url = URL.createObjectURL(archivo);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let lado = 900, q = 0.7, data = '';
        for (let i = 0; i < 7; i++) {
          const f = Math.min(1, lado / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * f)); c.height = Math.max(1, Math.round(img.height * f));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          data = c.toDataURL('image/jpeg', q);
          if (data.length <= 110000) break;
          q = Math.max(0.4, q - 0.1); lado = Math.round(lado * 0.85);
        }
        ok(data);
      };
      img.onerror = () => { URL.revokeObjectURL(url); mal(new Error('No se pudo leer la foto')); };
      img.src = url;
    });
  }

  function abrirEntrega(id) {
    const p = buscar(id);
    if (!p) return;
    const cfg = E.datos || {};
    const alRecibir = esCobro(p);
    const monto = montoCobrar(p);
    const paga = Number(p.paga_con) || 0;
    const cambio = paga > monto ? (Number(p.cambio) > 0 ? Number(p.cambio) : Math.round((paga - monto) * 100) / 100) : 0;
    const est = { metodo: 'efectivo', foto: null, firma: null, firmaVisible: false, tinta: false };
    const h = hoja(`
      <h3>Confirmar entrega</h3>
      <div class="rp-peq">${esc(p.nombre_contacto)}</div>
      ${alRecibir ? `
        <div class="rp-cobrar" style="margin-top:0"><div class="c1">Cobra</div><div class="c2">${dinero(monto)}</div>
          <div class="c3" id="rpCambio">${paga > monto ? `Paga con ${dinero(paga)} · cambio <b>${dinero(cambio)}</b>` : ''}</div></div>
        <div style="font-weight:700;margin-top:12px">¿Cómo te pagó?</div>
        <div class="rp-metodos">
          <button type="button" class="rp-metodo on" data-m="efectivo"><span>💵</span>Efectivo</button>
          <button type="button" class="rp-metodo" data-m="transferencia"><span>🏦</span>Transferencia</button>
          <button type="button" class="rp-metodo" data-m="tarjeta"><span>💳</span>Tarjeta</button>
        </div>` : (() => { const sc = sinCobro(p); return `<div class="rp-cobrar ${sc.clase}" style="margin-top:0"><div class="c1">${sc.c1}</div><div class="c2">No cobres nada</div>${sc.c1 === 'No cobres nada' ? `<div class="c3">${sc.c3}</div>` : ''}</div>`; })()}
      <div class="rp-prueba">
        <div class="tit"><span>📷 Foto de la entrega ${cfg.foto_obligatoria ? '<span class="rp-oblig">obligatoria</span>' : '<small style="color:var(--muted);font-weight:600">(opcional)</small>'}</span>
          <button type="button" class="rp-chico" id="rpFotoBtn">Tomar foto</button></div>
        <div id="rpFotoVista"></div>
        <input type="file" id="rpFotoArchivo" accept="image/*" capture="environment" style="display:none">
      </div>
      <div class="rp-prueba">
        <div class="tit"><span>✍ Firma del cliente ${cfg.firma_obligatoria ? '<span class="rp-oblig">obligatoria</span>' : '<small style="color:var(--muted);font-weight:600">(opcional)</small>'}</span>
          <button type="button" class="rp-chico" id="rpFirmaBtn">Pedir firma</button></div>
        <div id="rpFirmaCaja" style="display:none"><canvas id="rpFirmaLienzo"></canvas>
          <div style="text-align:right"><button type="button" class="rp-chico" id="rpFirmaBorrar">Borrar y firmar de nuevo</button></div></div>
      </div>
      <button type="button" class="rp-btn rp-pri" id="rpConfirmar">✔ Confirmar entrega</button>
      <button type="button" class="rp-btn rp-sec-btn" id="rpCancelar">Cancelar</button>`);

    h.q('#rpCancelar').onclick = () => h.cerrar();
    h.el.querySelectorAll('.rp-metodo').forEach((b) => {
      b.onclick = () => {
        est.metodo = b.dataset.m;
        h.el.querySelectorAll('.rp-metodo').forEach((x) => x.classList.toggle('on', x === b));
        const c = h.q('#rpCambio');
        if (c) c.innerHTML = est.metodo === 'efectivo' && paga > monto ? `Paga con ${dinero(paga)} · cambio <b>${dinero(cambio)}</b>` : '';
      };
    });

    // Foto
    const archivo = h.q('#rpFotoArchivo');
    h.q('#rpFotoBtn').onclick = () => (est.foto ? quitarFoto() : archivo.click());
    function quitarFoto() { est.foto = null; h.q('#rpFotoVista').innerHTML = ''; h.q('#rpFotoBtn').textContent = 'Tomar foto'; archivo.value = ''; }
    archivo.onchange = async () => {
      const f = archivo.files && archivo.files[0];
      if (!f) return;
      try {
        est.foto = await reducirFoto(f);
        h.q('#rpFotoVista').innerHTML = `<img class="vista" alt="Foto de la entrega" src="${est.foto}">`;
        h.q('#rpFotoBtn').textContent = 'Quitar foto';
      } catch (err) { mostrarToast(err.message, 'error'); }
    };

    // Firma
    const lienzo = h.q('#rpFirmaLienzo');
    const ctx = lienzo.getContext('2d');
    function prepararLienzo() {
      const r = lienzo.getBoundingClientRect();
      const k = Math.min(2, window.devicePixelRatio || 1);
      lienzo.width = Math.max(200, Math.round(r.width * k)); lienzo.height = Math.max(100, Math.round(r.height * k));
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, lienzo.width, lienzo.height);
      ctx.strokeStyle = '#111'; ctx.lineWidth = 2.6 * k; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      est.tinta = false;
    }
    h.q('#rpFirmaBtn').onclick = () => {
      est.firmaVisible = !est.firmaVisible;
      h.q('#rpFirmaCaja').style.display = est.firmaVisible ? '' : 'none';
      h.q('#rpFirmaBtn').textContent = est.firmaVisible ? 'Quitar firma' : 'Pedir firma';
      if (est.firmaVisible) prepararLienzo();
    };
    h.q('#rpFirmaBorrar').onclick = prepararLienzo;
    let dibujando = false;
    const punto = (e) => { const r = lienzo.getBoundingClientRect(); return [(e.clientX - r.left) * (lienzo.width / r.width), (e.clientY - r.top) * (lienzo.height / r.height)]; };
    lienzo.addEventListener('pointerdown', (e) => { e.preventDefault(); dibujando = true; lienzo.setPointerCapture(e.pointerId); const [x, y] = punto(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y + 0.1); ctx.stroke(); est.tinta = true; });
    lienzo.addEventListener('pointermove', (e) => { if (!dibujando) return; e.preventDefault(); const [x, y] = punto(e); ctx.lineTo(x, y); ctx.stroke(); });
    ['pointerup', 'pointercancel'].forEach((ev) => lienzo.addEventListener(ev, () => { dibujando = false; }));

    h.q('#rpConfirmar').onclick = async () => {
      const boton = h.q('#rpConfirmar');
      let firma = null;
      if (est.firmaVisible && est.tinta) {
        firma = lienzo.toDataURL('image/png');
        if (firma.length > 400000) firma = lienzo.toDataURL('image/jpeg', 0.7);
      }
      if (cfg.foto_obligatoria && !est.foto) return mostrarToast('Falta la foto de la entrega', 'error');
      if (cfg.firma_obligatoria && !firma) return mostrarToast('Falta la firma del cliente', 'error');
      boton.disabled = true; boton.textContent = 'Guardando…';
      const evidencias = {};
      if (est.foto) evidencias.foto = est.foto;
      if (firma) evidencias.firma = firma;
      const cuerpo = { evidencias };
      if (alRecibir) cuerpo.metodo_cobro = est.metodo;
      const ok = await accion(`${id}/entregar`, cuerpo, '✅ Entrega registrada');
      if (ok) { h.cerrar(); ir('entregas'); } else { boton.disabled = false; boton.textContent = '✔ Confirmar entrega'; }
    };
  }

  const MOTIVOS = ['No estaba o no abrió', 'No contestó el teléfono', 'La dirección no existe o no la encontré', 'El cliente ya no lo quiso', 'Otro motivo'];
  function abrirNoEntregado(id) {
    const p = buscar(id);
    if (!p) return;
    let elegido = null;
    const h = hoja(`
      <h3>¿Por qué no se entregó?</h3>
      <div class="rp-peq">${esc(p.nombre_contacto)} · el pedido regresa a la tienda y ellos deciden qué hacer.</div>
      <div class="rp-motivos">${MOTIVOS.map((m, i) => `<button type="button" class="rp-motivo" data-i="${i}">${esc(m)}</button>`).join('')}</div>
      <textarea id="rpMotivoTxt" rows="2" placeholder="Detalle (opcional; obligatorio si eliges «Otro motivo»)" style="margin-bottom:6px"></textarea>
      <button type="button" class="rp-btn rp-pri" id="rpNoConfirmar" style="background:var(--danger)">Registrar que no se entregó</button>
      <button type="button" class="rp-btn rp-sec-btn" id="rpNoCancelar">Cancelar</button>`);
    h.q('#rpNoCancelar').onclick = () => h.cerrar();
    h.el.querySelectorAll('.rp-motivo').forEach((b) => {
      b.onclick = () => { elegido = Number(b.dataset.i); h.el.querySelectorAll('.rp-motivo').forEach((x) => x.classList.toggle('on', x === b)); };
    });
    h.q('#rpNoConfirmar').onclick = async () => {
      const detalle = h.q('#rpMotivoTxt').value.trim();
      if (elegido === null) return mostrarToast('Elige el motivo', 'error');
      const base = elegido === MOTIVOS.length - 1 ? '' : MOTIVOS[elegido];
      const motivo = [base, detalle].filter(Boolean).join(': ');
      if (!motivo) return mostrarToast('Escribe qué pasó', 'error');
      const boton = h.q('#rpNoConfirmar');
      boton.disabled = true;
      const ok = await accion(`${id}/no-entregado`, { motivo }, 'Anotado: no se entregó');
      if (ok) { h.cerrar(); ir('entregas'); } else boton.disabled = false;
    };
  }

  // ------------------------------------------------------------------ en vivo
  function iniciarSocket() {
    if (typeof io !== 'function') return;
    const sucursal = usuario.sucursal_id || (typeof sucursalSeleccionada === 'function' ? sucursalSeleccionada() : null);
    if (!sucursal) return;
    try {
      const socket = io(API_URL.replace('/api', ''));
      socket.on('connect', () => { socket.emit('unirse_sucursal', sucursal); refrescarSuave(); });
      socket.on('pedido_actualizado', refrescarSuave);
    } catch (e) { /* sin tiempo real: se actualiza cada minuto */ }
  }

  function iniciar() {
    window.addEventListener('hashchange', leerHash);
    window.addEventListener('online', () => cargar(true));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { cargar(true); if (E.vista === 'corte') cargarCorte(true); } });
    setInterval(() => { if (!document.hidden && !E.enviando) cargar(true); }, 60000);
    const c = leerCache();
    if (c) { E.datos = c.d; E.cacheDe = c.t; }
    leerHash();
    cargar(false);
    iniciarSocket();
  }
  iniciar();

  return { ir, abrir, atras, refrescar, tomar, salir, llegue, abrirEntrega, abrirNoEntregado };
})();
