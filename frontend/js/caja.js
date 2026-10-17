requiereLogin();
const usuario = getUsuario();

// Imagen de respaldo (sin foto, sin internet o liga rota): cuadro gris con una cajita.
const IMAGEN_RESPALDO = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" fill="#eceff1"/><path d="M60 28l32 16v32L60 92 28 76V44z" fill="none" stroke="#90a4ae" stroke-width="5" stroke-linejoin="round"/><path d="M28 44l32 16 32-16M60 60v32" fill="none" stroke="#90a4ae" stroke-width="5" stroke-linejoin="round"/></svg>');
document.addEventListener('error', (e) => {
  const el = e.target;
  if (el && el.tagName === 'IMG' && !el.dataset.respaldo) { el.dataset.respaldo = '1'; el.src = IMAGEN_RESPALDO; }
}, true);

const pantallaAngosta = () => window.innerWidth < 900;

function limpiarPanelCobro() {
  const panel = document.getElementById('panelCobro');
  panel.classList.remove('abierto');
  panel.innerHTML = '<p style="color:#888; text-align:center;">Selecciona o escanea un ticket para cobrar</p>';
  document.querySelectorAll('.ticket-pendiente.sel').forEach(el => el.classList.remove('sel'));
}

// En celular el cobro se abre a pantalla completa; este botón regresa a la bandeja.
function volverABandeja() {
  document.getElementById('panelCobro').classList.remove('abierto');
}
let ticketActual = null;
let metodoPago = 'efectivo';
let clienteSeleccionado = null;
let scannerActivo = false;
let html5QrCode;

const socket = io(API_URL.replace('/api', ''));
socket.emit('unirse_sucursal', usuario.sucursal_id);
socket.on('nuevo_ticket', () => cargarBandeja());
socket.on('ticket_pagado', () => cargarBandeja());

// Cancela un ticket que aún está pendiente de pago — para cuando el
// cliente ya no lo requiere. Antes de cancelar, pide el motivo con
// opciones automáticas (para tener estadísticas útiles después en
// Bitácora), en vez de solo un sí/no genérico.
let ticketPendienteParaCancelar = null; // { id, folio }

function cancelarTicketPendiente(id, folio) {
  ticketPendienteParaCancelar = { id, folio };
  document.getElementById('folioMotivoCancelacion').textContent = `Ticket ${folio}`;
  document.getElementById('modalMotivoCancelacion').style.display = 'flex';
}

function cerrarModalMotivoCancelacion() {
  document.getElementById('modalMotivoCancelacion').style.display = 'none';
  ticketPendienteParaCancelar = null;
}

async function confirmarMotivoCancelacion(motivo) {
  if (!ticketPendienteParaCancelar) return;

  if (motivo === 'otro') {
    const motivoLibre = await solicitarTexto('Escribe el motivo de la cancelación:');
    if (!motivoLibre) return; // canceló el prompt, no cierra el modal de motivos por si quiere elegir otra opción
    motivo = motivoLibre.trim();
  }

  const { id, folio } = ticketPendienteParaCancelar;
  document.getElementById('modalMotivoCancelacion').style.display = 'none';

  try {
    await apiFetch(`/tickets/${id}/cancelar`, { method: 'POST', body: JSON.stringify({ motivo }) });
    mostrarToast(`Ticket ${folio} cancelado (${motivo})`, 'exito');

    if (ticketActual && ticketActual.folio === folio) {
      ticketActual = null;
      clienteSeleccionado = null;
      limpiarPanelCobro();
    }
    cargarBandeja();
  } catch (err) {
    mostrarToast(err.message, 'error');
  } finally {
    ticketPendienteParaCancelar = null;
  }
}

async function cargarBandeja() {
  try {
    const pendientes = await apiFetch('/tickets/pendientes');
    const cont = document.getElementById('bandeja');
    cont.innerHTML = '';
    pendientes.forEach(t => {
      const minutosEspera = Math.floor((Date.now() - new Date(t.fecha_creacion).getTime()) / 60000);
      let claseEspera = 'espera-reciente';
      if (minutosEspera >= 5) claseEspera = 'espera-larga';
      else if (minutosEspera >= 2) claseEspera = 'espera-media';

      const textoEspera = minutosEspera <= 0 ? 'Hace un momento' : `Hace ${minutosEspera} min`;

      const div = document.createElement('div');
      div.className = `ticket-pendiente ${claseEspera}`;
      div.innerHTML = `
        <span><b>${t.folio}</b><br><small>${textoEspera}</small></span>
        <span style="display:flex; align-items:center; gap:10px;">
          $${parseFloat(t.total).toFixed(2)}
          <button class="btn-cancelar-ticket-pendiente" title="Cancelar (el cliente ya no lo requiere)" data-id="${t.id}" data-folio="${t.folio}">✕</button>
        </span>
      `;
      if (ticketActual && ticketActual.folio === t.folio) div.classList.add('sel');
      div.onclick = () => cargarTicket(t.folio);
      div.querySelector('.btn-cancelar-ticket-pendiente').onclick = (evento) => {
        evento.stopPropagation(); // no debe abrir el ticket para cobrar, solo cancelarlo
        cancelarTicketPendiente(t.id, t.folio);
      };
      cont.appendChild(div);
    });
  } catch (err) {
    console.error(err);
  }
}

