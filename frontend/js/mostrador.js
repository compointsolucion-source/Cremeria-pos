requiereLogin();

let productos = [];
let kits = [];
let categorias = [];
let categoriaActiva = null; // null=todos, 'kits'=kits, número=categoría
let carrito = [];
let productoSeleccionado = null;
let pesoActual = '';
let cantidadUnidad = 1;
let scannerActivo = false;
let html5QrCode;

async function cargarDatos() {
  try {
    productos = await apiFetch('/productos');
    kits = await apiFetch('/kits');
    categorias = await apiFetch('/productos/categorias');
    guardarCatalogoLocal(productos, kits, categorias); // respaldo para cuando no haya internet
    renderCategorias();
    renderProductos();
  } catch (err) {
    if (esErrorDeConexion(err)) {
      const local = await obtenerCatalogoLocal();
      if (local.productos.length > 0) {
        productos = local.productos;
        kits = local.kits;
        categorias = local.categorias;
        renderCategorias();
        renderProductos();
        const fecha = local.fecha_guardado ? new Date(local.fecha_guardado).toLocaleString() : 'fecha desconocida';
        mostrarToast(`Sin conexión — usando el catálogo guardado del ${fecha}`, 'error');
        return;
      }
    }
    mostrarToast('Error al cargar productos: ' + err.message, 'error');
  }
}

function renderCategorias() {
  const cont = document.getElementById('categorias');
  cont.innerHTML = '';
  const todas = document.createElement('div');
  todas.className = 'categoria-tab' + (categoriaActiva === null ? ' activa' : '');
  todas.textContent = 'Todos';
  todas.onclick = () => { categoriaActiva = null; renderCategorias(); renderProductos(); };
  cont.appendChild(todas);

  categorias.forEach(cat => {
    const tab = document.createElement('div');
    tab.className = 'categoria-tab' + (categoriaActiva === cat.id ? ' activa' : '');
    tab.textContent = cat.nombre;
    tab.onclick = () => { categoriaActiva = cat.id; renderCategorias(); renderProductos(); };
    cont.appendChild(tab);
  });

  if (kits.length > 0) {
    const tabKits = document.createElement('div');
    tabKits.className = 'categoria-tab kits' + (categoriaActiva === 'kits' ? ' activa' : '');
    tabKits.textContent = '📦 Kits/Combos';
    tabKits.onclick = () => { categoriaActiva = 'kits'; renderCategorias(); renderProductos(); };
    cont.appendChild(tabKits);
  }
}

