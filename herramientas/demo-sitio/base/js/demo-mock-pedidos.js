/* ============================================================================
 * Compoint Punto — MODO DEMOSTRACIÓN · Pedidos a domicilio / para recoger y Repartidor
 *
 * Imita backend/routes/pedidos.js (y las direcciones de entrega de clientes)
 * dentro del navegador, con los datos de la demo guardados en localStorage.
 * Se carga después de demo-mock.js y registra sus rutas con DemoMock.R().
 *
 * Un pedido SIEMPRE tiene su ticket. Mientras ese ticket no deba verse en la
 * bandeja de Caja (pedido programado, o a domicilio que cobra el repartidor)
 * queda con el estado interno "pendiente_pedido": la bandeja de la demo solo
 * lista los tickets "pendiente". Para las pantallas de pedidos sigue siendo
 * "pendiente". Cada día se vuelven a crear los pedidos de ejemplo.
 * ========================================================================== */
(function () {
  'use strict';

  var D = window.DemoMock;
  if (!D || typeof D.R !== 'function') return;

  var OCULTO = 'pendiente_pedido';
  var LINEA_ENVIO = 'Envío a domicilio';
  var ESTADOS = ['programado', 'preparando', 'listo', 'en_camino', 'entregado', 'no_entregado', 'cancelado'];
  var ACTIVOS = ['programado', 'preparando', 'listo', 'en_camino'];
  var CANCELABLES = ['programado', 'preparando', 'listo', 'en_camino', 'no_entregado'];
  var TRANSICIONES = {
    programado: ['preparando', 'listo'],
    preparando: ['listo', 'en_camino', 'entregado'],
    listo: ['preparando', 'en_camino', 'entregado'],
    en_camino: ['listo', 'entregado', 'no_entregado'],
    no_entregado: ['listo', 'preparando'],
    entregado: [],
    cancelado: []
  };
  var ESTADO_TXT = { programado: 'Programado', preparando: 'Preparando', listo: 'Listo', en_camino: 'En camino', entregado: 'Entregado', no_entregado: 'No entregado', cancelado: 'Cancelado' };
  var METODOS_COBRO = ['efectivo', 'transferencia', 'tarjeta'];
  var PAGO_MODOS = ['al_recibir', 'pagado', 'credito'];
  var ADMIN = ['jefe_general', 'dueno', 'gerente'];
  var MAX_EVIDENCIAS = 4; // fotos/firmas guardadas en el navegador (para no llenar localStorage)

  var num = D.num, r2 = D.redondea, iso = D.iso, ahora = D.ahora, porId = D.porId, clonar = D.clonar, fallo = D.fallo;
  function db() { return D.db(); }

  // ------------------------------------------------------------------ utilidades
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function localStr(d) { return D.fechaLocalStr(d) + 'T' + hm(d); }
  function parseLocal(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
  }
  function hoyStr() { return D.fechaLocalStr(ahora()); }
  function sumarDias(f, n) { var p = f.split('-'); return D.fechaLocalStr(new Date(+p[0], +p[1] - 1, +p[2] + n)); }
  function fechaDe(ts) { return ts ? D.fechaLocalStr(new Date(ts)) : null; }
  function diaSemana(f) { var p = f.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).getDay(); }
  function vacio(v) { return v === undefined || v === null || v === ''; }
  function aNumero(v) { return vacio(v) ? null : Number(v); }
  function contiene(lista, v) { return lista.indexOf(v) !== -1; }
  function textoOnull(v, max) {
    if (v === undefined || v === null) return null;
    var t = String(v).trim();
    return t ? t.slice(0, max || 300) : null;
  }
  function soloDigitos(t) { return String(t || '').replace(/\D/g, ''); }
  function norm(t) { return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function numeroPedido(id) { return 'D-' + String(id).padStart(4, '0'); }
  function esEntero(v) { return /^\d+$/.test(String(v)); }
  function unicos(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
  function sumar(lista, fn) { var s = 0; lista.forEach(function (x) { s += fn(x) || 0; }); return s; }

  // Ordena por varias claves imitando ORDER BY (ASC: nulos al final; o lo que se indique).
  function ordenPor(claves) {
    return function (a, b) {
      for (var i = 0; i < claves.length; i++) {
        var c = claves[i], va = c.k(a), vb = c.k(b);
        var na = vacio(va), nb = vacio(vb);
        if (na && nb) continue;
        var nulosPrimero = c.nulos ? c.nulos === 'primero' : !!c.desc;
        if (na) return nulosPrimero ? -1 : 1;
        if (nb) return nulosPrimero ? 1 : -1;
        if (va < vb) return c.desc ? 1 : -1;
        if (va > vb) return c.desc ? -1 : 1;
      }
      return 0;
    };
  }

  function coordenadas(lat, lng) {
    if (vacio(lat) && vacio(lng)) return { latitud: null, longitud: null };
    var a = Number(lat), b = Number(lng);
    if (!isFinite(a) || !isFinite(b) || vacio(lat) || vacio(lng) || Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) {
      return { error: 'La ubicación (latitud y longitud) no es válida' };
    }
    return { latitud: Math.round(a * 1e7) / 1e7, longitud: Math.round(b * 1e7) / 1e7 };
  }

  function normalizarDireccion(b) {
    b = b || {};
    var calle = textoOnull(b.calle, 200);
    if (!calle) return { error: 'La calle y número de la dirección son requeridos' };
    var c = coordenadas(b.latitud, b.longitud);
    if (c.error) return { error: c.error };
    return {
      alias: textoOnull(b.alias, 60), calle: calle, colonia: textoOnull(b.colonia, 120), cp: textoOnull(b.cp, 10),
      ciudad: textoOnull(b.ciudad, 120), referencias: textoOnull(b.referencias, 300), latitud: c.latitud, longitud: c.longitud,
      ubicacion_enlace: textoOnull(b.ubicacion_enlace, 500),
      zona_id: esEntero(b.zona_id) && Number(b.zona_id) > 0 ? Number(b.zona_id) : null
    };
  }

  function validarFechaHora(v) {
    if (vacio(v)) return { valor: null };
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(v).trim());
    if (!m) return { error: 'La fecha y hora de entrega no es válida' };
    var a = +m[1], mes = +m[2], d = +m[3], h = +m[4], mi = +m[5];
    var f = new Date(Date.UTC(a, mes - 1, d, h, mi));
    if (f.getUTCFullYear() !== a || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== d || h > 23 || mi > 59) return { error: 'La fecha y hora de entrega no es válida' };
    if (a < 2020 || a > 2100) return { error: 'La fecha de entrega no es válida' };
    return { valor: m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] };
  }
  function validarFecha(v) {
    if (vacio(v)) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
    if (!m) return false;
    var f = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return f.getUTCMonth() === +m[2] - 1 && f.getUTCDate() === +m[3] ? String(v).trim() : false;
  }

  // Importe exacto de un renglón (venta "por importe"), igual que utils/importeExacto.js
  function subtotalRenglon(it) {
    var c = Number(it.cantidad), p = Number(it.precio_unitario), normal = r2(c * p);
    if (!vacio(it.importe)) {
      var imp = r2(Number(it.importe));
      if (c > 0 && p >= 0 && imp > 0 && isFinite(imp) && Math.abs(imp - c * p) <= p * 0.0005 + 0.011) return imp;
    }
    return normal;
  }

  function validarItems(items) {
    if (!Array.isArray(items) || !items.length) fallo(400, 'El pedido necesita al menos un producto');
    if (items.length > 200) fallo(400, 'El pedido tiene demasiados renglones');
    items.forEach(function (it) {
      var c = Number(it && it.cantidad), p = Number(it && it.precio_unitario);
      if (!it || !it.nombre_producto || !isFinite(c) || c <= 0 || !isFinite(p) || p < 0) fallo(400, 'Hay un producto con cantidad o precio inválido');
    });
  }

  // ------------------------------------------------------------------ configuración, usuarios, zonas
  function cfg() { return db().configuracion || {}; }
  function minPreparacion() { var v = cfg().pedidos_min_preparacion; return vacio(v) ? 30 : (Number(v) || 0); }
  function envioGratisGeneral() { return Number(cfg().pedidos_envio_gratis_desde || 0); }

  function usuario(id) { return vacio(id) ? null : porId(db().usuarios, id); }
  function repartidorValido(id) {
    if (vacio(id)) return null;
    var u = usuario(id);
    if (!u || u.rol !== 'repartidor' || !u.activo) fallo(400, 'Ese repartidor no existe o está desactivado');
    return u.id;
  }
  function esAdmin(c) { return contiene(ADMIN, c.user.rol); }

  function calcularEnvio(zonaId, subtotal) {
    if (!zonaId) return { costo: 0, zona: null, gratis: false };
    var z = porId(db().zonas_envio, zonaId);
    if (!z || !z.activo) return { error: 'La zona de envío no existe o está desactivada' };
    var minimo = z.envio_gratis_desde === null || z.envio_gratis_desde === undefined ? envioGratisGeneral() : Number(z.envio_gratis_desde);
    var gratis = minimo > 0 && Number(subtotal) >= minimo;
    return { costo: gratis ? 0 : r2(z.costo), zona: z, gratis: gratis, minimo: minimo };
  }
  function zonaFila(z) {
    var o = clonar(z); o.costo = Number(z.costo); o.envio_gratis_desde = aNumero(z.envio_gratis_desde); return o;
  }

  // ------------------------------------------------------------------ pedido ↔ ticket
  function ticketDe(p) { return porId(db().tickets, p.ticket_id); }
  function estadoTicket(t) { return !t ? null : (t.estado === OCULTO ? 'pendiente' : t.estado); }
  function esLineaEnvio(d) { return d.nombre_producto === LINEA_ENVIO && !d.producto_id && !d.kit_id; }

  // ¿El ticket de este pedido debe verse en la bandeja de Caja? (misma regla que /tickets/pendientes del sistema)
  function visibleEnCaja(p) {
    if (p.estado === 'programado' || p.estado === 'cancelado') return false;
    if (p.tipo === 'domicilio' && p.pago_modo === 'al_recibir') return false;
    return true;
  }

  // Deja el ticket del pedido como le toca (visible u oculto en Caja) y con los datos del pedido
  // que usa Caja (marca "Domicilio · cliente", anticipo). También: si Caja canceló el ticket, se cancela el pedido.
  function sincronizar(p) {
    var t = ticketDe(p);
    if (!t) return 0;
    var n = 0;
    if (t.estado === 'cancelado' && p.estado !== 'cancelado') {
      p.estado = 'cancelado'; p.motivo_cancelacion = p.motivo_cancelacion || 'Se canceló su ticket en Caja'; n++;
    }
    if (t.estado === 'pendiente' || t.estado === OCULTO) {
      var destino = p.estado === 'cancelado' ? 'cancelado' : (visibleEnCaja(p) ? 'pendiente' : OCULTO);
      if (t.estado !== destino) { t.estado = destino; n++; }
    }
    var ant = r2(num(p.anticipo));
    var campos = {
      pedido_id: p.id, pedido_tipo: p.tipo, pedido_estado: p.estado, pedido_pago_modo: p.pago_modo, pedido_contacto: p.nombre_contacto,
      pedido_anticipo: ant, pedido_anticipo_metodo: ant > 0 ? (p.anticipo_metodo || 'efectivo') : null
    };
    Object.keys(campos).forEach(function (k) { if (t[k] !== campos[k]) { t[k] = campos[k]; n++; } });
    return n;
  }
  function sincronizarTodos() { var n = 0; (db().pedidos || []).forEach(function (p) { n += sincronizar(p); }); return n; }

  function minutosRetraso(p) {
    if (!contiene(ACTIVOS, p.estado) || !p.programado_para) return 0;
    if (p.estado === 'programado' && !p.preparar_desde) return 0;
    var f = parseLocal(p.programado_para);
    if (!f) return 0;
    var dif = ahora().getTime() - f.getTime();
    return dif > 0 ? Math.floor(dif / 60000) : 0;
  }

  // Lo mismo que formato() del backend: el pedido como lo esperan las pantallas.
  function formato(p) {
    var BD = db(), t = ticketDe(p);
    var lineas = t ? D.itemsDe(t.id) : [];
    var descItems = sumar(lineas, function (d) { return num(d.descuento_monto); });
    var o = clonar(p);
    o.folio = t ? t.folio : null;
    o.ticket_estado = estadoTicket(t);
    o.ticket_total = t ? num(t.total) : null;
    o.total_neto = t ? r2(num(t.total) - num(t.descuento_monto) - descItems) : null;
    o.n_items = lineas.filter(function (d) { return !esLineaEnvio(d); }).length;
    var rep = usuario(p.repartidor_id);
    o.repartidor_nombre = rep ? rep.nombre : null;
    o.repartidor_telefono = rep ? (rep.telefono || null) : null;
    var ac = usuario(p.aceptado_por);
    o.aceptado_por_nombre = ac ? ac.nombre : null;
    var cl = p.cliente_id ? porId(BD.clientes, p.cliente_id) : null;
    o.cliente_tipo = cl ? (cl.tipo || 'publico') : null;
    o.cliente_mayoreo = cl ? !!cl.usa_mayoreo : null;
    var z = p.zona_id ? porId(BD.zonas_envio, p.zona_id) : null;
    o.zona_nombre = z ? z.nombre : null;
    o.retraso_min = minutosRetraso(p);
    o.etiqueta = numeroPedido(p.id);
    ['costo_envio', 'monto_cobrado', 'paga_con', 'latitud', 'longitud'].forEach(function (k) { o[k] = aNumero(p[k]); });
    o.anticipo = r2(num(p.anticipo));
    o.anticipo_metodo = o.anticipo > 0 ? (p.anticipo_metodo || 'efectivo') : null;
    o.resta = o.total_neto !== null ? Math.max(0, r2(o.total_neto - o.anticipo)) : null;
    var cubierto = o.ticket_estado === 'pagado' || (o.total_neto !== null && o.total_neto > 0 && o.anticipo >= o.total_neto);
    o.estado_cobro = cubierto ? 'pagado' : p.pago_modo === 'credito' ? 'credito' : (p.tipo === 'domicilio' && p.pago_modo === 'al_recibir') ? 'al_recibir' : 'en_caja';
    o.por_cobrar = o.estado_cobro === 'al_recibir' && o.ticket_estado === 'pendiente' && p.estado !== 'cancelado';
    o.cambio = o.paga_con !== null && o.resta !== null ? Math.max(0, r2(o.paga_con - o.resta)) : null;
    return o;
  }

  function itemsDelTicket(ticketId) {
    var BD = db();
    return D.itemsDe(ticketId).slice().sort(function (a, b) { return a.id - b.id; }).map(function (d) {
      var pr = d.producto_id ? porId(BD.productos, d.producto_id) : null;
      return {
        id: d.id, tipo: d.tipo, producto_id: d.producto_id || null, nombre_producto: d.nombre_producto, cantidad: num(d.cantidad),
        precio_unitario: num(d.precio_unitario), subtotal: num(d.subtotal), descuento_monto: num(d.descuento_monto),
        tipo_venta: pr ? pr.tipo_venta : null, es_envio: esLineaEnvio(d)
      };
    });
  }

  function cargarPedido(p, sinItems) {
    var o = formato(p);
    if (!sinItems) {
      o.items = itemsDelTicket(p.ticket_id);
      o.evidencias = (db().pedido_evidencias || []).filter(function (e) { return e.pedido_id === p.id; })
        .map(function (e) { return { id: e.id, tipo: e.tipo, creado_en: e.creado_en }; });
    }
    return o;
  }

  function pedidoOr404(id) {
    if (!esEntero(id)) fallo(404, 'Pedido no encontrado');
    var p = porId(db().pedidos, id);
    if (!p) fallo(404, 'Pedido no encontrado');
    return p;
  }

  function resumenParaRepartidor(f) {
    var o = {};
    ['id', 'etiqueta', 'folio', 'estado', 'tipo', 'nombre_contacto', 'telefono', 'calle', 'colonia', 'cp', 'ciudad', 'referencias', 'latitud', 'longitud',
      'ubicacion_enlace', 'programado_para', 'retraso_min', 'notas', 'pago_modo', 'por_cobrar', 'total_neto', 'paga_con', 'cambio', 'anticipo',
      'anticipo_metodo', 'resta', 'estado_cobro', 'metodo_cobro', 'monto_cobrado', 'repartidor_id', 'salio_en', 'llego_en', 'entregado_en',
      'motivo_no_entrega', 'n_items'].forEach(function (k) { o[k] = f[k] === undefined ? null : f[k]; });
    return o;
  }
  function itemsParaRepartidor(p) {
    return itemsDelTicket(p.ticket_id).filter(function (i) { return !i.es_envio; })
      .map(function (i) { return { nombre: i.nombre_producto, cantidad: i.cantidad, tipo_venta: i.tipo_venta || null }; });
  }

  // ------------------------------------------------------------------ anticipo
  function validarAnticipo(d, total, pagoModoActual) {
    var pagoModo = pagoModoActual || d.pago_modo;
    var anticipo = 0;
    if (d.ya_pago_todo === true) anticipo = r2(total);
    else if (!vacio(d.anticipo)) {
      anticipo = Number(d.anticipo);
      if (!isFinite(anticipo) || anticipo < 0) fallo(400, 'El anticipo no es válido');
      anticipo = r2(anticipo);
    }
    if (anticipo > 0 && pagoModo === 'credito') fallo(400, 'Un pedido a crédito no lleva anticipo: quita el anticipo o cambia la forma de pago');
    if (anticipo > total + 0.001) fallo(400, 'El anticipo ($' + anticipo.toFixed(2) + ') no puede ser mayor que el total del pedido ($' + Number(total).toFixed(2) + ')');
    var metodo = null;
    if (anticipo > 0) {
      metodo = vacio(d.anticipo_metodo) ? 'efectivo' : d.anticipo_metodo;
      if (!contiene(METODOS_COBRO, metodo)) fallo(400, 'Elige con qué dejó el anticipo: efectivo, transferencia o tarjeta');
    }
    var pagoFinal = anticipo > 0 && total > 0 && anticipo >= total && pagoModo === 'al_recibir' ? 'pagado' : pagoModo;
    return { anticipo: anticipo, anticipo_metodo: metodo, pago_modo: pagoFinal };
  }

  // ------------------------------------------------------------------ crear un pedido (ticket + pedido)
  function folioNuevo() {
    var BD = db(), base = 'S1-' + Date.now().toString(36).toUpperCase().slice(-6), f = base, i = 0;
    while (BD.tickets.some(function (t) { return t.folio === f; })) { i++; f = base + i; }
    return f;
  }

  // "d" ya trae al cliente y la dirección resueltos. Todo se valida ANTES de escribir nada.
  function crearPedidoCore(d) {
    var BD = db();
    var subtotales = d.items.map(subtotalRenglon);
    var subtotal = r2(sumar(subtotales, function (x) { return x; }));
    var costoEnvio = 0;
    if (d.tipo === 'domicilio') {
      var calc = calcularEnvio(d.zona_id, subtotal);
      if (calc.error) fallo(400, calc.error);
      costoEnvio = !vacio(d.costo_envio_forzado) ? r2(d.costo_envio_forzado) : calc.costo;
    }
    var total = r2(subtotal + costoEnvio);
    var an = validarAnticipo(d, total);

    var t = {
      id: D.sig('ticket'), folio: folioNuevo(), sucursal_id: 1, mostrador_usuario_id: d.usuarioId || null, cajero_usuario_id: null, estado: 'pendiente',
      total: total, descuento_monto: 0, descuento_motivo: null, descuento_autorizado_por: null, metodo_pago: null, monto_efectivo: 0, monto_tarjeta: 0,
      turno_id: null, cliente_id: d.cliente ? d.cliente.id : null, fecha_creacion: iso(ahora()), fecha_pago: null, efectivo_recibido: null
    };
    BD.tickets.push(t);
    d.items.forEach(function (it, n) {
      var tipo = it.tipo === 'kit' ? 'kit' : 'producto';
      BD.ticket_detalle.push({
        id: D.sig('ticket_detalle'), ticket_id: t.id, tipo: tipo,
        producto_id: tipo === 'producto' ? (parseInt(it.producto_id, 10) || null) : null, kit_id: tipo === 'kit' ? (parseInt(it.kit_id, 10) || null) : null,
        nombre_producto: String(it.nombre_producto).slice(0, 200), cantidad: Number(it.cantidad), precio_unitario: Number(it.precio_unitario), subtotal: subtotales[n],
        descuento_monto: 0, descuento_motivo: null, cantidad_devuelta: 0
      });
    });
    if (costoEnvio > 0) {
      BD.ticket_detalle.push({ id: D.sig('ticket_detalle'), ticket_id: t.id, tipo: 'producto', producto_id: null, kit_id: null, nombre_producto: LINEA_ENVIO, cantidad: 1, precio_unitario: costoEnvio, subtotal: costoEnvio, descuento_monto: 0, descuento_motivo: null, cantidad_devuelta: 0 });
    }

    var minPrep = minPreparacion();
    var prog = d.programado_para ? parseLocal(d.programado_para) : null;
    var estado = d.enviar === false ? 'programado' : (prog && prog.getTime() - minPrep * 60000 > ahora().getTime() ? 'programado' : 'preparando');
    var dir = d.direccion || {};
    var p = {
      id: D.sig('pedido'), sucursal_id: 1, ticket_id: t.id, cliente_id: d.cliente ? d.cliente.id : null, direccion_id: d.direccion_id || null,
      tipo: d.tipo, estado: estado, nombre_contacto: d.nombre_contacto, telefono: d.telefono || null,
      calle: dir.calle || null, colonia: dir.colonia || null, cp: dir.cp || null, ciudad: dir.ciudad || null, referencias: dir.referencias || null,
      latitud: aNumero(dir.latitud), longitud: aNumero(dir.longitud), ubicacion_enlace: dir.ubicacion_enlace || null, zona_id: d.zona_id || null,
      costo_envio: costoEnvio, pago_modo: an.pago_modo, paga_con: an.pago_modo === d.pago_modo && !vacio(d.paga_con) ? Number(d.paga_con) : null,
      metodo_cobro: null, monto_cobrado: null,
      programado_para: d.programado_para || null,
      fecha_entrega: d.programado_para ? d.programado_para.slice(0, 10) : hoyStr(),
      preparar_desde: d.enviar === false || !prog ? null : localStr(new Date(prog.getTime() - minPrep * 60000)),
      creado_en: iso(ahora()), creado_por: d.usuarioId || null, listo_en: null, salio_en: null, llego_en: null, entregado_en: null, aviso_camino_en: null,
      repartidor_id: d.repartidor_id || null, orden_ruta: null, notas: d.notas || null, motivo_no_entrega: null, motivo_cancelacion: null, liquidacion_id: null,
      origen: d.origen || 'manual', pedido_fijo_id: d.pedido_fijo_id || null, aceptado_en: null, aceptado_por: null,
      anticipo: an.anticipo, anticipo_metodo: an.anticipo_metodo
    };
    BD.pedidos.push(p);
    sincronizar(p);
    return p;
  }

  // Cliente del pedido: uno guardado, o uno nuevo (se busca primero por teléfono). No escribe nada:
  // devuelve { cliente, crear } y quien llama lo crea cuando ya validó todo.
  function resolverCliente(b) {
    var BD = db();
    if (b.cliente_id) {
      var c = porId(BD.clientes, b.cliente_id);
      if (!c || !c.activo) fallo(400, 'Ese cliente no existe');
      return { cliente: c, nombre: textoOnull(b.nombre_contacto, 150) || c.nombre, telefono: textoOnull(b.telefono, 30) || c.telefono || null };
    }
    var nombre = textoOnull(b.nombre_contacto, 150);
    if (!nombre) fallo(400, 'Escribe el nombre del cliente');
    var telefono = textoOnull(b.telefono, 30);
    var cliente = null, crear = false;
    if (b.guardar_cliente !== false) {
      var dig = soloDigitos(telefono);
      if (dig.length >= 8) {
        cliente = BD.clientes.filter(function (x) { return x.activo && soloDigitos(x.telefono).slice(-8) === dig.slice(-8); })
          .sort(function (a, z) { return a.id - z.id; })[0] || null;
      }
      if (!cliente) crear = true;
    }
    return { cliente: cliente, crear: crear, nombre: nombre, telefono: telefono };
  }

  function dirFila(d) { var o = clonar(d); o.latitud = aNumero(d.latitud); o.longitud = aNumero(d.longitud); return o; }
  function direccionesDe(clienteId) {
    return (db().cliente_direcciones || []).filter(function (d) { return d.cliente_id === clienteId && d.activo; })
      .sort(ordenPor([{ k: function (d) { return d.principal ? 1 : 0; }, desc: true }, { k: function (d) { return d.ultimo_uso; }, desc: true, nulos: 'ultimo' }, { k: function (d) { return d.id; } }]));
  }
  function nuevaDireccion(clienteId, d, principal) {
    var BD = db();
    if (principal) BD.cliente_direcciones.forEach(function (x) { if (x.cliente_id === clienteId) x.principal = false; });
    var fila = {
      id: D.sig('direccion'), cliente_id: clienteId, alias: d.alias || null, calle: d.calle, colonia: d.colonia || null, cp: d.cp || null, ciudad: d.ciudad || null,
      referencias: d.referencias || null, latitud: aNumero(d.latitud), longitud: aNumero(d.longitud), ubicacion_enlace: d.ubicacion_enlace || null,
      zona_id: d.zona_id || null, principal: !!principal, activo: true, ultimo_uso: null, creado_en: iso(ahora())
    };
    BD.cliente_direcciones.push(fila);
    return fila;
  }

  // ------------------------------------------------------------------ cambios de estado
  function validarEvidencias(ev) {
    var lista = [];
    ['foto', 'firma'].forEach(function (tipo) {
      var dato = ev && ev[tipo];
      if (!dato) return;
      if (typeof dato !== 'string' || dato.length > 450000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dato)) fallo(400, 'La ' + tipo + ' no es válida o pesa demasiado');
      lista.push({ tipo: tipo, dato: dato });
    });
    return lista;
  }
  function guardarEvidencias(c, pedidoId, lista) {
    var BD = db();
    lista.forEach(function (e) { BD.pedido_evidencias.push({ id: D.sig('evidencia'), pedido_id: pedidoId, tipo: e.tipo, dato: e.dato, creado_por: c.user.id, creado_en: iso(ahora()) }); });
    if (BD.pedido_evidencias.length > MAX_EVIDENCIAS) BD.pedido_evidencias.splice(0, BD.pedido_evidencias.length - MAX_EVIDENCIAS);
  }

  function transicionar(c, id, nuevo, datos, opciones) {
    datos = datos || {}; opciones = opciones || {};
    var p = pedidoOr404(id);
    var ped = formato(p);
    var actual = p.estado;
    var t = ticketDe(p);
    var ya = iso(ahora());
    if (opciones.soloRepartidor && p.repartidor_id !== c.user.id) fallo(403, 'Este pedido no es tuyo');

    if (nuevo === 'cancelado') {
      var eraEntregado = actual === 'entregado';
      if (!eraEntregado && !contiene(CANCELABLES, actual)) fallo(409, 'Este pedido ya no se puede cancelar');
      if (eraEntregado) {
        if (!esAdmin(c)) fallo(403, 'Solo el dueño o el gerente pueden cancelar un pedido ya entregado');
        if (p.liquidacion_id) fallo(409, 'Este pedido ya se liquidó en Caja: para regresar el dinero haz una devolución desde Devoluciones');
        if (!textoOnull(datos.motivo, 300)) fallo(400, 'Escribe por qué cancelas un pedido ya entregado');
      }
      if (ped.ticket_estado === 'pagado') fallo(409, 'Este pedido ya está cobrado: para regresar el dinero haz una devolución desde Devoluciones');
      if (t && estadoTicket(t) === 'pendiente') t.estado = 'cancelado';
      p.estado = 'cancelado';
      p.motivo_cancelacion = textoOnull(datos.motivo, 300);
    } else {
      if (!TRANSICIONES[actual] || !contiene(TRANSICIONES[actual], nuevo)) fallo(409, 'Este pedido está "' + (ESTADO_TXT[actual] || actual) + '" y no puede pasar a "' + (ESTADO_TXT[nuevo] || nuevo) + '"');
      if (p.tipo === 'recoger' && contiene(['en_camino', 'no_entregado'], nuevo)) fallo(409, 'Un pedido para recoger no sale con repartidor');
      if (nuevo === 'en_camino' && !p.repartidor_id) fallo(400, 'Primero asigna un repartidor');

      if (nuevo === 'preparando') {
        p.estado = 'preparando'; p.salio_en = null; p.llego_en = null; p.aceptado_en = null; p.aceptado_por = null;
      } else if (nuevo === 'listo') {
        p.estado = 'listo'; p.listo_en = p.listo_en || ya; p.salio_en = null; p.llego_en = null;
      } else if (nuevo === 'en_camino') {
        p.estado = 'en_camino'; p.salio_en = ya; p.llego_en = null; p.listo_en = p.listo_en || ya;
      } else if (nuevo === 'no_entregado') {
        var motivo = textoOnull(datos.motivo, 300);
        if (!motivo) fallo(400, 'Escribe por qué no se pudo entregar');
        p.estado = 'no_entregado'; p.motivo_no_entrega = motivo; p.llego_en = p.llego_en || ya;
      } else if (nuevo === 'entregado') {
        var metodo = null, monto = null;
        if (p.tipo === 'domicilio' && p.pago_modo === 'al_recibir') {
          if (!p.repartidor_id) fallo(400, 'Asigna un repartidor para registrar el cobro de este pedido');
          metodo = datos.metodo_cobro || 'efectivo';
          if (!contiene(METODOS_COBRO, metodo)) fallo(400, 'Forma de cobro inválida');
          monto = ped.resta; // en la puerta se cobra lo que RESTA (total menos el anticipo)
        }
        var ev = opciones.evidencias ? validarEvidencias(opciones.evidencias) : [];
        guardarEvidencias(c, p.id, ev);
        p.estado = 'entregado'; p.entregado_en = ya; p.llego_en = p.llego_en || ya; p.metodo_cobro = metodo; p.monto_cobrado = monto;
        p.listo_en = p.listo_en || ya;
        if (p.tipo === 'domicilio') p.salio_en = p.salio_en || ya;
      }
    }
    D.bitacora(c, 'pedido_' + nuevo, 'pedidos', p.id, { estado: nuevo, motivo: datos.motivo || undefined }, { estado: actual });
    sincronizar(p);
    return cargarPedido(p);
  }

  // ------------------------------------------------------------------ liquidación del repartidor
  function armarLiquidacion(repartidorId) {
    var BD = db();
    var lista = BD.pedidos.filter(function (p) { return p.repartidor_id === repartidorId && p.tipo === 'domicilio' && p.estado === 'entregado' && !p.liquidacion_id; })
      .sort(ordenPor([{ k: function (p) { return p.entregado_en; } }])).map(formato);
    var u = usuario(repartidorId);
    var s = { efectivo: 0, transferencia: 0, tarjeta: 0, pagados_antes: 0, credito: 0, ya_cobrados_en_caja: 0, n_efectivo: 0 };
    var detalle = lista.map(function (p) {
      var tipo;
      if (p.pago_modo === 'al_recibir') {
        if (p.ticket_estado !== 'pendiente') { tipo = 'ya_cobrado_en_caja'; s.ya_cobrados_en_caja += p.total_neto; }
        else { tipo = p.metodo_cobro || 'efectivo'; s[tipo] += p.resta; if (tipo === 'efectivo') s.n_efectivo += 1; }
      } else if (p.pago_modo === 'credito') { tipo = 'credito'; s.credito += p.total_neto; }
      else { tipo = 'pagado_antes'; s.pagados_antes += p.total_neto; }
      var o = resumenParaRepartidor(p); o.cobro = tipo; return o;
    });
    Object.keys(s).forEach(function (k) { if (k !== 'n_efectivo') s[k] = r2(s[k]); });
    var hechas = BD.pedidos.filter(function (p) { return p.repartidor_id === repartidorId && p.tipo === 'domicilio' && !p.liquidacion_id; });
    return {
      repartidor: u ? { id: u.id, nombre: u.nombre, telefono: u.telefono || null } : null,
      pedidos: detalle, resumen: s,
      entregadas: hechas.filter(function (p) { return p.estado === 'entregado'; }).length,
      no_entregadas: hechas.filter(function (p) { return p.estado === 'no_entregado'; }).length,
      debe_entregar_efectivo: s.efectivo
    };
  }

  function descontarInventarioTicket(t, c, agotados) {
    var BD = db();
    D.itemsDe(t.id).forEach(function (it) {
      if (it.tipo === 'producto' && it.producto_id) D.descontarProducto(it.producto_id, num(it.cantidad), t, c, agotados);
      else if (it.tipo === 'kit' && it.kit_id) {
        (BD.kit_productos || []).filter(function (kp) { return kp.kit_id === it.kit_id; })
          .forEach(function (kp) { D.descontarProducto(kp.producto_id, num(kp.cantidad) * num(it.cantidad), t, c, agotados); });
      }
    });
  }

  // ------------------------------------------------------------------ pedidos fijos
  function fijoFila(f) {
    var BD = db(), o = clonar(f);
    var c = porId(BD.clientes, f.cliente_id) || {};
    var d = f.direccion_id ? porId(BD.cliente_direcciones, f.direccion_id) : null;
    var u = usuario(f.repartidor_id);
    o.cliente_nombre = c.nombre || null; o.cliente_telefono = c.telefono || null; o.cliente_tipo = c.tipo || 'publico';
    o.calle = d ? d.calle : null; o.colonia = d ? d.colonia : null; o.direccion_alias = d ? d.alias : null;
    o.repartidor_nombre = u ? u.nombre : null;
    return o;
  }

  function validarFijo(b) {
    var crudos = Array.isArray(b.dias) ? b.dias : String(b.dias || '').split(',');
    var dias = unicos(crudos.map(function (d) { return parseInt(d, 10); }).filter(function (d) { return d >= 0 && d <= 6; })).sort();
    if (!dias.length) return { error: 'Elige al menos un día de la semana' };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.hora || ''))) return { error: 'La hora de entrega debe verse así: 09:00' };
    var tipo = b.tipo === 'recoger' ? 'recoger' : 'domicilio';
    var pago = contiene(PAGO_MODOS, b.pago_modo) ? b.pago_modo : 'credito';
    var items = (Array.isArray(b.items) ? b.items : []).map(function (i) { return { producto_id: Number(i.producto_id), nombre: textoOnull(i.nombre, 150), cantidad: Number(i.cantidad) }; });
    if (!items.length || items.length > 100) return { error: 'Agrega al menos un producto al pedido fijo' };
    if (items.some(function (i) { return !(i.producto_id > 0) || Math.floor(i.producto_id) !== i.producto_id || !isFinite(i.cantidad) || i.cantidad <= 0; })) return { error: 'Hay un producto con cantidad inválida' };
    return { dias: dias.join(','), hora: String(b.hora), tipo: tipo, pago_modo: pago, items: items, nombre: textoOnull(b.nombre, 100), notas: textoOnull(b.notas, 300) };
  }

  function validarRelacionesFijo(b, v) {
    var BD = db();
    var c = porId(BD.clientes, b.cliente_id);
    if (!c || !c.activo) fallo(400, 'Elige un cliente');
    var direccionId = null;
    if (v.tipo === 'domicilio') {
      if (!b.direccion_id) fallo(400, 'Elige la dirección de entrega');
      var d = porId(BD.cliente_direcciones, b.direccion_id);
      if (!d || d.cliente_id !== c.id || !d.activo) fallo(400, 'Esa dirección no es de este cliente');
      direccionId = d.id;
    }
    var zonaId = null;
    if (b.zona_id) {
      var z = porId(BD.zonas_envio, b.zona_id);
      if (!z) fallo(400, 'La zona de envío no existe');
      zonaId = z.id;
    }
    var repartidorId = repartidorValido(b.repartidor_id);
    v.items.forEach(function (i) {
      var p = porId(BD.productos, i.producto_id);
      if (!p) fallo(400, 'Hay un producto que ya no existe');
      i.nombre = i.nombre || p.nombre;
    });
    return { cliente: c, direccionId: direccionId, zonaId: zonaId, repartidorId: repartidorId };
  }

  // Precio de hoy: mayoreo si el cliente lo usa y la promoción por volumen si conviene.
  function itemsDeLista(lista, cliente) {
    var BD = db(), items = [];
    (lista || []).forEach(function (i) {
      var pid = Number(Array.isArray(i) ? i[0] : i.producto_id), cantidad = Number(Array.isArray(i) ? i[1] : i.cantidad);
      var p = porId(BD.productos, pid);
      if (!p || !p.activo || !(cantidad > 0)) return;
      var precio = Number(p.precio);
      if (cliente && cliente.usa_mayoreo && Number(p.precio_mayoreo) > 0) precio = Number(p.precio_mayoreo);
      (BD.promociones || []).forEach(function (pr) {
        if (pr.activo && pr.producto_id === p.id && Number(pr.cantidad_minima) <= cantidad && Number(pr.precio_promocional) < precio) precio = Number(pr.precio_promocional);
      });
      items.push({ tipo: 'producto', producto_id: p.id, nombre_producto: p.nombre, cantidad: cantidad, precio_unitario: precio });
    });
    return items;
  }

  function generarFijosDelDia(fecha, omitirNuevosYaPasados) {
    var BD = db(), res = { creados: 0, omitidos: 0, errores: [] };
    var dow = String(diaSemana(fecha)), horaYa = hm(ahora());
    BD.pedidos_fijos.filter(function (f) { return f.activo; })
      .sort(ordenPor([{ k: function (f) { return f.hora; } }, { k: function (f) { return f.id; } }]))
      .forEach(function (f) {
        var cli = porId(BD.clientes, f.cliente_id);
        if (!cli || !cli.activo) return;
        if (!contiene(String(f.dias).split(','), dow)) return;
        if (omitirNuevosYaPasados && fechaDe(f.creado_en) === fecha && f.hora <= horaYa) return;
        if (BD.pedidos.some(function (p) { return p.pedido_fijo_id === f.id && p.fecha_entrega === fecha; })) { res.omitidos++; return; }
        try {
          var items = itemsDeLista(f.items, cli);
          if (!items.length) fallo(400, 'ningún producto del pedido fijo está disponible');
          var dir = f.tipo === 'domicilio' && f.direccion_id ? porId(BD.cliente_direcciones, f.direccion_id) : null;
          var rep = f.repartidor_id ? usuario(f.repartidor_id) : null;
          crearPedidoCore({
            usuarioId: null, items: items, tipo: f.tipo, cliente: cli, nombre_contacto: cli.nombre, telefono: cli.telefono,
            direccion: dir ? clonar(dir) : null, direccion_id: dir ? dir.id : null, zona_id: f.zona_id || (dir && dir.zona_id) || null,
            pago_modo: f.pago_modo, paga_con: null, programado_para: fecha + 'T' + f.hora, enviar: true,
            repartidor_id: rep && rep.rol === 'repartidor' && rep.activo ? rep.id : null, notas: f.notas, origen: 'fijo', pedido_fijo_id: f.id
          });
          res.creados++;
        } catch (e) {
          res.errores.push(cli.nombre + ': ' + (e.apiError || e.message));
        }
      });
    return res;
  }

  // Hoy siempre; mañana desde la hora configurada (como el temporizador del servidor).
  function asegurarFijos() {
    var BD = db();
    if (!BD.pedidos_fijos.some(function (f) { return f.activo; })) return;
    var hoy = hoyStr();
    generarFijosDelDia(hoy, true);
    if (hm(ahora()) >= (cfg().pedidos_hora_aviso_fijos || '18:00')) generarFijosDelDia(sumarDias(hoy, 1), false);
  }

  function avanzarProgramados() {
    var n = 0, t = ahora().getTime();
    (db().pedidos || []).forEach(function (p) {
      if (p.estado !== 'programado' || !p.preparar_desde) return;
      var f = parseLocal(p.preparar_desde);
      if (f && f.getTime() <= t) { p.estado = 'preparando'; n++; }
    });
    return n;
  }

  // ------------------------------------------------------------------ datos de ejemplo
  var CLIENTES_SEM = { 1: ['María González', '33 1234 5678'], 2: ['Fonda Doña Lupe', '33 8765 4321'], 3: ['Carlos Ramírez', '33 5555 0101'] };
  var DIRS_SEM = {
    1: [
      { alias: 'Casa', calle: 'Av. de la Paz 1650', colonia: 'Americana', cp: '44160', ciudad: 'Guadalajara', referencias: 'Casa blanca con portón café, junto a la farmacia', latitud: 20.6713, longitud: -103.3655, zona: 0, principal: true },
      { alias: 'Trabajo', calle: 'Av. Chapultepec Sur 120, int. 4', colonia: 'Americana', cp: '44140', ciudad: 'Guadalajara', referencias: 'Oficina del segundo piso, preguntar en recepción', zona: 0 }
    ],
    2: [{ alias: 'Fonda', calle: 'Calle Pedro Moreno 980', colonia: 'Centro', cp: '44100', ciudad: 'Guadalajara', referencias: 'Entrar por la puerta de la cocina y preguntar por Doña Lupe', latitud: 20.6748, longitud: -103.3572, zona: 0, principal: true }],
    3: [{ alias: 'Casa', calle: 'Av. Guadalupe 4520, depto. 3B', colonia: 'Chapalita', cp: '45040', ciudad: 'Zapopan', referencias: 'Edificio gris frente al parque, timbre 3B', latitud: 20.6671, longitud: -103.4019, zona: 1, principal: true }]
  };
  var SUELTOS = {
    laura: { nombre: 'Laura Méndez', telefono: '33 3615 2290', zona: 1, dir: { calle: 'Av. Terranova 1215', colonia: 'Providencia', cp: '44630', ciudad: 'Guadalajara', referencias: 'Casa con reja verde, tocar el timbre de arriba', latitud: 20.6929, longitud: -103.3896 } },
    jorge: { nombre: 'Jorge Castillo', telefono: '33 1890 4471', zona: 2, dir: { calle: 'Calle Independencia 210', colonia: 'Centro Tlaquepaque', cp: '45500', ciudad: 'San Pedro Tlaquepaque', referencias: 'Local de artesanías, entregar en el mostrador' } },
    roberto: { nombre: 'Roberto Aguilar', telefono: '33 2201 7788', zona: 2, dir: { calle: 'Av. Patria 2085', colonia: 'Jardines Universidad', cp: '45110', ciudad: 'Zapopan', referencias: 'Casa de dos pisos color terracota' } },
    elena: { nombre: 'Elena Pérez', telefono: '33 3122 6045' },
    sofia: { nombre: 'Sofía Torres', telefono: '33 3954 1180' }
  };

  function zonaSemilla(n) {
    var BD = db(), id = (BD.zonasSemilla || [])[n];
    var z = id ? porId(BD.zonas_envio, id) : null;
    return z && z.activo ? z.id : null;
  }

  function sembrarZonas() {
    var BD = db();
    BD.zonas_envio = [];
    BD.zonasSemilla = [
      ['Zona 1 · Centro y Americana', 'Hasta 3 km de la tienda', 30, null],
      ['Zona 2 · Providencia y Chapalita', 'De 3 a 6 km', 45, null],
      ['Zona 3 · Zapopan y Tlaquepaque', 'Más de 6 km', 65, 1500]
    ].map(function (z, i) {
      var fila = { id: D.sig('zona'), sucursal_id: 1, nombre: z[0], descripcion: z[1], costo: z[2], envio_gratis_desde: z[3], orden: i + 1, activo: true, creado_en: iso(D.haceHoras(24 * 30)) };
      BD.zonas_envio.push(fila);
      return fila.id;
    });
  }

  function sembrarDirecciones() {
    var BD = db();
    BD.cliente_direcciones = [];
    Object.keys(DIRS_SEM).forEach(function (cid) {
      if (!porId(BD.clientes, cid)) return;
      DIRS_SEM[cid].forEach(function (d) {
        var o = clonar(d); o.zona_id = zonaSemilla(d.zona);
        var fila = nuevaDireccion(Number(cid), o, !!d.principal);
        fila.creado_en = iso(new Date(D.inicioDelDia().getTime() - 20 * 86400000));
      });
    });
  }

  function sembrarFijos() {
    var BD = db();
    BD.pedidos_fijos = [];
    var hace30 = iso(new Date(D.inicioDelDia().getTime() - 30 * 86400000));
    var dirFonda = direccionesDe(2)[0];
    if (porId(BD.clientes, 2)) {
      BD.pedidos_fijos.push({
        id: D.sig('pedido_fijo'), sucursal_id: 1, cliente_id: 2, direccion_id: dirFonda ? dirFonda.id : null, nombre: 'Surtido diario de la fonda',
        dias: '1,2,3,4,5,6', hora: '09:00', tipo: dirFonda ? 'domicilio' : 'recoger', pago_modo: 'credito', zona_id: null, repartidor_id: 4,
        items: [{ producto_id: 1, nombre: 'Queso Oaxaca', cantidad: 3 }, { producto_id: 7, nombre: 'Crema ácida a granel', cantidad: 2 }, { producto_id: 23, nombre: 'Tortillas de maíz', cantidad: 5 }, { producto_id: 14, nombre: 'Chorizo argentino', cantidad: 1.5 }],
        notas: 'Entregar antes de las 10:00 (abren a las 11:00)', activo: true, creado_en: hace30
      });
    }
    if (porId(BD.clientes, 1)) {
      BD.pedidos_fijos.push({
        id: D.sig('pedido_fijo'), sucursal_id: 1, cliente_id: 1, direccion_id: null, nombre: 'Despensa del sábado',
        dias: '6', hora: '11:00', tipo: 'recoger', pago_modo: 'pagado', zona_id: null, repartidor_id: null,
        items: [{ producto_id: 22, nombre: 'Huevo blanco 12 pzas', cantidad: 1 }, { producto_id: 9, nombre: 'Leche entera 1 L', cantidad: 4 }, { producto_id: 6, nombre: 'Queso Fresco', cantidad: 1 }],
        notas: 'Pasa ella misma a recogerlo', activo: true, creado_en: hace30
      });
    }
  }

  function sembrarLiquidaciones() {
    var BD = db(), ini = D.inicioDelDia().getTime();
    BD.liquidaciones = [
      { id: D.sig('liquidacion'), sucursal_id: 1, repartidor_id: 4, turno_id: null, recibido_por: 2, creada_en: iso(new Date(ini - 2 * 86400000 + (18 * 60 + 40) * 60000)), num_pedidos: 4, esperado_efectivo: 942, entregado_efectivo: 922, diferencia: -20, total_transferencia: 0, total_tarjeta: 185.5, notas: 'Faltaron $20: los repone mañana' },
      { id: D.sig('liquidacion'), sucursal_id: 1, repartidor_id: 4, turno_id: null, recibido_por: 2, creada_en: iso(new Date(ini - 86400000 + (19 * 60 + 10) * 60000)), num_pedidos: 6, esperado_efectivo: 1386.5, entregado_efectivo: 1386.5, diferencia: 0, total_transferencia: 312, total_tarjeta: 0, notas: null }
    ];
  }

  // Un pedido de ejemplo: se crea con el mismo núcleo que los reales y luego se le ponen sus tiempos.
  function semilla(o) {
    try {
      var BD = db();
      var cli = o.cliente_id ? porId(BD.clientes, o.cliente_id) : null;
      if (cli && !cli.activo) cli = null;
      var suelto = o.suelto ? SUELTOS[o.suelto] : null;
      var base = o.cliente_id ? CLIENTES_SEM[o.cliente_id] : null;
      var items = itemsDeLista(o.items, cli);
      if (!items.length) return null;
      var direccion = null, direccionId = null, zonaId = null;
      if (o.tipo === 'domicilio') {
        var dd = cli ? direccionesDe(cli.id)[0] : null;
        if (dd) { direccion = clonar(dd); direccionId = dd.id; zonaId = dd.zona_id; dd.ultimo_uso = iso(o.creado); }
        else if (suelto && suelto.dir) { direccion = clonar(suelto.dir); zonaId = zonaSemilla(suelto.zona); }
        else if (o.cliente_id && DIRS_SEM[o.cliente_id]) { direccion = clonar(DIRS_SEM[o.cliente_id][0]); zonaId = zonaSemilla(DIRS_SEM[o.cliente_id][0].zona); }
        var z = zonaId ? porId(BD.zonas_envio, zonaId) : null;
        if (!z || !z.activo) zonaId = null;
      }
      var pago = o.pago_modo;
      if (pago === 'credito' && !cli) pago = 'pagado';
      var p = crearPedidoCore({
        usuarioId: o.creado_por === undefined ? 3 : o.creado_por, items: items, tipo: o.tipo, cliente: cli,
        nombre_contacto: cli ? cli.nombre : (suelto ? suelto.nombre : base[0]), telefono: cli ? cli.telefono : (suelto ? suelto.telefono : base[1]),
        direccion: direccion, direccion_id: direccionId, zona_id: zonaId, pago_modo: pago, paga_con: o.paga_con,
        anticipo: o.anticipo, anticipo_metodo: o.anticipo_metodo, ya_pago_todo: o.ya_pago_todo,
        programado_para: o.programado_para || null, enviar: true, repartidor_id: o.repartidor_id && esRepartidorActivo(o.repartidor_id) ? o.repartidor_id : null,
        notas: o.notas || null, origen: o.origen || 'manual', pedido_fijo_id: o.pedido_fijo_id || null
      });
      var t = ticketDe(p);
      p.estado = o.estado;
      if (o.preparar_desde !== undefined) p.preparar_desde = o.preparar_desde;
      p.creado_en = iso(o.creado); t.fecha_creacion = p.creado_en;
      ['aceptado_en', 'listo_en', 'salio_en', 'llego_en', 'entregado_en', 'aviso_camino_en'].forEach(function (k) { p[k] = o[k] ? iso(o[k]) : null; });
      p.aceptado_por = o.aceptado_en ? 3 : null;
      if (!p.repartidor_id && contiene(['en_camino', 'entregado'], p.estado) && p.tipo === 'domicilio') p.estado = 'listo';
      if (o.estado === 'cancelado') { p.motivo_cancelacion = o.motivo || null; t.estado = 'cancelado'; }
      if (p.estado === 'entregado' && p.tipo === 'domicilio' && p.pago_modo === 'al_recibir') { p.metodo_cobro = o.metodo_cobro || 'efectivo'; p.monto_cobrado = formato(p).resta; }
      var folio = 'S1-D' + String(t.id).padStart(5, '0');
      if (!BD.tickets.some(function (x) { return x.folio === folio; })) t.folio = folio;
      sincronizar(p);
      return p;
    } catch (e) {
      try { console.warn('[demo] pedido de ejemplo omitido:', e && (e.apiError || e.message)); } catch (e2) { /* nada */ }
      return null;
    }
  }
  function esRepartidorActivo(id) { var u = usuario(id); return !!u && u.rol === 'repartidor' && u.activo; }

  // Los pedidos de ejemplo de HOY (y dos de mañana). Las horas salen de la hora actual para que todo se vea "en vivo".
  function sembrarDia() {
    var BD = db();
    var fuera = {};
    (BD.pedidos || []).forEach(function (p) { var t = porId(BD.tickets, p.ticket_id); if (t && t.estado !== 'pagado') fuera[t.id] = true; });
    BD.tickets = BD.tickets.filter(function (t) { return !fuera[t.id]; });
    BD.ticket_detalle = BD.ticket_detalle.filter(function (d) { return !fuera[d.ticket_id]; });
    BD.pedidos = [];
    BD.pedido_evidencias = [];
    BD.pedidosDia = hoyStr();

    var t0 = ahora(), ini = D.inicioDelDia(t0), finDia = ini.getTime() + 86400000 - 5 * 60000;
    var hoy = hoyStr(), manana = sumarDias(hoy, 1);
    var minDia = t0.getHours() * 60 + t0.getMinutes();
    function hace(min) { return new Date(Math.max(ini.getTime() + 60000, t0.getTime() - min * 60000)); }
    function enMin(min) {
      var d = new Date(Math.min(finDia, t0.getTime() + min * 60000));
      d.setSeconds(0, 0); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5);
      return new Date(Math.min(finDia, d.getTime()));
    }
    function haceRedondo(min) { var d = hace(min); d.setSeconds(0, 0); d.setMinutes(Math.floor(d.getMinutes() / 5) * 5); return d; }
    function aLas(hhmm, dias) { var x = hhmm.split(':'); return new Date(ini.getFullYear(), ini.getMonth(), ini.getDate() + (dias || 0), +x[0], +x[1]); }
    var minPrep = minPreparacion();

    // A) Fonda Doña Lupe: su pedido fijo de cada mañana, a crédito, lo lleva Luis.
    var fonda = BD.pedidos_fijos.filter(function (f) { return f.activo && f.cliente_id === 2 && f.tipo === 'domicilio'; })[0];
    var horaFonda = fonda ? fonda.hora : '09:00';
    var baseFonda = aLas(horaFonda), minFonda = baseFonda.getHours() * 60 + baseFonda.getMinutes();
    var fondaHoy = !!fonda && contiene(String(fonda.dias).split(','), String(t0.getDay()));
    var estFonda = minDia >= minFonda + 90 ? 'entregado' : (minDia >= minFonda - minPrep ? 'preparando' : 'programado');
    function relFonda(min) { return new Date(baseFonda.getTime() + min * 60000); }
    semilla({
      cliente_id: 2, tipo: 'domicilio', items: fonda ? fonda.items : [[1, 3], [7, 2], [23, 5], [14, 1.5]], pago_modo: 'credito', repartidor_id: 4,
      programado_para: hoy + 'T' + horaFonda, preparar_desde: localStr(relFonda(-minPrep)), estado: estFonda,
      origen: fondaHoy ? 'fijo' : 'manual', pedido_fijo_id: fondaHoy ? fonda.id : null, notas: fonda ? fonda.notas : null, creado_por: fondaHoy ? null : 3,
      creado: new Date(Math.max(ini.getTime() + 60000, Math.min(relFonda(-120).getTime(), t0.getTime() - 5 * 60000))),
      aceptado_en: estFonda === 'programado' ? null : (estFonda === 'entregado' ? relFonda(-55) : hace(2)),
      listo_en: estFonda === 'entregado' ? relFonda(-25) : null, salio_en: estFonda === 'entregado' ? relFonda(-20) : null,
      llego_en: estFonda === 'entregado' ? relFonda(-3) : null, entregado_en: estFonda === 'entregado' ? relFonda(1) : null
    });
    // B) Carlos Ramírez: ya entregado, pagó en efectivo al repartidor (falta liquidarlo en Caja).
    semilla({
      cliente_id: 3, tipo: 'domicilio', items: [[17, 1.5], [18, 1], [23, 1]], pago_modo: 'al_recibir', paga_con: 600, repartidor_id: 4, estado: 'entregado',
      metodo_cobro: 'efectivo', creado: hace(150), aceptado_en: hace(146), listo_en: hace(125), salio_en: hace(120), llego_en: hace(103), entregado_en: hace(100)
    });
    // C) María González: va en camino con Luis; paga al recibir con un billete de $500.
    semilla({
      cliente_id: 1, tipo: 'domicilio', items: [[2, 0.5], [12, 0.25], [9, 2], [22, 1]], pago_modo: 'al_recibir', paga_con: 500, repartidor_id: 4, estado: 'en_camino',
      programado_para: localStr(enMin(15)), notas: 'Tocar fuerte, el timbre no sirve', creado: hace(55), aceptado_en: hace(50), listo_en: hace(20), salio_en: hace(12), aviso_camino_en: hace(11)
    });
    // D) Laura Méndez: listo, sin repartidor y ya con retraso (lo puede tomar el que esté libre).
    semilla({
      suelto: 'laura', tipo: 'domicilio', items: [[19, 1], [21, 1.2], [24, 1]], pago_modo: 'al_recibir', estado: 'listo',
      programado_para: localStr(haceRedondo(10)), creado: hace(45), aceptado_en: hace(42), listo_en: hace(6)
    });
    // E) Jorge Castillo: ya pagó todo por transferencia; se está preparando y lo llevará Luis.
    semilla({
      suelto: 'jorge', tipo: 'domicilio', items: [[16, 0.3], [4, 0.5], [3, 0.5]], pago_modo: 'al_recibir', ya_pago_todo: true, anticipo_metodo: 'transferencia',
      repartidor_id: 4, estado: 'preparando', programado_para: localStr(enMin(50)), notas: 'Pagó por transferencia, ya está confirmado', creado: hace(25), aceptado_en: hace(9)
    });
    // F) Elena Pérez: para recoger, dejó $100 de anticipo; recién llegó (Mostrador lo ve como NUEVO).
    semilla({
      suelto: 'elena', tipo: 'recoger', items: [[6, 1], [7, 0.5], [23, 2]], pago_modo: 'pagado', anticipo: 100, anticipo_metodo: 'efectivo',
      estado: 'preparando', programado_para: localStr(enMin(40)), creado: hace(4)
    });
    // G) Roberto Aguilar: programado para más tarde (pasa solo a "Preparando" 30 min antes).
    var progG = enMin(180);
    semilla({
      suelto: 'roberto', tipo: 'domicilio', items: [[17, 1], [13, 0.5], [11, 1], [26, 2]], pago_modo: 'al_recibir', estado: 'programado',
      programado_para: localStr(progG), preparar_desde: localStr(new Date(progG.getTime() - minPrep * 60000)), notas: 'Llamar 10 minutos antes de llegar', creado: hace(70)
    });
    // H) Sofía Torres: cancelado.
    semilla({
      suelto: 'sofia', tipo: 'recoger', items: [[5, 0.25], [10, 1]], pago_modo: 'pagado', estado: 'cancelado', motivo: 'El cliente ya no lo quiso', creado: hace(95)
    });
    // I y J) Mañana: Carlos a crédito a las 10:00 y María pasa a recoger a las 12:30.
    semilla({
      cliente_id: 3, tipo: 'domicilio', items: [[17, 2], [18, 1], [25, 2]], pago_modo: 'credito', repartidor_id: 4, estado: 'programado',
      programado_para: manana + 'T10:00', preparar_desde: localStr(new Date(aLas('10:00', 1).getTime() - minPrep * 60000)), creado: hace(60)
    });
    semilla({
      cliente_id: 1, tipo: 'recoger', items: [[22, 1], [9, 4], [6, 1]], pago_modo: 'pagado', estado: 'programado',
      programado_para: manana + 'T12:30', preparar_desde: localStr(new Date(aLas('12:30', 1).getTime() - minPrep * 60000)), notas: 'Pasa su hija a recogerlo', creado: hace(20)
    });
  }

  // Se llama al inicio de cada ruta (y al cargar la página): crea lo que falte y pone todo al día.
  function asegurar() {
    var BD = db(), n = 0;
    if (!BD.seq) BD.seq = {};
    var c = BD.configuracion || (BD.configuracion = {});
    var defs = { pedidos_envio_gratis_desde: 1200, pedidos_min_preparacion: 30, pedidos_hora_aviso_fijos: '18:00', pedidos_foto_obligatoria: false, pedidos_firma_obligatoria: false };
    Object.keys(defs).forEach(function (k) { if (c[k] === undefined) { c[k] = defs[k]; n++; } });
    (BD.clientes || []).forEach(function (cl) {
      if (cl.tipo === undefined) { cl.tipo = cl.id === 2 ? 'tienda' : 'publico'; cl.usa_mayoreo = cl.id === 2; n++; }
    });
    if (!BD.zonas_envio) { sembrarZonas(); n++; }
    if (!BD.cliente_direcciones) { sembrarDirecciones(); n++; }
    if (!BD.pedidos_fijos) { sembrarFijos(); n++; }
    if (!BD.liquidaciones) { sembrarLiquidaciones(); n++; }
    if (!BD.pedido_evidencias) { BD.pedido_evidencias = []; n++; }
    if (!BD.pedidos || BD.pedidosDia !== hoyStr()) { sembrarDia(); n++; }
    n += avanzarProgramados();
    n += sincronizarTodos();
    return n;
  }

  // Registra una ruta: antes pone los datos al día y al final deja los tickets como les toca.
  function ruta(metodo, patron, fn) {
    D.R(metodo, patron, function (c) {
      asegurar();
      var r = fn(c);
      sincronizarTodos();
      return r;
    });
  }

  function soloRepartidor(c) { D.requiereRol(c, ['repartidor']); }
  // El repartidor solo ve sus pedidos (o los listos que nadie ha tomado).
  function puedeVer(c, p) {
    if (c.user.rol !== 'repartidor') return true;
    return p.repartidor_id === c.user.id || (!p.repartidor_id && p.estado === 'listo' && p.tipo === 'domicilio');
  }

  // =================================================================== ZONAS DE ENVÍO
  ruta('GET', '/pedidos/zonas', function (c) {
    var todas = c.query.todas === '1' && esAdmin(c);
    var zonas = db().zonas_envio.filter(function (z) { return todas || z.activo; })
      .sort(ordenPor([{ k: function (z) { return z.orden; } }, { k: function (z) { return Number(z.costo); } }, { k: function (z) { return z.id; } }])).map(zonaFila);
    return { zonas: zonas, envio_gratis_desde: envioGratisGeneral() };
  });

  function validarZona(b) {
    var nombre = textoOnull(b.nombre, 80);
    if (!nombre) return { error: 'El nombre de la zona es requerido' };
    var costo = Number(b.costo);
    if (vacio(b.costo)) costo = 0;
    if (!isFinite(costo) || costo < 0 || costo > 100000) return { error: 'El costo de envío debe ser 0 o más' };
    var gratis = null;
    if (!vacio(b.envio_gratis_desde)) {
      gratis = Number(b.envio_gratis_desde);
      if (!isFinite(gratis) || gratis < 0) return { error: 'El monto para envío gratis no es válido' };
    }
    return { nombre: nombre, descripcion: textoOnull(b.descripcion, 160), costo: r2(costo), gratis: gratis, orden: esEntero(b.orden) ? Number(b.orden) : 0 };
  }
  ruta('POST', '/pedidos/zonas', function (c) {
    D.requiereAdmin(c);
    var z = validarZona(c.body);
    if (z.error) fallo(400, z.error);
    var fila = { id: D.sig('zona'), sucursal_id: 1, nombre: z.nombre, descripcion: z.descripcion, costo: z.costo, envio_gratis_desde: z.gratis, orden: z.orden, activo: true, creado_en: iso(ahora()) };
    db().zonas_envio.push(fila);
    return zonaFila(fila);
  });
  ruta('PUT', '/pedidos/zonas/:id', function (c) {
    D.requiereAdmin(c);
    var z = validarZona(c.body);
    if (z.error) fallo(400, z.error);
    var fila = esEntero(c.params.id) ? porId(db().zonas_envio, c.params.id) : null;
    if (!fila) fallo(404, 'Zona no encontrada');
    fila.nombre = z.nombre; fila.descripcion = z.descripcion; fila.costo = z.costo; fila.envio_gratis_desde = z.gratis; fila.orden = z.orden;
    if (typeof c.body.activo === 'boolean') fila.activo = c.body.activo;
    return zonaFila(fila);
  });
  ruta('DELETE', '/pedidos/zonas/:id', function (c) {
    D.requiereAdmin(c);
    var fila = esEntero(c.params.id) ? porId(db().zonas_envio, c.params.id) : null;
    if (!fila) fallo(404, 'Zona no encontrada');
    fila.activo = false;
    return { ok: true };
  });

  ruta('GET', '/pedidos/cotizar-envio', function (c) {
    var calc = calcularEnvio(Number(c.query.zona_id) || null, Number(c.query.subtotal) || 0);
    if (calc.error) fallo(400, calc.error);
    return { costo: calc.costo, gratis: calc.gratis, minimo_gratis: calc.minimo || 0, zona: calc.zona ? calc.zona.nombre : null };
  });

  // =================================================================== CLIENTES PARA PEDIDOS
  ruta('GET', '/pedidos/clientes', function (c) {
    D.requierePermiso(c, 'VENTAS_CREAR');
    var q = String(c.query.q || '').trim();
    if (q.length < 2) return [];
    var BD = db(), nq = norm(q), dig = soloDigitos(q), porTel = dig.length >= 3;
    return BD.clientes.filter(function (cl) {
      return cl.activo && (norm(cl.nombre).indexOf(nq) !== -1 || (porTel && soloDigitos(cl.telefono).indexOf(dig) !== -1));
    }).sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); }).slice(0, 8).map(function (cl) {
      var suyos = BD.pedidos.filter(function (p) { return p.cliente_id === cl.id && p.estado !== 'cancelado'; });
      var ultimo = suyos.map(function (p) { return p.creado_en; }).sort().pop() || null;
      return {
        id: cl.id, nombre: cl.nombre, telefono: cl.telefono || null, tipo: cl.tipo || 'publico', usa_mayoreo: !!cl.usa_mayoreo,
        saldo_actual: num(cl.saldo_actual), limite_credito: num(cl.limite_credito), n_pedidos: suyos.length, ultimo_pedido: ultimo,
        direcciones: direccionesDe(cl.id).map(dirFila)
      };
    });
  });

  // =================================================================== REPARTIDORES (para asignar)
  ruta('GET', '/pedidos/repartidores', function () {
    var BD = db(), hoy = hoyStr();
    var us = BD.usuarios.filter(function (u) { return u.rol === 'repartidor' && u.activo; }).sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
    var filas = BD.pedidos.filter(function (p) { return p.repartidor_id && (contiene(['preparando', 'listo', 'en_camino'], p.estado) || (p.estado === 'entregado' && !p.liquidacion_id)); }).map(formato);
    return us.map(function (u) {
      var mios = filas.filter(function (p) { return p.repartidor_id === u.id; });
      var enCamino = mios.filter(function (p) { return p.estado === 'en_camino'; });
      var aEntregar = mios.filter(function (p) { return p.estado === 'entregado' && p.pago_modo === 'al_recibir' && p.ticket_estado === 'pendiente'; });
      function suma(a) { return r2(sumar(a, function (p) { return p.resta || 0; })); }
      return {
        id: u.id, nombre: u.nombre, telefono: u.telefono || null,
        en_camino: enCamino.length,
        por_salir: mios.filter(function (p) { return contiene(['preparando', 'listo'], p.estado); }).length,
        trae_por_cobrar: suma(enCamino.filter(function (p) { return p.pago_modo === 'al_recibir'; })),
        por_entregar_a_caja: suma(aEntregar),
        efectivo_por_entregar: suma(aEntregar.filter(function (p) { return (p.metodo_cobro || 'efectivo') === 'efectivo'; })),
        pedidos_por_liquidar: mios.filter(function (p) { return p.estado === 'entregado'; }).length,
        entregas_hoy: BD.pedidos.filter(function (p) { return p.repartidor_id === u.id && p.estado === 'entregado' && fechaDe(p.entregado_en) === hoy; }).length,
        estado: enCamino.length ? 'en_ruta' : 'libre'
      };
    });
  });

  // =================================================================== LISTA / TABLERO / AGENDA
  ruta('GET', '/pedidos', function (c) {
    asegurarFijos();
    var q = c.query;
    var fecha = validarFecha(q.fecha), desde = validarFecha(q.desde), hasta = validarFecha(q.hasta);
    if (fecha === false || desde === false || hasta === false) fallo(400, 'Fecha inválida');
    var estados = q.estado ? String(q.estado).split(',').filter(function (e) { return contiene(ESTADOS, e); }) : [];
    var tipo = contiene(['domicilio', 'recoger'], q.tipo) ? q.tipo : null;
    var rep = esEntero(q.repartidor_id || '') ? Number(q.repartidor_id) : null;
    var cli = esEntero(q.cliente_id || '') ? Number(q.cliente_id) : null;
    var texto = q.q ? norm(String(q.q).trim().slice(0, 60)) : '', dig = q.q ? soloDigitos(q.q) : '';
    var limite = Math.min(Math.max(parseInt(q.limit, 10) || 400, 1), 1000);
    var lista = db().pedidos.filter(function (p) {
      if (!puedeVer(c, p)) return false;
      if (fecha && !(p.fecha_entrega === fecha || (p.fecha_entrega < fecha && contiene(['programado', 'preparando', 'listo', 'en_camino', 'no_entregado'], p.estado)))) return false;
      if (desde && p.fecha_entrega < desde) return false;
      if (hasta && p.fecha_entrega > hasta) return false;
      if (estados.length && !contiene(estados, p.estado)) return false;
      if (tipo && p.tipo !== tipo) return false;
      if (rep !== null && p.repartidor_id !== rep) return false;
      if (cli !== null && p.cliente_id !== cli) return false;
      if (texto) {
        var t = ticketDe(p);
        var hay = [p.nombre_contacto, t ? t.folio : '', p.calle, p.colonia].some(function (x) { return norm(x).indexOf(texto) !== -1; });
        if (!hay && !(dig.length >= 3 && soloDigitos(p.telefono).indexOf(dig) !== -1)) return false;
      }
      return true;
    }).sort(ordenPor([{ k: function (p) { return p.fecha_entrega; } }, { k: function (p) { return p.programado_para; }, nulos: 'primero' }, { k: function (p) { return p.id; } }]));
    return lista.slice(0, limite).map(function (p) { return formato(p); });
  });

  ruta('GET', '/pedidos/resumen', function (c) {
    var fecha = validarFecha(c.query.fecha);
    if (fecha === false) fallo(400, 'Fecha inválida');
    var f = fecha || hoyStr();
    var x = db().pedidos.filter(function (p) {
      return puedeVer(c, p) && (p.fecha_entrega === f || contiene(['programado', 'preparando', 'listo', 'en_camino', 'no_entregado'], p.estado) || (p.estado === 'entregado' && !p.liquidacion_id));
    }).map(formato);
    return {
      fecha: f,
      pedidos_dia: x.filter(function (p) { return p.fecha_entrega === f && p.estado !== 'cancelado'; }).length,
      en_camino: x.filter(function (p) { return p.estado === 'en_camino'; }).length,
      por_cobrar: r2(sumar(x.filter(function (p) { return p.tipo === 'domicilio' && p.pago_modo === 'al_recibir' && p.ticket_estado === 'pendiente' && contiene(['en_camino', 'entregado'], p.estado); }),
        function (p) { return Math.max(p.total_neto - p.anticipo, 0); })),
      con_retraso: x.filter(function (p) { return p.retraso_min > 0; }).length,
      entregado_hoy: r2(sumar(x.filter(function (p) { return p.estado === 'entregado' && fechaDe(p.entregado_en) === f; }), function (p) { return p.total_neto; })),
      futuros: x.filter(function (p) { return p.estado === 'programado' && p.fecha_entrega > f; }).length
    };
  });

  // Hoja de producción: cuánto hay que preparar de cada producto para un día.
  ruta('GET', '/pedidos/produccion', function (c) {
    var fecha = validarFecha(c.query.fecha);
    if (!fecha) fallo(400, 'Indica la fecha (AAAA-MM-DD)');
    var estados = c.query.todos === '1' ? ['programado', 'preparando', 'listo', 'en_camino', 'entregado'] : ['programado', 'preparando'];
    var ps = db().pedidos.filter(function (p) { return p.fecha_entrega === fecha && contiene(estados, p.estado); })
      .sort(ordenPor([{ k: function (p) { return p.programado_para; }, nulos: 'primero' }, { k: function (p) { return p.id; } }]));
    var pedidos = [], acum = {}, orden = [];
    ps.forEach(function (row) {
      var p = formato(row);
      var items = itemsDelTicket(row.ticket_id).filter(function (i) { return !i.es_envio; });
      pedidos.push({
        id: p.id, etiqueta: p.etiqueta, estado: p.estado, tipo: p.tipo, cliente: p.nombre_contacto, hora: p.programado_para ? p.programado_para.slice(11) : null,
        repartidor_nombre: p.repartidor_nombre, items: items.map(function (i) { return { nombre: i.nombre_producto, cantidad: i.cantidad, tipo_venta: i.tipo_venta || null }; })
      });
      items.forEach(function (i) {
        var clave = i.producto_id ? 'p' + i.producto_id : 'n' + i.nombre_producto;
        if (!acum[clave]) { acum[clave] = { producto_id: i.producto_id, nombre: i.nombre_producto, tipo_venta: i.tipo_venta || null, cantidad: 0, pedidos: 0 }; orden.push(clave); }
        acum[clave].cantidad = Math.round((acum[clave].cantidad + i.cantidad) * 1000) / 1000;
        acum[clave].pedidos += 1;
      });
    });
    return { fecha: fecha, productos: orden.map(function (k) { return acum[k]; }).sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); }), pedidos: pedidos };
  });

  // Ruta del día: las paradas a domicilio en orden.
  ruta('GET', '/pedidos/ruta', function (c) {
    var fecha = validarFecha(c.query.fecha);
    if (!fecha) fallo(400, 'Indica la fecha (AAAA-MM-DD)');
    var r = c.query.repartidor_id;
    return db().pedidos.filter(function (p) {
      if (p.tipo !== 'domicilio' || p.fecha_entrega !== fecha || !contiene(ACTIVOS, p.estado)) return false;
      if (r === 'ninguno') return !p.repartidor_id;
      if (esEntero(r || '')) return p.repartidor_id === Number(r);
      return true;
    }).sort(ordenPor([{ k: function (p) { return p.orden_ruta; } }, { k: function (p) { return p.programado_para; } }, { k: function (p) { return p.id; } }])).map(formato);
  });

  ruta('PUT', '/pedidos/ruta/orden', function (c) {
    D.requierePermiso(c, 'VENTAS_CREAR');
    var ids = Array.isArray(c.body.ids) ? c.body.ids.map(Number).filter(function (n) { return n > 0 && Math.floor(n) === n; }) : [];
    if (!ids.length || ids.length > 300) fallo(400, 'Lista de pedidos inválida');
    ids.forEach(function (id, i) { var p = porId(db().pedidos, id); if (p) p.orden_ruta = i + 1; });
    return { ok: true };
  });

  // =================================================================== MÓDULO DEL REPARTIDOR
  ruta('GET', '/pedidos/repartidor/mis-pedidos', function (c) {
    soloRepartidor(c);
    var BD = db(), yo = c.user.id, hoy = hoyStr();
    var orden = ordenPor([{ k: function (p) { return p.orden_ruta; } }, { k: function (p) { return p.programado_para; } }, { k: function (p) { return p.id; } }]);
    function armar(lista) {
      return lista.map(function (p) { var r = resumenParaRepartidor(formato(p)); r.items = itemsParaRepartidor(p); return r; });
    }
    var dom = BD.pedidos.filter(function (p) { return p.tipo === 'domicilio'; });
    var mios = dom.filter(function (p) { return p.repartidor_id === yo && contiene(['preparando', 'listo', 'en_camino'], p.estado); }).sort(orden);
    var hechos = dom.filter(function (p) { return p.repartidor_id === yo && contiene(['entregado', 'no_entregado'], p.estado) && fechaDe(p.entregado_en || p.llego_en || p.creado_en) === hoy; })
      .sort(ordenPor([{ k: function (p) { return p.entregado_en || p.llego_en; }, desc: true }]));
    var libres = dom.filter(function (p) { return !p.repartidor_id && p.estado === 'listo'; }).sort(orden);
    var cf = cfg();
    return {
      repartidor: { id: c.user.id, nombre: c.user.nombre }, negocio: cf.nombre_negocio || null,
      foto_obligatoria: !!cf.pedidos_foto_obligatoria, firma_obligatoria: !!cf.pedidos_firma_obligatoria,
      pendientes: armar(mios), hechos_hoy: armar(hechos), disponibles: armar(libres)
    };
  });

  ruta('GET', '/pedidos/repartidor/mi-corte', function (c) {
    soloRepartidor(c);
    return armarLiquidacion(c.user.id);
  });

  ruta('POST', '/pedidos/repartidor/:id/tomar', function (c) {
    soloRepartidor(c);
    var p = esEntero(c.params.id) ? porId(db().pedidos, c.params.id) : null;
    if (!p || p.tipo !== 'domicilio' || p.estado !== 'listo' || p.repartidor_id) fallo(409, 'Este pedido ya lo tomó otra persona o ya no está disponible');
    p.repartidor_id = c.user.id;
    D.bitacora(c, 'pedido_tomado', 'pedidos', p.id, { repartidor_id: c.user.id });
    return cargarPedido(p);
  });
  ruta('POST', '/pedidos/repartidor/:id/salir', function (c) {
    soloRepartidor(c);
    return transicionar(c, c.params.id, 'en_camino', {}, { soloRepartidor: true });
  });
  ruta('POST', '/pedidos/repartidor/:id/llegue', function (c) {
    soloRepartidor(c);
    var p = esEntero(c.params.id) ? porId(db().pedidos, c.params.id) : null;
    if (!p || p.repartidor_id !== c.user.id || p.estado !== 'en_camino') fallo(409, 'Este pedido no está en camino contigo');
    p.llego_en = p.llego_en || iso(ahora());
    return cargarPedido(p);
  });
  ruta('POST', '/pedidos/repartidor/:id/entregar', function (c) {
    soloRepartidor(c);
    var cf = cfg(), ev = c.body.evidencias || {};
    if (cf.pedidos_foto_obligatoria && !ev.foto) fallo(400, 'Falta la foto de la entrega');
    if (cf.pedidos_firma_obligatoria && !ev.firma) fallo(400, 'Falta la firma del cliente');
    return transicionar(c, c.params.id, 'entregado', { metodo_cobro: c.body.metodo_cobro }, { soloRepartidor: true, evidencias: ev });
  });
  ruta('POST', '/pedidos/repartidor/:id/no-entregado', function (c) {
    soloRepartidor(c);
    return transicionar(c, c.params.id, 'no_entregado', { motivo: c.body.motivo }, { soloRepartidor: true });
  });

  // =================================================================== LIQUIDACIÓN DEL REPARTIDOR
  ruta('GET', '/pedidos/liquidacion/:repartidorId', function (c) {
    D.requierePermiso(c, 'CAJA_MOVIMIENTO');
    var u = esEntero(c.params.repartidorId) ? usuario(c.params.repartidorId) : null;
    if (!u || u.rol !== 'repartidor') fallo(404, 'Repartidor no encontrado');
    return armarLiquidacion(u.id);
  });

  ruta('POST', '/pedidos/liquidar', function (c) {
    D.requierePermiso(c, 'CAJA_MOVIMIENTO');
    var BD = db(), b = c.body;
    var repartidorId = Number(b.repartidor_id), turnoId = Number(b.turno_id), entregado = Number(b.efectivo_entregado);
    if (!(repartidorId > 0) || Math.floor(repartidorId) !== repartidorId) fallo(400, 'Elige al repartidor');
    if (!(turnoId > 0) || Math.floor(turnoId) !== turnoId) fallo(400, 'Abre tu turno de caja para recibir el dinero');
    if (vacio(b.efectivo_entregado) || !isFinite(entregado) || entregado < 0) fallo(400, 'Escribe cuánto efectivo entregó el repartidor');
    var turno = porId(BD.turnos, turnoId);
    if (!turno || turno.estado !== 'abierto') fallo(400, 'El turno de caja no está abierto');
    var rep = usuario(repartidorId);
    if (!rep || rep.rol !== 'repartidor') fallo(404, 'Repartidor no encontrado');
    var filtro = Array.isArray(b.pedido_ids) && b.pedido_ids.length ? b.pedido_ids.map(Number) : null;
    var lista = BD.pedidos.filter(function (p) {
      return p.repartidor_id === repartidorId && p.tipo === 'domicilio' && p.estado === 'entregado' && !p.liquidacion_id && (!filtro || contiene(filtro, p.id));
    }).sort(ordenPor([{ k: function (p) { return p.entregado_en; } }]));
    if (!lista.length) fallo(400, 'Este repartidor no tiene entregas pendientes por liquidar');

    var tot = { efectivo: 0, transferencia: 0, tarjeta: 0 }, agotados = [], ya = iso(ahora());
    lista.forEach(function (row) {
      var p = formato(row), t = ticketDe(row);
      if (p.pago_modo !== 'al_recibir' || p.ticket_estado !== 'pendiente' || !t) return;
      var metodo = p.metodo_cobro || 'efectivo';
      var efectivo = r2((metodo === 'efectivo' ? p.resta : 0) + (p.anticipo_metodo === 'efectivo' ? p.anticipo : 0));
      var tarjeta = r2(p.total_neto - efectivo);
      var metodoPago = p.anticipo > 0 && efectivo > 0 && tarjeta > 0 ? 'mixto' : efectivo > 0 ? 'efectivo' : (metodo !== 'efectivo' ? metodo : p.anticipo_metodo);
      t.estado = 'pagado'; t.cajero_usuario_id = c.user.id; t.metodo_pago = metodoPago; t.monto_efectivo = efectivo; t.monto_tarjeta = tarjeta;
      t.turno_id = turnoId; t.fecha_pago = ya; t.efectivo_recibido = efectivo > 0 ? efectivo.toFixed(2) : null;
      descontarInventarioTicket(t, c, agotados);
      tot[metodo] = r2(tot[metodo] + p.resta);
    });
    var esperado = r2(tot.efectivo), dif = r2(entregado - esperado);
    var liq = {
      id: D.sig('liquidacion'), sucursal_id: 1, repartidor_id: repartidorId, turno_id: turnoId, recibido_por: c.user.id, creada_en: ya,
      num_pedidos: lista.length, esperado_efectivo: esperado, entregado_efectivo: r2(entregado), diferencia: dif,
      total_transferencia: tot.transferencia, total_tarjeta: tot.tarjeta, notas: textoOnull(b.notas, 300)
    };
    BD.liquidaciones.push(liq);
    lista.forEach(function (p) { p.liquidacion_id = liq.id; });
    D.bitacora(c, 'liquidar_repartidor', 'pedidos', liq.id, { repartidor: rep.nombre, pedidos: lista.length, esperado: esperado, entregado: r2(entregado), diferencia: dif });
    return { ok: true, liquidacion: clonar(liq), repartidor: rep.nombre, productos_agotados: unicos(agotados) };
  });

  ruta('GET', '/pedidos/liquidaciones', function (c) {
    D.requierePermiso(c, 'CAJA_MOVIMIENTO');
    return db().liquidaciones.slice().sort(function (a, b) { return b.id - a.id; }).slice(0, 60).map(function (l) {
      var o = clonar(l), u = usuario(l.repartidor_id), r = usuario(l.recibido_por);
      o.repartidor_nombre = u ? u.nombre : null; o.recibido_por_nombre = r ? r.nombre : null;
      return o;
    });
  });

  // Reporte de repartidores: entregas, a tiempo, tiempos y dinero.
  ruta('GET', '/pedidos/reporte-repartidores', function (c) {
    D.requiereAdmin(c);
    var desde = validarFecha(c.query.desde), hasta = validarFecha(c.query.hasta);
    if (!desde || !hasta) fallo(400, 'Indica desde y hasta (AAAA-MM-DD)');
    var BD = db(), grupos = {}, orden = [];
    BD.pedidos.filter(function (p) { return p.tipo === 'domicilio' && p.repartidor_id && p.fecha_entrega >= desde && p.fecha_entrega <= hasta; }).map(formato).forEach(function (p) {
      if (!grupos[p.repartidor_id]) { grupos[p.repartidor_id] = []; orden.push(p.repartidor_id); }
      grupos[p.repartidor_id].push(p);
    });
    return orden.map(function (rid) {
      var x = grupos[rid], ent = x.filter(function (p) { return p.estado === 'entregado'; });
      var conSalida = ent.filter(function (p) { return p.salio_en && p.entregado_en; });
      var prom = conSalida.length ? sumar(conSalida, function (p) { return (new Date(p.entregado_en) - new Date(p.salio_en)) / 60000; }) / conSalida.length : 0;
      var conHora = ent.filter(function (p) { return p.programado_para && parseLocal(p.programado_para); });
      var aTiempo = conHora.filter(function (p) { return new Date(p.entregado_en).getTime() <= parseLocal(p.programado_para).getTime() + 10 * 60000; });
      var liqs = BD.liquidaciones.filter(function (l) { var f = fechaDe(l.creada_en); return l.repartidor_id === Number(rid) && f >= desde && f <= hasta; });
      return {
        repartidor_id: Number(rid), nombre: x[0].repartidor_nombre, entregas: ent.length, no_entregadas: x.filter(function (p) { return p.estado === 'no_entregado'; }).length,
        total_entregado: r2(sumar(ent, function (p) { return p.total_neto; })), envios: r2(sumar(ent, function (p) { return p.costo_envio; })),
        min_promedio: Math.round(prom), a_tiempo: aTiempo.length, con_hora: conHora.length,
        liquidaciones: liqs.length, diferencia: r2(sumar(liqs, function (l) { return num(l.diferencia); }))
      };
    }).sort(function (a, b) { return b.entregas - a.entregas; });
  });

  // =================================================================== PEDIDOS FIJOS
  ruta('GET', '/pedidos/fijos', function (c) {
    var BD = db(), todos = c.query.todos === '1';
    return BD.pedidos_fijos.filter(function (f) { return (todos || f.activo) && porId(BD.clientes, f.cliente_id); }).map(fijoFila)
      .sort(function (a, b) { return (a.activo === b.activo ? 0 : (a.activo ? -1 : 1)) || String(a.cliente_nombre).localeCompare(String(b.cliente_nombre), 'es') || a.id - b.id; });
  });
  ruta('POST', '/pedidos/fijos', function (c) {
    D.requiereAdmin(c);
    var v = validarFijo(c.body);
    if (v.error) fallo(400, v.error);
    var rel = validarRelacionesFijo(c.body, v);
    var f = {
      id: D.sig('pedido_fijo'), sucursal_id: 1, cliente_id: rel.cliente.id, direccion_id: rel.direccionId, nombre: v.nombre, dias: v.dias, hora: v.hora,
      tipo: v.tipo, pago_modo: v.pago_modo, zona_id: rel.zonaId, repartidor_id: rel.repartidorId, items: v.items, notas: v.notas, activo: true, creado_en: iso(ahora())
    };
    db().pedidos_fijos.push(f);
    D.bitacora(c, 'crear_pedido_fijo', 'pedidos', f.id, { cliente: rel.cliente.nombre, dias: v.dias, hora: v.hora });
    return fijoFila(f);
  });
  ruta('PUT', '/pedidos/fijos/:id', function (c) {
    D.requiereAdmin(c);
    var v = validarFijo(c.body);
    if (v.error) fallo(400, v.error);
    var f = esEntero(c.params.id) ? porId(db().pedidos_fijos, c.params.id) : null;
    if (!f) fallo(404, 'Pedido fijo no encontrado');
    var rel = validarRelacionesFijo(c.body, v);
    f.cliente_id = rel.cliente.id; f.direccion_id = rel.direccionId; f.nombre = v.nombre; f.dias = v.dias; f.hora = v.hora; f.tipo = v.tipo;
    f.pago_modo = v.pago_modo; f.zona_id = rel.zonaId; f.repartidor_id = rel.repartidorId; f.items = v.items; f.notas = v.notas;
    if (typeof c.body.activo === 'boolean') f.activo = c.body.activo;
    return fijoFila(f);
  });
  ruta('DELETE', '/pedidos/fijos/:id', function (c) {
    D.requiereAdmin(c);
    var BD = db(), id = esEntero(c.params.id) ? Number(c.params.id) : -1;
    if (!porId(BD.pedidos_fijos, id)) fallo(404, 'Pedido fijo no encontrado');
    BD.pedidos_fijos = BD.pedidos_fijos.filter(function (f) { return f.id !== id; });
    return { ok: true };
  });
  ruta('POST', '/pedidos/fijos/generar', function (c) {
    D.requiereAdmin(c);
    var fecha = validarFecha(c.body.fecha);
    if (!fecha) fallo(400, 'Indica la fecha (AAAA-MM-DD)');
    if (fecha > sumarDias(hoyStr(), 14)) fallo(400, 'Solo se pueden generar pedidos de los próximos 14 días');
    return generarFijosDelDia(fecha, false);
  });

  // =================================================================== CREAR / VER / EDITAR / CAMBIAR
  ruta('POST', '/pedidos', function (c) {
    D.requierePermiso(c, 'VENTAS_CREAR');
    var BD = db(), b = c.body || {};
    validarItems(b.items);
    var tipo = b.tipo === 'recoger' ? 'recoger' : 'domicilio';
    var pagoModo = contiene(PAGO_MODOS, b.pago_modo) ? b.pago_modo : 'al_recibir';
    var fh = validarFechaHora(b.programado_para);
    if (fh.error) fallo(400, fh.error);
    var pagaCon = null;
    if (!vacio(b.paga_con)) {
      pagaCon = Number(b.paga_con);
      if (!isFinite(pagaCon) || pagaCon < 0) fallo(400, 'El monto con el que paga no es válido');
    }
    var forzado = null;
    if (!vacio(b.costo_envio) && tipo === 'domicilio') {
      if (!D.tienePermiso(c.user, 'DESCUENTO_APLICAR')) fallo(403, 'No tienes permiso para cambiar el costo de envío');
      forzado = Number(b.costo_envio);
      if (!isFinite(forzado) || forzado < 0) fallo(400, 'El costo de envío no es válido');
    }
    // 1) Validar todo (cliente, dirección, zona, repartidor, total y anticipo) sin escribir nada.
    var rc = resolverCliente(b);
    if (pagoModo === 'credito' && !rc.cliente && !rc.crear) fallo(400, 'Para vender a crédito elige un cliente guardado');
    var direccion = null, direccionGuardada = null, dirNueva = null;
    if (tipo === 'domicilio') {
      if (b.direccion_id) {
        direccionGuardada = porId(BD.cliente_direcciones, b.direccion_id);
        if (!direccionGuardada || !direccionGuardada.activo) fallo(400, 'Esa dirección no existe');
        if (rc.cliente && direccionGuardada.cliente_id !== rc.cliente.id) fallo(400, 'Esa dirección es de otro cliente');
        direccion = clonar(direccionGuardada);
      } else {
        if (!b.direccion) fallo(400, 'Falta la dirección de entrega');
        dirNueva = normalizarDireccion(b.direccion);
        if (dirNueva.error) fallo(400, dirNueva.error);
        if (dirNueva.zona_id && !porId(BD.zonas_envio, dirNueva.zona_id)) dirNueva.zona_id = null;
        direccion = dirNueva;
      }
    }
    var zonaId = tipo === 'domicilio' ? (Number(b.zona_id) || (direccion && direccion.zona_id) || null) : null;
    var repartidorId = tipo === 'domicilio' ? repartidorValido(b.repartidor_id) : null;
    var sub = r2(sumar(b.items, subtotalRenglon));
    if (tipo === 'domicilio') {
      var calc = calcularEnvio(zonaId, sub);
      if (calc.error) fallo(400, calc.error);
      validarAnticipo({ anticipo: b.anticipo, anticipo_metodo: b.anticipo_metodo, ya_pago_todo: b.ya_pago_todo === true, pago_modo: pagoModo }, r2(sub + (forzado !== null ? forzado : calc.costo)));
    } else {
      validarAnticipo({ anticipo: b.anticipo, anticipo_metodo: b.anticipo_metodo, ya_pago_todo: b.ya_pago_todo === true, pago_modo: pagoModo }, sub);
    }

    // 2) Ahora sí: cliente nuevo, dirección guardada y el pedido con su ticket.
    var cliente = rc.cliente;
    if (rc.crear) {
      cliente = { id: D.sig('cliente'), sucursal_id: 1, nombre: rc.nombre, telefono: rc.telefono, limite_credito: 0, saldo_actual: 0, activo: true, tipo: 'publico', usa_mayoreo: false };
      BD.clientes.push(cliente);
      D.bitacora(c, 'crear_cliente', 'clientes', cliente.id, { nombre: cliente.nombre });
    }
    var direccionId = null;
    if (direccionGuardada) { direccionGuardada.ultimo_uso = iso(ahora()); direccionId = direccionGuardada.id; }
    else if (dirNueva && cliente && b.guardar_direccion !== false) {
      var dup = BD.cliente_direcciones.filter(function (x) {
        return x.cliente_id === cliente.id && x.activo && norm(x.calle) === norm(dirNueva.calle) && norm(x.colonia || '') === norm(dirNueva.colonia || '');
      })[0];
      if (dup) {
        ['referencias', 'latitud', 'longitud', 'ubicacion_enlace', 'zona_id'].forEach(function (k) { if (!vacio(dirNueva[k])) dup[k] = dirNueva[k]; });
        dup.ultimo_uso = iso(ahora()); direccionId = dup.id;
      } else {
        var fila = nuevaDireccion(cliente.id, dirNueva, direccionesDe(cliente.id).length === 0);
        fila.ultimo_uso = iso(ahora()); direccionId = fila.id;
      }
    }
    var p = crearPedidoCore({
      usuarioId: c.user.id, items: b.items, tipo: tipo, cliente: cliente, nombre_contacto: rc.nombre, telefono: rc.telefono,
      direccion: direccion, direccion_id: direccionId, zona_id: zonaId, costo_envio_forzado: forzado, pago_modo: pagoModo, paga_con: pagaCon,
      anticipo: b.anticipo, anticipo_metodo: b.anticipo_metodo, ya_pago_todo: b.ya_pago_todo === true,
      programado_para: fh.valor, enviar: b.enviar !== false, repartidor_id: repartidorId, notas: textoOnull(b.notas, 300), origen: 'manual'
    });
    var t = ticketDe(p);
    D.bitacora(c, 'crear_pedido', 'pedidos', p.id, { folio: t.folio, tipo: tipo, total: t.total, estado: p.estado, cliente: rc.nombre });
    return cargarPedido(p);
  });

  ruta('GET', '/pedidos/:id', function (c) {
    var p = pedidoOr404(c.params.id);
    if (!puedeVer(c, p)) fallo(404, 'Pedido no encontrado');
    return cargarPedido(p);
  });

  ruta('GET', '/pedidos/:id/evidencias/:evId', function (c) {
    var p = pedidoOr404(c.params.id);
    if (!puedeVer(c, p)) fallo(404, 'Imagen no encontrada');
    var e = esEntero(c.params.evId) ? porId(db().pedido_evidencias || [], c.params.evId) : null;
    if (!e || e.pedido_id !== p.id) fallo(404, 'Imagen no encontrada (la demo solo guarda las últimas fotos y firmas)');
    return { tipo: e.tipo, dato: e.dato, creado_en: e.creado_en };
  });

  // Editar un pedido que todavía no sale: contacto, dirección, hora, cobro, notas, zona (recalcula el envío) y productos.
  ruta('PUT', '/pedidos/:id', function (c) {
    D.requierePermiso(c, 'VENTAS_CREAR');
    var BD = db(), b = c.body || {};
    var p = pedidoOr404(c.params.id);
    var ped = formato(p), t = ticketDe(p);
    if (!contiene(['programado', 'preparando', 'listo', 'no_entregado'], p.estado)) fallo(409, 'Este pedido ya no se puede editar');
    var pendiente = ped.ticket_estado === 'pendiente';
    var set = {};

    if (b.nombre_contacto !== undefined) {
      var nom = textoOnull(b.nombre_contacto, 150);
      if (!nom) fallo(400, 'Escribe el nombre del cliente');
      set.nombre_contacto = nom;
    }
    if (b.telefono !== undefined) set.telefono = textoOnull(b.telefono, 30);
    if (b.notas !== undefined) set.notas = textoOnull(b.notas, 300);
    if (b.pago_modo !== undefined) {
      if (!contiene(PAGO_MODOS, b.pago_modo)) fallo(400, 'Forma de cobro inválida');
      if (b.pago_modo === 'credito' && !p.cliente_id) fallo(400, 'Para vender a crédito el pedido debe tener un cliente guardado');
      if (!pendiente) fallo(409, 'El ticket de este pedido ya fue cobrado');
      set.pago_modo = b.pago_modo;
    }
    if (b.paga_con !== undefined) {
      var pc = vacio(b.paga_con) ? null : Number(b.paga_con);
      if (pc !== null && (!isFinite(pc) || pc < 0)) fallo(400, 'El monto con el que paga no es válido');
      set.paga_con = pc;
    }
    var zonaB = b.zona_id;
    if (p.tipo === 'domicilio' && b.direccion) {
      var dn = normalizarDireccion(b.direccion);
      if (dn.error) fallo(400, dn.error);
      ['calle', 'colonia', 'cp', 'ciudad', 'referencias', 'latitud', 'longitud', 'ubicacion_enlace'].forEach(function (k) { set[k] = dn[k]; });
      if (dn.zona_id && zonaB === undefined) zonaB = dn.zona_id;
    }
    if (b.programado_para !== undefined) {
      var fh = validarFechaHora(b.programado_para);
      if (fh.error) fallo(400, fh.error);
      set.programado_para = fh.valor;
      set.fecha_entrega = fh.valor ? fh.valor.slice(0, 10) : hoyStr();
      if (fh.valor && !(p.estado === 'programado' && !p.preparar_desde)) set.preparar_desde = localStr(new Date(parseLocal(fh.valor).getTime() - minPreparacion() * 60000));
    }
    // Zona o costo de envío → se recalcula la línea de envío.
    var recalcular = false, forzado = null;
    if (p.tipo === 'domicilio' && (zonaB !== undefined || b.costo_envio !== undefined)) {
      if (!pendiente) fallo(409, 'El ticket de este pedido ya fue cobrado: no se puede cambiar el envío');
      recalcular = true;
      if (zonaB !== undefined) set.zona_id = Number(zonaB) || null;
      if (!vacio(b.costo_envio)) {
        if (!D.tienePermiso(c.user, 'DESCUENTO_APLICAR')) fallo(403, 'No tienes permiso para cambiar el costo de envío');
        forzado = Number(b.costo_envio);
        if (!isFinite(forzado) || forzado < 0) fallo(400, 'El costo de envío no es válido');
      }
    }
    // Productos: "lineas" = renglones que se quedan (con su cantidad); "agregar" = productos nuevos.
    var existentes = D.itemsDe(t.id).filter(function (d) { return !esLineaEnvio(d); });
    var quedan = null, nuevos = [];
    if (b.lineas !== undefined || b.agregar !== undefined) {
      if (!pendiente) fallo(409, 'El ticket de este pedido ya fue cobrado: no se pueden cambiar los productos');
      quedan = {};
      if (b.lineas === undefined) existentes.forEach(function (e) { quedan[e.id] = num(e.cantidad); });
      else {
        if (!Array.isArray(b.lineas)) fallo(400, 'La lista de productos no es válida');
        b.lineas.forEach(function (l) {
          var lid = Number(l && l.id), cant = Number(l && l.cantidad);
          if (!existentes.some(function (e) { return e.id === lid; })) fallo(400, 'Hay un producto que ya no está en el pedido');
          if (!isFinite(cant) || cant <= 0) fallo(400, 'Hay un producto con cantidad inválida');
          quedan[lid] = cant;
        });
      }
      nuevos = b.agregar === undefined ? [] : b.agregar;
      if (!Array.isArray(nuevos)) fallo(400, 'La lista de productos nuevos no es válida');
      if (nuevos.length) validarItems(nuevos);
      var cuantos = Object.keys(quedan).length + nuevos.length;
      if (!cuantos) fallo(400, 'El pedido necesita al menos un producto');
      if (cuantos > 200) fallo(400, 'El pedido tiene demasiados renglones');
      if (!recalcular) {
        // ¿El envío actual es el de la zona o lo cambiaron a mano? Si fue a mano, se respeta.
        var subViejo = r2(sumar(existentes, function (e) { return num(e.subtotal); }));
        var calcViejo = p.tipo === 'domicilio' ? calcularEnvio(p.zona_id, subViejo) : { costo: 0 };
        forzado = calcViejo.error || r2(calcViejo.costo) !== r2(num(p.costo_envio)) ? r2(num(p.costo_envio)) : null;
        recalcular = true;
      }
    }
    // Total que quedaría (para validar envío y anticipo antes de tocar nada).
    var subNuevo = quedan
      ? r2(sumar(existentes.filter(function (e) { return quedan[e.id] !== undefined; }), function (e) { return Math.abs(quedan[e.id] - num(e.cantidad)) > 0.0005 ? r2(quedan[e.id] * num(e.precio_unitario)) : num(e.subtotal); }) + sumar(nuevos, subtotalRenglon))
      : r2(sumar(existentes, function (e) { return num(e.subtotal); }));
    var costoNuevo = num(p.costo_envio);
    if (recalcular) {
      var zonaFinal = set.zona_id !== undefined ? set.zona_id : p.zona_id;
      var calcN = calcularEnvio(zonaFinal, subNuevo);
      if (calcN.error && forzado === null) fallo(400, calcN.error);
      costoNuevo = forzado !== null ? r2(forzado) : calcN.costo;
    }
    var descLineas = sumar(existentes.filter(function (e) { return !quedan || quedan[e.id] !== undefined; }), function (e) { return num(e.descuento_monto); });
    var totalNeto = recalcular ? r2(subNuevo + costoNuevo - num(t.descuento_monto) - descLineas) : ped.total_neto;
    var tocaAnticipo = b.anticipo !== undefined || b.anticipo_metodo !== undefined || b.ya_pago_todo === true;
    if (tocaAnticipo && !pendiente) fallo(409, 'El ticket de este pedido ya fue cobrado: no se puede cambiar el anticipo');
    var pagoModoFinal = set.pago_modo || p.pago_modo;
    var an = validarAnticipo({
      anticipo: b.ya_pago_todo === true || b.anticipo !== undefined ? b.anticipo : ped.anticipo,
      anticipo_metodo: b.anticipo_metodo !== undefined ? b.anticipo_metodo : ped.anticipo_metodo,
      ya_pago_todo: b.ya_pago_todo === true
    }, totalNeto, pagoModoFinal);

    // Aplicar
    Object.keys(set).forEach(function (k) { p[k] = set[k]; });
    if (quedan) {
      existentes.forEach(function (e) {
        if (quedan[e.id] === undefined) BD.ticket_detalle = BD.ticket_detalle.filter(function (x) { return x.id !== e.id; });
        else if (Math.abs(quedan[e.id] - num(e.cantidad)) > 0.0005) { e.cantidad = quedan[e.id]; e.subtotal = r2(quedan[e.id] * num(e.precio_unitario)); }
      });
      nuevos.forEach(function (it) {
        var tipoL = it.tipo === 'kit' ? 'kit' : 'producto';
        BD.ticket_detalle.push({
          id: D.sig('ticket_detalle'), ticket_id: t.id, tipo: tipoL, producto_id: tipoL === 'producto' ? (parseInt(it.producto_id, 10) || null) : null,
          kit_id: tipoL === 'kit' ? (parseInt(it.kit_id, 10) || null) : null, nombre_producto: String(it.nombre_producto).slice(0, 200),
          cantidad: Number(it.cantidad), precio_unitario: Number(it.precio_unitario), subtotal: subtotalRenglon(it), descuento_monto: 0, descuento_motivo: null, cantidad_devuelta: 0
        });
      });
    }
    if (recalcular) {
      BD.ticket_detalle = BD.ticket_detalle.filter(function (d) { return !(d.ticket_id === t.id && esLineaEnvio(d)); });
      if (costoNuevo > 0) BD.ticket_detalle.push({ id: D.sig('ticket_detalle'), ticket_id: t.id, tipo: 'producto', producto_id: null, kit_id: null, nombre_producto: LINEA_ENVIO, cantidad: 1, precio_unitario: costoNuevo, subtotal: costoNuevo, descuento_monto: 0, descuento_motivo: null, cantidad_devuelta: 0 });
      D.recalcTotal(t);
      p.costo_envio = costoNuevo;
    }
    if (an.anticipo !== ped.anticipo || an.anticipo_metodo !== ped.anticipo_metodo || an.pago_modo !== p.pago_modo) {
      p.anticipo = an.anticipo; p.anticipo_metodo = an.anticipo_metodo; p.pago_modo = an.pago_modo;
      if (an.pago_modo !== 'al_recibir') p.paga_con = null;
    }
    D.bitacora(c, 'editar_pedido', 'pedidos', p.id, { campos: Object.keys(b) });
    sincronizar(p);
    return cargarPedido(p);
  });

  ruta('POST', '/pedidos/:id/estado', function (c) {
    D.requierePermiso(c, 'VENTAS_CREAR');
    var nuevo = String(c.body.estado || '');
    if (!contiene(ESTADOS, nuevo) || nuevo === 'programado') fallo(400, 'Estado inválido');
    if (nuevo === 'cancelado' && !D.tienePermiso(c.user, 'VENTAS_CANCELAR')) fallo(403, 'No tienes permiso para cancelar pedidos');
    return transicionar(c, c.params.id, nuevo, { motivo: c.body.motivo, metodo_cobro: c.body.metodo_cobro });
  });

  // Mostrador acepta un pedido que está por preparar (se conserva quién lo tomó primero).
  ruta('POST', '/pedidos/:id/aceptar', function (c) {
    D.requierePermiso(c, 'VENTAS_CREAR');
    var p = pedidoOr404(c.params.id);
    if (p.estado !== 'preparando') fallo(409, 'Este pedido está "' + (ESTADO_TXT[p.estado] || p.estado) + '" y ya no se puede aceptar para preparar');
    p.aceptado_en = p.aceptado_en || iso(ahora());
    p.aceptado_por = p.aceptado_por || c.user.id;
    D.bitacora(c, 'pedido_aceptado', 'pedidos', p.id);
    return cargarPedido(p);
  });

  ruta('POST', '/pedidos/:id/asignar', function (c) {
    D.requierePermiso(c, 'VENTAS_CREAR');
    var p = pedidoOr404(c.params.id);
    if (p.tipo !== 'domicilio') fallo(400, 'Un pedido para recoger no lleva repartidor');
    var corrige = p.estado === 'entregado';
    if (corrige) {
      if (!esAdmin(c)) fallo(403, 'Solo el dueño o el gerente pueden cambiar el repartidor de un pedido ya entregado');
      if (p.liquidacion_id) fallo(409, 'Este pedido ya se liquidó en Caja: ya no se puede cambiar el repartidor');
    } else if (!contiene(CANCELABLES, p.estado)) fallo(409, 'Este pedido ya no se puede reasignar');
    var rid = repartidorValido(c.body.repartidor_id);
    if (corrige && !rid) fallo(400, 'Elige el repartidor que sí entregó este pedido');
    var antes = p.repartidor_id;
    p.repartidor_id = rid;
    D.bitacora(c, 'asignar_repartidor', 'pedidos', p.id, { repartidor_id: rid }, { repartidor_id: antes });
    return cargarPedido(p);
  });

  // «Deshacer entrega» (dueño/gerente): regresa a «En camino» (o a «Listo» sin repartidor válido) y borra el cobro.
  ruta('POST', '/pedidos/:id/deshacer-entrega', function (c) {
    D.requiereAdmin(c);
    var p = pedidoOr404(c.params.id), ped = formato(p);
    if (p.estado !== 'entregado') fallo(409, 'Este pedido no está entregado');
    if (p.liquidacion_id) fallo(409, 'Este pedido ya se liquidó en Caja: ya no se puede deshacer la entrega');
    if (ped.ticket_estado === 'cancelado') fallo(409, 'El ticket de este pedido está cancelado');
    var rid = p.repartidor_id && esRepartidorActivo(p.repartidor_id) ? p.repartidor_id : null;
    var destino = p.tipo === 'domicilio' && rid ? 'en_camino' : 'listo';
    var antes = { estado: 'entregado', repartidor_id: p.repartidor_id, metodo_cobro: p.metodo_cobro, monto_cobrado: p.monto_cobrado };
    p.estado = destino; p.entregado_en = null; p.metodo_cobro = null; p.monto_cobrado = null; p.llego_en = null;
    p.salio_en = destino === 'en_camino' ? (p.salio_en || iso(ahora())) : null;
    p.listo_en = p.listo_en || iso(ahora());
    p.repartidor_id = p.tipo === 'domicilio' ? rid : null;
    D.bitacora(c, 'pedido_deshacer_entrega', 'pedidos', p.id, { estado: destino, repartidor_id: rid }, antes);
    sincronizar(p);
    return cargarPedido(p);
  });

  // Se avisó al cliente por WhatsApp que su pedido va en camino.
  ruta('POST', '/pedidos/:id/avisado', function (c) {
    D.requierePermiso(c, 'VENTAS_CREAR');
    var p = pedidoOr404(c.params.id);
    p.aviso_camino_en = iso(ahora());
    return cargarPedido(p);
  });

  // =================================================================== DIRECCIONES DE ENTREGA DEL CLIENTE
  function clienteOr404(id) {
    var cl = esEntero(id) ? porId(db().clientes, id) : null;
    if (!cl) fallo(404, 'Cliente no encontrado');
    return cl;
  }
  function validarDirCliente(b) {
    var d = normalizarDireccion(b);
    if (d.error) fallo(400, d.error);
    if (d.zona_id && !porId(db().zonas_envio, d.zona_id)) fallo(400, 'La zona de envío no existe');
    return d;
  }
  ruta('GET', '/clientes/:id/direcciones', function (c) {
    var cl = clienteOr404(c.params.id);
    return direccionesDe(cl.id).map(dirFila);
  });
  ruta('POST', '/clientes/:id/direcciones', function (c) {
    D.requierePermiso(c, 'VENTAS_CREAR');
    var cl = clienteOr404(c.params.id);
    var d = validarDirCliente(c.body);
    var principal = c.body.principal === true || direccionesDe(cl.id).length === 0;
    return dirFila(nuevaDireccion(cl.id, d, principal));
  });
  ruta('PUT', '/clientes/:id/direcciones/:dirId', function (c) {
    D.requierePermiso(c, 'VENTAS_CREAR');
    var BD = db(), cl = clienteOr404(c.params.id);
    var d = validarDirCliente(c.body);
    var fila = esEntero(c.params.dirId) ? porId(BD.cliente_direcciones, c.params.dirId) : null;
    if (!fila || fila.cliente_id !== cl.id || !fila.activo) fallo(404, 'Dirección no encontrada');
    if (c.body.principal === true) BD.cliente_direcciones.forEach(function (x) { if (x.cliente_id === cl.id) x.principal = false; });
    ['alias', 'calle', 'colonia', 'cp', 'ciudad', 'referencias', 'latitud', 'longitud', 'ubicacion_enlace', 'zona_id'].forEach(function (k) { fila[k] = d[k]; });
    if (c.body.principal === true) fila.principal = true;
    return dirFila(fila);
  });
  ruta('DELETE', '/clientes/:id/direcciones/:dirId', function (c) {
    D.requierePermiso(c, 'VENTAS_CREAR');
    var BD = db(), cl = clienteOr404(c.params.id);
    var fila = esEntero(c.params.dirId) ? porId(BD.cliente_direcciones, c.params.dirId) : null;
    if (!fila || fila.cliente_id !== cl.id || !fila.activo) fallo(404, 'Dirección no encontrada');
    fila.activo = false; fila.principal = false;
    var resto = BD.cliente_direcciones.filter(function (x) { return x.cliente_id === cl.id && x.activo; });
    if (resto.length && !resto.some(function (x) { return x.principal; })) {
      resto.sort(ordenPor([{ k: function (x) { return x.ultimo_uso; }, desc: true, nulos: 'ultimo' }, { k: function (x) { return x.id; }, desc: true }]))[0].principal = true;
    }
    return { ok: true };
  });

  // =================================================================== AL CARGAR Y CADA RATO
  // Pone los pedidos de ejemplo y deja los tickets como les toca ANTES de que Caja pida su bandeja.
  // Cada 30 s pasa a "Preparando" lo programado que ya toca (como el temporizador del servidor).
  function ponerAlDia(recargar) {
    try {
      if (recargar || !D.db()) D.cargar(); // cada rato se relee por si otra pestaña cambió algo
      if (asegurar() > 0) D.guardar();
    } catch (e) {
      try { console.warn('[demo] pedidos:', e && (e.apiError || e.message)); } catch (e2) { /* nada */ }
    }
  }
  window.DemoPedidos = { crearPedidoCore: crearPedidoCore, formato: formato };   // para demo-mock-tienda.js
  ponerAlDia(false);
  setInterval(function () { if (!document.hidden) ponerAlDia(true); }, 30000);
})();