async function cargarTicket(folio) {
  try {
    const nuevo = await apiFetch(`/tickets/folio/${encodeURIComponent(folio)}`);
    if (!ticketActual || ticketActual.folio !== nuevo.folio) clienteSeleccionado = null; // al editar el mismo ticket se conserva el cliente
    ticketActual = nuevo;
    renderPanelCobro();
    cargarBandeja();
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

function totalNetoActual() {
  const descuentoItems = ticketActual.items.reduce((sum, i) => sum + parseFloat(i.descuento_monto || 0), 0);
  return parseFloat(ticketActual.total) - parseFloat(ticketActual.descuento_monto || 0) - descuentoItems;
}

function renderPanelCobro() {
  const t = ticketActual;
  const panel = document.getElementById('panelCobro');
  let itemsHtml = t.items.map(i => {
    const detalle = i.tipo === 'kit' ? 'Kit (fijo)' : (i.tipo_venta === 'peso' ? GRANEL.detalle(i, '×') : `${i.cantidad} × $${parseFloat(i.precio_unitario).toFixed(2)}`);
    const puedeEditar = i.tipo !== 'kit';
    const tieneDescuentoItem = parseFloat(i.descuento_monto || 0) > 0;
    const lineaDescuentoItem = tieneDescuentoItem
      ? `<div style="font-size:12px; color:#C62828;">Descuento (${i.descuento_motivo || ''}): -$${parseFloat(i.descuento_monto).toFixed(2)}</div>`
      : '';
    return `
      <div class="detalle-item">
        <span class="info"><img class="mini-foto" src="${i.imagen_url || IMAGEN_RESPALDO}" alt=""><span>${i.nombre_producto}<br><small>${detalle}</small>${lineaDescuentoItem}</span></span>
        <span class="acciones">
          $${parseFloat(i.subtotal).toFixed(2)}
          ${puedeEditar ? `<button onclick="editarCantidad(${i.id}, ${i.cantidad})">✏️</button>` : ''}
          ${puedeEditar && !tieneDescuentoItem ? `<button onclick="abrirDescuentoItem(${i.id})">🏷️</button>` : ''}
          <button class="quitar" onclick="quitarItem(${i.id})">✕</button>
        </span>
      </div>`;
  }).join('');

  const tieneDescuento = parseFloat(t.descuento_monto || 0) > 0;
  const filasDescuento = tieneDescuento ? `
    <div style="display:flex; justify-content:space-between; font-size:14px; color:#666;"><span>Subtotal</span><span>$${parseFloat(t.total).toFixed(2)}</span></div>
    <div style="display:flex; justify-content:space-between; font-size:14px; color:#C62828;"><span>Descuento (${t.descuento_motivo || ''})</span><span>-$${parseFloat(t.descuento_monto).toFixed(2)}</span></div>
  ` : '';

  panel.innerHTML = `
    <div class="encabezado-ticket">
      <span style="display:flex; align-items:center; gap:8px;">
        <button class="btn btn-secondary btn-volver-cobro" onclick="volverABandeja()">← Volver</button>
        <h3>Ticket ${t.folio}</h3>
      </span>
      <button class="btn btn-secondary" id="btnAsignarCliente" onclick="asignarClienteCaja()">👤 ${clienteSeleccionado ? clienteSeleccionado.nombre : 'Asignar cliente'}</button>
    </div>
    ${itemsHtml}
    ${filasDescuento}
    <div class="total-box" style="font-size:28px; font-weight:800; color:var(--primary,#5FAE46); text-align:right; margin:12px 0;">Total: $${totalNetoActual().toFixed(2)}</div>

    <button class="btn btn-secondary" style="width:100%; margin-bottom:10px;" onclick="abrirDescuento()">🏷️ Aplicar descuento</button>

    <div class="metodo-pago-btns" id="metodoPagoBtns"></div>

    <div class="cobro-cols">
      <div class="cobro-izq">
        <div id="camposPago"></div>
        <button class="btn btn-primary" id="btnConfirmarPago" style="width:100%; margin-top:14px;" onclick="cobrar()">✅ Confirmar Pago</button>
      </div>
      <div class="teclado-cobro" id="tecladoCobro">
        ${['7','8','9','4','5','6','1','2','3','0','.'].map(k => `<button type="button" onmousedown="event.preventDefault()" onclick="tecladoCobro('${k}')">${k}</button>`).join('')}
        <button type="button" class="tc-borrar" onmousedown="event.preventDefault()" onclick="tecladoCobro('borrar')">Borrar</button>
        <button type="button" class="tc-exacto" onmousedown="event.preventDefault()" onclick="tecladoCobro('exacto')">Exacto</button>
        <button type="button" class="tc-enter" onmousedown="event.preventDefault()" onclick="tecladoCobro('enter')">ENTER</button>
      </div>
    </div>
  `;
  panel.classList.toggle('abierto', pantallaAngosta());
  if (pantallaAngosta()) panel.scrollTop = 0;
  renderBotonesMetodoPago();
}

// Construye los botones de método de pago solo con los que estén activados
// en Configuración → Formas de Pago. Si el negocio nunca configuró nada,
// se usan los 4 métodos clásicos que siempre existieron (comportamiento
// igual al de antes de esta función, para no romper nada por defecto).
function renderBotonesMetodoPago() {
  const config = configuracionNegocioCaja || {};
  const etiquetaTransferencia = config.transferencia_etiqueta || 'Transferencia';

  const metodosDisponibles = [
    { id: 'efectivo', label: 'Efectivo', activo: true },
    { id: 'tarjeta', label: 'Tarjeta', activo: config.tarjeta_habilitado !== false },
    { id: 'transferencia', label: etiquetaTransferencia, activo: config.transferencia_habilitado !== false },
    { id: 'dolares', label: '💵 Dólares', activo: !!config.dolares_habilitado },
    { id: 'cheque', label: '🖋️ Cheque', activo: !!config.cheque_habilitado },
    { id: 'vale_despensa', label: '🎟️ Vale', activo: !!config.vales_habilitado },
    { id: 'mixto', label: 'Mixto', activo: config.mixto_habilitado !== false },
    { id: 'credito', label: '💳 Fiado', activo: config.credito_habilitado !== false }
  ];

  const idsBoton = { efectivo: 'btnEfectivo', tarjeta: 'btnTarjeta', transferencia: 'btnTransferencia', dolares: 'btnDolares', cheque: 'btnCheque', vale_despensa: 'btnVale', mixto: 'btnMixto', credito: 'btnCredito' };

  document.getElementById('metodoPagoBtns').innerHTML = metodosDisponibles
    .filter(m => m.activo)
    .map(m => `<button class="btn btn-secondary" id="${idsBoton[m.id]}" onclick="setMetodo('${m.id}')">${m.label}</button>`)
    .join('');

  // El primer método activo disponible es el que queda seleccionado al abrir el ticket.
  const primerDisponible = metodosDisponibles.find(m => m.activo);
  if (primerDisponible) setMetodo(primerDisponible.id);
}

async function editarCantidad(itemId, cantidadActual) {
  const nueva = await solicitarTexto('Nueva cantidad:', cantidadActual);
  if (nueva === null) return;
  const cantidad = parseFloat(nueva);
  if (!cantidad || cantidad <= 0) { mostrarToast('Cantidad inválida', 'error'); return; }

  try {
    await apiFetch(`/tickets/item/${itemId}`, { method: 'PUT', body: JSON.stringify({ cantidad }) });
    await cargarTicket(ticketActual.folio);
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

async function quitarItem(itemId) {
  const confirmado = await confirmarAccion('¿Quitar este producto del ticket?');
  if (!confirmado) return;
  try {
    await apiFetch(`/tickets/item/${itemId}`, { method: 'DELETE' });
    await cargarTicket(ticketActual.folio);
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

function setMetodo(m) {
  metodoPago = m;
  ['Efectivo','Tarjeta','Transferencia','Mixto','Credito','Dolares','Cheque','Vale'].forEach(nombre => {
    const btn = document.getElementById('btn' + nombre);
    if (btn) btn.classList.toggle('activo', (nombre === 'Vale' ? 'vale_despensa' : nombre.toLowerCase()) === m);
  });

  // En celular no se abre el teclado del teléfono: se usa el teclado grande de la pantalla.
  const modo = pantallaAngosta() ? 'none' : 'decimal';
  const teclado = document.getElementById('tecladoCobro');
  if (teclado) teclado.style.display = (m === 'efectivo' || m === 'mixto' || m === 'dolares') ? '' : 'none';

  let idCampoPrincipal = null;
  const camposDiv = document.getElementById('camposPago');
  if (m === 'mixto') {
    camposDiv.innerHTML = `
      <input type="text" class="campo-num" inputmode="${modo}" autocomplete="off" id="montoEfectivo" placeholder="Monto en efectivo" style="margin-bottom:8px;" oninput="calcularFaltanteMixto()">
      <input type="text" class="campo-num" inputmode="${modo}" autocomplete="off" id="montoTarjeta" placeholder="Monto en tarjeta" oninput="calcularFaltanteMixto()">
      <div id="faltanteMixtoTexto" class="cambio-grande" style="margin-top:12px;"></div>
    `;
    calcularFaltanteMixto();
    idCampoPrincipal = 'montoEfectivo';
  } else if (m === 'efectivo') {
    camposDiv.innerHTML = `
      <input type="text" class="campo-num" inputmode="${modo}" autocomplete="off" id="montoRecibido" placeholder="Efectivo recibido" oninput="calcularCambio()">
      <div id="cambioTexto" class="cambio-grande"></div>
    `;
    pintarCambio('cambioTexto', 0, 0, '');
    idCampoPrincipal = 'montoRecibido';
  } else if (m === 'credito') {
    camposDiv.innerHTML = `
      <input type="text" id="buscarCliente" placeholder="Buscar cliente por nombre..." oninput="buscarClientes()">
      <div id="resultadosCliente"></div>
      <div id="clienteElegido" style="margin-top:8px; font-weight:600;">${clienteSeleccionado ? 'Cliente seleccionado: ' + clienteSeleccionado.nombre : ''}</div>
    `;
  } else if (m === 'dolares') {
    const tipoCambio = parseFloat((configuracionNegocioCaja || {}).tipo_cambio_dolar || 0);
    const totalDolares = tipoCambio > 0 ? (totalNetoActual() / tipoCambio) : 0;
    camposDiv.innerHTML = `
      <p style="font-size:14px; color:#666;">Tipo de cambio: $${tipoCambio.toFixed(4)} MXN/USD — Total a cobrar: <b>$${totalDolares.toFixed(2)} USD</b></p>
      <input type="text" class="campo-num" inputmode="${modo}" autocomplete="off" id="dolaresRecibidos" placeholder="Dólares recibidos" oninput="calcularCambioDolares()">
      <div id="cambioDolaresTexto" class="cambio-grande"></div>
    `;
    pintarCambio('cambioDolaresTexto', 0, 0, ' USD');
    idCampoPrincipal = 'dolaresRecibidos';
  } else if (m === 'tarjeta') {
    const comision = parseFloat((configuracionNegocioCaja || {}).tarjeta_comision_porcentaje || 0);
    if (comision > 0) {
      const subtotal = totalNetoActual();
      const montoComision = subtotal * comision / 100;
      camposDiv.innerHTML = `
        <div style="font-size:14px; background:#F4F5F6; border-radius:10px; padding:10px 14px;">
          <div style="display:flex; justify-content:space-between;"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
          <div style="display:flex; justify-content:space-between; color:#C62828;"><span>Comisión tarjeta (${comision}%)</span><span>+$${montoComision.toFixed(2)}</span></div>
          <div style="display:flex; justify-content:space-between; font-weight:700; border-top:1px solid #DDD; margin-top:6px; padding-top:6px;"><span>Total a cobrar</span><span>$${(subtotal + montoComision).toFixed(2)}</span></div>
        </div>
      `;
    } else {
      camposDiv.innerHTML = '';
    }
  } else {
    camposDiv.innerHTML = '';
  }

  campoNumericoCobro = null;
  // En computadora el cursor queda listo en el campo principal; en celular no (para no tapar la pantalla).
  if (idCampoPrincipal && !pantallaAngosta()) {
    setTimeout(() => { const c = document.getElementById(idCampoPrincipal); if (c) c.focus(); }, 0);
  }
}

// ---------- Teclado en pantalla (cobro) ----------
// Escribe en el campo numérico activo (efectivo recibido, montos del pago mixto o dólares).
// ENTER confirma el pago (en mixto, de efectivo pasa a tarjeta); "Exacto" pone el total justo.
let campoNumericoCobro = null;

(function () {
  const panel = document.getElementById('panelCobro');
  panel.addEventListener('focusin', (e) => { if (e.target.classList && e.target.classList.contains('campo-num')) campoNumericoCobro = e.target; });
  // Solo números y un punto, escriba quien escriba (teclado físico o en pantalla)
  panel.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.classList || !el.classList.contains('campo-num')) return;
    let v = el.value.replace(/[^0-9.]/g, '');
    const i = v.indexOf('.');
    if (i !== -1) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '');
    if (v !== el.value) el.value = v;
  }, true);
  // Enter del teclado físico = ENTER del teclado en pantalla
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('campo-num')) { e.preventDefault(); tecladoCobro('enter'); }
  });
})();

