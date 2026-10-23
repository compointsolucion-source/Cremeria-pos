// Vista "Caja Mostrador" dentro de Caja Avanzada.
//
// Es una segunda forma de ver la MISMA venta (mismas pestañas, mismo cobro, mismas
// teclas F): a la izquierda la cuadrícula de productos como en Mostrador, a la
// derecha el ticket con descuentos por producto y al ticket, cliente y cobro.
// La vista "Clásica" (tabla) sigue igual. Se elige arriba y se recuerda en este equipo.
//
// Usa las variables y funciones de caja-avanzada.html (pestanas, catalogoAvanzada,
// agregarConDecisionDeTipo, irACobrarAvanzada, etc.), por eso se carga después de ese script.

const CLAVE_VISTA_CAJA = 'vista_caja_avanzada';
let vistaCajaActual = 'clasica';
let categoriasAv = [];
let categoriaActivaAv = null; // null = todos, 'kits' = kits, número = categoría

function leerVistaGuardada() {
  try { return localStorage.getItem(CLAVE_VISTA_CAJA) === 'mostrador' ? 'mostrador' : 'clasica'; } catch (e) { return 'clasica'; }
}

function escaparAv(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Descuentos y totales (compartidos con la vista Clásica y el cobro) ----------
function subtotalItemAv(it) {
  return GRANEL.subtotal(it); // cantidad × precio, o el importe exacto si fue venta a granel por importe
}

// Descuento en pesos de un renglón: el que se capturó aquí (porcentaje o monto) o el que
// ya tiene guardado el ticket en el servidor (cuando viene de Mostrador/Caja).
function descuentoItemAv(it) {
  const sub = subtotalItemAv(it);
  if (it.descuento) {
    const d = it.descuento.tipo === 'porcentaje' ? sub * it.descuento.valor / 100 : it.descuento.valor;
    return Math.min(Math.max(d, 0), sub);
  }
  return parseFloat(it.descuento_monto || 0) || 0;
}

function descuentoTicketAv(p) {
  const bruto = p.carrito.reduce((s, it) => s + subtotalItemAv(it), 0);
  if (p.descuentoTicket) {
    const d = p.descuentoTicket.tipo === 'porcentaje' ? bruto * p.descuentoTicket.valor / 100 : p.descuentoTicket.valor;
    return Math.min(Math.max(d, 0), bruto);
  }
  return parseFloat(p.descuento_monto_ticket || 0) || 0;
}

function totalesPestanaAv(p) {
  const bruto = p.carrito.reduce((s, it) => s + subtotalItemAv(it), 0);
  const descItems = p.carrito.reduce((s, it) => s + descuentoItemAv(it), 0);
  const descTicket = descuentoTicketAv(p);
  return { bruto, descItems, descTicket, neto: Math.max(0, bruto - descItems - descTicket) };
}

// Total a pagar de un ticket que ya existe en el servidor (ya con sus descuentos).
function totalNetoTicketAv(t) {
  const items = t.items || [];
  const descItems = items.reduce((s, i) => s + (parseFloat(i.descuento_monto || 0) || 0), 0);
  // Se redondea a centavos para que "Exacto" y las comparaciones del cobro no fallen por decimales flotantes.
  return Math.round((parseFloat(t.total) - (parseFloat(t.descuento_monto || 0) || 0) - descItems) * 100) / 100;
}

// Quita lo que solo existe en pantalla antes de mandar el renglón al servidor.
function itemParaServidorAv(it) {
  const { descuento, ...limpio } = it;
  return limpio;
}

function hayDescuentosPendientesAv(p) {
  return !!p.descuentoTicket || p.carrito.some(it => it.descuento);
}

// ---------- Captura de descuentos ----------
async function pedirDescuentoAv(baseMonto, etiqueta) {
  const motivo = await solicitarTexto(`Motivo del descuento ${etiqueta}:`);
  if (!motivo) return null;
  const entrada = await solicitarTexto('Porcentaje de descuento (ej. 10), o escribe "monto:20" para un monto fijo en pesos:');
  if (!entrada) return null;

  let tipo, valor;
  if (entrada.trim().toLowerCase().startsWith('monto:')) { tipo = 'monto'; valor = parseFloat(entrada.split(':')[1]); }
  else { tipo = 'porcentaje'; valor = parseFloat(entrada); }
  if (isNaN(valor) || valor <= 0) { mostrarToast('Descuento inválido', 'error'); return null; }
  if (tipo === 'porcentaje' && valor > 100) { mostrarToast('El porcentaje no puede pasar de 100', 'error'); return null; }
  const monto = tipo === 'porcentaje' ? baseMonto * valor / 100 : valor;
  if (monto > baseMonto) { mostrarToast('El descuento no puede ser mayor al importe', 'error'); return null; }

  const d = { tipo, valor, motivo };
  // Descuentos de más del 15% piden usuario y contraseña de un dueño/gerente.
  if (baseMonto > 0 && (monto / baseMonto) * 100 > 15) {
    d.autorizacion = await pedirAutorizacionAv();
    if (!d.autorizacion) return null;
  }
  return d;
}

async function pedirAutorizacionAv() {
  const usuario = await solicitarTexto('Este descuento requiere autorización. Usuario de un dueño/gerente:');
  if (!usuario) return null;
  const password = await solicitarTexto('Contraseña de autorización:');
  if (!password) return null;
  return { usuario, password };
}

function cuerpoDescuentoAv(d) {
  const body = { motivo: d.motivo };
  if (d.tipo === 'porcentaje') body.porcentaje = d.valor; else body.monto = d.valor;
  if (d.autorizacion) body.autorizacion = d.autorizacion;
  return body;
}

// PUT con reintento pidiendo autorización si el servidor la exige.
async function enviarDescuentoAv(url, d) {
  try {
    await apiFetch(url, { method: 'PUT', body: JSON.stringify(cuerpoDescuentoAv(d)) });
  } catch (err) {
    if (!d.autorizacion && (err.message.includes('supera el 15%') || err.message.includes('autorización'))) {
      const aut = await pedirAutorizacionAv();
      if (!aut) throw new Error('Descuento sin autorización');
      await apiFetch(url, { method: 'PUT', body: JSON.stringify(cuerpoDescuentoAv({ ...d, autorizacion: aut })) });
    } else {
      throw err;
    }
  }
}

// Al cobrar: el ticket ya se creó en el servidor; aquí se le aplican los descuentos
// capturados en pantalla y se devuelve el ticket actualizado (con sus descuentos).
async function aplicarDescuentosPendientesAv(ticket, pest) {
  for (let i = 0; i < pest.carrito.length; i++) {
    const it = pest.carrito[i];
    if (!it.descuento) continue;
    const real = ticket.items[i];
    if (!real) throw new Error('No se encontró el renglón del ticket para aplicar el descuento');
    await enviarDescuentoAv(`/tickets/item/${real.id}/descuento`, it.descuento);
  }
  if (pest.descuentoTicket) {
    await enviarDescuentoAv(`/tickets/${ticket.id}/descuento`, pest.descuentoTicket);
  }
  return await apiFetch(`/tickets/folio/${encodeURIComponent(ticket.folio)}`);
}

// Si un descuento no se pudo aplicar, el ticket ya quedó creado: la pestaña pasa a ser ese
// ticket guardado (igual que uno traído de Mostrador) para no duplicarlo ni perderlo.
function convertirPestanaEnTicketGuardadoAv(pest, ticket) {
  pest.nombre = `📥 ${ticket.folio}`;
  pest.ticketIdExistente = ticket.id;
  pest.descuentoTicket = null;
  pest.descuento_monto_ticket = parseFloat(ticket.descuento_monto || 0);
  pest.carrito = (ticket.items || []).map(i => ({
    tipo: i.tipo, producto_id: i.producto_id, kit_id: i.kit_id, id: i.id, codigo_barras: '',
    nombre_producto: i.nombre_producto, tipo_venta: i.tipo_venta, cantidad: parseFloat(i.cantidad), precio_unitario: parseFloat(i.precio_unitario),
    importe: parseFloat(i.subtotal), descuento_monto: parseFloat(i.descuento_monto || 0), existencia_referencia: null
  }));
}

// ---------- Cambio de vista ----------
function moverNodosVista(aMostrador) {
  const clasica = document.getElementById('vistaClasica');
  const arriba = document.getElementById('vmSlotArriba');
  const abajo = document.getElementById('vmSlotAbajo');
  const ultima = document.getElementById('vmSlotUltima');
  const q = (s) => document.querySelector(s);
  const pestanasBar = document.getElementById('barraPestanas');
  const buscador = q('.barra-superior-avanzada');
  const atajos = q('.barra-atajos');
  const tabla = q('.tabla-venta-wrap');
  const inferior = q('.zona-inferior-btns');
  const panelUlt = document.getElementById('panelUltimaVenta');
  const total = q('.zona-total');

  if (aMostrador) {
    arriba.appendChild(pestanasBar);
    arriba.appendChild(buscador);
    abajo.appendChild(atajos);
    abajo.appendChild(inferior);
    ultima.appendChild(panelUlt);
  } else {
    // Orden original de la vista Clásica
    [pestanasBar, buscador, atajos, tabla, inferior, panelUlt, total].forEach(n => clasica.appendChild(n));
  }
}

function cambiarVistaCaja(vista) {
  const aMostrador = vista === 'mostrador';
  vistaCajaActual = aMostrador ? 'mostrador' : 'clasica';
  try { localStorage.setItem(CLAVE_VISTA_CAJA, vistaCajaActual); } catch (e) { /* sin almacenamiento */ }
  moverNodosVista(aMostrador);
  document.body.classList.toggle('vista-mostrador', aMostrador);
  document.getElementById('selVistaClasica').classList.toggle('activa', !aMostrador);
  document.getElementById('selVistaMostrador').classList.toggle('activa', aMostrador);
  renderTablaVentaAvanzada();
  const campo = document.getElementById('campoCodigoProducto');
  if (campo) campo.focus();
}

// ---------- Cuadrícula de productos ----------
async function cargarCategoriasAv() {
  try { categoriasAv = await apiFetch('/productos/categorias'); } catch (err) { categoriasAv = []; }
  if (vistaCajaActual === 'mostrador') renderVistaMostrador();
}

function renderCategoriasAv() {
  const cont = document.getElementById('vmCategorias');
  if (!cont) return;
  let html = `<div class="vm-cat ${categoriaActivaAv === null ? 'activa' : ''}" onclick="elegirCategoriaAv(null)">Todos</div>`;
  html += categoriasAv.map(c => `<div class="vm-cat ${categoriaActivaAv === c.id ? 'activa' : ''}" onclick="elegirCategoriaAv(${c.id})">${escaparAv(c.nombre)}</div>`).join('');
  if (kitsAvanzada.length > 0) html += `<div class="vm-cat kits ${categoriaActivaAv === 'kits' ? 'activa' : ''}" onclick="elegirCategoriaAv('kits')">📦 Kits/Combos</div>`;
  cont.innerHTML = html;
}

function elegirCategoriaAv(c) {
  categoriaActivaAv = c;
  renderCategoriasAv();
  renderGridAv();
}

function tarjetaAv(imagen, nombre, precio, badgeClase, badgeTexto, onclick) {
  const foto = imagen
    ? `<img src="${escaparAv(imagen)}" alt="" onerror="this.outerHTML='<div class=&quot;vm-sinfoto&quot;>🛒</div>'">`
    : '<div class="vm-sinfoto">🛒</div>';
  return `<div class="vm-card" onclick="${onclick}"><span class="vm-badge ${badgeClase}">${badgeTexto}</span>${foto}<div class="vm-nombre">${escaparAv(nombre)}</div><div class="vm-precio">${precio}</div></div>`;
}

function renderGridAv() {
  const grid = document.getElementById('vmGrid');
  if (!grid) return;
  const campo = document.getElementById('campoCodigoProducto');
  const texto = campo ? campo.value.trim().toLowerCase() : '';
  let kitsLista = [];
  let prodLista = [];

  if (texto) {
    prodLista = catalogoAvanzada.filter(p => p.nombre.toLowerCase().includes(texto) || (p.codigo_barras && p.codigo_barras.toLowerCase().includes(texto)));
    kitsLista = kitsAvanzada.filter(k => k.nombre.toLowerCase().includes(texto));
  } else if (categoriaActivaAv === 'kits') {
    kitsLista = kitsAvanzada;
  } else {
    prodLista = categoriaActivaAv ? catalogoAvanzada.filter(p => p.categoria_id === categoriaActivaAv) : catalogoAvanzada;
  }

  const html =
    kitsLista.map(k => tarjetaAv(k.imagen_url, k.nombre, '$' + parseFloat(k.precio_kit).toFixed(2), 'vm-b-kit', 'KIT', `vmAgregarKit(${k.id})`)).join('') +
    prodLista.map(p => {
      const esUnidad = p.tipo_venta === 'unidad';
      return tarjetaAv(p.imagen_url, p.nombre, '$' + parseFloat(p.precio).toFixed(2) + (esUnidad ? '/pza' : '/kg'),
        esUnidad ? 'vm-b-uni' : 'vm-b-peso', esUnidad ? 'PZA' : 'KG', `vmAgregarProducto(${p.id})`);
    }).join('');
  grid.innerHTML = html || '<p style="color:#888; padding:20px;">Sin productos para mostrar</p>';
}

function vmAgregarProducto(id) {
  const p = catalogoAvanzada.find(x => x.id === id);
  if (!p) return;
  // Igual que en Mostrador: por pieza se abre la ventana de cantidad (Enter agrega 1); a granel, la de kilos.
  agregarConDecisionDeTipo(p, { alConfirmar: vmAgregarPiezas });
}

// Por pieza: si el producto ya está en el ticket (y no tiene descuento propio), se suma a ese renglón.
function vmAgregarPiezas(p, cantidad) {
  const pest = pestanas[pestanaActivaIndex];
  if (!pest.ticketIdExistente) {
    const existente = pest.carrito.find(it => it.tipo === 'producto' && it.producto_id === p.id && !it.descuento && it.precio_unitario === parseFloat(p.precio));
    if (existente) { existente.cantidad = (parseFloat(existente.cantidad) || 0) + cantidad; renderTablaVentaAvanzada(); return; }
  }
  agregarProductoAvanzada(p, cantidad);
}
function vmAgregarKit(id) {
  const k = kitsAvanzada.find(x => x.id === id);
  if (k) agregarKitAvanzada(k);
}

// ---------- Ticket (panel derecho) ----------
function formatoCantidadAv(it) {
  const c = parseFloat(it.cantidad) || 0;
  return Number.isInteger(c) ? String(c) : c.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function renderTicketAv() {
  const cont = document.getElementById('vmTicket');
  if (!cont) return;
  const p = pestanas[pestanaActivaIndex];
  const guardado = !!p.ticketIdExistente;
  const t = totalesPestanaAv(p);

  const filas = p.carrito.map((it, idx) => {
    const sub = subtotalItemAv(it);
    const desc = descuentoItemAv(it);
    const esKit = it.tipo === 'kit';
    const detalle = esKit ? 'Kit' : (it.tipo_venta === 'peso'
      ? GRANEL.detalle(it, '×')
      : `${formatoCantidadAv(it)} × $${(parseFloat(it.precio_unitario) || 0).toFixed(2)}`);
    const lineaDesc = desc > 0
      ? `<small class="vm-desc">Descuento${it.descuento ? ' (' + escaparAv(it.descuento.motivo) + ')' : (it.descuento_motivo ? ' (' + escaparAv(it.descuento_motivo) + ')' : '')}: −$${desc.toFixed(2)}${it.descuento ? ` <a href="#" onclick="vmQuitarDescuentoItem(${idx}); return false;">quitar</a>` : ''}</small>`
      : '';
    const cantidadCtrl = (guardado || esKit) ? '' :
      `<button type="button" onclick="event.stopPropagation(); vmCambiarCantidad(${idx}, -1)" title="Menos">−</button>
       <button type="button" onclick="event.stopPropagation(); vmEditarCantidad(${idx})" title="Escribir cantidad">✎</button>
       <button type="button" onclick="event.stopPropagation(); vmCambiarCantidad(${idx}, 1)" title="Más">＋</button>`;
    const quitarBtn = guardado ? '' : `<button type="button" class="vm-x" onclick="event.stopPropagation(); vmQuitar(${idx})" title="Quitar">✕</button>`;
    const descBtn = esKit ? '' : `<button type="button" onclick="event.stopPropagation(); vmDescuentoItem(${idx})" title="Descuento a este producto">%</button>`;
    return `
      <div class="vm-fila ${idx === filaSeleccionadaIndex ? 'sel' : ''}" onclick="seleccionarFilaAvanzada(${idx})">
        <div class="vm-fila-t"><b>${escaparAv(it.nombre_producto)}</b><br><span>${detalle}</span>${lineaDesc}</div>
        <div class="vm-fila-b">${cantidadCtrl}${descBtn}${quitarBtn}</div>
        <div class="vm-fila-s">$${(sub - desc).toFixed(2)}</div>
      </div>`;
  }).join('') || '<p style="color:#888; text-align:center; padding:24px 0;">Toca un producto para agregarlo</p>';

  const descTicketTxt = t.descTicket > 0
    ? `<div class="vm-t-desc"><span>Descuento al ticket${p.descuentoTicket ? ' (' + escaparAv(p.descuentoTicket.motivo) + ')' : ''}${p.descuentoTicket ? ' <a href="#" onclick="vmQuitarDescuentoTicket(); return false;">quitar</a>' : ''}</span><span>−$${t.descTicket.toFixed(2)}</span></div>` : '';
  const descItemsTxt = t.descItems > 0 ? `<div class="vm-t-desc"><span>Descuentos a productos</span><span>−$${t.descItems.toFixed(2)}</span></div>` : '';
  const clienteTxt = p.clienteAsignado ? `<div class="vm-cliente">👤 ${escaparAv(p.clienteAsignado.nombre)}</div>` : '';

  cont.innerHTML = `
    <h3>${escaparAv(p.nombre)} <small>${p.carrito.length} producto${p.carrito.length === 1 ? '' : 's'}</small></h3>
    ${clienteTxt}
    <div class="vm-filas">${filas}</div>
    <div class="vm-botones">
      <button type="button" class="btn btn-secondary" onclick="asignarClienteAvanzada().then(renderTicketAv)">👤 Cliente</button>
      <button type="button" class="btn btn-secondary" onclick="vmDescuentoTicket()">🏷️ Descuento al ticket</button>
      <button type="button" class="btn btn-secondary" onclick="eliminarPestanaActual()">🗑️ Eliminar</button>
    </div>
    <div class="vm-totales">
      <div><span>Subtotal</span><span>$${t.bruto.toFixed(2)}</span></div>
      ${descItemsTxt}${descTicketTxt}
      <div class="vm-gran"><span>Total</span><span>$${t.neto.toFixed(2)}</span></div>
    </div>
    <button type="button" class="btn btn-primary vm-cobrar" onclick="irACobrarAvanzada()">💰 Cobrar</button>`;
}

function renderVistaMostrador() {
  if (vistaCajaActual !== 'mostrador') return;
  renderCategoriasAv();
  renderGridAv();
  renderTicketAv();
}

// Acciones del ticket
function vmCambiarCantidad(idx, delta) {
  const it = carritoActivo()[idx];
  if (!it) return;
  const paso = it.tipo === 'producto' && catalogoAvanzada.find(p => p.id === it.producto_id && p.tipo_venta === 'peso') ? 0.1 : 1;
  const nueva = Math.round(((parseFloat(it.cantidad) || 0) + delta * paso) * 1000) / 1000;
  if (nueva <= 0) { vmQuitar(idx); return; }
  it.cantidad = nueva;
  delete it.importe; // la cantidad cambió: ya no aplica el importe exacto capturado antes
  renderTablaVentaAvanzada();
}

async function vmEditarCantidad(idx) {
  const it = carritoActivo()[idx];
  if (!it) return;
  const txt = await solicitarTexto(`Cantidad de "${it.nombre_producto}":`, String(it.cantidad));
  if (txt === null || txt === '') return;
  const n = parseFloat(txt);
  if (isNaN(n) || n <= 0) { mostrarToast('Cantidad inválida', 'error'); return; }
  it.cantidad = n;
  delete it.importe;
  renderTablaVentaAvanzada();
}

function vmQuitar(idx) {
  if (pestanas[pestanaActivaIndex].ticketIdExistente) { mostrarToast('No se puede modificar un ticket ya guardado desde aquí', 'error'); return; }
  carritoActivo().splice(idx, 1);
  filaSeleccionadaIndex = null;
  renderTablaVentaAvanzada();
}

async function vmDescuentoItem(idx) {
  const p = pestanas[pestanaActivaIndex];
  const it = p.carrito[idx];
  if (!it) return;
  const d = await pedirDescuentoAv(subtotalItemAv(it), 'para este producto');
  if (!d) return;

  if (p.ticketIdExistente) {
    // El ticket ya está guardado: el descuento se aplica de inmediato en el servidor.
    try {
      await enviarDescuentoAv(`/tickets/item/${it.id}/descuento`, d);
      await recargarPestanaGuardadaAv(p);
      mostrarToast('Descuento aplicado al producto', 'exito');
    } catch (err) { mostrarToast(err.message, 'error'); }
    return;
  }
  it.descuento = d;
  renderTablaVentaAvanzada();
}

function vmQuitarDescuentoItem(idx) {
  const it = carritoActivo()[idx];
  if (it) { delete it.descuento; renderTablaVentaAvanzada(); }
}

async function vmDescuentoTicket() {
  const p = pestanas[pestanaActivaIndex];
  if (p.carrito.length === 0) { mostrarToast('Agrega al menos un producto', 'error'); return; }
  const bruto = p.carrito.reduce((s, it) => s + subtotalItemAv(it), 0);
  const d = await pedirDescuentoAv(bruto, 'al ticket');
  if (!d) return;

  if (p.ticketIdExistente) {
    try {
      await enviarDescuentoAv(`/tickets/${p.ticketIdExistente}/descuento`, d);
      await recargarPestanaGuardadaAv(p);
      mostrarToast('Descuento aplicado al ticket', 'exito');
    } catch (err) { mostrarToast(err.message, 'error'); }
    return;
  }
  p.descuentoTicket = d;
  renderTablaVentaAvanzada();
}

function vmQuitarDescuentoTicket() {
  const p = pestanas[pestanaActivaIndex];
  p.descuentoTicket = null;
  renderTablaVentaAvanzada();
}

async function recargarPestanaGuardadaAv(p) {
  const folio = p.nombre.replace('📥 ', '');
  const ticket = await apiFetch(`/tickets/folio/${encodeURIComponent(folio)}`);
  convertirPestanaEnTicketGuardadoAv(p, ticket);
  renderTablaVentaAvanzada();
}

// ---------- Arranque ----------
document.addEventListener('DOMContentLoaded', () => {
  const campo = document.getElementById('campoCodigoProducto');
  if (campo) campo.addEventListener('input', () => { if (vistaCajaActual === 'mostrador') renderGridAv(); });
});
