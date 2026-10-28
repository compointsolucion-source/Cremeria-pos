// Pantalla de Pedidos: tablero de hoy, detalle del pedido, repartidores, agenda de mañana y de la semana.
// (Pedidos fijos, zonas, ajustes, liquidación, reporte, ruta y hoja de producción viven en pedidos-extra.js.)
requiereLogin();
const usuarioPedidos = getUsuario();
if (usuarioPedidos && usuarioPedidos.rol === 'repartidor') window.location.replace('repartidor.html');

const PT = (function () {
  'use strict';

  // ------------------------------------------------------------------ utilidades
  const esc = (t) => String(t === undefined || t === null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dinero = (n) => { const v = Number(n) || 0; return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const lleno = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  // Solo se abre como enlace si empieza con http:// o https:// (así un "javascript:..." no se ejecuta). Si no, devuelve ''.
  const enlaceSeguro = (v) => { const t = String(v === undefined || v === null ? '' : v).trim(); return /^https?:\/\//i.test(t) ? t : ''; };
  const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const esAdmin = ['dueno', 'gerente', 'jefe_general'].includes((usuarioPedidos || {}).rol);
  const primerNombre = (n) => String(n || '').trim().split(/\s+/)[0] || '';
  const iniciales = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

  function sumarDias(iso, n) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function fechaLarga(iso) {
    const d = new Date(iso + 'T12:00:00Z');
    return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
  }
  function fechaBonita(iso) {
    if (iso === E.hoy) return 'hoy';
    if (E.hoy && iso === sumarDias(E.hoy, 1)) return 'mañana';
    return fechaLarga(iso);
  }
  // 'YYYY-MM-DDTHH:MM' o 'HH:MM' -> '4:30 pm'
  function hora12(ts) {
    const m = /(\d{2}):(\d{2})/.exec(String(ts || ''));
    if (!m) return '';
    const h = Number(m[1]);
    return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'pm' : 'am'}`;
  }
  // Marcas de tiempo del servidor (NOW()) -> hora local de este dispositivo
  function horaLocal(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' }).replace(/\s?([ap])\.?\s?m\.?/i, (x, a) => ' ' + a.toLowerCase() + 'm');
  }

  const ESTADO_TXT = { programado: 'Programado', preparando: 'Preparando', listo: 'Listo', en_camino: 'En camino', entregado: 'Entregado', no_entregado: 'No entregado', cancelado: 'Cancelado' };

  // ------------------------------------------------------------------ ventanas
  const pila = [];
  // Mientras hay una ventana abierta se esconden los botones flotantes (tema y conexión) para que no tapen "Guardar" en el celular.
  const marcarHoja = () => document.body.classList.toggle('hoja-abierta', pila.length > 0 || !!document.querySelector('#pdOverlay.abierto'));
  function abrirModal({ titulo, ancho, cuerpo, pie, arriba }) {
    const ov = document.createElement('div');
    ov.className = 'pt-overlay abierto' + (arriba ? ' arriba' : '');
    ov.innerHTML = `<div class="pt-modal" style="--ancho:${ancho || 900}px" role="dialog" aria-modal="true">
      <div class="pt-modal-cab"><h2></h2><button type="button" class="pd-x" aria-label="Cerrar">✕</button></div>
      <div class="pt-modal-cuerpo"></div><div class="pt-modal-pie" style="display:none"></div></div>`;
    document.body.appendChild(ov);
    const m = {
      el: ov, cuerpo: ov.querySelector('.pt-modal-cuerpo'), pie: ov.querySelector('.pt-modal-pie'),
      titulo(t) { ov.querySelector('h2').innerHTML = t; },
      html(h) { m.cuerpo.innerHTML = h; },
      botones(h) { m.pie.style.display = h ? '' : 'none'; m.pie.innerHTML = h || ''; },
      cerrar() { const i = pila.indexOf(m); if (i >= 0) pila.splice(i, 1); ov.remove(); marcarHoja(); if (m.alCerrar) m.alCerrar(); }
    };
    m.titulo(titulo || '');
    if (cuerpo !== undefined) m.html(cuerpo);
    if (pie !== undefined) m.botones(pie);
    ov.querySelector('.pd-x').onclick = () => m.cerrar();
    pila.push(m);
    marcarHoja();
    return m;
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pila.length) pila[pila.length - 1].cerrar(); });

  async function avisoError(fn) {
    try { return await fn(); } catch (err) { mostrarToast(err.message || 'No se pudo completar', 'error'); return null; }
  }

  // ------------------------------------------------------------------ estado
  const E = { tab: 'hoy', hoy: null, pedidos: [], resumen: null, reps: [], agendaFecha: null, agenda: [], produccion: null, semana: [], fijos: [], zonas: null, verTodosEntregados: false };

  const COLUMNAS = [
    { id: 'programado', titulo: 'Programados', icono: '📅', estados: ['programado'] },
    { id: 'preparando', titulo: 'Preparando', icono: '👨‍🍳', estados: ['preparando'] },
    { id: 'listo', titulo: 'Listos', icono: '✅', estados: ['listo'] },
    { id: 'en_camino', titulo: 'En camino', icono: '🛵', estados: ['en_camino'] },
    { id: 'entregado', titulo: 'Entregados hoy', icono: '📦', estados: ['no_entregado', 'entregado'] }
  ];

  function tagPago(p) {
    if (p.pago_modo === 'credito') return ['credito', 'A crédito'];
    if (p.ticket_estado === 'pagado') return ['pagado', 'Pagado'];
    if (p.estado_cobro === 'pagado') return ['pagado', 'Ya pagó todo'];            // pagó por adelantado: solo falta registrarlo en Caja
    const resta = p.anticipo > 0 ? ` ${dinero(p.resta)}` : '';                      // con anticipo se ve cuánto FALTA
    const conAnticipo = p.anticipo > 0 ? ' (anticipo)' : '';
    if (p.tipo === 'domicilio' && p.pago_modo === 'al_recibir') return ['cobrar', p.estado === 'entregado' ? 'Por liquidar' : `Cobrar${resta}${conAnticipo}`];
    return ['cobrar', p.anticipo > 0 ? `Caja:${resta}${conAnticipo}` : 'Cobrar en caja'];
  }

  function textoEntrega(p) {
    const dia = p.fecha_entrega && p.fecha_entrega !== E.hoy ? fechaBonita(p.fecha_entrega) + ' ' : '';
    if (p.programado_para) return `${p.tipo === 'recoger' ? 'Recoge' : 'Entrega'} ${dia}${hora12(p.programado_para)}`;
    return dia ? `${p.tipo === 'recoger' ? 'Recoge' : 'Entrega'} ${dia.trim()}` : 'Lo antes posible';
  }

  function accionPrincipal(p) {
    switch (p.estado) {
      case 'programado': return { txt: '▶ Empezar a preparar', est: 'preparando' };
      case 'preparando': return { txt: p.tipo === 'recoger' ? '✓ Listo para recoger' : '✓ Listo para salir', est: 'listo' };
      case 'listo':
        if (p.tipo === 'recoger') return { txt: '📦 Ya lo recogió', est: 'entregado' };
        // El texto se pinta como HTML en el botón: el nombre va escapado.
        if (p.repartidor_id) return { txt: `🛵 Salió con ${esc(primerNombre(p.repartidor_nombre))}`, est: 'en_camino' };
        return { txt: '👤 Asignar repartidor', asignar: true };
      case 'en_camino': return { txt: '✔ Entregado', est: 'entregado' };
      case 'no_entregado': return { txt: '↩ Volver a "listo"', est: 'listo' };
      default: return null;
    }
  }

  // ------------------------------------------------------------------ carga de datos
  async function cargarHoy() {
    const r0 = await apiFetch('/pedidos/resumen');
    E.hoy = r0.fecha;
    const [pedidos, reps] = await Promise.all([apiFetch(`/pedidos?fecha=${E.hoy}&limit=800`), apiFetch('/pedidos/repartidores')]);
    E.resumen = r0; E.pedidos = pedidos; E.reps = reps;
    pintarHoy();
  }

  async function cargarAgenda() {
    if (!E.hoy) await cargarHoy();
    if (!E.agendaFecha) E.agendaFecha = sumarDias(E.hoy, 1);
    const f = E.agendaFecha;
    const [lista, prod] = await Promise.all([apiFetch(`/pedidos?desde=${f}&hasta=${f}&limit=800`), apiFetch(`/pedidos/produccion?fecha=${f}`)]);
    E.agenda = lista.filter((p) => p.estado !== 'cancelado'); E.produccion = prod;
    pintarAgenda();
  }

  async function cargarSemana() {
    if (!E.hoy) await cargarHoy();
    E.semana = (await apiFetch(`/pedidos?desde=${E.hoy}&hasta=${sumarDias(E.hoy, 6)}&limit=1000`)).filter((p) => p.estado !== 'cancelado');
    pintarSemana();
  }

  async function recargar() {
    try {
      if (E.tab === 'hoy') await cargarHoy();
      else if (E.tab === 'manana') await cargarAgenda();
      else if (E.tab === 'semana') await cargarSemana();
      else if (E.tab === 'fijos') await PTX.cargarFijos();
      vivo(true);
    } catch (err) {
      vivo(false);
      if (!esErrorDeConexion || !esErrorDeConexion(err)) mostrarToast(err.message || 'No se pudieron cargar los pedidos', 'error');
    }
  }

  function vivo(ok) {
    const el = $('indicadorVivo');
    if (!el) return;
    el.classList.toggle('sin', !ok);
    el.textContent = ok ? 'se actualiza solo, en vivo' : 'sin conexión — reintentando…';
  }

  // ------------------------------------------------------------------ pestañas
  function tab(nombre) {
    E.tab = nombre;
    document.querySelectorAll('.pt-tab').forEach((b) => b.classList.toggle('activo', b.dataset.tab === nombre));
    $('vistaHoy').style.display = nombre === 'hoy' ? '' : 'none';
    $('vistaManana').style.display = nombre === 'manana' ? '' : 'none';
    $('vistaSemana').style.display = nombre === 'semana' ? '' : 'none';
    $('vistaFijos').style.display = nombre === 'fijos' ? '' : 'none';
    if (nombre === 'manana') E.agendaFecha = E.hoy ? sumarDias(E.hoy, 1) : null;
    recargar();
  }

  function cambiarFechaAgenda(f) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return;
    E.agendaFecha = f;
    E.tab = 'manana';
    recargar();
  }

  function irADia(f) {
    E.tab = 'manana';
    document.querySelectorAll('.pt-tab').forEach((b) => b.classList.toggle('activo', b.dataset.tab === 'manana'));
    $('vistaHoy').style.display = 'none'; $('vistaSemana').style.display = 'none'; $('vistaFijos').style.display = 'none'; $('vistaManana').style.display = '';
    E.agendaFecha = f;
    recargar();
  }

  // ------------------------------------------------------------------ tablero de hoy
  function filtrados() {
    const q = norm($('filtroTexto').value);
    const t = $('filtroTipo').value;
    return E.pedidos.filter((p) => p.estado !== 'cancelado' && (t === 'todos' || p.tipo === t)
      && (!q || norm([p.nombre_contacto, p.etiqueta, p.folio, p.colonia, p.calle, p.telefono].join(' ')).includes(q)));
  }

  function tarjeta(p) {
    const [clasePago, textoPago] = tagPago(p);
    const acc = accionPrincipal(p);
    const prep = p.estado === 'programado'
      ? (lleno(p.preparar_desde) ? `<div class="pt-sub">Preparar a las ${hora12(p.preparar_desde)}${p.preparar_desde.slice(0, 10) !== E.hoy ? ' del ' + fechaLarga(p.preparar_desde.slice(0, 10)) : ''}</div>` : '<div class="pt-sub">Guardado sin enviar: tú decides cuándo empezar</div>')
      : '';
    const donde = p.tipo === 'recoger' ? 'Pasa a recoger' : (lleno(p.colonia) ? 'Col. ' + esc(p.colonia) : esc(p.calle || ''));
    const rep = p.tipo === 'recoger' ? '' : (p.repartidor_id ? `<span class="pt-rep"><i>${esc(iniciales(p.repartidor_nombre))}</i>${esc(primerNombre(p.repartidor_nombre))}</span>` : '<span class="pt-rep nadie">sin repartidor</span>');
    const extra = p.estado === 'no_entregado' && p.motivo_no_entrega ? `<div class="pt-sub">⚠ ${esc(p.motivo_no_entrega)}</div>` : '';
    return `<div class="pt-card e-${p.estado} ${p.retraso_min > 0 ? 'retraso' : ''}" onclick="PT.abrir(${p.id})">
      <div class="pt-card-top"><span class="pt-et">${esc(p.etiqueta)}</span>
        ${p.retraso_min > 0 ? `<span class="pt-t retraso">⚠ +${p.retraso_min} min</span>` : ''}
        ${p.tipo === 'recoger' ? '<span class="pt-t recoger">🏪 Recoger</span>' : ''}
        ${p.origen === 'fijo' ? '<span class="pt-t fijo">🔁 Fijo</span>' : ''}
        ${p.estado === 'no_entregado' ? '<span class="pt-t noent">No se entregó</span>' : `<span class="pt-t ${clasePago}">${textoPago}</span>`}</div>
      <div class="pt-nombre">${esc(p.nombre_contacto)}</div>
      <div class="pt-sub">${donde}${p.cliente_tipo === 'tienda' ? ' · tienda' : ''}</div>
      <div class="pt-hora">🕓 ${esc(textoEntrega(p))}</div>${prep}${extra}
      <div class="pt-pie-card"><b>${dinero(p.total_neto)}</b>${rep}</div>
      ${acc ? `<button type="button" class="btn ${p.estado === 'no_entregado' ? 'btn-secondary' : 'btn-primary'} pt-accion" onclick="event.stopPropagation(); PT.accion(${p.id}, ${acc.asignar ? "'asignar'" : `'${acc.est}'`})">${acc.txt}</button>` : ''}
    </div>`;
  }

  function panelRepartidores() {
    if (!E.reps.length) {
      return `<div class="pt-rep-card"><b>Sin repartidores</b><p>Crea un usuario con el rol <b>Repartidor</b> en Equipo para poder asignarle pedidos.</p><a class="btn btn-secondary" href="admin/equipo.html">Ir a Equipo</a></div>`;
    }
    return E.reps.map((r) => `<div class="pt-rep-card">
        <div class="cab"><span class="av">${esc(iniciales(r.nombre))}</span><b>${esc(r.nombre)}</b><span class="pt-t ${r.estado === 'en_ruta' ? 'cobrar' : 'pagado'}">${r.estado === 'en_ruta' ? 'En ruta' : 'Libre'}</span></div>
        <p><b>${r.en_camino}</b> en la mano · <b>${r.por_salir}</b> por salir · <b>${r.entregas_hoy}</b> entregas hoy</p>
        ${r.trae_por_cobrar > 0 ? `<p>Trae por cobrar: <b>${dinero(r.trae_por_cobrar)}</b></p>` : ''}
        ${r.por_entregar_a_caja > 0 ? `<p>Ya cobrado, sin entregar a caja: <b>${dinero(r.por_entregar_a_caja)}</b></p>` : ''}
        ${r.pedidos_por_liquidar > 0 ? `<button type="button" class="btn btn-primary" onclick="PTX.liquidar(${r.id})">💵 Liquidar a ${esc(primerNombre(r.nombre))}${r.por_entregar_a_caja > 0 ? ' · ' + dinero(r.por_entregar_a_caja) : ''}</button>` : ''}
      </div>`).join('');
  }

  function pintarHoy() {
    const k = E.resumen || {};
    $('kpis').innerHTML = `
      <div class="pt-kpi"><b>${k.pedidos_dia || 0}</b><span>Pedidos de hoy</span></div>
      <div class="pt-kpi"><b>${k.en_camino || 0}</b><span>En camino ahora</span></div>
      <div class="pt-kpi ambar"><b>${dinero(k.por_cobrar)}</b><span>Por cobrar (con repartidores)</span></div>
      <div class="pt-kpi ${k.con_retraso ? 'rojo' : ''}"><b>${k.con_retraso || 0}</b><span>Con retraso</span></div>
      <div class="pt-kpi"><b>${dinero(k.entregado_hoy)}</b><span>Entregado hoy</span></div>`;
    const lista = filtrados();
    let h = '';
    COLUMNAS.forEach((c) => {
      let items = lista.filter((p) => c.estados.includes(p.estado));
      if (c.id === 'entregado') {
        items.sort((a, b) => (a.estado === b.estado ? String(b.entregado_en || '').localeCompare(String(a.entregado_en || '')) : (a.estado === 'no_entregado' ? -1 : 1)));
      }
      const total = items.length;
      if (c.id === 'entregado' && !E.verTodosEntregados) items = items.slice(0, 8);
      h += `<div class="pt-col"><h3><span>${c.icono} ${c.titulo}</span><span class="n">${total}</span></h3>`
        + (items.length ? items.map(tarjeta).join('') : '<div class="pt-vacia">Nada por aquí</div>')
        + (c.id === 'entregado' && total > 8 ? `<div class="pt-mas"><a class="pd-link" onclick="PT.verTodosEntregados()">${E.verTodosEntregados ? 'Ver menos' : `+ ${total - 8} más · ver todos`}</a></div>` : '')
        + '</div>';
    });
    h += `<div class="pt-reps"><h3>Repartidores ahora</h3>${panelRepartidores()}</div>`;
    $('tablero').innerHTML = h;
  }

  // ------------------------------------------------------------------ agenda (mañana u otro día) y semana
  function filaAgenda(p) {
    const [clasePago, textoPago] = tagPago(p);
    return `<div class="pt-fila-ped" onclick="PT.abrir(${p.id})"><div class="h">${p.programado_para ? hora12(p.programado_para) : 'ASAP'}</div>
      <div><span class="n">${esc(p.nombre_contacto)}</span> ${p.origen === 'fijo' ? '<span class="pt-t fijo">🔁 fijo</span>' : ''} ${p.tipo === 'recoger' ? '<span class="pt-t recoger">recoger</span>' : ''}
        <small>${p.tipo === 'recoger' ? 'Pasa a recoger' : esc([p.colonia ? 'Col. ' + p.colonia : '', p.calle].filter(Boolean).join(' · '))} · ${esc(ESTADO_TXT[p.estado] || p.estado)}${p.repartidor_nombre ? ' · ' + esc(primerNombre(p.repartidor_nombre)) : ''}</small></div>
      <div class="d">${dinero(p.total_neto)}<br><span class="pt-t ${clasePago}">${textoPago}</span></div></div>`;
  }

  function pintarAgenda() {
    const f = E.agendaFecha;
    $('fechaAgenda').value = f;
    $('tituloAgenda').textContent = `${f === E.hoy ? 'Hoy' : f === sumarDias(E.hoy, 1) ? 'Mañana' : 'Pedidos'} · ${fechaLarga(f)}`;
    const l = E.agenda.slice().sort((a, b) => String(a.programado_para || '').localeCompare(String(b.programado_para || '')));
    $('listaAgenda').innerHTML = l.length ? l.map(filaAgenda).join('') : '<div class="pt-vacia" style="padding:30px">No hay pedidos para este día. Usa “＋ Programar pedido” o crea un pedido fijo.</div>';
    const pr = E.produccion;
    $('resumenProduccion').innerHTML = pr && pr.productos.length
      ? `<ul class="pt-linea">${pr.productos.map((x) => `<li><span>${esc(x.nombre)}<br><small style="color:var(--muted)">${x.pedidos} ${x.pedidos === 1 ? 'pedido' : 'pedidos'}</small></span><b>${x.tipo_venta === 'peso' ? PTX.kg(x.cantidad) + ' kg' : x.cantidad + ' pza'}</b></li>`).join('')}</ul>`
      : '<div class="pt-vacia">Sin productos por preparar ese día.</div>';
  }

  function pintarSemana() {
    $('tituloSemana').textContent = `Semana del ${fechaLarga(E.hoy)} al ${fechaLarga(sumarDias(E.hoy, 6))}`;
    let h = '';
    for (let i = 0; i < 7; i++) {
      const f = sumarDias(E.hoy, i);
      const dia = E.semana.filter((p) => p.fecha_entrega === f).sort((a, b) => String(a.programado_para || '').localeCompare(String(b.programado_para || '')));
      h += `<div class="pt-dia ${i === 0 ? 'hoy' : ''}"><div class="pt-dia-cab" onclick="PT.irADia('${f}')">${fechaLarga(f)}<small>${dia.length} ${dia.length === 1 ? 'pedido' : 'pedidos'}</small></div><div class="pt-dia-cuerpo">`
        + (dia.length ? dia.map((p) => `<button type="button" class="pt-chip-ped ${p.origen === 'fijo' ? 'fijo' : i === 0 ? 'hoy' : ''} ${['entregado', 'no_entregado'].includes(p.estado) ? 'hecho' : ''}" onclick="PT.abrir(${p.id})"><b>${p.programado_para ? hora12(p.programado_para) : 'Pronto'}</b>${esc(p.nombre_contacto)}<br>${dinero(p.total_neto)}</button>`).join('') : '<div class="pt-vacia">—</div>')
        + '</div></div>';
    }
    $('semana').innerHTML = h;
  }

  // ------------------------------------------------------------------ acciones sobre un pedido
  async function pedirMetodoCobro(p) {
    return new Promise((resolve) => {
      const m = abrirModal({ titulo: `¿Cómo pagó ${esc(p.nombre_contacto)}?`, ancho: 420, arriba: true,
        cuerpo: `<p style="margin:0 0 12px">${p.anticipo > 0 ? `Total ${dinero(p.total_neto)} − anticipo ${dinero(p.anticipo)} = a cobrar` : 'Total a cobrar'}: <b>${dinero(p.resta)}</b>${p.paga_con ? ` · pagó con ${dinero(p.paga_con)} (cambio ${dinero(p.cambio)})` : ''}</p>
          <div style="display:grid; gap:8px;">
            <button type="button" class="btn btn-primary" data-m="efectivo">💵 Efectivo</button>
            <button type="button" class="btn btn-secondary" data-m="transferencia">🏦 Transferencia</button>
            <button type="button" class="btn btn-secondary" data-m="tarjeta">💳 Tarjeta</button></div>` });
      m.cuerpo.querySelectorAll('button[data-m]').forEach((b) => { b.onclick = () => { m.alCerrar = null; m.cerrar(); resolve(b.dataset.m); }; });
      m.alCerrar = () => resolve(null);
    });
  }

  async function elegirRepartidor(pedido) {
    if (!E.reps.length) { E.reps = await apiFetch('/pedidos/repartidores').catch(() => []); }
    return new Promise((resolve) => {
      if (!E.reps.length) { mostrarToast('Todavía no hay repartidores: crea uno en Equipo (rol Repartidor)', 'error'); resolve(null); return; }
      const yaEntregado = pedido.estado === 'entregado';
      const m = abrirModal({ titulo: `${yaEntregado ? 'Cambiar repartidor' : 'Asignar repartidor'} · ${esc(pedido.etiqueta)}`, ancho: 440, arriba: true,
        cuerpo: `<div style="display:grid; gap:8px;">${E.reps.map((r) => `<button type="button" class="btn ${pedido.repartidor_id === r.id ? 'btn-primary' : 'btn-secondary'}" style="justify-content:space-between" data-r="${r.id}"><span>${esc(r.nombre)}</span><small>${r.estado === 'en_ruta' ? 'en ruta (' + r.en_camino + ')' : 'libre'}</small></button>`).join('')}
          ${yaEntregado ? '<div class="pt-sub">Elige quién SÍ entregó este pedido.</div>' : '<button type="button" class="btn btn-secondary" data-r="">Quitar repartidor (que lo tome el que esté libre)</button>'}</div>` });
      m.cuerpo.querySelectorAll('button[data-r]').forEach((b) => { b.onclick = () => { m.alCerrar = null; m.cerrar(); resolve(b.dataset.r === '' ? 0 : Number(b.dataset.r)); }; });
      m.alCerrar = () => resolve(null);
    });
  }

  async function asignar(id) {
    const p = await apiFetch(`/pedidos/${id}`);
    const rid = await elegirRepartidor(p);
    if (rid === null) return null;
    const r = await avisoError(() => apiFetch(`/pedidos/${id}/asignar`, { method: 'POST', body: JSON.stringify({ repartidor_id: rid || null }) }));
    if (r) { mostrarToast(rid ? `Asignado a ${r.repartidor_nombre}` : 'Repartidor quitado', 'exito'); recargar(); }
    return r;
  }

  async function accion(id, est) {
    if (est === 'asignar') { await asignar(id); return; }
    let p = E.pedidos.find((x) => x.id === id) || E.agenda.find((x) => x.id === id) || E.semana.find((x) => x.id === id);
    if (!p) p = await avisoError(() => apiFetch(`/pedidos/${id}`));
    if (!p) return;
    const cuerpo = { estado: est };
    if (est === 'en_camino' && !p.repartidor_id) {
      const r = await asignar(id);
      if (!r || !r.repartidor_id) return;
      p = r;
    }
    if (est === 'entregado' && p.tipo === 'domicilio' && p.pago_modo === 'al_recibir') {
      if (!p.repartidor_id) { mostrarToast('Asigna un repartidor para poder registrar el cobro', 'error'); await asignar(id); return; }
      const metodo = await pedirMetodoCobro(p);
      if (!metodo) return;
      cuerpo.metodo_cobro = metodo;
    }
    const r = await avisoError(() => apiFetch(`/pedidos/${id}/estado`, { method: 'POST', body: JSON.stringify(cuerpo) }));
    if (r) {
      mostrarToast(`${r.etiqueta}: ${ESTADO_TXT[r.estado].toLowerCase()}`, 'exito');
      recargar();
      return r;
    }
  }

  async function noEntregado(id) {
    const motivo = await solicitarTexto('¿Por qué no se pudo entregar? (ej. no estaba, dirección incorrecta)');
    if (!motivo) return null;
    const r = await avisoError(() => apiFetch(`/pedidos/${id}/estado`, { method: 'POST', body: JSON.stringify({ estado: 'no_entregado', motivo }) }));
    if (r) { mostrarToast('Se marcó como no entregado', 'exito'); recargar(); }
    return r;
  }

  async function cancelar(id, p) {
    const entregado = !!p && p.estado === 'entregado';
    const anticipo = p && p.anticipo > 0 ? ` Dejó un anticipo de ${dinero(p.anticipo)}: recuerda devolvérselo al cliente.` : '';
    const ok = await confirmarAccion((entregado
      ? '¿Cancelar este pedido que ya se entregó? El ticket también se cancela y el dinero que cobró el repartidor deja de contar.'
      : '¿Cancelar este pedido? El ticket también se cancela.') + anticipo);
    if (!ok) return null;
    const motivo = await solicitarTexto(entregado ? '¿Por qué se cancela? (obligatorio)' : '¿Por qué se cancela? (opcional)');
    if (entregado && !(motivo || '').trim()) { mostrarToast('Escribe el motivo para poder cancelarlo', 'error'); return null; }
    const r = await avisoError(() => apiFetch(`/pedidos/${id}/estado`, { method: 'POST', body: JSON.stringify({ estado: 'cancelado', motivo: motivo || '' }) }));
    if (r) { mostrarToast('Pedido cancelado', 'exito'); recargar(); }
    return r;
  }

  // Dueño/gerente: el pedido se marcó «Entregado» por error → regresa a «En camino» (o «Listo») sin cobro registrado.
  async function deshacerEntrega(p) {
    const repValido = (E.reps || []).some((r) => r.id === p.repartidor_id);   // un repartidor de verdad (no el dueño)
    const destino = p.tipo === 'domicilio' && repValido ? 'En camino' : 'Listo';
    const sinRep = p.tipo === 'domicilio' && p.repartidor_id && !repValido ? ' Como ese usuario no es repartidor, queda sin repartidor para que lo asignes bien.' : '';
    const cobro = p.metodo_cobro ? ` Se borra el cobro que se había registrado (${p.metodo_cobro} ${dinero(p.monto_cobrado)}).` : '';
    if (!(await confirmarAccion(`¿Deshacer la entrega de ${p.etiqueta}? El pedido regresa a «${destino}».${cobro}${sinRep}`))) return null;
    const r = await avisoError(() => apiFetch(`/pedidos/${p.id}/deshacer-entrega`, { method: 'POST' }));
    if (r) { mostrarToast('Entrega deshecha: el pedido regresó a «' + (ESTADO_TXT[r.estado] || r.estado) + '»', 'exito'); recargar(); }
    return r;
  }

  // ------------------------------------------------------------------ mensajes de WhatsApp
  function mensajeCliente(p) {
    const n = primerNombre(p.nombre_contacto);
    if (p.estado === 'en_camino') return `Hola ${n}, tu pedido ${p.etiqueta} ya va en camino${p.repartidor_nombre ? ' con ' + primerNombre(p.repartidor_nombre) : ''}. ` + (p.por_cobrar ? `Total a pagar: ${dinero(p.total_neto)}. ` : '') + '¡Gracias!';
    if (p.estado === 'listo' && p.tipo === 'recoger') return `Hola ${n}, tu pedido ${p.etiqueta} ya está listo para recoger. Total: ${dinero(p.total_neto)}. ¡Te esperamos!`;
    if (p.estado === 'listo') return `Hola ${n}, tu pedido ${p.etiqueta} ya está listo y saldrá en unos minutos. ¡Gracias!`;
    if (p.programado_para) return `Hola ${n}, confirmamos tu pedido ${p.etiqueta} por ${dinero(p.total_neto)} para ${fechaBonita(p.programado_para.slice(0, 10))} a las ${hora12(p.programado_para)}. ¡Gracias!`;
    return `Hola ${n}, recibimos tu pedido ${p.etiqueta} por ${dinero(p.total_neto)}. Ya lo estamos preparando. ¡Gracias!`;
  }

  function mensajeRepartidor(p) {
    const items = (p.items || []).filter((i) => !i.es_envio).map((i) => `• ${typeof GRANEL !== 'undefined' ? GRANEL.formatoCantidad(i.cantidad) : i.cantidad}${i.tipo_venta === 'peso' ? ' kg' : ''} ${i.nombre_producto}`).join('\n');
    const url = UBICACION.urlWaze(p);
    return `🛵 Pedido ${p.etiqueta}\nCliente: ${p.nombre_contacto}${p.telefono ? ' · ' + p.telefono : ''}\nDirección: ${UBICACION.textoDireccion(p)}${p.referencias ? '\nRef.: ' + p.referencias : ''}\nWaze: ${url}\n${p.programado_para ? 'Hora: ' + hora12(p.programado_para) + '\n' : ''}${items ? 'Lleva:\n' + items + '\n' : ''}`
      + (p.por_cobrar ? `💵 COBRAR: ${dinero(p.resta)}${p.anticipo > 0 ? ` (total ${dinero(p.total_neto)}, ya dejó ${dinero(p.anticipo)} de anticipo)` : ''}${p.paga_con ? ` (paga con ${dinero(p.paga_con)}, cambio ${dinero(p.cambio)})` : ''}`
        : p.estado_cobro === 'pagado' ? '✔ No cobrar: ya está pagado'
        : p.estado_cobro === 'credito' ? '✔ No cobrar: va a crédito del cliente'
        : '✔ No cobrar: se cobra en Caja') + (p.notas ? `\nNotas: ${p.notas}` : '');
  }

  // ------------------------------------------------------------------ detalle del pedido
  const editables = ['programado', 'preparando', 'listo', 'no_entregado'];

  async function abrir(id) {
    const p = await avisoError(() => apiFetch(`/pedidos/${id}`));
    if (!p) return;
    const m = abrirModal({ titulo: '', ancho: 940 });
    pintarDetalle(m, p);
  }

  function pintarDetalle(m, p) {
    const [clasePago, textoPago] = tagPago(p);
    m.titulo(`${esc(p.etiqueta)} · ${esc(ESTADO_TXT[p.estado] || p.estado)} <span class="pt-t ${clasePago}" style="margin-left:8px">${textoPago}</span>${p.tipo === 'recoger' ? ' <span class="pt-t recoger">🏪 recoger</span>' : ''}${p.origen === 'fijo' ? ' <span class="pt-t fijo">🔁 fijo</span>' : ''}`);
    const tel = lleno(p.telefono) ? `<div class="pt-botonera"><a class="btn btn-secondary" href="${esc(UBICACION.urlLlamar(p.telefono) || '#')}">📞 Llamar</a><a class="btn btn-secondary" target="_blank" rel="noopener" href="${esc(UBICACION.urlWhatsApp(p.telefono) || '#')}">💬 WhatsApp</a></div>` : '';
    const direccion = p.tipo === 'domicilio' ? `
      <div class="pt-bloque"><h4>Dirección de entrega</h4>
        <div style="font-weight:700">${esc(UBICACION.textoDireccion(p) || 'Sin dirección')}</div>
        ${p.referencias ? `<div class="pt-sub">Ref.: ${esc(p.referencias)}</div>` : ''}
        ${p.zona_nombre ? `<div class="pt-sub">Zona: ${esc(p.zona_nombre)} · envío ${dinero(p.costo_envio)}</div>` : ''}
        <div class="pt-botonera"><a class="btn btn-secondary" style="background:#33CCFF;border-color:#33CCFF;color:#06303d" target="_blank" rel="noopener" href="${esc(UBICACION.urlWaze(p))}">🧭 Waze</a>
          <a class="btn btn-secondary" target="_blank" rel="noopener" href="${esc(UBICACION.urlGoogleMaps(p))}">🗺 Google Maps</a>
          ${enlaceSeguro(p.ubicacion_enlace) ? `<a class="btn btn-secondary" target="_blank" rel="noopener" href="${esc(enlaceSeguro(p.ubicacion_enlace))}">📍 Ubicación del cliente</a>` : ''}</div></div>` : '';
    const repartidor = p.tipo === 'domicilio' ? `<div class="pt-dato"><span>Repartidor</span><span>${p.repartidor_id ? esc(p.repartidor_nombre) : 'Sin asignar'}</span></div>` : '';
    const lineas = (p.items || []).map((i) => `<li><span>${esc(i.nombre_producto)}<br><small style="color:var(--muted)">${i.es_envio ? (p.zona_nombre ? 'Zona: ' + esc(p.zona_nombre) : 'Costo de envío') : esc(typeof GRANEL !== 'undefined' ? GRANEL.detalle(i, '×') : i.cantidad)}</small></span><b>${dinero(i.subtotal)}</b></li>`).join('');
    const hist = [['Pedido creado', horaLocal(p.creado_en)], ['Aceptado en Mostrador' + (p.aceptado_por_nombre ? ' por ' + esc(primerNombre(p.aceptado_por_nombre)) : ''), horaLocal(p.aceptado_en)], ['Listo', horaLocal(p.listo_en)], ['Salió', horaLocal(p.salio_en)], ['Llegó', horaLocal(p.llego_en)], ['Entregado', horaLocal(p.entregado_en)], ['Aviso al cliente', horaLocal(p.aviso_camino_en)]]
      .filter((x) => x[1]).map((x) => `<div><b>${x[0]}:</b> ${x[1]}</div>`).join('');
    const evid = (p.evidencias || []).map((e) => `<button type="button" class="btn btn-secondary" onclick="PT.verEvidencia(${p.id}, ${e.id})">${e.tipo === 'foto' ? '📷 Ver foto de entrega' : '✍ Ver firma'}</button>`).join('');
    const acc = accionPrincipal(p);
    // Un pedido ya entregado lo corrige el dueño/gerente, mientras el repartidor no haya liquidado en Caja.
    const corregible = esAdmin && p.estado === 'entregado' && !p.liquidacion_id;
    const filasAnticipo = p.anticipo > 0
      ? `<div class="pt-dato"><span>${p.resta > 0 ? 'Anticipo' : 'Pagó por adelantado'}</span><span>${dinero(p.anticipo)} (${esc(p.anticipo_metodo || 'efectivo')})</span></div>${p.resta > 0 ? `<div class="pt-dato"><span>Resta por cobrar</span><span><b>${dinero(p.resta)}</b></span></div>` : ''}` : '';
    const cobro = filasAnticipo + (p.tipo === 'domicilio' && p.pago_modo === 'al_recibir'
      ? `${p.paga_con ? `<div class="pt-dato"><span>Paga con</span><span>${dinero(p.paga_con)} (cambio ${dinero(p.cambio)})</span></div>` : ''}${p.metodo_cobro ? `<div class="pt-dato"><span>Cobró</span><span>${esc(p.metodo_cobro)} ${dinero(p.monto_cobrado)}</span></div>` : ''}` : '');
    m.html(`<div class="pt-dos"><div>
        <div class="pt-bloque"><h4>Cliente</h4><div style="font-weight:800; font-size:17px">${esc(p.nombre_contacto)}${p.cliente_tipo === 'tienda' ? ' <span class="pd-tag azul">Tienda</span>' : ''}</div>
          <div class="pt-sub">${esc(p.telefono || 'Sin teléfono')}</div>${tel}</div>
        ${direccion}
        <div class="pt-bloque"><h4>Entrega</h4>
          <div class="pt-dato"><span>${p.tipo === 'recoger' ? 'Recoge' : 'Entrega'}</span><span>${esc(textoEntrega(p))}</span></div>
          ${p.estado === 'programado' && lleno(p.preparar_desde) ? `<div class="pt-dato"><span>Se empieza a preparar</span><span>${hora12(p.preparar_desde)}</span></div>` : ''}
          ${repartidor}
          ${p.notas ? `<div class="pt-dato"><span>Notas</span><span>${esc(p.notas)}</span></div>` : ''}
          ${p.motivo_no_entrega ? `<div class="pt-dato"><span>No se entregó porque</span><span>${esc(p.motivo_no_entrega)}</span></div>` : ''}
          ${p.motivo_cancelacion ? `<div class="pt-dato"><span>Cancelado porque</span><span>${esc(p.motivo_cancelacion)}</span></div>` : ''}
          ${esAdmin && p.estado === 'entregado' && p.liquidacion_id ? '<div class="pt-sub">ℹ️ Ya se liquidó en Caja: para corregir el dinero usa Devoluciones.</div>' : ''}
          ${corregible && p.ticket_estado === 'pagado' ? '<div class="pt-sub">ℹ️ El ticket ya está pagado en Caja: para cancelarlo y regresar el dinero usa Devoluciones.</div>' : ''}
          ${p.tipo === 'domicilio' && (editables.concat(['en_camino']).includes(p.estado) || corregible) ? '<div class="pt-botonera"><button type="button" class="btn btn-secondary" id="dtAsignar">👤 Cambiar repartidor</button>' + (lleno(p.repartidor_telefono) ? '<a class="btn btn-secondary" id="dtWaRep" target="_blank" rel="noopener">📲 Mandarle el pedido por WhatsApp</a>' : '') + '</div>' : ''}
        </div>
      </div><div>
        <div class="pt-bloque"><h4>Pedido · ticket ${esc(p.folio)}</h4><ul class="pt-linea">${lineas}</ul>
          <div class="pt-dato" style="border-top:2px solid var(--text); margin-top:6px; padding-top:8px; font-size:19px"><span style="color:var(--text); font-weight:800">Total</span><span>${dinero(p.total_neto)}</span></div></div>
        <div class="pt-bloque"><h4>Cobro</h4>
          <div class="pt-dato"><span>Forma</span><span>${p.estado_cobro === 'pagado' && p.ticket_estado !== 'pagado' ? 'Ya pagó todo por adelantado' : p.pago_modo === 'al_recibir' ? (p.tipo === 'recoger' ? 'Paga al recoger (en Caja)' : 'Paga al recibir') : p.pago_modo === 'credito' ? 'A crédito del cliente' : 'Se cobra en Caja'}</span></div>
          <div class="pt-dato"><span>Ticket</span><span>${esc(p.ticket_estado)}</span></div>${cobro}</div>
        ${hist ? `<div class="pt-bloque"><h4>Historial</h4><div class="pt-hist">${hist}</div></div>` : ''}
        ${evid ? `<div class="pt-bloque"><h4>Comprobantes de entrega</h4><div class="pt-botonera">${evid}</div></div>` : ''}
      </div></div>`);

    const b = [];
    if (lleno(p.telefono) && ['programado', 'preparando', 'listo', 'en_camino'].includes(p.estado)) b.push('<button type="button" class="btn btn-secondary" id="dtAvisar">💬 Avisar al cliente</button>');
    if (editables.includes(p.estado)) b.push('<button type="button" class="btn btn-secondary" id="dtEditar">✏ Editar</button>');
    if (corregible && p.ticket_estado !== 'cancelado') b.push('<button type="button" class="btn btn-secondary" id="dtDeshacer">↩ Deshacer entrega</button>');
    if ((['programado', 'preparando', 'listo', 'en_camino', 'no_entregado'].includes(p.estado) || corregible) && p.ticket_estado !== 'pagado') b.push('<button type="button" class="btn btn-secondary" id="dtCancelar" style="color:var(--danger)">✕ Cancelar pedido</button>');
    if (p.estado === 'en_camino') b.push('<button type="button" class="btn btn-secondary" id="dtNoEnt">No se entregó</button>');
    if (p.estado === 'programado') b.push('<button type="button" class="btn btn-secondary" id="dtListo">Ya está listo</button>');
    if (acc) b.push(`<button type="button" class="btn btn-primary" id="dtAccion">${acc.txt}</button>`);
    m.botones(b.join(''));

    const dar = (idb, fn) => { const el = m.el.querySelector('#' + idb); if (el) el.onclick = fn; };
    const refrescarDetalle = async () => { const n = await avisoError(() => apiFetch(`/pedidos/${p.id}`)); if (n) pintarDetalle(m, n); recargar(); };
    dar('dtAccion', async () => { const r = await accion(p.id, acc.asignar ? 'asignar' : acc.est); if (r || acc.asignar) refrescarDetalle(); });
    dar('dtListo', async () => { if (await accion(p.id, 'listo')) refrescarDetalle(); });
    dar('dtNoEnt', async () => { if (await noEntregado(p.id)) refrescarDetalle(); });
    dar('dtCancelar', async () => { if (await cancelar(p.id, p)) m.cerrar(); });
    dar('dtDeshacer', async () => { if (await deshacerEntrega(p)) refrescarDetalle(); });
    dar('dtAsignar', async () => { await asignar(p.id); refrescarDetalle(); });
    dar('dtEditar', () => pintarEdicion(m, p));
    dar('dtAvisar', async () => {
      const url = UBICACION.urlWhatsApp(p.telefono, mensajeCliente(p));
      if (!url) { mostrarToast('El teléfono del cliente no es válido', 'error'); return; }
      window.open(url, '_blank', 'noopener');
      if (p.estado === 'en_camino') { await avisoError(() => apiFetch(`/pedidos/${p.id}/avisado`, { method: 'POST' })); refrescarDetalle(); }
    });
    const wa = m.el.querySelector('#dtWaRep');
    if (wa) wa.href = UBICACION.urlWhatsApp(p.repartidor_telefono, mensajeRepartidor(p)) || '#';
  }

  async function verEvidencia(pedidoId, evId) {
    const e = await avisoError(() => apiFetch(`/pedidos/${pedidoId}/evidencias/${evId}`));
    if (!e) return;
    const m = abrirModal({ titulo: e.tipo === 'foto' ? '📷 Foto de la entrega' : '✍ Firma del cliente', ancho: 640, arriba: true, cuerpo: `<img class="pt-img" alt="${esc(e.tipo)}" src="${esc(e.dato)}">` });
    return m;
  }

  // ------------------------------------------------------------------ editar un pedido
  async function pintarEdicion(m, p) {
    if (!E.zonas) { const z = await apiFetch('/pedidos/zonas').catch(() => ({ zonas: [] })); E.zonas = z.zonas || []; }
    const dom = p.tipo === 'domicilio';
    const puedeCobro = p.ticket_estado === 'pendiente';
    const adelantoActual = p.anticipo > 0 ? (p.resta > 0 ? 'anticipo' : 'todo') : 'ninguno';
    const campo = (k, etq, v, tipo) => `<div><label class="pd-etq" for="ed_${k}">${etq}</label><input type="${tipo || 'text'}" id="ed_${k}" value="${esc(v)}"></div>`;
    const prog = p.programado_para || '';
    m.titulo(`Editar ${esc(p.etiqueta)}`);
    m.html(`<div class="pt-bloque"><div class="pd-fila f2">${campo('nombre', 'Nombre', p.nombre_contacto)}${campo('telefono', 'Teléfono', p.telefono || '', 'tel')}</div>
      ${dom ? `<div class="pd-fila f3" style="margin-top:6px">${campo('calle', 'Calle y número', p.calle || '')}${campo('colonia', 'Colonia', p.colonia || '')}${campo('cp', 'C.P.', p.cp || '')}</div>
        <div class="pd-fila f2">${campo('ciudad', 'Ciudad', p.ciudad || '')}${campo('referencias', 'Referencias', p.referencias || '')}</div>
        ${campo('ubicacion', '📍 Ubicación exacta (pega un enlace o coordenadas)', lleno(p.ubicacion_enlace) ? p.ubicacion_enlace : (UBICACION.tieneCoordenadas(p) ? `${p.latitud}, ${p.longitud}` : ''))}
        <div id="ed_estadoUbic" class="pd-nota"></div>` : ''}
      <div class="pd-fila f2" style="margin-top:6px"><div><label class="pd-etq" for="ed_fecha">Día de entrega</label><input type="date" id="ed_fecha" value="${esc(prog.slice(0, 10))}"></div>
        <div><label class="pd-etq" for="ed_hora">Hora</label><input type="time" id="ed_hora" value="${esc(prog.slice(11, 16))}"></div></div>
      ${dom && puedeCobro ? `<label class="pd-etq" for="ed_zona">Zona de envío</label><select id="ed_zona"><option value="">Sin zona (envío $0)</option>${E.zonas.map((z) => `<option value="${z.id}" ${p.zona_id === z.id ? 'selected' : ''}>${esc(z.nombre)} · ${dinero(z.costo)}</option>`).join('')}</select>` : ''}
      ${puedeCobro ? `<div class="pd-fila f2"><div><label class="pd-etq" for="ed_pago">Cómo paga</label><select id="ed_pago">
          ${dom ? `<option value="al_recibir" ${p.pago_modo === 'al_recibir' ? 'selected' : ''}>Paga al recibir</option>` : ''}
          <option value="pagado" ${p.pago_modo === 'pagado' ? 'selected' : ''}>Se cobra en Caja</option>
          <option value="credito" ${p.pago_modo === 'credito' ? 'selected' : ''}>A crédito del cliente</option></select></div>
          ${dom ? campo('pagaCon', '¿Con cuánto paga?', p.paga_con === null || p.paga_con === undefined ? '' : p.paga_con, 'number') : ''}</div>` : ''}
      ${puedeCobro && p.pago_modo !== 'credito' ? `<div class="pd-fila f3" style="margin-top:6px"><div><label class="pd-etq" for="ed_adelanto">¿Ya pagó algo?</label><select id="ed_adelanto">
          <option value="ninguno" ${adelantoActual === 'ninguno' ? 'selected' : ''}>No ha pagado nada</option>
          <option value="anticipo" ${adelantoActual === 'anticipo' ? 'selected' : ''}>Dio anticipo</option>
          <option value="todo" ${adelantoActual === 'todo' ? 'selected' : ''}>Ya pagó todo</option></select></div>
          ${campo('anticipo', 'Anticipo ($)', p.anticipo > 0 && adelantoActual === 'anticipo' ? p.anticipo : '', 'number')}
          <div><label class="pd-etq" for="ed_antmetodo">Lo pagó con</label><select id="ed_antmetodo">${['efectivo', 'transferencia', 'tarjeta'].map((k) => `<option value="${k}" ${(p.anticipo_metodo || 'efectivo') === k ? 'selected' : ''}>${k.charAt(0).toUpperCase() + k.slice(1)}</option>`).join('')}</select></div></div>
        <div class="pd-nota">Total ${dinero(p.total_neto)}${p.anticipo > 0 ? ` · ya tiene ${dinero(p.anticipo)} · falta ${dinero(p.resta)}` : ''}. «Ya pagó todo» deja el pedido sin nada por cobrar.</div>` : ''}
      ${puedeCobro ? `<label class="pd-etq" style="margin-top:8px">Productos del pedido</label><div id="ed_prods"></div>
        <label class="pd-etq" for="ed_buscar">＋ Agregar otro producto</label><input type="search" id="ed_buscar" placeholder="Escribe el nombre del producto…" autocomplete="off"><div id="ed_res"></div>
        <div class="pd-nota">Al guardar, el envío y el total del ticket se calculan otra vez${p.cliente_mayoreo ? ' (a este cliente se le cobra precio de mayoreo en lo que agregues)' : ''}.</div>`
        : '<div class="pd-nota" style="margin-top:8px">🔒 El ticket de este pedido ya se cobró en Caja, por eso los productos ya no se pueden cambiar.</div>'}
      ${campo('notas', 'Notas', p.notas || '')}
      <div class="pd-error" id="ed_error"></div></div>`);
    m.botones('<button type="button" class="btn btn-secondary" id="edVolver">Volver sin guardar</button><button type="button" class="btn btn-primary" id="edGuardar">💾 Guardar cambios</button>');

    // Productos: "quedan" son los renglones que ya tenía (se puede cambiar su cantidad o quitarlos); "nuevos" los que se agregan ahora.
    const quedan = (p.items || []).filter((i) => !i.es_envio).map((i) => ({ id: i.id, nombre: i.nombre_producto, cantidad: i.cantidad, original: i.cantidad, precio: i.precio_unitario, peso: i.tipo_venta === 'peso' }));
    const nuevos = [];
    const unidad = (i) => (i.peso ? 'kg' : 'pza');
    const subProductos = () => Math.round([...quedan, ...nuevos].reduce((s, i) => s + (Number(i.cantidad) || 0) * i.precio, 0) * 100) / 100;
    function pintaProductos() {
      const cont = m.el.querySelector('#ed_prods');
      if (!cont) return;
      const todos = [...quedan.map((i) => ({ i, lista: quedan })), ...nuevos.map((i) => ({ i, lista: nuevos }))];
      cont.innerHTML = todos.length ? `<table class="pt-tabla pt-editprods"><thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Precio</th><th class="num">Importe</th><th></th></tr></thead><tbody>
        ${todos.map(({ i, lista }, n) => `<tr><td>${esc(i.nombre)}${lista === nuevos ? ' <span class="pd-tag ok">nuevo</span>' : ''}</td>
          <td class="num"><input type="number" min="0" step="${i.peso ? 'any' : '1'}" value="${esc(i.cantidad)}" data-n="${n}" class="ed_cant" aria-label="Cantidad de ${esc(i.nombre)}" style="width:86px"> ${unidad(i)}</td>
          <td class="num">${dinero(i.precio)}</td><td class="num"><b>${dinero((Number(i.cantidad) || 0) * i.precio)}</b></td>
          <td><button type="button" class="pd-mini ed_quitar" data-n="${n}" aria-label="Quitar ${esc(i.nombre)}">✕</button></td></tr>`).join('')}
        </tbody><tfoot><tr><td colspan="3" style="text-align:right">Productos</td><td class="num"><b id="ed_sub">${dinero(subProductos())}</b></td><td></td></tr></tfoot></table>`
        : '<div class="pt-vacia">El pedido necesita al menos un producto.</div>';
      cont.querySelectorAll('.ed_cant').forEach((inp) => {
        inp.oninput = () => {
          const { i } = todos[Number(inp.dataset.n)];
          i.cantidad = inp.value === '' ? 0 : Number(inp.value);
          inp.closest('tr').children[3].innerHTML = `<b>${dinero((Number(i.cantidad) || 0) * i.precio)}</b>`;
          cont.querySelector('#ed_sub').textContent = dinero(subProductos());
        };
      });
      cont.querySelectorAll('.ed_quitar').forEach((b) => {
        b.onclick = () => { const { i, lista } = todos[Number(b.dataset.n)]; lista.splice(lista.indexOf(i), 1); pintaProductos(); };
      });
    }
    pintaProductos();
    const buscar = m.el.querySelector('#ed_buscar');
    if (buscar) {
      const cargarCatalogo = async () => { if (!E.catalogo) E.catalogo = await apiFetch('/productos'); return E.catalogo; };
      buscar.onfocus = () => { cargarCatalogo().catch(() => {}); };
      buscar.oninput = async () => {
        const res = m.el.querySelector('#ed_res');
        const q = norm(buscar.value);
        if (q.length < 2) { res.innerHTML = ''; return; }
        const cat = await avisoError(cargarCatalogo);
        if (!cat) return;
        const hay = cat.filter((x) => x.activo !== false && (norm(x.nombre).includes(q) || String(x.codigo_barras || '').includes(q))).slice(0, 8);
        const precioDe = (x) => { const may = parseFloat(x.precio_mayoreo); return p.cliente_mayoreo && may > 0 && may < parseFloat(x.precio) ? may : parseFloat(x.precio) || 0; };
        res.innerHTML = hay.length ? hay.map((x) => `<button type="button" class="pd-res" data-id="${x.id}"><span><b>${esc(x.nombre)}</b><small>${dinero(precioDe(x))}${x.tipo_venta === 'peso' ? ' / kg' : ''}</small></span></button>`).join('') : '<div class="pd-vacio">Sin resultados</div>';
        res.querySelectorAll('.pd-res').forEach((b) => {
          b.onclick = () => {
            const x = cat.find((c) => c.id === Number(b.dataset.id));
            const ya = quedan.find((i) => i.producto_id === x.id) || nuevos.find((i) => i.producto_id === x.id);
            if (ya) ya.cantidad = Number(ya.cantidad) + 1;
            else nuevos.push({ producto_id: x.id, nombre: x.nombre, cantidad: 1, precio: precioDe(x), peso: x.tipo_venta === 'peso' });
            buscar.value = ''; res.innerHTML = ''; pintaProductos(); buscar.focus();
          };
        });
      };
    }
    const v = (k) => { const el = m.el.querySelector('#ed_' + k); return el ? el.value : undefined; };
    const ub = m.el.querySelector('#ed_ubicacion');
    const pintaUbic = () => {
      const est = m.el.querySelector('#ed_estadoUbic');
      if (!ub || !est) return;
      const c = UBICACION.extraerCoordenadas(ub.value);
      est.textContent = !lleno(ub.value) ? '' : c ? `✔ Ubicación exacta (${c.latitud}, ${c.longitud})` : /^https?:\/\//i.test(ub.value.trim()) ? 'Se guardará el enlace (sin coordenadas exactas).' : 'No pude leer una ubicación ahí.';
    };
    if (ub) { ub.oninput = pintaUbic; pintaUbic(); }
    m.el.querySelector('#edVolver').onclick = () => pintarDetalle(m, p);
    m.el.querySelector('#edGuardar').onclick = async () => {
      const cuerpo = {};
      const err = m.el.querySelector('#ed_error');
      err.classList.remove('visible');
      if (v('nombre').trim() !== p.nombre_contacto) cuerpo.nombre_contacto = v('nombre');
      if ((v('telefono') || '').trim() !== (p.telefono || '')) cuerpo.telefono = v('telefono');
      if (v('notas').trim() !== (p.notas || '')) cuerpo.notas = v('notas');
      if (dom) {
        const nuevaUbic = (v('ubicacion') || '').trim();
        const viejaUbic = (lleno(p.ubicacion_enlace) ? p.ubicacion_enlace : (UBICACION.tieneCoordenadas(p) ? `${p.latitud}, ${p.longitud}` : '')).trim();
        const cambioDir = ['calle', 'colonia', 'cp', 'ciudad', 'referencias'].some((k) => (v(k) || '').trim() !== (p[k] || '')) || nuevaUbic !== viejaUbic;
        if (cambioDir) {
          const c = UBICACION.extraerCoordenadas(nuevaUbic);
          cuerpo.direccion = { calle: v('calle'), colonia: v('colonia'), cp: v('cp'), ciudad: v('ciudad'), referencias: v('referencias'),
            latitud: c ? c.latitud : null, longitud: c ? c.longitud : null, ubicacion_enlace: /^https?:\/\//i.test(nuevaUbic) ? nuevaUbic : null };
        }
        if (puedeCobro && v('zona') !== undefined && (Number(v('zona')) || null) !== (p.zona_id || null)) cuerpo.zona_id = Number(v('zona')) || null;
        if (puedeCobro && v('pagaCon') !== undefined && String(v('pagaCon')) !== String(p.paga_con === null || p.paga_con === undefined ? '' : p.paga_con)) cuerpo.paga_con = v('pagaCon') === '' ? null : Number(v('pagaCon'));
      }
      if (puedeCobro) {
        if (![...quedan, ...nuevos].length) { err.textContent = 'El pedido necesita al menos un producto'; err.classList.add('visible'); return; }
        if ([...quedan, ...nuevos].some((i) => !(Number(i.cantidad) > 0))) { err.textContent = 'Revisa las cantidades: todas deben ser mayores que cero'; err.classList.add('visible'); return; }
        const cambioLineas = quedan.length !== (p.items || []).filter((i) => !i.es_envio).length || quedan.some((i) => Math.abs(Number(i.cantidad) - Number(i.original)) > 0.0005);
        if (cambioLineas) cuerpo.lineas = quedan.map((i) => ({ id: i.id, cantidad: Number(i.cantidad) }));
        if (nuevos.length) cuerpo.agregar = nuevos.map((i) => ({ tipo: 'producto', producto_id: i.producto_id, nombre_producto: i.nombre, cantidad: Number(i.cantidad), precio_unitario: i.precio }));
      }
      if (puedeCobro && v('pago') !== p.pago_modo) cuerpo.pago_modo = v('pago');
      if (puedeCobro && v('adelanto') !== undefined) {
        const adel = v('adelanto'), metodoAnt = v('antmetodo') || 'efectivo';
        if (adel === 'anticipo') {
          const a = Number(v('anticipo'));
          if (!(a > 0)) { err.textContent = 'Escribe cuánto dejó de anticipo (o elige «No ha pagado nada»)'; err.classList.add('visible'); return; }
          if (a !== p.anticipo || metodoAnt !== (p.anticipo_metodo || 'efectivo') || adelantoActual !== 'anticipo') { cuerpo.anticipo = a; cuerpo.anticipo_metodo = metodoAnt; }
        } else if (adel === 'todo') {
          if (adelantoActual !== 'todo' || metodoAnt !== (p.anticipo_metodo || 'efectivo') || cuerpo.lineas || cuerpo.agregar || cuerpo.zona_id !== undefined) { cuerpo.ya_pago_todo = true; cuerpo.anticipo_metodo = metodoAnt; }
        } else if (p.anticipo > 0) cuerpo.anticipo = 0;
      }
      if (v('fecha') && v('hora') && `${v('fecha')}T${v('hora')}` !== prog) cuerpo.programado_para = `${v('fecha')}T${v('hora')}`;
      if (!Object.keys(cuerpo).length) { pintarDetalle(m, p); return; }
      try {
        const r = await apiFetch(`/pedidos/${p.id}`, { method: 'PUT', body: JSON.stringify(cuerpo) });
        mostrarToast('Pedido actualizado', 'exito');
        pintarDetalle(m, r); recargar();
      } catch (e) { err.textContent = e.message; err.classList.add('visible'); }
    };
  }

  // ------------------------------------------------------------------ tiempo real
  let temporizadorRefresco = null;
  function refrescarSuave() { clearTimeout(temporizadorRefresco); temporizadorRefresco = setTimeout(recargar, 450); }

  function beep() {
    try {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      const c = new C(); const o = c.createOscillator(); const g = c.createGain();
      o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(c.destination);
      o.start(); setTimeout(() => { o.stop(); c.close(); }, 180);
    } catch (e) { /* sin sonido */ }
  }

  function iniciarSocket() {
    if (typeof io !== 'function' || !usuarioPedidos) return;
    // El servidor pide el token de la sesión para conectarse a los avisos en vivo.
    const socket = io(API_URL.replace('/api', ''), { auth: { token: getToken() } });
    socket.on('connect', () => { socket.emit('unirse_sucursal', usuarioPedidos.sucursal_id); vivo(true); refrescarSuave(); });
    socket.on('disconnect', () => vivo(false));
    socket.on('pedido_actualizado', (d) => {
      if (d && d.nuevo) { mostrarToast('🛵 Llegó un pedido nuevo', 'info'); beep(); }
      refrescarSuave();
    });
    ['nuevo_ticket', 'ticket_pagado', 'ticket_actualizado'].forEach((ev) => socket.on(ev, refrescarSuave));
  }

  function filtrar() { if (E.tab === 'hoy') pintarHoy(); }
  function verTodosEntregados() { E.verTodosEntregados = !E.verTodosEntregados; pintarHoy(); }

  function iniciar() {
    if (esAdmin) { $('btnAjustesPedidos').style.display = ''; $('btnNuevoFijo').style.display = ''; $('btnGenerarFijos').style.display = ''; }
    iniciarSocket();
    recargar().then(() => {
      // Desde el Inicio: pedidos.html?liquidar=ID abre directo la liquidación de ese repartidor.
      const idLiq = Number(new URLSearchParams(window.location.search).get('liquidar'));
      if (!idLiq) return;
      const abrirLiquidacion = () => { history.replaceState(null, '', window.location.pathname); PTX.liquidar(idLiq); };
      if (typeof PTX !== 'undefined') abrirLiquidacion();
      else window.addEventListener('load', abrirLiquidacion);
    });
    setInterval(() => { if (!document.hidden && !pila.length) recargar(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refrescarSuave(); });
  }

  const API_PT = {
    estado: E, u: { esc, dinero, hora12, horaLocal, fechaLarga, fechaBonita, sumarDias, abrirModal, avisoError, iniciales, primerNombre, norm, lleno, ESTADO_TXT, tagPago, esAdmin },
    tab, recargar, filtrar, abrir, accion, noEntregado, cancelar, deshacerEntrega, asignar, irADia, cambiarFechaAgenda, verEvidencia, verTodosEntregados, mensajeCliente, mensajeRepartidor, pedirMetodoCobro, iniciar
  };
  return API_PT;
})();

window.PT = PT;
if (!usuarioPedidos || usuarioPedidos.rol !== 'repartidor') PT.iniciar();