function renderProductos() {
  const grid = document.getElementById('gridProductos');
  grid.innerHTML = '';

  const textoBusqueda = document.getElementById('buscadorProductos').value.trim().toLowerCase();

  // Si hay texto en el buscador, ignora las categorías y busca en todo
  // (incluyendo kits), por nombre.
  if (textoBusqueda) {
    const productosFiltrados = productos.filter(p =>
      p.nombre.toLowerCase().includes(textoBusqueda) ||
      (p.codigo_barras && p.codigo_barras.toLowerCase().includes(textoBusqueda))
    );
    const kitsFiltrados = kits.filter(k => k.nombre.toLowerCase().includes(textoBusqueda));

    kitsFiltrados.forEach(k => {
      const card = document.createElement('div');
      card.className = 'producto-card';
      card.innerHTML = `
        <span class="badge-tipo badge-kit">KIT</span>
        <img src="${k.imagen_url || 'img/kit-generico.png'}" alt="${k.nombre}">
        <div class="nombre">${k.nombre}</div>
        <div class="precio">$${parseFloat(k.precio_kit).toFixed(2)}</div>
      `;
      card.onclick = () => agregarKit(k);
      grid.appendChild(card);
    });

    productosFiltrados.forEach(p => {
      const card = document.createElement('div');
      card.className = 'producto-card';
      const badge = p.tipo_venta === 'unidad' ? '<span class="badge-tipo badge-unidad">PZA</span>' : '<span class="badge-tipo badge-peso">KG</span>';
      const precioLabel = p.tipo_venta === 'unidad' ? `$${parseFloat(p.precio).toFixed(2)}/pza` : `$${parseFloat(p.precio).toFixed(2)}/kg`;
      card.innerHTML = `${badge}<img src="${p.imagen_url || 'img/producto-generico.png'}" alt="${p.nombre}"><div class="nombre">${p.nombre}</div><div class="precio">${precioLabel}</div>`;
      card.onclick = () => seleccionarProducto(p);
      grid.appendChild(card);
    });

    if (productosFiltrados.length === 0 && kitsFiltrados.length === 0) {
      grid.innerHTML = '<p style="color:#888; padding:20px;">Sin resultados para esa búsqueda</p>';
    }
    return;
  }

  if (categoriaActiva === 'kits') {
    kits.forEach(k => {
      const card = document.createElement('div');
      card.className = 'producto-card';
      card.innerHTML = `
        <span class="badge-tipo badge-kit">KIT</span>
        <img src="${k.imagen_url || 'img/kit-generico.png'}" alt="${k.nombre}">
        <div class="nombre">${k.nombre}</div>
        <div class="precio">$${parseFloat(k.precio_kit).toFixed(2)}</div>
      `;
      card.onclick = () => agregarKit(k);
      grid.appendChild(card);
    });
    return;
  }

  const lista = categoriaActiva ? productos.filter(p => p.categoria_id === categoriaActiva) : productos;

  lista.forEach(p => {
    const card = document.createElement('div');
    card.className = 'producto-card';
    const badge = p.tipo_venta === 'unidad'
      ? '<span class="badge-tipo badge-unidad">PZA</span>'
      : '<span class="badge-tipo badge-peso">KG</span>';
    const precioLabel = p.tipo_venta === 'unidad' ? `$${parseFloat(p.precio).toFixed(2)}/pza` : `$${parseFloat(p.precio).toFixed(2)}/kg`;
    const tienePromo = p.promociones && p.promociones.length > 0;
    const avisoPromo = tienePromo ? `<div style="font-size:10px; color:#F9A825; font-weight:700;">🏷️ ${p.promociones[0].cantidad_minima}+ = $${parseFloat(p.promociones[0].precio_promocional).toFixed(2)}</div>` : '';
    card.innerHTML = `
      ${badge}
      <img src="${p.imagen_url || 'img/producto-generico.png'}" alt="${p.nombre}">
      <div class="nombre">${p.nombre}</div>
      <div class="precio">${precioLabel}</div>
      ${avisoPromo}
    `;
    card.onclick = () => seleccionarProducto(p);
    grid.appendChild(card);
  });
}

function seleccionarProducto(producto) {
  if (producto.tipo_venta === 'unidad') abrirModalUnidad(producto);
  else abrirModalPeso(producto);
}

// ---------- Modal de PESO (a granel) ----------
// Calcula el precio real a cobrar según las promociones por cantidad del
// producto (si tiene): usa el escalón más alto que la cantidad alcance a
// cubrir. Si no tiene promociones o no alcanza ningún escalón, es el precio normal.
function precioEfectivo(producto, cantidad) {
  if (!producto.promociones || producto.promociones.length === 0) return parseFloat(producto.precio);
  let mejorPrecio = parseFloat(producto.precio);
  producto.promociones.forEach(promo => {
    if (cantidad >= parseFloat(promo.cantidad_minima)) mejorPrecio = parseFloat(promo.precio_promocional);
  });
  return mejorPrecio;
}

function abrirModalPeso(producto) {
  productoSeleccionado = producto;
  pesoActual = '';
  document.getElementById('modalProductoNombre').textContent = producto.nombre;
  actualizarDisplayPeso();
  document.getElementById('modalPeso').classList.add('abierto');
}

function teclear(valor) {
  if (valor === '.' && pesoActual.includes('.')) return;
  if (pesoActual.length >= 6) return;
  pesoActual += valor;
  actualizarDisplayPeso();
}

function borrarUltimo() {
  pesoActual = pesoActual.slice(0, -1);
  actualizarDisplayPeso();
}

