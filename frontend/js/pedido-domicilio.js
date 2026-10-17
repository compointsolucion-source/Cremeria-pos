// Nuevo pedido (a domicilio o para recoger) dentro del Mostrador.
// El cajero arma el ticket como siempre; en el selector de arriba cambia a "A domicilio" o "Para recoger",
// el botón de abajo abre esta ventana: cliente → dirección → cuándo/quién lo lleva → cómo paga.
// Todo se manda a /api/pedidos, que crea el ticket y el pedido juntos.
(function () {
  'use strict';

  const esc = (t) => String(t === undefined || t === null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dinero = (n) => '$' + (Number(n) || 0).toFixed(2);
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const fechaISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const horaHM = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const horaBonita = (hm) => {
    const [h, m] = String(hm).split(':').map(Number);
    return `${h % 12 || 12}:${pad(m || 0)} ${h >= 12 ? 'pm' : 'am'}`;
  };
  const fechaBonita = (iso) => {
    const hoy = fechaISO(new Date());
    const man = fechaISO(new Date(Date.now() + 86400000));
    if (iso === hoy) return 'hoy';
    if (iso === man) return 'mañana';
    return new Date(iso + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  };
  const iniciales = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const lleno = (v) => v !== undefined && v !== null && String(v).trim() !== '';

  const PD = { modo: 'mostrador' };
  let S = null; // lo que se lleva capturado en la ventana
  const apoyo = { zonas: [], envioGratis: 0, repartidores: [], minPrep: 30, listo: false };
  let temporizadorBusqueda = null;

  const estadoNuevo = () => ({
    tipo: 'domicilio', cliente: null, modoCliente: 'buscar', q: '', resultados: null, nuevoNombre: '', telefono: '', guardarCliente: true,
    dirSel: 'nueva', dir: dirVacia(), dirBase: null, zonaId: null, envioForzado: null,
    cuando: 'ya', fecha: '', hora: '', repartidorId: '', pago: 'al_recibir', pagaCon: '', notas: '',
    adelanto: 'ninguno', anticipoMonto: '', anticipoMetodo: 'efectivo',   // ¿ya pagó algo? ninguno | anticipo | todo
    enviando: false, exito: null
  });
  function dirVacia() { return { alias: '', calle: '', colonia: '', cp: '', ciudad: '', referencias: '', ubicacion: '', latitud: null, longitud: null, ubicacion_enlace: null }; }

  const esAdmin = () => { const u = (typeof getUsuario === 'function') ? getUsuario() : null; return !!u && ['dueno', 'gerente', 'jefe_general'].includes(u.rol); };

  // ------------------------------------------------------------------ carrito y totales
  const carritoActual = () => (typeof carrito !== 'undefined' && Array.isArray(carrito)) ? carrito : [];
  const subtotalCarrito = () => r2(carritoActual().reduce((s, it) => s + GRANEL.subtotal(it), 0));

  // Clientes de mayoreo (tiendas): se les cobra el precio de mayoreo del producto cuando es menor.
  function aplicarMayoreo(activar) {
    let cambios = 0;
    const catalogo = (typeof productos !== 'undefined' && Array.isArray(productos)) ? productos : [];
    carritoActual().forEach((it) => {
      if (it.tipo === 'kit' || !it.producto_id) return;
      if (lleno(it.importe)) return; // si el cliente pidió un importe exacto no se toca
      if (activar) {
        if (it._precio_normal !== undefined) return;
        const p = catalogo.find((x) => x.id === it.producto_id);
        const may = p ? parseFloat(p.precio_mayoreo) : 0;
        const actual = parseFloat(it.precio_unitario);
        if (may > 0 && may < actual) { it._precio_normal = actual; it.precio_unitario = may; cambios++; }
      } else if (it._precio_normal !== undefined) {
        it.precio_unitario = it._precio_normal; delete it._precio_normal; cambios++;
      }
    });
    if (cambios && typeof renderCarrito === 'function') renderCarrito();
  }
  const hayMayoreoAplicado = () => carritoActual().some((it) => it._precio_normal !== undefined);

  function zonaActual() { return apoyo.zonas.find((z) => z.id === S.zonaId) || null; }

  function calcEnvio() {
    if (S.tipo !== 'domicilio') return { costo: 0, gratis: false, falta: 0, zona: null };
    const z = zonaActual();
    const sub = subtotalCarrito();
    if (S.envioForzado !== null && S.envioForzado !== undefined) return { costo: S.envioForzado, gratis: false, falta: 0, zona: z, manual: true };
    if (!z) return { costo: 0, gratis: false, falta: 0, zona: null };
    const min = z.envio_gratis_desde !== null && z.envio_gratis_desde !== undefined ? z.envio_gratis_desde : apoyo.envioGratis;
    const gratis = min > 0 && sub >= min;
    return { costo: gratis ? 0 : z.costo, gratis, falta: min > 0 && !gratis ? r2(min - sub) : 0, minimo: min, zona: z };
  }
  const totalPedido = () => r2(subtotalCarrito() + calcEnvio().costo);
  // Anticipo: lo que el cliente ya dejó. "Ya pagó todo" = anticipo igual al total. Lo que se cobra después es la resta.
  const anticipoPedido = () => (!S ? 0 : S.adelanto === 'todo' ? totalPedido() : S.adelanto === 'anticipo' ? Math.max(0, r2(Number(S.anticipoMonto) || 0)) : 0);
  const restaPedido = () => Math.max(0, r2(totalPedido() - anticipoPedido()));
  const NOMBRE_METODO = { efectivo: 'efectivo', transferencia: 'transferencia', tarjeta: 'tarjeta' };

  // ------------------------------------------------------------------ selector de modo (barra del Mostrador)
  PD.setModo = function (m) {
    if (!['mostrador', 'domicilio', 'recoger'].includes(m) || m === PD.modo) return;
    PD.modo = m;
    document.body.setAttribute('data-modo-venta', m);
    document.querySelectorAll('#modoVenta button').forEach((b) => b.classList.toggle('activo', b.dataset.modo === m));
    const btn = $('btnGenerarTicket');
    if (btn) btn.textContent = m === 'domicilio' ? '🛵 Continuar con el pedido →' : m === 'recoger' ? '🏪 Continuar con el pedido →' : '🖨 Generar e Imprimir Ticket';
    if (m === 'mostrador') { aplicarMayoreo(false); S = null; }
    else if (S) { S.tipo = m; ajustarPago(); }
  };

  // ------------------------------------------------------------------ abrir / cerrar
  PD.abrir = async function () {
    if (PD.modo === 'mostrador') return;
    if (!carritoActual().length) { if (typeof mostrarToast === 'function') mostrarToast('Agrega al menos un producto', 'error'); return; }
    asegurarModal();
    if (!S) S = estadoNuevo();
    S.tipo = PD.modo;
    S.exito = null;
    ajustarPago();
    if (S.cliente) aplicarMayoreo(!!S.cliente.usa_mayoreo);
    $('pdOverlay').classList.add('abierto');
    document.body.classList.add('hoja-abierta');
    $('pdCuerpo').style.display = '';
    $('pdExito').style.display = 'none';
    $('pdPie').style.display = '';
    renderTodo();
    cargarApoyo();
    const foco = $('pdBuscar') || $('pdNombreNuevo');
    if (foco && !S.cliente) setTimeout(() => foco.focus(), 60);
  };

  PD.cerrar = function () {
    const o = $('pdOverlay');
    if (o) o.classList.remove('abierto');
    if (!document.querySelector('.pt-overlay')) document.body.classList.remove('hoja-abierta');
    if (S && S.exito) S = null; // ya se mandó: la siguiente vez empieza limpio
  };

  async function cargarApoyo() {
    try {
      const [z, r, cfg] = await Promise.all([
        apiFetch('/pedidos/zonas').catch(() => null),
        apiFetch('/pedidos/repartidores').catch(() => null),
        (typeof configuracionNegocio !== 'undefined' && configuracionNegocio && configuracionNegocio.pedidos_min_preparacion !== undefined)
          ? Promise.resolve(configuracionNegocio) : apiFetch('/configuracion').catch(() => null)
      ]);
      if (z) { apoyo.zonas = z.zonas || []; apoyo.envioGratis = Number(z.envio_gratis_desde || 0); }
      if (r) apoyo.repartidores = r;
      if (cfg && cfg.pedidos_min_preparacion !== undefined) apoyo.minPrep = Number(cfg.pedidos_min_preparacion) || 0;
      apoyo.listo = true;
    } catch (e) { /* se queda con lo que haya */ }
    if (S && $('pdOverlay') && $('pdOverlay').classList.contains('abierto')) {
      if (S.tipo === 'domicilio' && S.zonaId && !zonaActual()) S.zonaId = null;
      renderEntrega(); renderResumen(); renderCobro();
    }
  }

  // ------------------------------------------------------------------ esqueleto de la ventana
  function asegurarModal() {
    if ($('pdOverlay')) return;
    const div = document.createElement('div');
    div.className = 'pd-overlay';
    div.id = 'pdOverlay';
    div.innerHTML = `
      <div class="pd-modal" role="dialog" aria-modal="true" aria-labelledby="pdTitulo">
        <div class="pd-cab"><h2 id="pdTitulo">Nuevo pedido</h2><button type="button" class="pd-x" onclick="PedidoDom.cerrar()" aria-label="Cerrar">✕</button></div>
        <div class="pd-cuerpo" id="pdCuerpo">
          <div class="pd-izq">
            <section class="pd-paso" id="pdPasoCliente"></section>
            <section class="pd-paso" id="pdPasoDir"></section>
            <section class="pd-paso" id="pdPasoEntrega"></section>
          </div>
          <div class="pd-der">
            <div class="pd-tarjeta" id="pdResumen"></div>
            <div class="pd-tarjeta" id="pdCobro"></div>
          </div>
        </div>
        <div class="pd-cuerpo" id="pdExito" style="display:none; grid-template-columns:1fr;"></div>
        <div class="pd-pie" id="pdPie">
          <div class="pd-error" id="pdError" role="alert"></div>
          <div class="pd-pie-fila" id="pdBotones"></div>
        </div>
      </div>`;
    document.body.appendChild(div);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && div.classList.contains('abierto')) PD.cerrar(); });
    // El aviso de error se quita en cuanto el cajero toca o escribe algo en el formulario.
    div.addEventListener('input', () => mostrarError(''));
    div.addEventListener('click', (e) => { if (!e.target.closest('#pdPie')) mostrarError(''); });
  }

  function renderTodo() {
    $('pdTitulo').textContent = S.tipo === 'domicilio' ? '🛵 Nuevo pedido a domicilio' : '🏪 Nuevo pedido para recoger';
    renderCliente(); renderDir(); renderEntrega(); renderResumen(); renderCobro(); renderBotones();
  }

  // ------------------------------------------------------------------ paso 1: cliente
  function renderCliente() {
    const el = $('pdPasoCliente');
    const c = S.cliente;
    let h = '<h3><span class="pd-num"></span> ¿Quién es el cliente?</h3>';
    if (c) {
      const tags = (c.tipo === 'tienda' ? '<span class="pd-tag azul">Tienda</span>' : '') + (c.usa_mayoreo ? '<span class="pd-tag ok">Mayoreo</span>' : '') + (c.n_pedidos >= 3 ? '<span class="pd-tag ok">Frecuente</span>' : '');
      let ult = '';
      if (c.ultimo_pedido) {
        const dias = Math.max(0, Math.floor((Date.now() - new Date(c.ultimo_pedido).getTime()) / 86400000));
        ult = ` · último pedido ${dias === 0 ? 'hoy' : 'hace ' + dias + (dias === 1 ? ' día' : ' días')}`;
      }
      h += `<div class="pd-cliente-sel"><div class="pd-avatar">${esc(iniciales(c.nombre))}</div>
        <div class="info"><b>${esc(c.nombre)} ${tags}</b><small>${c.n_pedidos ? c.n_pedidos + (c.n_pedidos === 1 ? ' pedido' : ' pedidos') : 'Sin pedidos todavía'}${ult}</small></div>
        <button type="button" class="pd-link" onclick="PedidoDom.cambiarCliente()">Cambiar</button></div>
        <label class="pd-etq" for="pdTelefono">Teléfono ${S.tipo === 'domicilio' ? '(el repartidor puede llamar)' : '(para avisarle)'}</label>
        <input type="tel" id="pdTelefono" inputmode="tel" value="${esc(S.telefono)}" placeholder="33 1234 5678" oninput="PedidoDom.set('telefono', this.value)">`;
      if (c.usa_mayoreo && hayMayoreoAplicado()) h += '<div class="pd-nota">🏷 Se aplicó su <b>precio de mayoreo</b> en los productos que lo tienen.</div>';
    } else if (S.modoCliente === 'nuevo') {
      h += `<div class="pd-fila f2">
          <div><label class="pd-etq" for="pdNombreNuevo">Nombre</label><input type="text" id="pdNombreNuevo" value="${esc(S.nuevoNombre)}" placeholder="Nombre del cliente" oninput="PedidoDom.set('nuevoNombre', this.value)"></div>
          <div><label class="pd-etq" for="pdTelefono">Teléfono</label><input type="tel" id="pdTelefono" inputmode="tel" value="${esc(S.telefono)}" placeholder="33 1234 5678" oninput="PedidoDom.set('telefono', this.value)"></div>
        </div>
        <label class="pd-imprimir" style="margin-top:10px"><input type="checkbox" ${S.guardarCliente ? 'checked' : ''} onchange="PedidoDom.set('guardarCliente', this.checked)"> Guardarlo en mis clientes (la próxima vez ya está su dirección)</label>
        <button type="button" class="pd-link" onclick="PedidoDom.volverABuscar()">← Buscar un cliente que ya existe</button>`;
    } else {
      h += `<input type="search" id="pdBuscar" autocomplete="off" placeholder="🔍 Busca por teléfono o nombre…" value="${esc(S.q)}" oninput="PedidoDom.buscar(this.value)">
        <div id="pdResultados"></div>
        <button type="button" class="pd-link" onclick="PedidoDom.nuevoCliente()">＋ Es un cliente nuevo</button>`;
    }
    el.innerHTML = h;
    if (!c && S.modoCliente !== 'nuevo') pintarResultados();
  }

  function pintarResultados() {
    const cont = $('pdResultados');
    if (!cont) return;
    const q = S.q.trim();
    if (q.length < 2) { cont.innerHTML = '<div class="pd-vacio">Escribe al menos 2 letras o 3 números del teléfono.</div>'; return; }
    if (S.resultados === null) { cont.innerHTML = '<div class="pd-vacio">Buscando…</div>'; return; }
    if (!S.resultados.length) { cont.innerHTML = `<div class="pd-vacio">No encontré a nadie con “${esc(q)}”. <a onclick="PedidoDom.nuevoCliente()">Crear cliente nuevo</a></div>`; return; }
    cont.innerHTML = S.resultados.map((c) => `<button type="button" class="pd-res" onclick="PedidoDom.elegirCliente(${c.id})">
        <span class="pd-avatar">${esc(iniciales(c.nombre))}</span>
        <span><b>${esc(c.nombre)}${c.tipo === 'tienda' ? ' <span class="pd-tag azul">Tienda</span>' : ''}</b><small>${esc(c.telefono || 'Sin teléfono')} · ${c.direcciones.length} ${c.direcciones.length === 1 ? 'dirección' : 'direcciones'} · ${c.n_pedidos} ${c.n_pedidos === 1 ? 'pedido' : 'pedidos'}</small></span></button>`).join('');
  }

  PD.buscar = function (v) {
    S.q = v;
    S.resultados = null;
    clearTimeout(temporizadorBusqueda);
    pintarResultados();
    if (v.trim().length < 2) return;
    temporizadorBusqueda = setTimeout(async () => {
      const consulta = v;
      try {
        const r = await apiFetch('/pedidos/clientes?q=' + encodeURIComponent(consulta.trim()));
        if (!S || S.q !== consulta) return; // ya escribió otra cosa
        S.resultados = r;
      } catch (e) {
        if (!S || S.q !== consulta) return;
        S.resultados = [];
      }
      pintarResultados();
    }, 250);
  };

  PD.elegirCliente = function (id) {
    const c = (S.resultados || []).find((x) => x.id === id);
    if (!c) return;
    S.cliente = c;
    S.modoCliente = 'buscar';
    S.telefono = c.telefono || '';
    S.q = ''; S.resultados = null;
    const d = c.direcciones[0];
    if (d) { elegirDirGuardada(d); } else { S.dirSel = 'nueva'; S.dir = dirVacia(); S.dirBase = null; }
    aplicarMayoreo(!!c.usa_mayoreo);
    renderTodo();
  };

  PD.nuevoCliente = function () {
    S.cliente = null; S.modoCliente = 'nuevo';
    S.nuevoNombre = /\D/.test(S.q) && !/^[\d\s+()-]+$/.test(S.q) ? S.q.trim() : '';
    if (/^[\d\s+()-]+$/.test(S.q)) S.telefono = S.q.trim();
    S.dirSel = 'nueva'; S.dir = dirVacia(); S.dirBase = null;
    aplicarMayoreo(false);
    renderTodo();
    const f = $('pdNombreNuevo'); if (f) f.focus();
  };

  PD.volverABuscar = function () { S.modoCliente = 'buscar'; renderCliente(); const f = $('pdBuscar'); if (f) f.focus(); };

  PD.cambiarCliente = function () {
    S.cliente = null; S.modoCliente = 'buscar'; S.telefono = ''; S.q = ''; S.resultados = null;
    S.dirSel = 'nueva'; S.dir = dirVacia(); S.dirBase = null;
    aplicarMayoreo(false);
    if (S.pago === 'credito') S.pago = S.tipo === 'domicilio' ? 'al_recibir' : 'pagado';
    renderTodo();
    const f = $('pdBuscar'); if (f) f.focus();
  };

  PD.set = function (k, v) { S[k] = v; };

  // ------------------------------------------------------------------ paso 2: dirección
  function textoUbicacionDe(d) {
    if (lleno(d.ubicacion_enlace)) return d.ubicacion_enlace;
    if (UBICACION.tieneCoordenadas(d)) return `${d.latitud}, ${d.longitud}`;
    return '';
  }

  function elegirDirGuardada(d) {
    S.dirSel = d.id;
    S.dir = {
      alias: d.alias || '', calle: d.calle || '', colonia: d.colonia || '', cp: d.cp || '', ciudad: d.ciudad || '', referencias: d.referencias || '',
      ubicacion: textoUbicacionDe(d), latitud: d.latitud === undefined ? null : d.latitud, longitud: d.longitud === undefined ? null : d.longitud,
      ubicacion_enlace: d.ubicacion_enlace || null
    };
    S.dirBase = JSON.stringify(firmaDir(S.dir));
    if (d.zona_id && apoyo.zonas.some((z) => z.id === d.zona_id)) S.zonaId = d.zona_id;
  }
  const firmaDir = (d) => [d.calle, d.colonia, d.cp, d.ciudad, d.referencias, d.latitud, d.longitud].map((x) => (x === null || x === undefined ? '' : String(x).trim()));
  const dirModificada = () => S.dirSel !== 'nueva' && JSON.stringify(firmaDir(S.dir)) !== S.dirBase;

  function renderDir() {
    const el = $('pdPasoDir');
    if (S.tipo !== 'domicilio') { el.classList.add('oculto'); el.innerHTML = ''; return; }
    el.classList.remove('oculto');
    const dirs = S.cliente ? S.cliente.direcciones : [];
    let h = '<h3><span class="pd-num"></span> ¿A dónde se lleva?</h3>';
    dirs.forEach((d, i) => {
      h += `<div class="pd-dir ${S.dirSel === d.id ? 'sel' : ''}" onclick="PedidoDom.elegirDir(${d.id})"><span class="punto"></span><div style="flex:1;min-width:0">
        <b>${esc(d.alias || 'Dirección ' + (i + 1))}${d.principal ? ' <span class="pd-tag ok">Principal</span>' : ''}${UBICACION.tieneCoordenadas(d) ? ' <span class="pd-tag ok">📍 Ubicación guardada</span>' : ''}</b>
        <small>${esc(UBICACION.textoDireccion(d))}</small>${d.referencias ? `<small>Ref.: ${esc(d.referencias)}</small>` : ''}</div></div>`;
    });
    if (dirs.length) h += `<div class="pd-dir nueva ${S.dirSel === 'nueva' ? 'sel' : ''}" onclick="PedidoDom.elegirDir('nueva')"><span class="punto"></span><b>＋ Otra dirección nueva</b></div>`;
    const d = S.dir;
    const campo = (k, etq, ph, extra) => `<div ${extra || ''}><label class="pd-etq" for="pdD_${k}">${etq}</label><input type="text" id="pdD_${k}" value="${esc(d[k])}" placeholder="${esc(ph || '')}" oninput="PedidoDom.campoDir('${k}', this.value)"></div>`;
    h += `<div class="pd-fila f3" style="margin-top:6px">${campo('calle', 'Calle y número *', 'Av. Patria 1234')}${campo('colonia', 'Colonia', 'Jardines Universidad')}${campo('cp', 'C.P.', '45110')}</div>
      <div class="pd-fila f2">${campo('ciudad', 'Ciudad', 'Zapopan')}${campo('alias', 'Nombre de esta dirección (opcional)', 'Casa, Trabajo…')}</div>
      <label class="pd-etq" for="pdD_referencias">Referencias para el repartidor</label>
      <input type="text" id="pdD_referencias" value="${esc(d.referencias)}" placeholder="Portón negro, esquina con Av. Aviación. Tocar el timbre." oninput="PedidoDom.campoDir('referencias', this.value)">
      <label class="pd-etq" for="pdD_ubicacion">📍 Ubicación exacta (opcional, pero ayuda mucho)</label>
      <input type="text" id="pdD_ubicacion" value="${esc(d.ubicacion)}" placeholder="Pega aquí la ubicación que mandó el cliente por WhatsApp o un enlace de Google Maps" oninput="PedidoDom.campoDir('ubicacion', this.value)">
      <div class="pd-ubic"><span class="estado" id="pdUbicEstado"></span>
        <button type="button" class="pd-mini waze" onclick="PedidoDom.probar('waze')">🧭 Waze</button>
        <button type="button" class="pd-mini" onclick="PedidoDom.probar('maps')">🗺 Google Maps</button></div>
      ${S.dirSel !== 'nueva' ? '<div class="pd-nota" id="pdDirNota"></div>' : ''}`;
    el.innerHTML = h;
    pintarEstadoUbic();
    pintarNotaDir();
  }

  function pintarEstadoUbic() {
    const e = $('pdUbicEstado');
    if (!e) return;
    const d = S.dir;
    e.className = 'estado';
    if (UBICACION.tieneCoordenadas(d)) { e.classList.add('ok'); e.textContent = `✔ Ubicación exacta guardada (${d.latitud}, ${d.longitud})`; }
    else if (lleno(d.ubicacion_enlace)) { e.textContent = 'Enlace guardado: el repartidor lo podrá abrir. Si pegas las coordenadas, Waze navega directo.'; }
    else if (lleno(d.ubicacion)) { e.classList.add('mal'); e.textContent = 'No pude leer una ubicación ahí. Pega el enlace de Google Maps o las coordenadas (ej. 20.6736, -103.3440).'; }
    else e.textContent = 'Sin ubicación exacta: Waze y Maps buscarán la dirección escrita.';
  }
  function pintarNotaDir() {
    const n = $('pdDirNota');
    if (n) n.textContent = dirModificada() ? 'Cambiaste algo: se guardará como una dirección nueva del cliente.' : 'Dirección guardada del cliente. Si cambias algo, se guarda como nueva.';
  }

  PD.elegirDir = function (id) {
    if (id === 'nueva') { S.dirSel = 'nueva'; S.dir = dirVacia(); S.dirBase = null; }
    else { const d = (S.cliente ? S.cliente.direcciones : []).find((x) => x.id === id); if (!d) return; elegirDirGuardada(d); }
    renderDir(); renderEntrega(); renderResumen();
  };

  PD.campoDir = function (k, v) {
    S.dir[k] = v;
    if (k === 'ubicacion') {
      const t = v.trim();
      const c = UBICACION.extraerCoordenadas(t);
      if (c) { S.dir.latitud = c.latitud; S.dir.longitud = c.longitud; S.dir.ubicacion_enlace = /^https?:\/\//i.test(t) ? t.slice(0, 500) : null; }
      else { S.dir.latitud = null; S.dir.longitud = null; S.dir.ubicacion_enlace = /^https?:\/\//i.test(t) ? t.slice(0, 500) : null; }
      pintarEstadoUbic();
    }
    pintarNotaDir();
  };

  PD.probar = function (app) {
    const d = S.dir;
    if (!UBICACION.tieneCoordenadas(d) && !lleno(d.calle)) { mostrarToast('Escribe la dirección o pega la ubicación primero', 'error'); return; }
    const url = app === 'waze' ? UBICACION.urlWaze(d) : UBICACION.urlGoogleMaps(d);
    window.open(url, '_blank', 'noopener');
  };

  // ------------------------------------------------------------------ paso 3: cuándo y quién
  function primeraHoraLibre() {
    const t = new Date(Date.now() + 30 * 60000);
    t.setMinutes(t.getMinutes() <= 30 ? (t.getMinutes() === 0 ? 0 : 30) : 60, 0, 0);
    return t;
  }

  function opcionesHora(fecha) {
    if (fecha === fechaISO(new Date())) {
      const t = primeraHoraLibre();
      const lista = [];
      for (let i = 0; i < 5; i++) {
        const x = new Date(t.getTime() + i * 30 * 60000);
        if (fechaISO(x) !== fecha) break;
        lista.push(horaHM(x));
      }
      return lista;
    }
    return ['09:00', '11:00', '13:00', '15:00', '17:00'];
  }

  function renderEntrega() {
    const el = $('pdPasoEntrega');
    const dom = S.tipo === 'domicilio';
    let h = `<h3><span class="pd-num"></span> ${dom ? '¿Cuándo y quién lo lleva?' : '¿Cuándo lo recoge?'}</h3><div class="pd-fila ${dom ? 'f2' : ''}"><div>
      <label class="pd-etq">${dom ? 'Entrega' : 'Recoge'}</label>
      <div class="pd-seg"><button type="button" class="${S.cuando === 'ya' ? 'activo' : ''}" onclick="PedidoDom.cuando('ya')">Lo antes posible</button><button type="button" class="${S.cuando === 'programar' ? 'activo' : ''}" onclick="PedidoDom.cuando('programar')">📅 Programar</button></div>`;
    if (S.cuando === 'programar') {
      const hoy = fechaISO(new Date());
      h += `<div class="pd-fila f2" style="margin-top:10px"><input type="date" id="pdFecha" min="${hoy}" value="${esc(S.fecha)}" onchange="PedidoDom.fechaHora()"><input type="time" id="pdHora" value="${esc(S.hora)}" onchange="PedidoDom.fechaHora()"></div>
        <div class="pd-chips" id="pdChipsHora"></div><div class="pd-nota" id="pdNotaPrep"></div>`;
    } else {
      h += `<div class="pd-nota">${dom ? 'Se prepara de inmediato y sale en cuanto esté listo.' : 'Se prepara de inmediato; avisas al cliente cuando esté listo.'}</div>`;
    }
    h += '</div>';
    if (dom) {
      const reps = apoyo.repartidores;
      h += `<div><label class="pd-etq" for="pdRepartidor">Repartidor</label><select id="pdRepartidor" onchange="PedidoDom.set('repartidorId', this.value)">
          <option value="">Sin asignar (lo toma el que esté libre)</option>
          ${reps.map((r) => `<option value="${r.id}" ${String(S.repartidorId) === String(r.id) ? 'selected' : ''}>${esc(r.nombre)} · ${r.estado === 'en_ruta' ? 'en ruta (' + r.en_camino + ')' : 'libre'}</option>`).join('')}</select>
        ${apoyo.listo && !reps.length ? '<div class="pd-nota">⚠ Todavía no hay repartidores. Crea un usuario con rol <b>Repartidor</b> en Equipo.</div>' : ''}
        <label class="pd-etq" for="pdZona">Costo de envío</label>
        <select id="pdZona" onchange="PedidoDom.zona(this.value)"><option value="">Sin zona (envío $0.00)</option>
          ${apoyo.zonas.map((z) => `<option value="${z.id}" ${S.zonaId === z.id ? 'selected' : ''}>${esc(z.nombre)} · ${dinero(z.costo)}</option>`).join('')}</select>
        <div class="pd-nota" id="pdNotaEnvio"></div></div>`;
    }
    h += '</div>';
    el.innerHTML = h;
    if (S.cuando === 'programar') pintarChips();
    pintarNotaEnvio();
  }

  function pintarChips() {
    const c = $('pdChipsHora');
    if (!c) return;
    c.innerHTML = opcionesHora(S.fecha).map((hm) => `<button type="button" class="pd-chip ${S.hora === hm ? 'activo' : ''}" onclick="PedidoDom.horaChip('${hm}')">${horaBonita(hm)}</button>`).join('');
    const n = $('pdNotaPrep');
    if (!n) return;
    n.innerHTML = notaPreparacion();
  }

  function notaPreparacion() {
    if (!S.fecha || !S.hora) return 'Elige el día y la hora.';
    const prog = new Date(`${S.fecha}T${S.hora}`);
    if (isNaN(prog.getTime())) return 'Elige el día y la hora.';
    if (prog.getTime() < Date.now() - 60000) return '⚠ Esa hora ya pasó.';
    const prep = new Date(prog.getTime() - apoyo.minPrep * 60000);
    const cuando = `${fechaBonita(S.fecha)} a las <b>${horaBonita(S.hora)}</b>`;
    if (prep.getTime() <= Date.now()) return `Para ${cuando}. Se empieza a preparar de inmediato.`;
    const dia = fechaISO(prep) === S.fecha ? '' : ` del ${fechaBonita(fechaISO(prep))}`;
    return `Para ${cuando}. Se avisa en el tablero para preparar a las <b>${horaBonita(horaHM(prep))}</b>${dia}.`;
  }

  function pintarNotaEnvio() {
    const n = $('pdNotaEnvio');
    if (!n) return;
    const e = calcEnvio();
    let t = '';
    if (!apoyo.zonas.length && apoyo.listo) t = esAdmin() ? 'No hay zonas de envío: créalas en Pedidos → Zonas de envío.' : 'No hay zonas de envío configuradas (pídele al dueño que las cree).';
    else if (e.manual) t = 'Costo de envío cambiado a mano.';
    else if (e.gratis) t = '🎉 Envío gratis por el monto de la compra.';
    else if (e.zona && e.falta > 0) t = `Envío gratis desde ${dinero(e.minimo)} (faltan ${dinero(e.falta)}).`;
    n.textContent = t;
    if (esAdmin() && S.tipo === 'domicilio') {
      const a = document.createElement('button');
      a.type = 'button'; a.className = 'pd-link'; a.textContent = '✎ Cambiar el costo a mano';
      a.onclick = PD.cambiarEnvio;
      n.appendChild(document.createElement('br')); n.appendChild(a);
    }
  }

  PD.cuando = function (c) {
    S.cuando = c;
    if (c === 'programar' && (!S.fecha || !S.hora)) {
      const t = primeraHoraLibre();
      if (t.getHours() >= 21 || fechaISO(t) !== fechaISO(new Date())) { S.fecha = fechaISO(new Date(Date.now() + 86400000)); S.hora = '09:00'; }
      else { S.fecha = fechaISO(t); S.hora = horaHM(t); }
    }
    renderEntrega(); renderBotones();
  };

  PD.fechaHora = function () {
    S.fecha = ($('pdFecha') || {}).value || '';
    S.hora = ($('pdHora') || {}).value || '';
    pintarChips();
  };

  PD.horaChip = function (hm) {
    S.hora = hm;
    const i = $('pdHora'); if (i) i.value = hm;
    pintarChips();
  };

  PD.zona = function (v) {
    S.zonaId = v ? Number(v) : null;
    S.envioForzado = null;
    pintarNotaEnvio(); renderResumen(); renderCobro();
  };

  PD.cambiarEnvio = async function () {
    const t = await solicitarTexto('¿Cuánto cobrar de envío? (0 = sin costo)', String(calcEnvio().costo));
    if (t === null || t === undefined || String(t).trim() === '') return;
    const n = Number(String(t).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n) || n < 0) { mostrarToast('Escribe un monto válido', 'error'); return; }
    S.envioForzado = r2(n);
    pintarNotaEnvio(); renderResumen(); renderCobro();
  };

  // ------------------------------------------------------------------ columna derecha: resumen, cobro, botones
  function renderResumen() {
    const el = $('pdResumen');
    if (!el || !S) return;
    const e = calcEnvio();
    let h = '<h3>🧾 Pedido</h3>';
    carritoActual().forEach((it) => {
      h += `<div class="pd-item"><span>${esc(it.nombre_producto)}<small>${esc(GRANEL.detalle(it, '×'))}${it._precio_normal !== undefined ? ' · precio de mayoreo' : ''}</small></span><b>${dinero(GRANEL.subtotal(it))}</b></div>`;
    });
    h += `<div class="pd-sum" style="margin-top:6px"><span>Subtotal</span><span>${dinero(subtotalCarrito())}</span></div>`;
    if (S.tipo === 'domicilio') {
      h += `<div class="pd-sum"><span>🛵 Envío${e.zona ? ' · ' + esc(e.zona.nombre) : ''}${e.gratis ? ' <span class="pd-tag ok">Gratis</span>' : ''}${e.manual ? ' <span class="pd-tag aviso">A mano</span>' : ''}</span><span>${dinero(e.costo)}</span></div>`;
    }
    h += `<div class="pd-total"><span>Total</span><span>${dinero(totalPedido())}</span></div>`;
    const ant = anticipoPedido();
    if (ant > 0) {
      h += `<div class="pd-sum" style="margin-top:4px"><span>💰 ${S.adelanto === 'todo' ? 'Ya pagó' : 'Anticipo'} (${NOMBRE_METODO[S.anticipoMetodo] || 'efectivo'})</span><span>−${dinero(ant)}</span></div>
        <div class="pd-sum" style="font-weight:800"><span>${restaPedido() > 0 ? 'Resta por cobrar' : 'Por cobrar'}</span><span>${dinero(restaPedido())}</span></div>`;
    }
    el.innerHTML = h;
    const pt = $('pdPieTotal'); if (pt) pt.textContent = dinero(totalPedido());
  }

  function ajustarPago() {
    if (!S) return;
    const validos = S.tipo === 'domicilio' ? ['al_recibir', 'pagado', 'credito'] : ['pagado', 'credito'];
    if (!validos.includes(S.pago)) S.pago = S.tipo === 'domicilio' ? 'al_recibir' : 'pagado';
  }

  // Caja no deja cobrar a crédito a quien no tiene límite o se pasaría: se avisa desde aquí para no descubrirlo hasta la entrega.
  function textoAvisoCredito() {
    if (!S || S.pago !== 'credito' || !S.cliente) return '';
    const limite = Number(S.cliente.limite_credito) || 0, saldo = Number(S.cliente.saldo_actual) || 0;
    const quedaria = r2(saldo + totalPedido());
    if (limite <= 0) return '⚠ Este cliente <b>no tiene crédito autorizado</b>. En Caja no se podrá cobrar a crédito: elige «Se cobra en Caja» o ponle un límite en <b>Clientes</b>.';
    if (quedaria > limite) return `⚠ Con este pedido su deuda sería <b>${dinero(quedaria)}</b> y su límite es <b>${dinero(limite)}</b>. En Caja no se podrá cobrar a crédito hasta que abone o le subas el límite.`;
    return '';
  }

  function renderCobro() {
    const el = $('pdCobro');
    if (!el || !S) return;
    const dom = S.tipo === 'domicilio';
    const sinCliente = !S.cliente;
    const todo = S.adelanto === 'todo';
    const resta = restaPedido();
    const op = (id, titulo, sub, extra, bloq) => `<div class="pd-pago ${S.pago === id ? 'sel' : ''} ${bloq ? 'bloq' : ''}" ${bloq ? '' : `onclick="PedidoDom.pago('${id}')"`}><span class="punto"></span><div style="flex:1;min-width:0"><b>${titulo}</b><small>${sub}</small>${S.pago === id && extra ? extra : ''}</div></div>`;
    const ad = (id, titulo, sub, extra) => `<div class="pd-pago ${S.adelanto === id ? 'sel' : ''}" onclick="PedidoDom.adelanto('${id}')"><span class="punto"></span><div style="flex:1;min-width:0"><b>${titulo}</b><small>${sub}</small>${S.adelanto === id && extra ? extra : ''}</div></div>`;
    const metodos = `<div class="pd-metodos" onclick="event.stopPropagation()" role="group" aria-label="¿Con qué lo pagó?">${[['efectivo', '💵 Efectivo'], ['transferencia', '🏦 Transferencia'], ['tarjeta', '💳 Tarjeta']].map(([k, t]) => `<button type="button" class="pd-metodo ${S.anticipoMetodo === k ? 'on' : ''}" onclick="PedidoDom.anticipoMetodo('${k}')">${t}</button>`).join('')}</div>`;

    // 1) ¿Ya pagó algo? (anticipo o pago completo). A crédito no aplica.
    let h = '';
    if (S.pago !== 'credito') {
      h += '<h3>💰 ¿Ya pagó algo?</h3>';
      h += ad('ninguno', 'No ha pagado nada', 'Se cobra todo al entregar o al recoger.');
      h += ad('anticipo', 'Dio anticipo', 'Anota cuánto dejó. Al entregar o recoger solo se cobra lo que falta.',
        `<div class="pd-pagacon" onclick="event.stopPropagation()"><label for="pdAnticipo">Dejó $</label><input type="number" id="pdAnticipo" inputmode="decimal" min="0" step="any" placeholder="0.00" value="${esc(S.anticipoMonto)}" oninput="PedidoDom.anticipoMonto(this.value)"> <span id="pdResta">${restaTexto()}</span></div>${metodos}`);
      h += ad('todo', 'Ya pagó todo', 'Ya pagó el total por adelantado: en el ticket sale «YA PAGADO» y nadie le cobra nada más.', metodos);
    }

    // 2) ¿Cómo paga el resto?
    h += `<h3${h ? ' style="margin-top:16px"' : ''}>💵 ${S.adelanto === 'anticipo' ? '¿Cómo paga lo que falta?' : '¿Cómo paga?'}</h3>`;
    if (todo) {
      h += `<div class="pd-pagado-aviso">✅ <b>Ya pagó todo</b> (${NOMBRE_METODO[S.anticipoMetodo] || 'efectivo'}). No hay nada que cobrar${dom ? ' al entregar' : ' al recoger'}. Caja solo registra el pago.</div>`;
    } else {
      if (dom) {
        const cambio = Number(S.pagaCon) > 0 ? Math.max(0, r2(Number(S.pagaCon) - resta)) : null;
        h += op('al_recibir', 'Paga al recibir', 'El repartidor cobra (efectivo, transferencia o tarjeta) y entrega el dinero en caja.',
          `<div class="pd-pagacon" onclick="event.stopPropagation()"><label for="pdPagaCon">¿Con cuánto paga?</label><input type="number" id="pdPagaCon" inputmode="decimal" min="0" step="any" placeholder="${resta.toFixed(2)}" value="${esc(S.pagaCon)}" oninput="PedidoDom.pagaCon(this.value)"> <span id="pdCambio">${cambio !== null ? 'cambio: ' + dinero(cambio) : ''}</span></div>`);
        h += op('pagado', 'Se cobra en Caja', 'Se cobra en Caja, no con el repartidor. Si ya pagó, usa «Ya pagó todo» o «Dio anticipo» arriba.');
      } else {
        h += op('pagado', 'Paga al recoger (en Caja)', 'El pedido aparece en la bandeja de Caja para cobrarlo.');
      }
      h += op('credito', 'A crédito del cliente', sinCliente ? 'Primero elige un cliente guardado.' : `Se suma a su cuenta${S.cliente.saldo_actual ? ' (debe ' + dinero(S.cliente.saldo_actual) + ')' : ''}.`, '', sinCliente);
      const avisoCredito = textoAvisoCredito();
      if (avisoCredito) h += `<div class="pd-aviso-credito" role="alert">${avisoCredito}</div>`;
    }
    h += `<label class="pd-etq" for="pdNotas">Notas del pedido (opcional)</label><input type="text" id="pdNotas" maxlength="300" placeholder="Ej. Sin sal, tocar el timbre…" value="${esc(S.notas)}" oninput="PedidoDom.set('notas', this.value)">`;
    el.innerHTML = h;
  }

  function restaTexto() {
    const a = anticipoPedido();
    return a > 0 ? `resta por cobrar: <b>${dinero(restaPedido())}</b>` : '';
  }

  // Cambiar entre "no ha pagado / anticipo / ya pagó todo".
  PD.adelanto = function (id) {
    if (!S || S.adelanto === id) return;
    S.adelanto = id;
    if (id !== 'ninguno' && S.pago === 'credito') S.pago = S.tipo === 'domicilio' ? 'al_recibir' : 'pagado';   // a crédito no hay anticipo
    renderResumen(); renderCobro();
    if (id === 'anticipo') { const f = $('pdAnticipo'); if (f) f.focus(); }
  };
  PD.anticipoMonto = function (v) {
    S.anticipoMonto = v;
    const r = $('pdResta'); if (r) r.innerHTML = restaTexto();
    const c = $('pdCambio');
    if (c) { const n = Number(S.pagaCon); c.textContent = n > 0 ? 'cambio: ' + dinero(Math.max(0, r2(n - restaPedido()))) : ''; }
    renderResumen();
  };
  PD.anticipoMetodo = function (m) { S.anticipoMetodo = m; renderResumen(); renderCobro(); };

  PD.pago = function (m) { S.pago = m; if (m === 'credito') S.adelanto = 'ninguno'; renderResumen(); renderCobro(); };
  PD.pagaCon = function (v) {
    S.pagaCon = v;
    const c = $('pdCambio');
    if (c) { const n = Number(v); c.textContent = n > 0 ? 'cambio: ' + dinero(Math.max(0, r2(n - restaPedido()))) : ''; }
  };

  function renderBotones() {
    const el = $('pdBotones');
    if (!el || !S) return;
    const prog = S.cuando === 'programar';
    el.innerHTML = `
      <span class="pd-imprimir" style="color:var(--muted,#7A7D83); cursor:default">🖨 El ticket se imprime en Mostrador cuando el pedido esté listo</span>
      <span class="pd-pie-total">Total <span id="pdPieTotal">${dinero(totalPedido())}</span></span>
      <button type="button" class="btn btn-secondary" id="pdBtnGuardar" onclick="PedidoDom.enviar(false)" ${S.enviando ? 'disabled' : ''}>📝 Guardar sin enviar</button>
      <button type="button" class="btn btn-primary" id="pdBtnEnviar" onclick="PedidoDom.enviar(true)" ${S.enviando ? 'disabled' : ''}>${prog ? '📅 Programar pedido' : '✓ Enviar pedido a preparar'}</button>`;
  }

  function mostrarError(msg) {
    const e = $('pdError');
    if (!e) return;
    e.textContent = msg || '';
    e.classList.toggle('visible', !!msg);
  }

  // ------------------------------------------------------------------ validar y mandar
  function validar() {
    if (!carritoActual().length) return 'El ticket está vacío: agrega productos.';
    if (!S.cliente) {
      if (!lleno(S.nuevoNombre)) return S.modoCliente === 'nuevo' ? 'Escribe el nombre del cliente.' : 'Busca al cliente o crea uno nuevo.';
    }
    const dig = String(S.telefono || '').replace(/\D/g, '');
    if (S.tipo === 'domicilio' && dig.length < 8) return 'Pon el teléfono del cliente (el repartidor puede necesitar llamarle).';
    if (S.tipo === 'domicilio' && !lleno(S.dir.calle)) return 'Escribe la calle y número de la dirección.';
    if (S.pago === 'credito' && !S.cliente) return 'Para vender a crédito elige un cliente guardado.';
    if (S.cuando === 'programar') {
      if (!S.fecha || !S.hora) return 'Elige el día y la hora de entrega.';
      const prog = new Date(`${S.fecha}T${S.hora}`);
      if (isNaN(prog.getTime())) return 'La fecha u hora no es válida.';
      if (prog.getTime() < Date.now() - 60000) return 'Esa hora ya pasó. Elige una hora que todavía no llega.';
    }
    if (S.pagaCon !== '' && !(Number(S.pagaCon) >= 0)) return 'Revisa con cuánto paga el cliente.';
    if (S.adelanto === 'anticipo') {
      const a = r2(Number(S.anticipoMonto));
      if (!(a > 0)) return 'Escribe cuánto dejó de anticipo (o elige «No ha pagado nada»).';
      if (a > totalPedido()) return `El anticipo (${dinero(a)}) no puede ser mayor que el total del pedido (${dinero(totalPedido())}).`;
      if (a === totalPedido()) return 'El anticipo es igual al total: elige «Ya pagó todo».';
    }
    return '';
  }

  function construirCuerpo(enviarAhora) {
    const cuerpo = {
      items: carritoActual().map((it) => { const { _precio_normal, ...limpio } = it; return limpio; }),
      tipo: S.tipo, pago_modo: S.pago, enviar: enviarAhora, notas: lleno(S.notas) ? S.notas.trim() : undefined
    };
    if (S.cliente) {
      cuerpo.cliente_id = S.cliente.id;
      if (lleno(S.telefono) && S.telefono.trim() !== String(S.cliente.telefono || '').trim()) cuerpo.telefono = S.telefono.trim();
    } else {
      cuerpo.nombre_contacto = S.nuevoNombre.trim();
      cuerpo.telefono = lleno(S.telefono) ? S.telefono.trim() : undefined;
      cuerpo.guardar_cliente = !!S.guardarCliente;
    }
    if (S.tipo === 'domicilio') {
      if (S.dirSel !== 'nueva' && !dirModificada()) cuerpo.direccion_id = S.dirSel;
      else {
        const d = S.dir;
        cuerpo.direccion = {
          alias: d.alias, calle: d.calle, colonia: d.colonia, cp: d.cp, ciudad: d.ciudad, referencias: d.referencias,
          latitud: d.latitud, longitud: d.longitud, ubicacion_enlace: d.ubicacion_enlace, zona_id: S.zonaId
        };
      }
      if (S.zonaId) cuerpo.zona_id = S.zonaId;
      if (S.envioForzado !== null && S.envioForzado !== undefined) cuerpo.costo_envio = S.envioForzado;
      if (lleno(S.repartidorId)) cuerpo.repartidor_id = Number(S.repartidorId);
      if (S.pago === 'al_recibir' && S.adelanto !== 'todo' && lleno(S.pagaCon)) cuerpo.paga_con = Number(S.pagaCon);
    }
    if (S.adelanto === 'anticipo') { cuerpo.anticipo = r2(Number(S.anticipoMonto)); cuerpo.anticipo_metodo = S.anticipoMetodo; }
    else if (S.adelanto === 'todo') { cuerpo.ya_pago_todo = true; cuerpo.anticipo_metodo = S.anticipoMetodo; }
    if (S.cuando === 'programar') cuerpo.programado_para = `${S.fecha}T${S.hora}`;
    return cuerpo;
  }

  PD.enviar = async function (enviarAhora) {
    if (!S || S.enviando) return;
    const problema = validar();
    if (problema) { mostrarError(problema); return; }
    mostrarError('');
    S.enviando = true; renderBotones();
    try {
      const p = await apiFetch('/pedidos', { method: 'POST', body: JSON.stringify(construirCuerpo(enviarAhora)) });
      S.exito = p;
      // Ya no se imprime aquí: el ticket sale cuando Mostrador termina de preparar el pedido (js/mostrador-pedidos.js).
      carrito = [];
      if (typeof renderCarrito === 'function') renderCarrito();
      mostrarExito(p);
    } catch (err) {
      const sinInternet = typeof esErrorDeConexion === 'function' && esErrorDeConexion(err);
      mostrarError(sinInternet ? 'Sin internet: los pedidos necesitan conexión. Para vender ahorita usa el modo Mostrador.' : (err.message || 'No se pudo crear el pedido'));
    } finally {
      if (S) { S.enviando = false; if (!S.exito) renderBotones(); }
    }
  };

  function mostrarExito(p) {
    $('pdCuerpo').style.display = 'none';
    $('pdPie').style.display = 'none';
    const ex = $('pdExito');
    ex.style.display = 'grid';
    const total = p.total_neto !== null && p.total_neto !== undefined ? p.total_neto : p.ticket_total;
    let linea;
    if (p.estado === 'programado' && !lleno(p.preparar_desde)) linea = 'Quedó guardado sin enviar. Cuando esté listo para preparar, inícialo desde el tablero.';
    else if (p.estado === 'programado') linea = `Programado para ${fechaBonita(String(p.programado_para).slice(0, 10))} a las ${horaBonita(String(p.programado_para).slice(11, 16))}. Se avisa en el tablero a las ${horaBonita(String(p.preparar_desde).slice(11, 16))} para prepararlo.`;
    else linea = 'Ya le apareció a Mostrador para prepararlo. El ticket se imprime cuando esté listo.';
    const tel = p.telefono || '';
    const msg = `Hola ${p.nombre_contacto || ''}, recibimos tu pedido ${p.etiqueta} por ${dinero(total)}. ` + (p.estado === 'programado' && lleno(p.programado_para) ? `Lo ${p.tipo === 'recoger' ? 'tendremos listo' : 'entregaremos'} ${fechaBonita(String(p.programado_para).slice(0, 10))} a las ${horaBonita(String(p.programado_para).slice(11, 16))}. ` : 'Ya lo estamos preparando. ') + '¡Gracias!';
    const wa = UBICACION.urlWhatsApp(tel, msg);
    ex.innerHTML = `<div class="pd-exito"><div class="grande">✅</div><h3>Pedido ${esc(p.etiqueta)} creado</h3>
      <p><b>${esc(p.nombre_contacto || '')}</b> · ${dinero(total)} · ticket ${esc(p.folio)}</p>
      ${Number(p.anticipo) > 0 ? `<p>💰 ${Number(p.resta) > 0 ? `Dejó anticipo de <b>${dinero(p.anticipo)}</b> (${esc(p.anticipo_metodo || 'efectivo')}) · falta cobrar <b>${dinero(p.resta)}</b>` : `<b>Ya pagó todo</b> (${esc(p.anticipo_metodo || 'efectivo')}) · no hay nada que cobrar`}</p>` : ''}
      <p>${esc(linea)}</p>
      <div class="acciones">
        ${wa ? `<a class="btn btn-secondary" href="${esc(wa)}" target="_blank" rel="noopener">💬 Confirmar por WhatsApp</a>` : ''}
        <a class="btn btn-secondary" href="pedidos.html">📋 Ver el tablero</a>
        <button type="button" class="btn btn-primary" onclick="PedidoDom.cerrar()">＋ Hacer otro pedido</button>
      </div></div>`;
  }

  PD._estado = () => S;
  window.PedidoDom = PD;

  // Si llegan desde el tablero con "＋ Nuevo pedido": mostrador.html?modo=domicilio
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#modoVenta button').forEach((b) => b.addEventListener('click', () => PD.setModo(b.dataset.modo)));
    const m = new URLSearchParams(location.search).get('modo');
    if (m === 'domicilio' || m === 'recoger') PD.setModo(m);
  });
})();
