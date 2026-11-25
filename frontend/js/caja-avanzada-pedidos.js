// Caja Avanzada: TOMAR PEDIDO (a domicilio o para recoger), igual que en Mostrador.
//
// Arriba se elige «Venta · A domicilio · Para recoger» (o con la tecla F10). En modo pedido el botón
// Cobrar se vuelve naranja, dice «Tomar pedido» y abre la misma ventana de Mostrador (js/pedido-domicilio.js)
// con los productos de la pestaña activa. Al terminar el pedido la caja regresa sola a «Venta».
// También trae «Pedidos por preparar» (js/mostrador-pedidos.js) para los negocios que no usan Mostrador.
//
// Usa variables de caja-avanzada.html (pestanas, pestanaActivaIndex, catalogoAvanzada, renderTablaVentaAvanzada,
// hayVentanaAbiertaAv, configuracionCobrarAvanzada…) y de caja-avanzada-mostrador.js (hayDescuentosPendientesAv,
// textoBotonCobrarAv). Por eso se carga al final, después de pedido-domicilio.js y mostrador-pedidos.js.
(function () {
  'use strict';
  if (!window.PedidoDom) return;

  const MODOS = ['mostrador', 'domicilio', 'recoger'];
  const pestanaActiva = () => pestanas[pestanaActivaIndex];

  // Lo capturado en la ventana del pedido (cliente, dirección…) es de una pestaña: si el cajero cambia de
  // pestaña a medio pedido, se guarda con la que deja y se retoma al volver.
  let pestanaDelPedido = pestanaActiva();
  let guardados = new WeakMap();

  function revisarPestana() {
    const actual = pestanaActiva();
    if (!actual || actual === pestanaDelPedido) return;
    const anterior = pestanaDelPedido;
    pestanaDelPedido = actual; // antes de soltar: soltar vuelve a pintar la tabla y llega aquí otra vez
    const s = PedidoDom.soltarPestana(anterior ? anterior.carrito : []);
    if (anterior && s) guardados.set(anterior, s);
    PedidoDom.retomarPestana(guardados.get(actual) || null);
    guardados.delete(actual);
  }

  function pintarModo(m) {
    const pedido = m !== 'mostrador';
    const b = document.querySelector('.btn-cobrar-grande');
    if (b) b.textContent = textoBotonCobrarAv();
    const et = document.querySelector('.zona-total .total-etiqueta');
    if (et) et.textContent = pedido ? 'PEDIDO' : 'TOTAL';
    if (!pedido) guardados = new WeakMap(); // de regreso a «Venta» no queda ningún pedido a medias
    renderTablaVentaAvanzada(); // la vista Caja Mostrador pinta su propio botón
  }

  // Ya se mandó el pedido: la pestaña se cierra igual que al cobrar (o se vacía si es la única).
  function quitarPestanaDelPedido() {
    if (pestanas.length === 1) {
      pestanas[0] = { id: 1, nombre: 'Ticket 1', carrito: [], clienteAsignado: null, ticketIdExistente: null };
    } else {
      pestanas.splice(pestanaActivaIndex, 1);
      pestanaActivaIndex = Math.max(0, pestanaActivaIndex - 1);
    }
    filaSeleccionadaIndex = null;
    // La ventana sigue abierta mostrando «Pedido creado»: no se cambia lo capturado por cambiar de pestaña.
    pestanaDelPedido = pestanaActiva();
  }

  PedidoDom.usarPantalla({
    carrito: () => pestanaActiva().carrito,
    catalogo: () => catalogoAvanzada,
    refrescar: () => renderTablaVentaAvanzada(),
    vaciar: quitarPestanaDelPedido,
    nombreVenta: 'Venta',
    avisoImpresion: '🖨 El ticket se imprime cuando el pedido esté listo (botón 📦 Pedidos)',
    volverAVenta: true,
    alCambiarModo: pintarModo
  });

  // Botón Cobrar en modo pedido (lo llama cobrarOPedidoAv de caja-avanzada-mostrador.js).
  function tomarPedido() {
    const p = pestanaActiva();
    if (!p.carrito.length) { mostrarToast('Agrega al menos un producto', 'error'); return; }
    if (p.ticketIdExistente) {
      mostrarToast('Este ticket ya está guardado: cóbralo en «Venta». Para tomar un pedido usa otra pestaña.', 'error', 6000);
      return;
    }
    if (hayDescuentosPendientesAv(p) || p.carrito.some((it) => (parseFloat(it.descuento_monto) || 0) > 0)) {
      mostrarToast('Los pedidos no llevan descuentos. Quita el descuento para tomar el pedido.', 'error', 6000);
      return;
    }
    PedidoDom.abrir();
  }

  // F10: Venta → A domicilio → Para recoger → Venta. Funciona aunque el cursor esté en la barra de código
  // (F10 no escribe nada), pero no con una ventana abierta.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'F10' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (hayVentanaAbiertaAv()) return;
    PedidoDom.setModo(MODOS[(MODOS.indexOf(PedidoDom.modo) + 1) % MODOS.length]);
  });

  // «Pedido listo» imprime el ticket del pedido (datos del cliente en letra grande). Mostrador lo hace con
  // su imprimirTicket() de js/mostrador.js; aquí va lo mismo con la configuración de Caja Avanzada.
  async function imprimirTicketPedido(ticket) {
    if (!configuracionCobrarAvanzada) {
      try {
        configuracionCobrarAvanzada = await apiFetch('/configuracion');
        guardarCacheOffline('config', configuracionCobrarAvanzada);
      } catch (e) {
        configuracionCobrarAvanzada = leerCacheOffline('config') || {};
      }
    }
    const config = configuracionCobrarAvanzada || {};
    const datosTicket = {
      ancho_ticket: obtenerAnchoTicketDispositivo(config),
      negocio: { nombre: 'Compoint Punto de Soluciones', direccion: config.direccion, telefono: config.telefono },
      folio: ticket.folio,
      fecha: new Date().toLocaleString(),
      items: ticket.items.map((i) => ({
        nombre_producto: i.nombre_producto,
        detalle: i.detalle !== undefined ? i.detalle : GRANEL.detalle(i),
        cantidad_texto: i.cantidad_texto,
        subtotal: parseFloat(i.subtotal).toFixed(2)
      })),
      total: parseFloat(ticket.total).toFixed(2),
      piePagina: ticket.pie_pagina || 'Presenta este ticket en caja para pagar',
      lineasSuperiores: config.lineas_superiores || 0,
      lineasInferiores: config.lineas_inferiores !== undefined ? config.lineas_inferiores : 3,
      incluirPrecioUnitario: config.incluir_precio_unitario !== false,
      descripcionCompleta: config.descripcion_completa !== false,
      tipoCodigoEscaneo: config.tipo_codigo_escaneo || 'qr',
      ...estiloTicketDesdeConfig(config, false)
    };
    if (ticket.pedido) {
      if (typeof MostradorPedidos !== 'undefined' && MostradorPedidos.aplicarAjustesPedido) {
        MostradorPedidos.aplicarAjustesPedido(datosTicket, ticket);
      } else {
        datosTicket.pedido = ticket.pedido;
        datosTicket.codigoAlFinal = true;
        datosTicket.tipoCodigoEscaneo = 'barras';
      }
    }
    if ((localStorage.getItem('modo_impresion') || 'directo') === 'sistema') {
      await imprimirConDialogoDelSistema(datosTicket);
      return;
    }
    try {
      await imprimirTicketBLE(datosTicket);
      mostrarToast('Ticket impreso correctamente', 'exito');
    } catch (err) {
      mostrarToast(`No se pudo imprimir: ${err.message}`, 'error');
      const usarRespaldo = await confirmarAccion(`Ticket del pedido ${ticket.folio}. No se pudo imprimir por Bluetooth/USB. ¿Imprimir con una impresora ya instalada en esta computadora (Windows)?`);
      if (usarRespaldo) await imprimirConDialogoDelSistema(datosTicket);
    }
  }
  if (typeof window.imprimirTicket !== 'function') window.imprimirTicket = imprimirTicketPedido;

  window.CajaPedidos = { revisarPestana, tomarPedido };
})();