function tecladoCobro(tecla) {
  if (!ticketActual) return;
  let campo = campoNumericoCobro && document.body.contains(campoNumericoCobro) ? campoNumericoCobro : null;
  if (!campo) campo = document.querySelector('#camposPago .campo-num');

  if (tecla === 'enter') {
    const ef = document.getElementById('montoEfectivo');
    const tj = document.getElementById('montoTarjeta');
    if (ef && tj && campo === ef) {
      if (!tj.value) {
        const resto = totalNetoActual() - (parseFloat(ef.value) || 0);
        if (resto > 0) tj.value = resto.toFixed(2);
        calcularFaltanteMixto();
      }
      tj.focus();
      return;
    }
    cobrar();
    return;
  }
  if (!campo) return;

  if (tecla === 'exacto') {
    const total = totalNetoActual();
    if (campo.id === 'dolaresRecibidos') {
      const tc = parseFloat((configuracionNegocioCaja || {}).tipo_cambio_dolar || 0);
      campo.value = tc > 0 ? (total / tc).toFixed(2) : '';
    } else {
      campo.value = total.toFixed(2);
    }
  } else if (tecla === 'borrar') {
    campo.value = campo.value.slice(0, -1);
  } else if (tecla === '.') {
    if (!campo.value.includes('.')) campo.value = (campo.value || '0') + '.';
  } else {
    campo.value += tecla;
  }
  if (!pantallaAngosta()) campo.focus();
  campo.dispatchEvent(new Event('input', { bubbles: true }));
}