function actualizarDisplayPeso() {
  const peso = parseFloat(pesoActual || '0');
  document.getElementById('displayPeso').textContent = (pesoActual || '0');
  const precioAplicado = precioEfectivo(productoSeleccionado, peso);
  const subtotal = peso * precioAplicado;
  const textoPromo = precioAplicado < parseFloat(productoSeleccionado.precio) ? ' 🏷️ Precio promocional aplicado' : '';
  document.getElementById('subtotalPreview').textContent = `Subtotal: $${subtotal.toFixed(2)}${textoPromo}`;
}

function confirmarPeso() {
  const peso = parseFloat(pesoActual || '0');
  if (peso <= 0) { mostrarToast('Ingresa un peso válido', 'error'); return; }

  carrito.push({
    tipo: 'producto',
    producto_id: productoSeleccionado.id,
    nombre_producto: productoSeleccionado.nombre,
    cantidad: peso,
    precio_unitario: precioEfectivo(productoSeleccionado, peso)
  });

  renderCarrito();
  cerrarModal('modalPeso');
}

// ---------- Modal de UNIDAD (piezas) ----------
function abrirModalUnidad(producto) {
  productoSeleccionado = producto;
  cantidadUnidad = 1;
  document.getElementById('modalUnidadNombre').textContent = producto.nombre;
  actualizarDisplayUnidad();
  document.getElementById('modalUnidad').classList.add('abierto');
}

function cambiarCantidadUnidad(delta) {
  cantidadUnidad = Math.max(1, cantidadUnidad + delta);
  actualizarDisplayUnidad();
}

function actualizarDisplayUnidad() {
  document.getElementById('cantidadUnidadNum').textContent = cantidadUnidad;
  const precioAplicado = precioEfectivo(productoSeleccionado, cantidadUnidad);
  const subtotal = cantidadUnidad * precioAplicado;
  const textoPromo = precioAplicado < parseFloat(productoSeleccionado.precio) ? ' 🏷️ Precio promocional aplicado' : '';
  document.getElementById('subtotalUnidadPreview').textContent = `Subtotal: $${subtotal.toFixed(2)}${textoPromo}`;
}

function confirmarUnidad() {
  carrito.push({
    tipo: 'producto',
    producto_id: productoSeleccionado.id,
    nombre_producto: productoSeleccionado.nombre,
    cantidad: cantidadUnidad,
    precio_unitario: precioEfectivo(productoSeleccionado, cantidadUnidad)
  });

  renderCarrito();
  cerrarModal('modalUnidad');
}

// ---------- Kits ----------
function agregarKit(kit) {
  carrito.push({
    tipo: 'kit',
    kit_id: kit.id,
    nombre_producto: '📦 ' + kit.nombre,
    cantidad: 1,
    precio_unitario: parseFloat(kit.precio_kit)
  });
  renderCarrito();
}

function cerrarModal(id) {
  document.getElementById(id).classList.remove('abierto');
}

// ---------- Escáner de código de barras ----------
function toggleScannerProducto() {
  if (scannerActivo) {
    html5QrCode.stop();
    scannerActivo = false;
    return;
  }
  html5QrCode = new Html5Qrcode("scannerProducto");
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 280, height: 160 } },
    async (codigo) => {
      html5QrCode.stop();
      scannerActivo = false;
      await buscarPorCodigo(codigo);
    }
  );
  scannerActivo = true;
}

async function buscarPorCodigo(codigo) {
  try {
    const producto = await apiFetch(`/productos/codigo/${codigo}`);
    seleccionarProducto(producto);
  } catch (err) {
    try {
      const kit = await apiFetch(`/kits/codigo/${codigo}`);
      agregarKit(kit);
    } catch (err2) {
      mostrarToast('No se encontró ningún producto o kit con ese código: ' + codigo, 'error');
    }
  }
}

// ---------- Carrito ----------
function renderCarrito() {
  const cont = document.getElementById('carritoItems');
  cont.innerHTML = '';
  let total = 0;

  carrito.forEach((item, idx) => {
    const subtotal = item.cantidad * item.precio_unitario;
    total += subtotal;
    const detalle = item.tipo === 'kit' ? 'Kit' : `${item.cantidad} × $${item.precio_unitario}`;
    const div = document.createElement('div');
    div.className = 'carrito-item';
    div.innerHTML = `
      <span>${item.nombre_producto}<br><small>${detalle}</small></span>
      <span>$${subtotal.toFixed(2)} <button onclick="quitarItem(${idx})">✕</button></span>
    `;
    cont.appendChild(div);
  });

  document.getElementById('totalTicket').textContent = total.toFixed(2);
}

