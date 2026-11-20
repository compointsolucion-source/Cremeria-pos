/* ============================================================================
 * Compoint Punto — DEMO: Tienda en línea (versión 1.3.0)
 * Configuración de la tienda, productos que se ven, temas, «Aparecer en Compoint Pedidos»
 * y la página pública tienda.html (los pedidos llegan a Pedidos → «Por confirmar»).
 * Se carga después de demo-mock-pedidos.js y registra sus rutas con DemoMock.R().
 * ========================================================================== */
(function () {
  'use strict';
  var M = window.DemoMock, P = window.DemoPedidos;
  if (!M || !P) return;
  var R = M.R, fallo = M.fallo, clonar = M.clonar;
  var TEMAS = ['letrero', 'libreta', 'minisuper', 'tianguis', 'color', 'pizarron', 'receta', 'cuadritos', 'estraza', 'taller'];

  function db() { return M.db(); }
  function r2(n) { return Math.round(Number(n) * 100) / 100; }
  function texto(v, max) { if (typeof v !== 'string') return null; v = v.trim().replace(/\s+/g, ' '); return v ? v.slice(0, max) : null; }
  function soloDigitos(v) { return String(v || '').replace(/\D/g, ''); }

  function cfg() {
    var D = db();
    if (!D.extra) D.extra = {};
    if (!D.extra.tienda) {
      D.extra.tienda = {
        sucursal_id: 1, activo: true, giro: 'Quesos, lácteos y carnes frías', tiempo_entrega: '30 a 45 min', pedido_minimo: 0,
        horario: { semana: ['00:00', '23:59'], domingo: ['00:00', '23:59'] }, max_pendientes_por_telefono: 3,
        acepta_tarjeta: true, fiado_en_linea: false, ocultar_sin_existencia: true, imprimir_al_confirmar: false, sonido: true,
        tema: 'letrero', color_principal: null, color_oferta: null,
        red_visible: false, red_lat: null, red_lng: null, red_direccion: null, red_domicilio: true, red_recoger: false, red_buscar: true
      };
      (D.productos || []).forEach(function (p) { if (p.en_tienda === undefined) p.en_tienda = true; });
    }
    return D.extra.tienda;
  }

  function h12(h) { var p = String(h).split(':').map(Number), x = p[0] % 12 || 12; return x + (p[1] ? ':' + String(p[1]).padStart(2, '0') : '') + ' ' + (p[0] >= 12 ? 'pm' : 'am'); }
  function estadoHorario(hor) {
    var a = M.ahora(), dia = a.getDay(), t = hor && (dia === 0 ? hor.domingo : hor.semana), min = a.getHours() * 60 + a.getMinutes();
    var aMin = function (x) { var p = String(x).split(':').map(Number); return p[0] * 60 + p[1]; };
    if (t && min >= aMin(t[0]) && min < aMin(t[1])) return { abierto: true, texto: 'Abierto hasta las ' + h12(t[1]) };
    if (t && min < aMin(t[0])) return { abierto: false, texto: 'Cerrado. Recibimos pedidos a partir de las ' + h12(t[0]) };
    return { abierto: false, texto: 'Cerrado por hoy' };
  }
  function apariencia(c) { return { tema: TEMAS.indexOf(c.tema) >= 0 ? c.tema : 'letrero', color_principal: c.color_principal || null, color_oferta: c.color_oferta || null }; }
  function negocio() { var c = db().configuracion || {}; return { negocio: c.nombre_negocio || 'Demo Compoint Punto', telefono: soloDigitos(c.telefono).slice(-10) || null, logo_url: c.logo_url || null }; }

  function visibles(ids) {
    var D = db(), c = cfg();
    return (D.productos || []).filter(function (p) {
      if (!p.activo || p.en_tienda === false || !(Number(p.precio) > 0)) return false;
      if (ids && ids.indexOf(p.id) < 0) return false;
      var ex = Number((M.inv(p.id) || {}).existencia_actual || 0);
      return !(c.ocultar_sin_existencia && p.usa_inventario && ex <= 0);
    }).sort(function (a, b) { return (b.favorito ? 1 : 0) - (a.favorito ? 1 : 0) || (a.orden || 0) - (b.orden || 0); }).map(function (p) {
      var pr = (D.promociones || []).filter(function (x) { return x.producto_id === p.id && x.activo; }).sort(function (a, b) { return a.precio_promocional - b.precio_promocional; })[0];
      return { id: p.id, nombre: p.nombre, precio: Number(p.precio), imagen_url: p.imagen_url || null, por_peso: p.tipo_venta === 'peso',
        departamento: M.catNombre(p.categoria_id) || 'Otros',
        promo: pr && Number(pr.precio_promocional) < Number(p.precio) ? { desde: Number(pr.cantidad_minima), precio: Number(pr.precio_promocional) } : null };
    });
  }
  function zonasPublicas() {
    return (db().zonas_envio || []).filter(function (z) { return z.activo; }).map(function (z) {
      return { id: z.id, nombre: z.nombre, costo: Number(z.costo), envio_gratis_desde: z.envio_gratis_desde == null ? null : Number(z.envio_gratis_desde) };
    });
  }

  // ---------------------------------------------------------------- página pública (tienda.html)
  R('GET', '/tienda/publico/info', function () {
    var c = cfg(); if (!c.activo) fallo(404, 'Esta tienda no está recibiendo pedidos por internet.');
    var n = negocio();
    return Object.assign({ sucursal_id: 1 }, apariencia(c), { negocio: n.negocio, giro: c.giro, telefono: n.telefono, logo_url: n.logo_url,
      horario: estadoHorario(c.horario), tiempo_entrega: c.tiempo_entrega, pedido_minimo: Number(c.pedido_minimo), acepta_tarjeta: c.acepta_tarjeta,
      zonas: zonasPublicas(), cuenta: null });
  });
  R('GET', '/tienda/publico/productos', function () { if (!cfg().activo) fallo(404, 'Esta tienda no está recibiendo pedidos por internet.'); return visibles(); });

  R('POST', '/tienda/publico/pedido', function (ctx) {
    var c = cfg(), b = ctx.body || {}, D = db();
    if (!c.activo) fallo(404, 'Esta tienda no está recibiendo pedidos por internet.');
    var hor = estadoHorario(c.horario); if (!hor.abierto) fallo(409, hor.texto);
    var nombre = texto(b.nombre, 150), tel = soloDigitos(b.telefono).slice(-10);
    if (!nombre) fallo(400, 'Escribe tu nombre');
    if (tel.length !== 10) fallo(400, 'Escribe tu WhatsApp a 10 números');
    var zona = b.zona_id ? M.porId(D.zonas_envio, b.zona_id) : null;
    if (!zona || !zona.activo) fallo(400, 'Elige tu colonia');
    var calle = texto(b.calle, 200); if (!calle) fallo(400, 'Escribe tu calle y número');
    if (!Array.isArray(b.items) || !b.items.length) fallo(400, 'Tu pedido está vacío');
    var cant = {};
    b.items.forEach(function (it) {
      var id = Number(it && it.producto_id), q = Math.round(Number(it && it.cantidad) * 1000) / 1000;
      if (!(id > 0) || !(q > 0) || q > 999) fallo(400, 'Hay un producto con cantidad inválida');
      cant[id] = (cant[id] || 0) + q;
    });
    var cat = {}; visibles(Object.keys(cant).map(Number)).forEach(function (p) { cat[p.id] = p; });
    var items = Object.keys(cant).map(function (id) {
      var p = cat[id]; if (!p) fallo(409, 'Uno de tus productos ya no está disponible. Revisa tu pedido.');
      var q = p.por_peso ? cant[id] : Math.round(cant[id]);
      var precio = p.promo && q >= p.promo.desde ? p.promo.precio : p.precio;
      return { tipo: 'producto', producto_id: p.id, nombre_producto: p.nombre, cantidad: q, precio_unitario: precio };
    }).filter(function (i) { return i.cantidad > 0; });
    var pend = (D.pedidos || []).filter(function (p) { return p.origen === 'en_linea' && !p.confirmado_en && p.estado === 'programado' && soloDigitos(p.telefono).slice(-10) === tel; }).length;
    if (pend >= c.max_pendientes_por_telefono) fallo(429, 'Ya tienes pedidos esperando que la tienda los confirme. Espera a que te confirmen o llama a la tienda.');
    var pago = ['efectivo', 'tarjeta'].indexOf(b.pago) >= 0 ? b.pago : 'efectivo';
    var p = P.crearPedidoCore({
      tipo: 'domicilio', items: items, zona_id: zona.id, nombre_contacto: nombre, telefono: tel, cliente: null,
      direccion: { calle: calle, colonia: zona.nombre, referencias: texto(b.referencias, 300) },
      pago_modo: 'al_recibir', paga_con: pago === 'efectivo' && Number(b.paga_con) > 0 ? Number(b.paga_con) : null,
      enviar: false, origen: 'en_linea', notas: null
    });
    p.si_falta = ['parecido', 'llamar', 'quitar'].indexOf(b.si_falta) >= 0 ? b.si_falta : 'llamar';
    p.pago_previsto = pago; p.confirmado_en = null;
    p.seguimiento = 'demo' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    var f = P.formato(p);
    M.toast('🌐 Llegó un pedido en línea: míralo en Pedidos → «Por confirmar»', 'info');
    return { ok: true, seguimiento: p.seguimiento, numero: f.etiqueta, total: f.total_neto, costo_envio: Number(p.costo_envio) };
  });

  R('GET', '/tienda/publico/seguimiento/:clave', function (ctx) {
    var D = db(), p = (D.pedidos || []).filter(function (x) { return x.seguimiento === ctx.params.clave; })[0];
    if (!p) fallo(404, 'No encontramos ese pedido');
    var f = P.formato(p), n = negocio();
    var confirmado = p.estado !== 'programado' || !!p.confirmado_en;
    var paso = p.estado === 'cancelado' ? 'cancelado' : p.estado === 'entregado' ? 'entregado' : p.estado === 'en_camino' ? 'en_camino'
      : p.estado === 'no_entregado' ? 'no_entregado' : !confirmado ? 'recibido' : p.estado === 'listo' ? 'listo' : 'surtiendo';
    var items = M.itemsDe(p.ticket_id).filter(function (i) { return i.producto_id; }).map(function (i) { return { nombre: i.nombre_producto, cantidad: Number(i.cantidad), subtotal: Number(i.subtotal), producto_id: i.producto_id }; });
    var total = f.total_neto;
    return Object.assign({ numero: f.etiqueta, negocio: n.negocio, telefono_tienda: n.telefono, nombre: p.nombre_contacto }, apariencia(cfg()), {
      paso: paso, motivo_cancelacion: paso === 'cancelado' ? p.motivo_cancelacion : null,
      horas: { recibido: p.creado_en, confirmado: confirmado ? (p.confirmado_en || p.aceptado_en || p.creado_en) : null, salio: p.salio_en || null, entregado: p.entregado_en || null },
      repartidor: f.repartidor_nombre ? { nombre: String(f.repartidor_nombre).split(' ')[0], telefono: paso === 'en_camino' ? f.repartidor_telefono : null } : null,
      total: total, pago_previsto: p.pago_previsto || 'efectivo', paga_con: p.paga_con == null ? null : Number(p.paga_con),
      cambio: p.paga_con != null && Number(p.paga_con) > total ? r2(Number(p.paga_con) - total) : null, items: items });
  });

  // ---------------------------------------------------------------- administración (Tienda en línea)
  R('GET', '/tienda/config', function (ctx) {
    M.requiereAdmin(ctx);
    var c = clonar(cfg()), D = db();
    c.productos_ocultos = (D.productos || []).filter(function (p) { return p.activo && p.en_tienda === false; }).length;
    c.zonas = zonasPublicas().length;
    c.horario_texto = estadoHorario(c.horario).texto;
    return c;
  });
  R('PUT', '/tienda/config', function (ctx) {
    M.requiereAdmin(ctx);
    var c = cfg(), b = ctx.body || {};
    var bool = function (v, d) { return typeof v === 'boolean' ? v : d; };
    var hora = /^([01]\d|2[0-3]):[0-5]\d$/;
    var tramo = function (t) {
      if (t === null || t === false) return null;
      if (!Array.isArray(t) || t.length !== 2 || !hora.test(t[0]) || !hora.test(t[1]) || t[0] >= t[1]) fallo(400, 'El horario no es válido: escribe la hora en que abres y la hora en que cierras (ej. 08:00 y 20:00)');
      return t;
    };
    if (b.tema !== undefined && TEMAS.indexOf(b.tema) < 0) fallo(400, 'Ese tema no existe');
    ['color_principal', 'color_oferta'].forEach(function (k) {
      if (b[k] === undefined) return;
      if (b[k] === null || b[k] === '') { c[k] = null; return; }
      if (!/^#[0-9a-f]{6}$/i.test(b[k])) fallo(400, 'El color debe ser como #1D6A3A');
      c[k] = String(b[k]).toUpperCase();
    });
    if (b.horario) c.horario = { semana: tramo(b.horario.semana), domingo: tramo(b.horario.domingo) };
    if (b.pedido_minimo !== undefined) { var m = Number(b.pedido_minimo); if (!(m >= 0) || m > 100000) fallo(400, 'El pedido mínimo no es válido'); c.pedido_minimo = r2(m); }
    if (b.max_pendientes_por_telefono !== undefined) { var x = Number(b.max_pendientes_por_telefono); if (!(x >= 1 && x <= 20) || x % 1) fallo(400, 'El máximo de pedidos sin confirmar debe ser de 1 a 20'); c.max_pendientes_por_telefono = x; }
    if (b.giro !== undefined) c.giro = texto(b.giro, 120);
    if (b.tiempo_entrega !== undefined) c.tiempo_entrega = texto(b.tiempo_entrega, 40) || c.tiempo_entrega;
    if (b.tema !== undefined) c.tema = b.tema;
    ['activo', 'acepta_tarjeta', 'fiado_en_linea', 'ocultar_sin_existencia', 'imprimir_al_confirmar', 'sonido'].forEach(function (k) { c[k] = bool(b[k], c[k]); });
    var r = clonar(c); r.horario_texto = estadoHorario(c.horario).texto; return r;
  });
  R('PUT', '/tienda/red', function (ctx) {
    M.requiereAdmin(ctx);
    var c = cfg(), b = ctx.body || {};
    if (b.lat !== undefined || b.lng !== undefined) {
      if (b.lat === null && b.lng === null) { c.red_lat = null; c.red_lng = null; } else {
        var la = Number(b.lat), lo = Number(b.lng);
        if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) fallo(400, 'La ubicación no es válida. Usa el botón o pega el enlace de Google Maps de tu tienda');
        c.red_lat = Math.round(la * 1e6) / 1e6; c.red_lng = Math.round(lo * 1e6) / 1e6;
      }
    }
    var vis = typeof b.visible === 'boolean' ? b.visible : c.red_visible;
    if (vis && c.red_lat === null) fallo(400, 'Primero pon dónde está tu tienda');
    var dom = typeof b.domicilio === 'boolean' ? b.domicilio : c.red_domicilio, rec = typeof b.recoger === 'boolean' ? b.recoger : c.red_recoger;
    if (vis && !dom && !rec) fallo(400, 'Escoge al menos una forma de entregar');
    c.red_visible = vis; c.red_domicilio = dom; c.red_recoger = rec;
    if (b.direccion !== undefined) c.red_direccion = texto(b.direccion, 200);
    if (typeof b.buscar === 'boolean') c.red_buscar = b.buscar;
    return { red_visible: c.red_visible, red_lat: c.red_lat, red_lng: c.red_lng, red_direccion: c.red_direccion, red_domicilio: c.red_domicilio, red_recoger: c.red_recoger, red_buscar: c.red_buscar };
  });
  R('GET', '/tienda/productos', function (ctx) {
    M.requiereAdmin(ctx); cfg();
    var q = String(ctx.query.q || '').toLowerCase();
    return (db().productos || []).filter(function (p) { return p.activo && (!q || p.nombre.toLowerCase().indexOf(q) >= 0); }).map(function (p) {
      return { id: p.id, nombre: p.nombre, precio: Number(p.precio), en_tienda: p.en_tienda !== false, con_foto: !!p.imagen_url,
        departamento: M.catNombre(p.categoria_id) || 'Otros', existencia: Number((M.inv(p.id) || {}).existencia_actual || 0), usa_inventario: !!p.usa_inventario };
    }).sort(function (a, b) { return a.departamento.localeCompare(b.departamento) || a.nombre.localeCompare(b.nombre); });
  });
  R('PUT', '/tienda/productos', function (ctx) {
    M.requiereAdmin(ctx); cfg();
    var b = ctx.body || {}, ids = Array.isArray(b.ids) ? b.ids.map(Number) : [];
    if (typeof b.en_tienda !== 'boolean' || !ids.length) fallo(400, 'Datos inválidos');
    var n = 0; (db().productos || []).forEach(function (p) { if (ids.indexOf(p.id) >= 0) { p.en_tienda = b.en_tienda; n++; } });
    return { cambiados: n };
  });
  R('PUT', '/tienda/productos/:id', function (ctx) {
    M.requiereAdmin(ctx); cfg();
    var p = M.porId(db().productos, ctx.params.id); if (!p) fallo(404, 'Producto no encontrado');
    if (typeof (ctx.body || {}).en_tienda !== 'boolean') fallo(400, 'Datos inválidos');
    p.en_tienda = ctx.body.en_tienda; return { id: p.id, en_tienda: p.en_tienda };
  });
  R('GET', '/tienda/fiado', function (ctx) {
    M.requiereAdmin(ctx);
    return (db().clientes || []).filter(function (c) { return c.activo && Number(c.limite_credito) > 0; }).map(function (c) {
      return { id: c.id, nombre: c.nombre, telefono: c.telefono, limite_credito: Number(c.limite_credito), saldo_actual: Number(c.saldo_actual || 0), enlace_tienda: c.enlace_tienda || null };
    });
  });
  R('POST', '/tienda/fiado/:id/enlace', function (ctx) {
    M.requiereAdmin(ctx);
    var c = M.porId(db().clientes, ctx.params.id); if (!c) fallo(404, 'Cliente no encontrado');
    if (!c.enlace_tienda || (ctx.body || {}).nuevo === true) c.enlace_tienda = 'demo' + Math.random().toString(36).slice(2, 14);
    return { id: c.id, enlace_tienda: c.enlace_tienda };
  });

  // Un pedido de ejemplo «Por confirmar» al día, para que se vea la columna nueva en Pedidos.
  function sembrarEnLinea() {
    try {
      var D = M.cargar(); cfg();
      var hoy = M.fechaLocalStr(M.ahora());
      if (D.extra.tiendaSemilla === hoy || !(D.zonas_envio || []).length) { M.guardar(); return; }
      var hay = (D.pedidos || []).some(function (p) { return p.origen === 'en_linea' && String(p.creado_en || '').slice(0, 10) === hoy; });
      if (!hay) {
        var prod = visibles([9, 1, 11]);
        var items = prod.map(function (p) { var q = p.por_peso ? 0.5 : 2; return { tipo: 'producto', producto_id: p.id, nombre_producto: p.nombre, cantidad: q, precio_unitario: p.precio }; });
        if (items.length) {
          var z = D.zonas_envio.filter(function (x) { return x.activo; })[0];
          var p = P.crearPedidoCore({ tipo: 'domicilio', items: items, zona_id: z.id, nombre_contacto: 'Laura Gómez', telefono: '3398765432', cliente: null,
            direccion: { calle: 'Av. Juárez 250', colonia: z.nombre, referencias: 'Portón negro junto a la farmacia' }, pago_modo: 'al_recibir', paga_con: 500, enviar: false, origen: 'en_linea' });
          p.si_falta = 'parecido'; p.pago_previsto = 'efectivo'; p.confirmado_en = null; p.seguimiento = 'demoejemplo' + hoy.replace(/-/g, '');
          p.creado_en = M.iso(new Date(M.ahora().getTime() - 6 * 60000));
        }
      }
      D.extra.tiendaSemilla = hoy;
      M.guardar();
    } catch (e) { try { console.warn('[demo] tienda:', e && (e.apiError || e.message)); } catch (e2) { /* nada */ } }
  }
  sembrarEnLinea();
})();