// Cambio (o lo que falta) grande y con color: verde = cambio a entregar, rojo = falta dinero.
function pintarCambio(idElemento, recibido, cambio, sufijo) {
  const el = document.getElementById(idElemento);
  if (!el) return;
  const redondeado = Math.round(cambio * 100) / 100;
  if (!recibido) { el.className = 'cambio-grande vacio'; el.innerHTML = '<span class="cg-etiqueta">CAMBIO</span><span class="cg-monto">$0.00' + sufijo + '</span>'; return; }
  if (redondeado >= 0) {
    el.className = 'cambio-grande ok';
    el.innerHTML = '<span class="cg-etiqueta">CAMBIO A ENTREGAR</span><span class="cg-monto">$' + redondeado.toFixed(2) + sufijo + '</span>';
  } else {
    el.className = 'cambio-grande falta';
    el.innerHTML = '<span class="cg-etiqueta">FALTA</span><span class="cg-monto">$' + Math.abs(redondeado).toFixed(2) + sufijo + '</span>';
  }
}

// Pago mixto: lo que FALTA por cubrir (rojo), o PAGO COMPLETO (verde).
function calcularFaltanteMixto() {
  const el = document.getElementById('faltanteMixtoTexto');
  if (!el || !ticketActual) return;
  const ef = parseFloat(document.getElementById('montoEfectivo').value || 0) || 0;
  const tj = parseFloat(document.getElementById('montoTarjeta').value || 0) || 0;
  const dif = Math.round((totalNetoActual() - ef - tj) * 100) / 100; // >0 falta, <0 sobra
  let clase, etiqueta, monto;
  if (Math.abs(dif) < 0.005) { clase = 'ok'; etiqueta = 'PAGO COMPLETO'; monto = 0; }
  else if (dif > 0) { clase = 'falta'; etiqueta = 'FALTA'; monto = dif; }
  else { clase = 'falta'; etiqueta = 'SOBRA'; monto = -dif; }
  el.className = 'cambio-grande ' + clase;
  el.innerHTML = '<span class="cg-etiqueta">' + etiqueta + '</span><span class="cg-monto">$' + monto.toFixed(2) + '</span>';
}

// Cambio en dólares (se entrega en dólares).
function calcularCambioDolares() {
  const tipoCambio = parseFloat((configuracionNegocioCaja || {}).tipo_cambio_dolar || 0);
  const totalDolares = tipoCambio > 0 ? (totalNetoActual() / tipoCambio) : 0;
  const recibido = parseFloat(document.getElementById('dolaresRecibidos').value || 0);
  pintarCambio('cambioDolaresTexto', recibido, recibido - totalDolares, ' USD');
}

async function abrirDescuentoItem(itemId) {
  const motivo = await solicitarTexto('Motivo del descuento para este producto:');
  if (!motivo) return;

  const entrada = await solicitarTexto('Porcentaje de descuento (ej. 10), o escribe "monto:20" para un monto fijo en pesos:');
  if (!entrada) return;

  let body = { motivo };
  if (entrada.trim().toLowerCase().startsWith('monto:')) {
    body.monto = parseFloat(entrada.split(':')[1]);
  } else {
    body.porcentaje = parseFloat(entrada);
  }

  await intentarAplicarDescuentoItem(itemId, body);
}

async function intentarAplicarDescuentoItem(itemId, body) {
  try {
    await apiFetch(`/tickets/item/${itemId}/descuento`, { method: 'PUT', body: JSON.stringify(body) });
    mostrarToast('Descuento aplicado al producto', 'exito');
    await cargarTicket(ticketActual.folio);
  } catch (err) {
    if (err.message.includes('supera el 15%') || err.message.includes('autorización')) {
      const usuarioAutoriza = await solicitarTexto('Este descuento requiere autorización. Usuario de un dueño/gerente:');
      if (!usuarioAutoriza) return;
      const passwordAutoriza = await solicitarTexto('Contraseña de autorización:');
      if (!passwordAutoriza) return;
      await intentarAplicarDescuentoItem(itemId, { ...body, autorizacion: { usuario: usuarioAutoriza, password: passwordAutoriza } });
    } else {
      mostrarToast(err.message, 'error');
    }
  }
}

async function abrirDescuento() {
  const motivo = await solicitarTexto('Motivo del descuento:');
  if (!motivo) return;

  const entrada = await solicitarTexto('Porcentaje de descuento (ej. 10), o escribe "monto:50" para un monto fijo en pesos:');
  if (!entrada) return;

  let body = { motivo };
  if (entrada.trim().toLowerCase().startsWith('monto:')) {
    body.monto = parseFloat(entrada.split(':')[1]);
  } else {
    body.porcentaje = parseFloat(entrada);
  }

  await intentarAplicarDescuento(body);
}