function quitarItem(idx) {
  carrito.splice(idx, 1);
  renderCarrito();
}

let configuracionNegocio = null;

async function cargarConfiguracionNegocio() {
  try {
    configuracionNegocio = await apiFetch('/configuracion');
  } catch (err) {
    configuracionNegocio = { ancho_ticket: '80mm' };
  }
}

function actualizarBannerImpresora() {
  const modoImpresion = localStorage.getItem('modo_impresion') || 'directo';
  document.getElementById('bannerImpresora').style.display = (modoImpresion === 'sistema' || impresoraConectada()) ? 'none' : 'block';
}

async function conectarImpresoraMostrador() {
  try {
    await conectarImpresora();
    actualizarBannerImpresora();
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

async function conectarImpresoraMostradorUSB() {
  try {
    await conectarImpresoraUSB();
    actualizarBannerImpresora();
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

async function generarTicket() {
  if (carrito.length === 0) { mostrarToast('Agrega al menos un producto', 'error'); return; }

  try {
    const ticket = await apiFetch('/tickets', {
      method: 'POST',
      body: JSON.stringify({ items: carrito })
    });

    await imprimirTicket(ticket);
    carrito = [];
    renderCarrito();
    mostrarToast(`Ticket ${ticket.folio} generado`, 'exito');
  } catch (err) {
    mostrarToast('Error al generar el ticket: ' + err.message, 'error');
  }
}

async function imprimirTicket(ticket) {
  const config = configuracionNegocio || {};
  const datosTicket = {
    ancho_ticket: config.ancho_ticket || '80mm',
    negocio: {
      nombre: 'Compoint Punto de Soluciones',
      direccion: config.direccion,
      telefono: config.telefono
    },
    folio: ticket.folio,
    fecha: new Date().toLocaleString(),
    items: ticket.items.map(i => ({
      nombre_producto: i.nombre_producto,
      detalle: i.tipo === 'kit' ? 'Kit' : `${i.cantidad} x $${i.precio_unitario}`,
      subtotal: parseFloat(i.subtotal).toFixed(2)
    })),
    total: parseFloat(ticket.total).toFixed(2),
    piePagina: 'Presenta este ticket en caja para pagar',
    lineasSuperiores: config.lineas_superiores || 0,
    lineasInferiores: config.lineas_inferiores !== undefined ? config.lineas_inferiores : 3,
    incluirPrecioUnitario: config.incluir_precio_unitario !== false,
    descripcionCompleta: config.descripcion_completa !== false,
    tipoCodigoEscaneo: config.tipo_codigo_escaneo || 'qr',
    // Sin logotipo aquí a propósito: el ticket de Mostrador es interno (antes
    // de pagar), imprimirlo con logo solo gastaría papel sin necesidad.
    negocioNegritas: config.negocio_negritas !== false,
    totalNegritas: config.total_negritas !== false,
    tamanoLetra: config.tamano_letra || 'normal',
    tipoFuente: config.tipo_fuente || 'monospace'
  };

  const modoImpresion = localStorage.getItem('modo_impresion') || 'directo';
  if (modoImpresion === 'sistema') {
    await imprimirConDialogoDelSistema(datosTicket);
    return;
  }

  try {
    await imprimirTicketBLE(datosTicket);
    mostrarToast('Ticket impreso correctamente', 'exito');
  } catch (err) {
    actualizarBannerImpresora();
    mostrarToast(`No se pudo imprimir: ${err.message}`, 'error');
    const usarRespaldo = await confirmarAccion(`Ticket generado: ${ticket.folio} — Total: $${ticket.total}. No se pudo imprimir por Bluetooth/USB. ¿Imprimir con una impresora ya instalada en esta computadora (Windows)?`);
    if (usarRespaldo) await imprimirConDialogoDelSistema(datosTicket);
  }
}

cargarConfiguracionNegocio();
setTimeout(actualizarBannerImpresora, 500);

// Atajos de teclado: F1 buscar (ahora sí existe el buscador), F2 escanear,
// F3 nueva venta (vaciar carrito), F4 generar ticket, ESC cerrar modal abierto.
// DELETE sigue sin aplicar: no hay un ítem "seleccionado" en el carrito.
document.addEventListener('keydown', async (e) => {
  const enCampoDeTexto = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);

  if (e.key === 'Escape') {
    cerrarModal('modalPeso');
    cerrarModal('modalUnidad');
    document.getElementById('buscadorProductos').blur();
    return;
  }
  if (e.key === 'F1') { e.preventDefault(); document.getElementById('buscadorProductos').focus(); return; }
  if (enCampoDeTexto) return; // no interferir con lo que el usuario esté escribiendo

  if (e.key === 'F2') { e.preventDefault(); toggleScannerProducto(); }
  else if (e.key === 'F3') {
    e.preventDefault();
    if (carrito.length === 0) return;
    const confirmado = await confirmarAccion('¿Vaciar el ticket actual y empezar una venta nueva?');
    if (confirmado) { carrito = []; renderCarrito(); }
  }
  else if (e.key === 'F4') { e.preventDefault(); generarTicket(); }
});

function filtrarProductosPorTexto() {
  renderProductos();
}

// Lector de código de barras físico: escanea y agrega el producto/kit
// automáticamente, igual que si se hubiera escaneado con la cámara.
activarLectorFisico(buscarPorCodigo);

// ---------- Fichas / Turnos ----------
async function generarFicha() {
  try {
    const ficha = await apiFetch('/fichas', { method: 'POST' });
    const anchoTicket = (configuracionNegocio && configuracionNegocio.ancho_ticket) || '80mm';
    const modoImpresion = localStorage.getItem('modo_impresion') || 'directo';

    if (modoImpresion === 'sistema') {
      imprimirFichaConDialogoDelSistema(ficha.numero, anchoTicket);
    } else {
      try {
        await imprimirFicha(ficha.numero, anchoTicket);
      } catch (err) {
        mostrarToast(`Ficha #${String(ficha.numero).padStart(3,'0')} generada, pero no se pudo imprimir: ${err.message}`, 'error');
        actualizarContadorFichas();
        return;
      }
    }
    mostrarToast(`Ficha #${String(ficha.numero).padStart(3,'0')} generada`, 'exito');
    actualizarContadorFichas();
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

async function llamarSiguienteTurno() {
  const nombreMostrador = localStorage.getItem('nombre_mostrador') || 'Mostrador';
  try {
    const ficha = await apiFetch('/fichas/llamar-siguiente', {
      method: 'POST',
      body: JSON.stringify({ mostrador: nombreMostrador })
    });
    mostrarToast(`Llamando turno #${String(ficha.numero).padStart(3,'0')} → ${nombreMostrador}`, 'exito');
    actualizarContadorFichas();
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

async function reimprimirUltimaFicha() {
  try {
    const ficha = await apiFetch('/fichas/ultima');
    const anchoTicket = (configuracionNegocio && configuracionNegocio.ancho_ticket) || '80mm';
    const modoImpresion = localStorage.getItem('modo_impresion') || 'directo';

    if (modoImpresion === 'sistema') {
      imprimirFichaConDialogoDelSistema(ficha.numero, anchoTicket);
    } else {
      await imprimirFicha(ficha.numero, anchoTicket);
    }
    mostrarToast(`Reimprimiendo ficha #${String(ficha.numero).padStart(3,'0')}`, 'exito');
  } catch (err) {
    mostrarToast(err.message, 'error');
  }
}

async function actualizarContadorFichas() {
  try {
    const data = await apiFetch('/fichas/pendientes-count');
    document.getElementById('contadorFichasPendientes').textContent = `${data.total} en espera`;
  } catch (err) {
    console.error(err);
  }
}

actualizarContadorFichas();
setInterval(actualizarContadorFichas, 15000);

cargarDatos();