async function intentarAplicarDescuento(body) {
  try {
    await apiFetch(`/tickets/${ticketActual.id}/descuento`, { method: 'PUT', body: JSON.stringify(body) });
    mostrarToast('Descuento aplicado', 'exito');
    await cargarTicket(ticketActual.folio);
  } catch (err) {
    if (err.message.includes('supera el 15%') || err.message.includes('autorización')) {
      const usuarioAutoriza = await solicitarTexto('Este descuento requiere autorización. Usuario de un dueño/gerente:');
      if (!usuarioAutoriza) return;
      const passwordAutoriza = await solicitarTexto('Contraseña de autorización:');
      if (!passwordAutoriza) return;
      await intentarAplicarDescuento({ ...body, autorizacion: { usuario: usuarioAutoriza, password: passwordAutoriza } });
    } else {
      mostrarToast(err.message, 'error');
    }
  }
}

function calcularCambio() {
  const recibido = parseFloat(document.getElementById('montoRecibido').value || 0);
  pintarCambio('cambioTexto', recibido, recibido - totalNetoActual(), '');
}

let debounceBusqueda;
function buscarClientes() {
  clearTimeout(debounceBusqueda);
  debounceBusqueda = setTimeout(async () => {
    const texto = document.getElementById('buscarCliente').value.trim();
    if (texto.length < 2) { document.getElementById('resultadosCliente').innerHTML = ''; return; }
    const resultados = await apiFetch(`/clientes/buscar/${texto}`);
    document.getElementById('resultadosCliente').innerHTML = resultados.map(c => `
      <div class="resultado-cliente" onclick='elegirCliente(${JSON.stringify(c)})'>
        ${c.nombre} — Debe $${parseFloat(c.saldo_actual).toFixed(2)} / Límite $${parseFloat(c.limite_credito).toFixed(2)}
      </div>
    `).join('');
  }, 300);
}

function elegirCliente(cliente) {
  clienteSeleccionado = cliente;
  document.getElementById('resultadosCliente').innerHTML = '';
  document.getElementById('buscarCliente').value = '';
  document.getElementById('clienteElegido').textContent = `Cliente seleccionado: ${cliente.nombre}`;
  const bc = document.getElementById('btnAsignarCliente'); if (bc) bc.textContent = '👤 ' + cliente.nombre;
}

async function abrirCajonManual() {
  const motivo = await solicitarTexto('Motivo (ej. Sacar cambio, meter fondo):');
  if (!motivo) return;
  try {
    await abrirCajonDinero();
    await apiFetch('/turnos/registrar-apertura-cajon', { method: 'POST', body: JSON.stringify({ motivo }) });
    mostrarToast('Cajón abierto', 'exito');
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

// Asigna un cliente al ticket (sale en el comprobante y sirve para el fiado).
async function asignarClienteCaja() {
  if (!ticketActual) return;
  const texto = await solicitarTexto('Buscar cliente por nombre:');
  if (!texto) return;
  try {
    const resultados = await apiFetch(`/clientes/buscar/${encodeURIComponent(texto)}`);
    if (resultados.length === 0) { mostrarToast('No se encontró ningún cliente con ese nombre', 'error'); return; }
    let elegido = resultados[0];
    if (resultados.length > 1) {
      const nombres = resultados.map(c => c.nombre).join(', ');
      const eleccion = await solicitarTexto(`Varios clientes coinciden (${nombres}). Escribe el nombre exacto:`);
      if (!eleccion) return;
      const encontrado = resultados.find(c => c.nombre.toLowerCase() === eleccion.trim().toLowerCase());
      if (!encontrado) { mostrarToast('Ese nombre no coincide exactamente con ninguno', 'error'); return; }
      elegido = encontrado;
    }
    clienteSeleccionado = elegido;
    const bc = document.getElementById('btnAsignarCliente'); if (bc) bc.textContent = '👤 ' + elegido.nombre;
    const ce = document.getElementById('clienteElegido'); if (ce) ce.textContent = `Cliente seleccionado: ${elegido.nombre}`;
    mostrarToast(`Cliente "${elegido.nombre}" asignado`, 'exito');
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

// Entradas y salidas de dinero de la caja (requiere turno abierto).
async function registrarMovimientoRapido(tipo) {
  try {
    const turno = await apiFetch('/turnos/actual');
    if (!turno) { mostrarToast('No hay un turno de caja abierto', 'error'); return; }
    const etiqueta = tipo === 'ingreso' ? 'Entrada' : 'Salida';
    const montoTexto = await solicitarTexto(`Monto de la ${etiqueta.toLowerCase()}:`);
    if (!montoTexto) return;
    const monto = parseFloat(montoTexto);
    if (isNaN(monto) || monto <= 0) { mostrarToast('Monto inválido', 'error'); return; }
    const concepto = await solicitarTexto(`Concepto de la ${etiqueta.toLowerCase()}:`);
    if (!concepto) return;
    await apiFetch('/movimientos', { method: 'POST', body: JSON.stringify({ turno_id: turno.id, tipo, monto, concepto }) });
    mostrarToast(`${etiqueta} de $${monto.toFixed(2)} registrada`, 'exito');
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

// Estado del turno en la barra de arriba.
async function actualizarChipTurno() {
  const chip = document.getElementById('chipTurno');
  try {
    const turno = await apiFetch('/turnos/actual');
    chip.textContent = turno ? '🟢 Turno abierto' : '🔴 Sin turno (se abre al cobrar)';
    chip.classList.toggle('cerrado', !turno);
  } catch (err) {
    chip.textContent = '⚪ Turno: sin conexión';
    chip.classList.add('cerrado');
  }
}

function totalNetoDeTicket(t) {
  const di = (t.items || []).reduce((s, i) => s + parseFloat(i.descuento_monto || 0), 0);
  return parseFloat(t.total) - parseFloat(t.descuento_monto || 0) - di;
}

// Imprime una copia de un ticket ya cobrado (reimpresión o copia del historial).
async function imprimirCopiaTicketCaja(ticket, pie) {
  const config = configuracionNegocioCaja || await apiFetch('/configuracion');
  const neto = totalNetoDeTicket(ticket);
  const datosTicket = {
    ancho_ticket: obtenerAnchoTicketDispositivo(config),
    negocio: { nombre: 'Compoint Punto de Soluciones', direccion: config.direccion, telefono: config.telefono },
    folio: ticket.folio,
    fecha: new Date(ticket.fecha_pago || ticket.fecha_creacion).toLocaleString(),
    items: [
      ...ticket.items.map(i => ({
        nombre_producto: i.nombre_producto,
        detalle: GRANEL.detalle(i),
        subtotal: parseFloat(i.subtotal).toFixed(2)
      })),
      ...((parseFloat(ticket.total) - neto) > 0.004
        ? [{ nombre_producto: 'Descuentos', detalle: '', subtotal: (-(parseFloat(ticket.total) - neto)).toFixed(2) }] : [])
    ],
    total: neto.toFixed(2),
    piePagina: pie,
    lineasInferiores: config.lineas_inferiores !== undefined ? config.lineas_inferiores : 3,
    incluirPrecioUnitario: config.incluir_precio_unitario !== false,
    descripcionCompleta: config.descripcion_completa !== false,
    ...estiloTicketDesdeConfig(config, true)
  };
  const modoImpresion = localStorage.getItem('modo_impresion') || 'directo';
  if (modoImpresion === 'sistema') await imprimirConDialogoDelSistema(datosTicket);
  else await imprimirTicketBLE(datosTicket);
}

async function reimprimirUltimoTicketCaja() {
  try {
    const ticket = await apiFetch('/tickets/ultimo-pagado');
    await imprimirCopiaTicketCaja(ticket, `Pagado con ${String(ticket.metodo_pago || '').toUpperCase()} — REIMPRESIÓN`);
    mostrarToast(`Reimprimiendo ticket ${ticket.folio}`, 'exito');
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

// ---------- Historial de ventas y devoluciones del día ----------
let ticketHistorialCaja = null;

function abrirHistorialCaja() {
  document.getElementById('modalHistorialCaja').style.display = 'flex';
  document.getElementById('fechaHistorialCaja').value = new Date().toISOString().split('T')[0];
  cargarHistorialCaja();
}
function cerrarHistorialCaja() {
  document.getElementById('modalHistorialCaja').style.display = 'none';
}

async function cargarHistorialCaja() {
  try {
    const fecha = document.getElementById('fechaHistorialCaja').value;
    const ventas = await apiFetch(`/tickets/historial-dia?fecha=${fecha}`);
    document.getElementById('listaHistorialCaja').innerHTML = ventas.map(v => `
      <div class="hist-fila" data-id="${v.id}" data-folio="${v.folio}">
        <span><b>${v.folio}</b>${v.estado === 'cancelado' ? ' <span style="color:#C62828;">(cancelado)</span>' : ''}<br><small>${v.cajero_nombre || '—'} · ${new Date(v.fecha_pago || v.fecha_creacion).toLocaleTimeString()}</small></span>
        <b>$${parseFloat(v.total).toFixed(2)}</b>
      </div>`).join('') || '<p style="color:#888; text-align:center;">Sin ventas en esta fecha</p>';
    document.querySelectorAll('#listaHistorialCaja .hist-fila').forEach(f => { f.onclick = () => verTicketHistorialCaja(f); });
    document.getElementById('detalleHistorialCaja').innerHTML = '<p style="color:#888; text-align:center;">Selecciona un ticket para ver el detalle</p>';
    ticketHistorialCaja = null;
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

async function verTicketHistorialCaja(fila) {
  try {
    document.querySelectorAll('#listaHistorialCaja .hist-fila').forEach(f => f.classList.toggle('sel', f === fila));
    const t = await apiFetch(`/tickets/folio/${encodeURIComponent(fila.dataset.folio)}`);
    ticketHistorialCaja = t;
    document.getElementById('detalleHistorialCaja').innerHTML = `
      <h4>Folio: ${t.folio}</h4>
      <p style="font-size:13px; color:#666;">Estado: ${t.estado} — Método: ${t.metodo_pago || '—'}</p>
      ${t.items.map(i => `<div class="detalle-item"><span class="info"><img class="mini-foto" src="${i.imagen_url || IMAGEN_RESPALDO}" alt=""><span>${i.nombre_producto}<br><small>${i.tipo_venta === 'peso' ? GRANEL.detalle(i, '×') : `${i.cantidad} × $${parseFloat(i.precio_unitario).toFixed(2)}`}</small></span></span><span>$${parseFloat(i.subtotal).toFixed(2)}</span></div>`).join('')}
      <p style="text-align:right; font-weight:700; margin:10px 0;">Total: $${totalNetoDeTicket(t).toFixed(2)}</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn btn-secondary" onclick="imprimirCopiaHistorialCaja()">🖨️ Imprimir copia</button>
        ${t.estado === 'pagado' ? `<button class="btn btn-secondary" onclick="window.location.href='admin/devoluciones.html?folio=${encodeURIComponent(t.folio)}'">↩️ Devolver producto / cancelar</button>` : ''}
      </div>`;
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

async function imprimirCopiaHistorialCaja() {
  if (!ticketHistorialCaja) return;
  try { await imprimirCopiaTicketCaja(ticketHistorialCaja, 'COPIA'); } catch (err) { mostrarToast(err.message, 'error'); }
}

async function cobrar() {
  const boton = document.getElementById('btnConfirmarPago');
  if (boton) { boton.disabled = true; boton.textContent = 'Procesando...'; }

  try {
    // Sin turno abierto: se abre una ventana para abrirlo y declarar el efectivo en caja.
    const turno = await asegurarTurnoAbierto();
    if (!turno) return;

    let montoEfectivo = 0, montoTarjeta = 0, cliente_id = null;
    let recibidoEfectivoParaTicket = null, cambioParaTicket = null;
    const totalAPagar = totalNetoActual();

    if (metodoPago === 'efectivo') {
      montoEfectivo = totalAPagar;
      const recibido = parseFloat(document.getElementById('montoRecibido').value || 0);
      const bloquearInsuficiente = (configuracionNegocioCaja || {}).efectivo_bloquear_insuficiente !== false;
      if (bloquearInsuficiente && recibido < totalAPagar) {
        mostrarToast('El efectivo ingresado es menor que el total — este negocio no permite cobrar así', 'error');
        return;
      }
      // Si no se bloqueó por insuficiente y el cajero dejó el campo en 0,
      // no tiene sentido imprimir "Pagó con $0.00" — solo se imprime si
      // de verdad se capturó un monto.
      if (recibido > 0) {
        recibidoEfectivoParaTicket = recibido.toFixed(2);
        cambioParaTicket = Math.max(0, recibido - totalAPagar).toFixed(2);
      }
    } else if (metodoPago === 'tarjeta') {
      const comision = parseFloat((configuracionNegocioCaja || {}).tarjeta_comision_porcentaje || 0);
      montoTarjeta = totalAPagar * (1 + comision / 100);
    } else if (metodoPago === 'transferencia' || metodoPago === 'dolares' || metodoPago === 'cheque' || metodoPago === 'vale_despensa') {
      montoTarjeta = totalAPagar;
      if (metodoPago === 'dolares') {
        const tipoCambio = parseFloat((configuracionNegocioCaja || {}).tipo_cambio_dolar || 0);
        const totalDolares = tipoCambio > 0 ? (totalAPagar / tipoCambio) : 0;
        const recibidoDolares = parseFloat(document.getElementById('dolaresRecibidos').value || 0);
        if (recibidoDolares < totalDolares) {
          mostrarToast('Los dólares recibidos no alcanzan el total', 'error');
          return;
        }
      }
    } else if (metodoPago === 'mixto') {
      montoEfectivo = parseFloat(document.getElementById('montoEfectivo').value || 0);
      montoTarjeta = parseFloat(document.getElementById('montoTarjeta').value || 0);
      if (Math.abs((montoEfectivo + montoTarjeta) - totalAPagar) > 0.01) {
        mostrarToast('La suma de efectivo y tarjeta debe ser igual al total', 'error');
        return;
      }
    } else if (metodoPago === 'credito') {
      if (!clienteSeleccionado) { mostrarToast('Selecciona un cliente para autorizar el fiado', 'error'); return; }
      cliente_id = clienteSeleccionado.id;
    }

    const resultadoPago = await apiFetch(`/tickets/${ticketActual.id}/pagar`, {
      method: 'POST',
      body: JSON.stringify({
        metodo_pago: metodoPago,
        monto_efectivo: montoEfectivo,
        monto_tarjeta: montoTarjeta,
        turno_id: turno.id,
        cliente_id,
        efectivo_recibido: recibidoEfectivoParaTicket
      })
    });

    mostrarToast('Pago procesado correctamente', 'exito');
    if (resultadoPago.productos_agotados && resultadoPago.productos_agotados.length > 0) {
      mostrarToast(`⚠️ Se agotó el inventario de: ${resultadoPago.productos_agotados.join(', ')} — registra reabastecimiento en Inventario`, 'error');
    }
    if ((configuracionNegocioCaja || {}).cajon_abrir_automatico) {
      try { await abrirCajonDinero(); } catch (err) { console.error('No se pudo abrir el cajón automáticamente:', err.message); }
    }
    await imprimirComprobante(ticketActual, metodoPago, recibidoEfectivoParaTicket, cambioParaTicket);
    ticketActual = null;
    clienteSeleccionado = null;
    limpiarPanelCobro();
    cargarBandeja();
    actualizarChipTurno();
  } catch (err) {
    mostrarToast('Error al cobrar: ' + err.message, 'error');
  } finally {
    // Si el panel ya se reemplazó (pago exitoso), este botón ya no existe en
    // el DOM y esto simplemente no hace nada — está bien.
    const botonActual = document.getElementById('btnConfirmarPago');
    if (botonActual) { botonActual.disabled = false; botonActual.textContent = '✅ Confirmar Pago'; }
  }
}

let configuracionNegocioCaja = null;
async function cargarConfiguracionNegocioCaja() {
  try {
    configuracionNegocioCaja = await apiFetch('/configuracion');
  } catch (err) {
    configuracionNegocioCaja = { ancho_ticket: '80mm' };
  }
}

async function imprimirComprobante(ticket, metodoPagoUsado, montoRecibido = null, cambio = null) {
  const config = configuracionNegocioCaja || {};
  const comision = parseFloat(config.tarjeta_comision_porcentaje || 0);
  const aplicaComision = metodoPagoUsado === 'tarjeta' && comision > 0;
  const subtotalTicket = totalNetoActual(); // ya incluye cualquier descuento aplicado
  const montoComision = aplicaComision ? subtotalTicket * comision / 100 : 0;

  const itemsComprobante = ticket.items.map(i => ({
    nombre_producto: i.nombre_producto,
    detalle: GRANEL.detalle(i),
    subtotal: parseFloat(i.subtotal).toFixed(2)
  }));
  if (aplicaComision) {
    itemsComprobante.push({
      nombre_producto: `Comisión tarjeta (${comision}%)`,
      detalle: '',
      subtotal: montoComision.toFixed(2)
    });
  }

  const datosTicket = {
    ancho_ticket: obtenerAnchoTicketDispositivo(config),
    negocio: {
      nombre: 'Compoint Punto de Soluciones',
      direccion: config.direccion,
      telefono: config.telefono
    },
    folio: ticket.folio,
    fecha: new Date().toLocaleString(),
    items: itemsComprobante,
    total: (subtotalTicket + montoComision).toFixed(2),
    montoRecibido,
    cambio,
    piePagina: `Pagado con ${metodoPagoUsado.toUpperCase()} — ¡Gracias por su compra!`,
    lineasSuperiores: config.lineas_superiores || 0,
    lineasInferiores: config.lineas_inferiores !== undefined ? config.lineas_inferiores : 3,
    incluirPrecioUnitario: config.incluir_precio_unitario !== false,
    descripcionCompleta: config.descripcion_completa !== false,
    // El comprobante final (ya pagado) NO lleva QR/código de barras — ese
    // código es solo para que Caja localice el pedido antes de cobrar; una
    // vez cobrado, ya no hay nada que escanear.
    imprimirDatosCliente: !!config.imprimir_datos_cliente,
    cliente: clienteSeleccionado ? { nombre: clienteSeleccionado.nombre, telefono: clienteSeleccionado.telefono } : null,
    // Logo, tamaños de letra, acentos y QR de promoción (Configuración → Diseñador de ticket)
    ...estiloTicketDesdeConfig(config, true)
  };

  const modoImpresion = localStorage.getItem('modo_impresion') || 'directo';
  if (modoImpresion === 'sistema') {
    await imprimirConDialogoDelSistema(datosTicket);
    return;
  }

  try {
    await imprimirTicketBLE(datosTicket);
  } catch (err) {
    actualizarBannerImpresoraCaja();
    const usarRespaldo = await confirmarAccion(`No se pudo imprimir el comprobante por Bluetooth/USB (${err.message}). ¿Imprimir con una impresora ya instalada en esta computadora (Windows)?`);
    if (usarRespaldo) await imprimirConDialogoDelSistema(datosTicket);
  }
}

cargarConfiguracionNegocioCaja();

function actualizarBannerImpresoraCaja() {
  const modoImpresion = localStorage.getItem('modo_impresion') || 'directo';
  document.getElementById('bannerImpresoraCaja').style.display = (modoImpresion === 'sistema' || impresoraConectada()) ? 'none' : 'block';
}
async function conectarImpresoraCaja() {
  try {
    await conectarImpresora();
    actualizarBannerImpresoraCaja();
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

async function conectarImpresoraCajaUSB() {
  try {
    await conectarImpresoraUSB();
    actualizarBannerImpresoraCaja();
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}
setTimeout(actualizarBannerImpresoraCaja, 500);

function toggleScanner() {
  if (scannerActivo) {
    html5QrCode.stop().catch(() => {});
    scannerActivo = false;
    return;
  }
  html5QrCode = new Html5Qrcode("scanner");
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 280, height: 160 } },
    (codigo) => { procesarCodigoEscaneadoCaja(codigo); html5QrCode.stop().catch(() => {}); scannerActivo = false; }
  ).then(() => {
    scannerActivo = true;
  }).catch((err) => {
    mostrarToast(mensajeErrorCamara(err), 'error');
  });
}

// Un código escaneado en Caja puede ser dos cosas muy distintas: el folio de
// un ticket (lo normal — lo trae desde Mostrador para cobrar), o una
// etiqueta que la báscula ya imprimió por su cuenta (PLU + peso/precio
// embebido) para agregar ese producto ya pesado al ticket que está abierto
// en este momento, sin tener que regresarlo a Mostrador. Se distinguen por
// formato (la etiqueta de báscula son 13 dígitos numéricos con dígito
// verificador válido; el folio de ticket nunca tiene esa forma), así que no
// hace falta que el cajero elija nada.
async function procesarCodigoEscaneadoCaja(codigo) {
  const tipoDatoBascula = (configuracionNegocioCaja && configuracionNegocioCaja.bascula_tipo_dato) || 'peso';
  const decodificado = decodificarCodigoBascula(codigo, tipoDatoBascula);
  if (decodificado) {
    await agregarProductoPesadoPorEtiquetaCaja(decodificado);
    return;
  }
  cargarTicket(codigo);
}

// Agrega un producto ya pesado (leído de la etiqueta de la báscula) al
// ticket que está abierto ahorita en Caja. Requiere tener un ticket
// cargado — si el cajero aún no ha cargado ninguno, no hay a dónde agregarlo.
async function agregarProductoPesadoPorEtiquetaCaja({ plu, valor, tipoDato }) {
  if (!ticketActual) {
    mostrarToast('Primero carga un ticket (escanea su folio o selecciónalo de la bandeja) antes de agregar un producto pesado.', 'error');
    return;
  }

  let producto;
  try {
    producto = await apiFetch(`/productos/codigo/${plu}`);
  } catch (err) {
    mostrarToast(`La etiqueta trae el código de producto "${plu}", pero ningún producto tiene ese código de barras registrado.`, 'error');
    return;
  }

  // La etiqueta con PRECIO se cobra por ese importe exacto (sin centavos de diferencia por redondeo).
  const calculo = tipoDato === 'precio'
    ? GRANEL.porImporte(producto, valor, { promos: false })
    : GRANEL.porCantidad(producto, valor, { promos: false });
  if (!calculo || calculo.error) {
    mostrarToast(`La etiqueta de "${producto.nombre}" no se pudo leer: revisa el precio del producto.`, 'error');
    return;
  }
  const peso = calculo.cantidad;

  try {
    await apiFetch(`/tickets/${ticketActual.id}/agregar-item`, {
      method: 'POST',
      body: JSON.stringify(GRANEL.renglon(producto, calculo))
    });
    await cargarTicket(ticketActual.folio);
    mostrarToast(`${producto.nombre}: ${peso.toFixed(3)} kg agregado desde la etiqueta de báscula`, 'exito');
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

// Lector de código de barras físico: puede traer el folio de un ticket o
// una etiqueta de báscula (ver procesarCodigoEscaneadoCaja arriba).
activarLectorFisico(procesarCodigoEscaneadoCaja);

// Campo visible para el lector: lo que se escanee (o escriba) aquí y termine
// en Enter se procesa igual que el escaneo con cámara. Se detiene la
// propagación para que el lector global no lo procese dos veces.
const campoLectorCaja = document.getElementById('campoLectorCaja');
if (campoLectorCaja) {
  campoLectorCaja.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return;
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const codigo = campoLectorCaja.value.trim();
      campoLectorCaja.value = '';
      if (codigo) procesarCodigoEscaneadoCaja(codigo);
    }
  });
  // En computadora queda listo para escanear sin hacer clic (en celular no, para que no salga el teclado).
  if (window.innerWidth >= 900) campoLectorCaja.focus();
}

cargarBandeja();
setInterval(cargarBandeja, 15000);
actualizarChipTurno();
setInterval(actualizarChipTurno, 60000);

// Si se llegó desde Caja Avanzada con un folio en la URL, cargarlo directo
// para continuar el cobro sin tener que buscarlo en la bandeja.
const folioDesdeUrl = new URLSearchParams(window.location.search).get('folio');
if (folioDesdeUrl) {
  cargarTicket(folioDesdeUrl);
  window.history.replaceState({}, '', 'caja.html');
}

// Atajos de teclado: F2 escanear, F4 cobrar (si hay ticket seleccionado),
// ESC cierra el panel de cobro. F1 y F3 no aplican en Caja (no hay buscador
// de texto ni concepto de "nueva venta" aquí) — no se simulan.
document.addEventListener('keydown', (e) => {
  const enCampoDeTexto = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);

  if (e.key === 'Escape') {
    ticketActual = null;
    clienteSeleccionado = null;
    limpiarPanelCobro();
    return;
  }
  if (enCampoDeTexto) return;

  if (e.key === 'F2') { e.preventDefault(); toggleScanner(); }
  else if (e.key === 'F4') { e.preventDefault(); if (ticketActual) cobrar(); }
});
