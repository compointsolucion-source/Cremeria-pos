/* ============================================================================
 * Compoint Punto — MODO DEMOSTRACIÓN (100% en el navegador, sin servidor)
 *
 * Este archivo se carga PRIMERO en todas las pantallas. Reemplaza fetch()
 * para que las llamadas al backend real (API_URL) las conteste un "servidor
 * de mentiras" que vive aquí mismo y guarda sus datos en localStorage.
 * Nada sale del navegador. Para reiniciar los datos: botón "Reiniciar demo".
 * ========================================================================== */
(function () {
  'use strict';

  var DB_KEY = 'compoint_demo_db_v1';
  var ORIGEN_API = 'https://cremeria-pos.onrender.com';
  var WA_URL = 'https://wa.me/523325907090';
  var SITIO_URL = 'https://www.compoint.com.mx';

  // ---------- Raíz de la demo (funciona en cualquier subcarpeta) ----------
  var scriptSrc = (document.currentScript && document.currentScript.src) || '';
  var DEMO_ROOT = scriptSrc ? scriptSrc.replace(/js\/demo-mock\.js(\?.*)?$/, '') : (location.href.replace(/[^\/]*$/, ''));
  window.DEMO_ROOT = DEMO_ROOT;
  window.COMPOINT_DEMO = true;
  window.DEMO_API = ORIGEN_API + '/api';   // tienda.html llama a la API pública por aquí

  // ---------- Bloqueos de hardware / Service Worker ----------
  // socket.io: se define un "io" falso que NO se puede sobrescribir aunque el
  // CDN cargue (así kiosco/pantalla/caja nunca intentan abrir un websocket).
  function crearSocketFalso() {
    var s = {
      connected: false, id: 'demo',
      on: function () { return s; }, off: function () { return s; }, once: function () { return s; },
      emit: function () { return s; }, connect: function () { return s; },
      disconnect: function () { return s; }, close: function () { return s; },
      io: { on: function () {}, off: function () {} }
    };
    return s;
  }
  var ioFalso = function () { return crearSocketFalso(); };
  ioFalso.connect = ioFalso;
  try {
    Object.defineProperty(window, 'io', {
      configurable: true,
      get: function () { return ioFalso; },
      set: function () { /* ignora al socket.io real */ }
    });
  } catch (e) { window.io = ioFalso; }

  // Service Worker: nunca registrar; y quitar los que hayan quedado de esta carpeta.
  try {
    if ('serviceWorker' in navigator) {
      try {
        navigator.serviceWorker.register = function () { return Promise.resolve(undefined); };
      } catch (e) { /* ignorar */ }
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        regs.forEach(function (r) { if (r.scope && r.scope.indexOf(DEMO_ROOT) === 0) r.unregister(); });
      }).catch(function () {});
      if (window.caches && caches.keys) {
        caches.keys().then(function (ks) { ks.forEach(function (k) { if (/compoint|cremeria/i.test(k)) caches.delete(k); }); }).catch(function () {});
      }
    }
  } catch (e) { /* ignorar */ }

  // ---------- Utilidades ----------
  function ahora() { return new Date(); }
  function iso(d) { return (d instanceof Date ? d : new Date(d)).toISOString(); }
  function inicioDelDia(d) { d = d || ahora(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function fechaLocalStr(d) {
    d = new Date(d);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function haceHoras(h) {
    var min = inicioDelDia().getTime() + 60000;
    return new Date(Math.max(min, ahora().getTime() - h * 3600000));
  }
  function num(v, def) { var n = parseFloat(v); return isNaN(n) ? (def === undefined ? 0 : def) : n; }
  function redondea(n) { return Math.round(n * 100) / 100; }
  function redondea3(n) { return Math.round(n * 1000) / 1000; }
  function clonar(o) { return JSON.parse(JSON.stringify(o)); }
  function parseFechaParam(s) {
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
    var d = new Date(s); return isNaN(d.getTime()) ? null : d;
  }

  // ---------- Datos de ejemplo (seed) ----------
  function construirSeed() {
    var db = {
      v: 3,
      seedDia: fechaLocalStr(ahora()),
      seq: {},
      sucursal: { id: 1, nombre: 'Demo Compoint Punto', direccion: 'Calle Fontaneros 527, Guadalajara, Jalisco', telefono: '33 25 90 70 90', activo: true },
      usuarios: [
        { id: 1, sucursal_id: 1, nombre: 'Demo Dueño', usuario: 'demo', password: 'demo', rol: 'dueno', permisos: {}, activo: true, creado_en: iso(haceHoras(24 * 30)), nombre_mostrador: null },
        { id: 2, sucursal_id: 1, nombre: 'Cajero Demo', usuario: 'cajero', password: 'demo', rol: 'cajero', permisos: {}, activo: true, creado_en: iso(haceHoras(24 * 29)), nombre_mostrador: null },
        { id: 3, sucursal_id: 1, nombre: 'Mostrador Demo', usuario: 'mostrador', password: 'demo', rol: 'mostrador', permisos: {}, activo: true, creado_en: iso(haceHoras(24 * 28)), nombre_mostrador: 'Mostrador 1' },
        { id: 4, sucursal_id: 1, nombre: 'Luis Repartidor', usuario: 'repartidor', password: 'demo', rol: 'repartidor', permisos: {}, activo: true, creado_en: iso(haceHoras(24 * 27)), nombre_mostrador: null, telefono: '33 4444 0101' }
      ],
      categorias: [
        { id: 1, nombre: 'Quesos', orden: 1 },
        { id: 2, nombre: 'Cremas y lácteos', orden: 2 },
        { id: 3, nombre: 'Carnes frías', orden: 3 },
        { id: 4, nombre: 'Carnes', orden: 4 },
        { id: 5, nombre: 'Abarrotes', orden: 5 }
      ],
      productos: [], inventario: {}, promociones: [], kits: [], kit_productos: [],
      clientes: [], tickets: [], ticket_detalle: [], turnos: [], movimientos_caja: [],
      movimientos_inventario: [], creditos_cargo: [], creditos_abono: [], fichas: [],
      proveedores: [], compras: [], compra_detalle: [], devoluciones: [], bitacora: [], recargas_ventas: [],
      configuracion: {
        sucursal_id: 1,
        nombre_negocio: 'Demo Compoint Punto',
        logo_url: null, direccion: 'Calle Fontaneros 527, Guadalajara, Jalisco', telefono: '33 25 90 70 90', rfc: null,
        ancho_ticket: '80mm', terminos: 'Gracias por su compra. Esta es una demostración.',
        lineas_superiores: 0, lineas_inferiores: 3, incluir_precio_unitario: true, descripcion_completa: true,
        imprimir_datos_cliente: false, tipo_codigo_escaneo: 'qr', negocio_negritas: true, total_negritas: true,
        tamano_letra: 'normal', tipo_fuente: 'monospace', efectivo_bloquear_insuficiente: true,
        dolares_habilitado: false, tipo_cambio_dolar: 0, tarjeta_habilitado: true, tarjeta_comision_porcentaje: 0,
        transferencia_habilitado: true, transferencia_etiqueta: 'Transferencia', cheque_habilitado: false,
        vales_habilitado: false, mixto_habilitado: true, credito_habilitado: true, cajon_abrir_automatico: false,
        promos_pantalla_turnos: [], promos_intervalo_segundos: 10, promos_orden_aleatorio: false,
        etiqueta_modo: 'auto', ancho_etiqueta: '50mm', bascula_tipo_dato: 'peso'
      }
    };

    // [id, cat, nombre, tipo, codigo, costo, precio, mayoreo, existencia, minimo, maximo, favorito]
    var P = [
      [1, 1, 'Queso Oaxaca', 'peso', '10001', 105, 150, 140, 18.5, 5, 30, true],
      [2, 1, 'Queso Panela', 'peso', '10002', 85, 125, 118, 12.2, 4, 20, true],
      [3, 1, 'Queso Chihuahua', 'peso', '10003', 120, 170, 160, 9.8, 4, 20, false],
      [4, 1, 'Queso Manchego', 'peso', '10004', 130, 185, 175, 7.4, 3, 15, false],
      [5, 1, 'Queso Cotija', 'peso', '10005', 140, 195, 185, 2.1, 3, 12, false],
      [6, 1, 'Queso Fresco', 'peso', '10006', 70, 105, 98, 14.0, 5, 25, true],
      [7, 2, 'Crema ácida a granel', 'peso', '10011', 60, 90, 84, 10.5, 3, 15, false],
      [8, 2, 'Mantequilla sin sal 90 g', 'unidad', '7501000112345', 19, 28, 26, 40, 12, 60, false],
      [9, 2, 'Leche entera 1 L', 'unidad', '7501020510016', 21, 27, 25, 72, 24, 120, true],
      [10, 2, 'Yogurt natural 1 kg', 'unidad', '7501055310012', 38, 55, 52, 18, 6, 30, false],
      [11, 2, 'Queso crema 190 g', 'unidad', '7501000113250', 32, 45, 42, 26, 8, 40, false],
      [12, 3, 'Jamón de pierna', 'peso', '10021', 110, 160, 150, 11.3, 3, 15, true],
      [13, 3, 'Salchicha de pavo', 'peso', '10022', 70, 99, 92, 8.6, 3, 15, false],
      [14, 3, 'Chorizo argentino', 'peso', '10023', 95, 140, 132, 6.2, 2, 12, false],
      [15, 3, 'Tocino ahumado', 'peso', '10024', 130, 185, 175, 1.4, 2, 10, false],
      [16, 3, 'Salami', 'peso', '10025', 150, 210, 198, 4.9, 2, 10, false],
      [17, 4, 'Bistec de res', 'peso', '10031', 150, 215, 205, 22.0, 6, 40, true],
      [18, 4, 'Carne molida de res', 'peso', '10032', 120, 170, 160, 16.5, 5, 30, true],
      [19, 4, 'Chuleta de cerdo', 'peso', '10033', 85, 125, 118, 13.7, 5, 30, false],
      [20, 4, 'Pechuga de pollo', 'peso', '10034', 80, 115, 108, 0, 5, 30, false],
      [21, 4, 'Costilla de cerdo', 'peso', '10035', 100, 145, 136, 9.1, 4, 25, false],
      [22, 5, 'Huevo blanco 12 pzas', 'unidad', '7501000900123', 38, 52, 49, 35, 10, 60, true],
      [23, 5, 'Tortillas de maíz', 'peso', '10041', 17, 25, 23, 20.0, 6, 40, true],
      [24, 5, 'Aceite vegetal 1 L', 'unidad', '7501000901010', 38, 52, 49, 28, 8, 48, false],
      [25, 5, 'Frijol negro 1 kg', 'unidad', '7501000902017', 28, 40, 37, 30, 10, 50, false],
      [26, 5, 'Arroz blanco 1 kg', 'unidad', '7501000903014', 22, 32, 30, 34, 10, 50, false]
    ];
    // Mosaico con emoji como imagen de ejemplo (no depende de ningún archivo externo)
    var EMOJI = { 1: '🧀', 2: '🧀', 3: '🧀', 4: '🧀', 5: '🧀', 6: '🧀', 7: '🥛', 8: '🧈', 9: '🥛', 10: '🥛', 11: '🧀', 12: '🥓', 13: '🌭', 14: '🌭', 15: '🥓', 16: '🍖', 17: '🥩', 18: '🥩', 19: '🍖', 20: '🍗', 21: '🍖', 22: '🥚', 23: '🫓', 24: '🫒', 25: '🫘', 26: '🍚' };
    var FONDO = { 1: '#FFF3C4', 2: '#E3F1FB', 3: '#FBE0E0', 4: '#F7D9D0', 5: '#EFE6D5' };
    function mosaico(id, cat) {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="' + FONDO[cat] + '"/><text x="80" y="108" font-size="84" text-anchor="middle">' + EMOJI[id] + '</text></svg>';
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }
    P.forEach(function (r, i) {
      db.productos.push({
        id: r[0], sucursal_id: 1, categoria_id: r[1], nombre: r[2], precio: r[6], imagen_url: mosaico(r[0], r[1]),
        favorito: r[11], orden: i, activo: true, codigo_barras: r[4], tipo_venta: r[3],
        precio_costo: r[5], ganancia_porcentaje: Math.round((r[6] - r[5]) / r[5] * 100), precio_mayoreo: r[7], usa_inventario: true
      });
      db.inventario[r[0]] = { existencia_actual: r[8], stock_minimo: r[9], stock_maximo: r[10] };
    });
    db.promociones.push({ id: 1, producto_id: 1, cantidad_minima: 3, precio_promocional: 138, activo: true });
    db.promociones.push({ id: 2, producto_id: 17, cantidad_minima: 5, precio_promocional: 199, activo: true });

    db.kits = [
      { id: 1, sucursal_id: 1, nombre: 'Kit Parrillada', precio_kit: 380, imagen_url: null, codigo_barras: '20001', activo: true },
      { id: 2, sucursal_id: 1, nombre: 'Kit Desayuno', precio_kit: 125, imagen_url: null, codigo_barras: '20002', activo: true },
      { id: 3, sucursal_id: 1, nombre: 'Kit Botanero', precio_kit: 190, imagen_url: null, codigo_barras: '20003', activo: true }
    ];
    db.kit_productos = [
      { kit_id: 1, producto_id: 17, cantidad: 1 }, { kit_id: 1, producto_id: 14, cantidad: 0.5 }, { kit_id: 1, producto_id: 1, cantidad: 0.5 },
      { kit_id: 2, producto_id: 22, cantidad: 1 }, { kit_id: 2, producto_id: 12, cantidad: 0.25 }, { kit_id: 2, producto_id: 6, cantidad: 0.25 }, { kit_id: 2, producto_id: 9, cantidad: 1 },
      { kit_id: 3, producto_id: 16, cantidad: 0.3 }, { kit_id: 3, producto_id: 3, cantidad: 0.3 }, { kit_id: 3, producto_id: 5, cantidad: 0.2 }
    ];

    db.clientes = [
      { id: 1, sucursal_id: 1, nombre: 'María González', telefono: '33 1234 5678', limite_credito: 2000, saldo_actual: 450, activo: true },
      { id: 2, sucursal_id: 1, nombre: 'Fonda Doña Lupe', telefono: '33 8765 4321', limite_credito: 5000, saldo_actual: 0, activo: true },
      { id: 3, sucursal_id: 1, nombre: 'Carlos Ramírez', telefono: '33 5555 0101', limite_credito: 1000, saldo_actual: 0, activo: true }
    ];

    db.proveedores = [
      { id: 1, sucursal_id: 1, nombre: 'Lácteos del Bajío', contacto: 'Ing. Ramón Torres', telefono: '33 3000 1111', activo: true },
      { id: 2, sucursal_id: 1, nombre: 'Carnes Selectas Jalisco', contacto: 'Lic. Patricia Núñez', telefono: '33 3000 2222', activo: true },
      { id: 3, sucursal_id: 1, nombre: 'Abarrotes La Central', contacto: 'Don Beto', telefono: '33 3000 3333', activo: true }
    ];
    var compras = [
      [1, 1, 48, [[1, 20, 103], [2, 15, 84], [6, 15, 69]]],
      [2, 2, 30, [[17, 25, 148], [18, 20, 118], [19, 15, 84]]],
      [3, 3, 72, [[22, 60, 37], [24, 48, 37]]]
    ];
    compras.forEach(function (c) {
      var total = 0;
      c[3].forEach(function (it) { total += it[1] * it[2]; });
      db.compras.push({ id: c[0], sucursal_id: 1, proveedor_id: c[1], usuario_id: 1, total: total, fecha: iso(haceHoras(c[2])) });
      c[3].forEach(function (it) {
        db.compra_detalle.push({ id: db.compra_detalle.length + 1, compra_id: c[0], producto_id: it[0], cantidad: it[1], costo_unitario: it[2], precio_venta_nuevo: null, subtotal: it[1] * it[2] });
      });
    });

    // Turno abierto
    db.turnos.push({ id: 1, sucursal_id: 1, usuario_id: 2, fondo_inicial: 500, estado: 'abierto', fecha_apertura: iso(haceHoras(8)), fecha_cierre: null, saldo_teorico: null, saldo_contado: null });
    db.movimientos_caja.push({ id: 1, turno_id: 1, usuario_id: 1, tipo: 'egreso', monto: 150, concepto: 'Pago de hielo y bolsas', fecha: iso(haceHoras(5)) });

    // Tickets pagados de hoy: [horasAtras, metodo, [[pid, cantidad], ...]]
    var ventas = [
      [7.5, 'efectivo', [[1, 0.750], [22, 1]]],
      [6.8, 'tarjeta', [[17, 1.250], [14, 0.400]]],
      [6.0, 'efectivo', [[6, 0.500], [9, 2], [8, 1]]],
      [5.2, 'transferencia', [[18, 2.000], [25, 2]]],
      [4.4, 'mixto', [[12, 0.300], [16, 0.250], [3, 0.500]]],
      [3.5, 'efectivo', [[19, 1.500], [23, 1.000]]],
      [2.6, 'tarjeta', [[2, 0.800], [11, 2], [10, 1]]],
      [1.7, 'efectivo', [[21, 1.100], [24, 1]]],
      [0.9, 'efectivo', [[4, 0.350], [13, 0.500], [26, 2]]]
    ];
    var ticketId = 0, detId = 0;
    function agregaTicket(horas, metodo, items, clienteId, estado) {
      ticketId++;
      var total = 0, fecha = haceHoras(horas);
      var detalle = [];
      items.forEach(function (it) {
        var p = db.productos.filter(function (x) { return x.id === it[0]; })[0];
        var sub = redondea(it[1] * p.precio);
        total += sub; detId++;
        detalle.push({ id: detId, ticket_id: ticketId, tipo: 'producto', producto_id: p.id, kit_id: null, nombre_producto: p.nombre, cantidad: it[1], precio_unitario: p.precio, subtotal: sub, descuento_monto: 0, descuento_motivo: null, cantidad_devuelta: 0 });
      });
      total = redondea(total);
      var t = {
        id: ticketId, folio: 'S1-' + (estado === 'pendiente' ? 'DEMO01' : 'D' + String(ticketId).padStart(5, '0')), sucursal_id: 1, mostrador_usuario_id: 3,
        cajero_usuario_id: estado === 'pendiente' ? null : 2, estado: estado, total: total, descuento_monto: 0, descuento_motivo: null, descuento_autorizado_por: null,
        metodo_pago: estado === 'pendiente' ? null : metodo, monto_efectivo: 0, monto_tarjeta: 0, turno_id: estado === 'pendiente' ? null : 1,
        cliente_id: clienteId || null, fecha_creacion: iso(new Date(fecha.getTime() - 4 * 60000)),
        fecha_pago: estado === 'pendiente' ? null : iso(fecha), efectivo_recibido: null
      };
      if (estado !== 'pendiente') {
        if (metodo === 'efectivo') { t.monto_efectivo = total; t.efectivo_recibido = String(Math.ceil(total / 50) * 50) + '.00'; }
        else if (metodo === 'mixto') { t.monto_efectivo = redondea(total / 2); t.monto_tarjeta = redondea(total - t.monto_efectivo); }
        else if (metodo === 'tarjeta' || metodo === 'transferencia') { t.monto_tarjeta = total; }
      }
      db.tickets.push(t);
      detalle.forEach(function (d) { db.ticket_detalle.push(d); });
      return t;
    }
    // Historial: un turno cerrado por día (últimos 12 días, sin domingos) con sus ventas,
    // para que Cortes, Reportes y el Dashboard tengan semanas con datos.
    var semilla = 7;
    function azar() { semilla = (semilla * 9301 + 49297) % 233280; return semilla / 233280; }
    function agregaTicketEn(fecha, metodo, items, turnoId) {
      ticketId++;
      var total = 0;
      items.forEach(function (it) {
        var p = db.productos[it[0] - 1];
        var sub = redondea(it[1] * p.precio); total += sub; detId++;
        db.ticket_detalle.push({ id: detId, ticket_id: ticketId, tipo: 'producto', producto_id: p.id, kit_id: null, nombre_producto: p.nombre, cantidad: it[1], precio_unitario: p.precio, subtotal: sub, descuento_monto: 0, descuento_motivo: null, cantidad_devuelta: 0 });
      });
      total = redondea(total);
      var t = { id: ticketId, folio: 'S1-D' + String(ticketId).padStart(5, '0'), sucursal_id: 1, mostrador_usuario_id: 3, cajero_usuario_id: 2, estado: 'pagado',
        total: total, descuento_monto: 0, descuento_motivo: null, descuento_autorizado_por: null, metodo_pago: metodo,
        monto_efectivo: metodo === 'efectivo' ? total : 0, monto_tarjeta: metodo === 'efectivo' ? 0 : total, turno_id: turnoId, cliente_id: null,
        fecha_creacion: iso(new Date(fecha.getTime() - 3 * 60000)), fecha_pago: iso(fecha), efectivo_recibido: metodo === 'efectivo' ? String(Math.ceil(total / 50) * 50) + '.00' : null };
      db.tickets.push(t);
      return t;
    }
    var turnoSeq = 1;
    for (var dAtras = 12; dAtras >= 1; dAtras--) {
      var dia = new Date(inicioDelDia().getTime() - dAtras * 86400000);
      if (dia.getDay() === 0) continue;
      turnoSeq++;
      var apertura = new Date(dia.getTime() + 8 * 3600000 + Math.floor(azar() * 20) * 60000);
      var cierre = new Date(dia.getTime() + 20 * 3600000 + Math.floor(azar() * 30) * 60000);
      var tur = { id: turnoSeq, sucursal_id: 1, usuario_id: 2, fondo_inicial: 500, estado: 'cerrado', fecha_apertura: iso(apertura), fecha_cierre: iso(cierre),
        saldo_teorico: null, saldo_contado: null, declaracion: null, cerrado_por: 2 };
      var nT = 9 + Math.floor(azar() * 8), efectivoDia = 0;
      var metodos = ['efectivo', 'efectivo', 'efectivo', 'tarjeta', 'transferencia', 'efectivo', 'tarjeta'];
      for (var k = 0; k < nT; k++) {
        var fechaPago = new Date(apertura.getTime() + (k + 1) * (cierre.getTime() - apertura.getTime()) / (nT + 1));
        var items = [], nIt = 1 + Math.floor(azar() * 3);
        for (var q = 0; q < nIt; q++) {
          var prod = db.productos[Math.floor(azar() * 26)];
          items.push([prod.id, prod.tipo_venta === 'peso' ? redondea3(0.25 + Math.floor(azar() * 8) * 0.25) : 1 + Math.floor(azar() * 3)]);
        }
        var met = metodos[Math.floor(azar() * metodos.length)];
        var tk = agregaTicketEn(fechaPago, met, items, tur.id);
        if (met === 'efectivo') efectivoDia += tk.total;
      }
      tur.saldo_teorico = redondea(500 + efectivoDia);
      tur.saldo_contado = redondea(tur.saldo_teorico + [0, 0, 0, -10, 0, 20, 0, -5][Math.floor(azar() * 8)]);
      db.turnos.push(tur);
    }
    ventas.forEach(function (v) { agregaTicket(v[0], v[1], v[2], null, 'pagado'); });
    // Un ticket de ayer a crédito (origen del fiado de María) + su abono
    var ayer = agregaTicket(30, 'credito', [[17, 2.000], [18, 1.500], [14, 0.600]], 1, 'pagado');
    ayer.fecha_pago = iso(new Date(inicioDelDia().getTime() - 4 * 3600000)); ayer.fecha_creacion = iso(new Date(inicioDelDia().getTime() - 4.1 * 3600000));
    ayer.monto_efectivo = 0; ayer.monto_tarjeta = 0;
    db.creditos_cargo.push({ id: 1, cliente_id: 1, ticket_id: ayer.id, monto: ayer.total, autorizado_por: 1, fecha: ayer.fecha_pago });
    var abono0 = redondea(ayer.total - 450);
    db.creditos_abono.push({ id: 1, cliente_id: 1, monto: abono0, metodo_pago: 'efectivo', turno_id: null, recibido_por: 2, fecha: iso(new Date(inicioDelDia().getTime() - 2 * 3600000)) });
    // Un ticket pendiente listo para cobrar en Caja
    agregaTicket(0.1, null, [[2, 0.600], [9, 3], [22, 1]], null, 'pendiente');

    db.seq = { ticket: ticketId, ticket_detalle: detId, producto: 26, categoria: 5, kit: 3, cliente: 3, turno: turnoSeq, mov_caja: 1, mov_inv: 0, cargo: 1, abono: 1, ficha: 0, usuario: 4, proveedor: 3, compra: 3, compra_detalle: db.compra_detalle.length, devolucion: 0, bitacora: 0, promocion: 2 };
    [['login', 'usuarios', 1], ['abrir_turno', 'turnos', 1], ['registrar_compra', 'compras', 3]].forEach(function (b, i) {
      db.bitacora.push({ id: ++db.seq.bitacora, usuario_id: 1, accion: b[0], modulo: b[1], referencia_id: b[2], valor_anterior: null, valor_nuevo: null, fecha: iso(haceHoras(8 - i)) });
    });
    return db;
  }

  // ---------- Persistencia ----------
  var memoria = null; // respaldo si localStorage no está disponible
  var DB = null;

  function cargarDB() {
    var raw = null;
    try { raw = localStorage.getItem(DB_KEY); } catch (e) { raw = null; }
    var d = null;
    if (raw) { try { d = JSON.parse(raw); } catch (e) { d = null; } }
    if (!d && memoria) d = memoria;
    if (!d || d.v !== 3) { d = construirSeed(); DB = d; completarCortesDeEjemplo(); guardarDB(); }
    DB = d;
    rejuvenecer();
  }

  var avisoAlmacenamiento = false;
  function guardarDB() {
    memoria = DB;
    try { localStorage.setItem(DB_KEY, JSON.stringify(DB)); }
    catch (e) {
      // Cuota llena (ej. imágenes grandes) o almacenamiento bloqueado: la demo sigue en memoria.
      if (!avisoAlmacenamiento) { avisoAlmacenamiento = true; setTimeout(function () { toastDemo('No se pudo guardar en el navegador (almacenamiento lleno o bloqueado). Los cambios se perderán al recargar.', 'error'); }, 0); }
    }
  }

  // Si la demo se abre otro día, recorre las fechas para que "hoy" siga teniendo ventas.
  function rejuvenecer() {
    var hoy = fechaLocalStr(ahora());
    if (DB.seedDia === hoy) return;
    var dias = Math.round((inicioDelDia().getTime() - parseFechaParam(DB.seedDia).getTime()) / 86400000);
    if (dias > 0) {
      var ms = dias * 86400000;
      ['tickets', 'turnos', 'movimientos_caja', 'creditos_cargo', 'creditos_abono', 'compras', 'bitacora', 'movimientos_inventario', 'devoluciones', 'usuarios', 'recargas_ventas'].forEach(function (k) {
        (DB[k] || []).forEach(function (r) {
          Object.keys(r).forEach(function (c) {
            if ((c.indexOf('fecha') === 0 || c === 'creado_en') && r[c]) r[c] = iso(new Date(new Date(r[c]).getTime() + ms));
          });
        });
      });
    }
    DB.fichas = [];
    DB.seedDia = hoy;
    guardarDB();
  }

  function reiniciarDemo() {
    try { localStorage.removeItem(DB_KEY); } catch (e) { /* ignorar */ }
    memoria = null; DB = null;
    ['sucursal_seleccionada', 'sucursal_seleccionada_nombre'].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
    cargarDB();
  }
  window.reiniciarDemo = function () { reiniciarDemo(); location.reload(); };

  function sig(k) { DB.seq[k] = (DB.seq[k] || 0) + 1; return DB.seq[k]; }

  // ---------- Errores tipo backend ----------
  function fallo(status, error) { var e = new Error(error); e.status = status; e.apiError = error; throw e; }

  // ---------- Permisos (copia de middleware/auth.js) ----------
  var PERMISOS_BASE = {
    cajero: ['VENTAS_CREAR', 'VENTAS_CANCELAR', 'VENTAS_DEVOLVER', 'CAJA_ABRIR', 'CAJA_CERRAR', 'CAJA_MOVIMIENTO', 'INVENTARIO_VER', 'REPORTES_VER', 'CLIENTES_CREAR', 'CREDITO_ABONO', 'RECARGAS_VENDER'],
    mostrador: ['VENTAS_CREAR']
  };
  var TODOS_PERMISOS = ['VENTAS_CREAR', 'VENTAS_CANCELAR', 'VENTAS_DEVOLVER', 'DESCUENTO_APLICAR', 'INVENTARIO_VER', 'INVENTARIO_AJUSTAR', 'INVENTARIO_MERMA', 'CAJA_ABRIR', 'CAJA_CERRAR', 'CAJA_MOVIMIENTO', 'REPORTES_VER', 'PRODUCTOS_CREAR', 'PRODUCTOS_EDITAR', 'PRODUCTOS_PRECIO', 'CLIENTES_CREAR', 'CREDITO_ABONO', 'RECARGAS_VENDER'];
  function tienePermiso(u, p) {
    if (u.rol === 'jefe_general' || u.rol === 'dueno' || u.rol === 'gerente') return true;
    var pm = u.permisos || {};
    if (pm[p] === true) return true;
    if (pm[p] === false) return false;
    return (PERMISOS_BASE[u.rol] || []).indexOf(p) !== -1;
  }
  function requierePermiso(ctx, p) {
    if (!tienePermiso(ctx.user, p)) fallo(403, 'No tienes el permiso "' + p + '" para esta acción. Pide a tu gerente que te lo asigne en Equipo.');
  }
  var ADMIN = ['jefe_general', 'dueno', 'gerente'];
  function requiereRol(ctx, roles) {
    if (roles.indexOf(ctx.user.rol) === -1) fallo(403, 'No tienes permiso para esta acción');
  }
  function requiereAdmin(ctx) { requiereRol(ctx, ADMIN); }

  function bitacora(ctx, accion, modulo, ref, nuevo, anterior) {
    DB.bitacora.push({ id: sig('bitacora'), usuario_id: ctx.user ? ctx.user.id : 1, accion: accion, modulo: modulo, referencia_id: ref === undefined ? null : ref, valor_anterior: anterior || null, valor_nuevo: nuevo || null, fecha: iso(ahora()) });
    if (DB.bitacora.length > 300) DB.bitacora.splice(0, DB.bitacora.length - 300);
  }

  // ---------- Helpers de dominio ----------
  function porId(lista, id) { id = parseInt(id, 10); for (var i = 0; i < lista.length; i++) if (lista[i].id === id) return lista[i]; return null; }
  function catNombre(id) { var c = porId(DB.categorias, id); return c ? c.nombre : null; }
  function inv(pid) {
    if (!DB.inventario[pid]) DB.inventario[pid] = { existencia_actual: 0, stock_minimo: 0, stock_maximo: null };
    return DB.inventario[pid];
  }
  function usuarioNombre(id) { var u = porId(DB.usuarios, id); return u ? u.nombre : null; }
  function itemsDe(ticketId) { return DB.ticket_detalle.filter(function (d) { return d.ticket_id === ticketId; }); }
  function recalcTotal(ticket) {
    var t = 0; itemsDe(ticket.id).forEach(function (d) { t += num(d.subtotal); });
    ticket.total = redondea(t); return ticket.total;
  }
  function costoPromedio(pid) {
    var det = DB.compra_detalle.filter(function (c) { return c.producto_id === pid; });
    if (det.length) { var s = 0; det.forEach(function (c) { s += num(c.costo_unitario); }); return s / det.length; }
    var p = porId(DB.productos, pid);
    return p && p.precio_costo ? num(p.precio_costo) : 0;
  }
  function promosDe(pid) {
    return DB.promociones.filter(function (p) { return p.producto_id === pid && p.activo; })
      .sort(function (a, b) { return a.cantidad_minima - b.cantidad_minima; })
      .map(function (p) { return { cantidad_minima: p.cantidad_minima, precio_promocional: p.precio_promocional }; });
  }
  function productoFila(p) {
    var o = clonar(p); o.categoria_nombre = catNombre(p.categoria_id); o.promociones = promosDe(p.id); return o;
  }
  function kitFila(k) {
    var o = clonar(k);
    o.productos = DB.kit_productos.filter(function (kp) { return kp.kit_id === k.id; }).map(function (kp) {
      var p = porId(DB.productos, kp.producto_id) || {};
      return { cantidad: kp.cantidad, producto_id: kp.producto_id, nombre: p.nombre, tipo_venta: p.tipo_venta };
    });
    return o;
  }
  function ticketConItems(t) { var o = clonar(t); o.items = clonar(itemsDe(t.id)); return o; }
  function enRango(fecha, desde, hasta) { if (!fecha) return false; var f = new Date(fecha).getTime(); return f >= desde.getTime() && f <= hasta.getTime(); }
  function resolverRango(q) {
    var ini = inicioDelDia(), fin = new Date(ini.getTime() + 86400000);
    return { desde: parseFechaParam(q.desde) || ini, hasta: parseFechaParam(q.hasta) || fin };
  }
  function pagadosEn(r) { return DB.tickets.filter(function (t) { return t.estado === 'pagado' && enRango(t.fecha_pago, r.desde, r.hasta); }); }

  function descontarProducto(pid, cantidad, ticket, ctx, agotados) {
    var i = inv(pid);
    var antes = num(i.existencia_actual);
    if (antes - cantidad < 0) { var p = porId(DB.productos, pid); if (p) agotados.push(p.nombre); }
    i.existencia_actual = Math.max(redondea3(antes - cantidad), 0);
    DB.movimientos_inventario.push({ id: sig('mov_inv'), producto_id: pid, tipo: 'salida_venta', cantidad: -cantidad, motivo: null, referencia_id: ticket.id, usuario_id: ctx.user.id, fecha: iso(ahora()) });
  }

  function verificarAutorizacionDescuento(pct, autorizacion, user) {
    if (pct <= 15) return user.id;
    if (!autorizacion || !autorizacion.usuario || !autorizacion.password) fallo(403, 'Este descuento supera el 15% y requiere autorización de un dueño o gerente (usuario y contraseña)');
    var a = DB.usuarios.filter(function (u) { return u.usuario === autorizacion.usuario && u.activo && (u.rol === 'dueno' || u.rol === 'gerente'); })[0];
    if (!a) fallo(403, 'Usuario de autorización no encontrado o no tiene rango suficiente');
    if (a.password !== autorizacion.password) fallo(403, 'Contraseña de autorización incorrecta');
    return a.id;
  }

  // ---------- Tabla de rutas ----------
  var RUTAS = [];
  function R(metodo, patron, fn) {
    var nombres = [];
    var rx = new RegExp('^' + patron.replace(/:([a-z_]+)/gi, function (_, n) { nombres.push(n); return '([^/]+)'; }) + '/?$');
    RUTAS.push({ metodo: metodo, rx: rx, nombres: nombres, fn: fn });
  }

  // ---------- Puerta para los módulos extra de la demo (js/demo-mock-*.js) ----------
  // Se cargan DESPUÉS de este archivo y registran sus propias rutas con R().
  window.DemoMock = {
    R: R, db: function () { return DB; }, cargar: function () { cargarDB(); return DB; }, guardar: function () { guardarDB(); },
    sig: sig, porId: porId, fallo: fallo, iso: iso, ahora: ahora, haceHoras: haceHoras, inicioDelDia: inicioDelDia,
    fechaLocalStr: fechaLocalStr, parseFechaParam: parseFechaParam, num: num, redondea: redondea, redondea3: redondea3, clonar: clonar,
    requiereAdmin: requiereAdmin, requiereRol: requiereRol, requierePermiso: requierePermiso, tienePermiso: tienePermiso, bitacora: bitacora,
    itemsDe: itemsDe, recalcTotal: recalcTotal, inv: inv, usuarioNombre: usuarioNombre, productoFila: productoFila,
    resolverRango: resolverRango, enRango: enRango, pagadosEn: pagadosEn, descontarProducto: descontarProducto, catNombre: catNombre,
    toast: function (m, t) { toastDemo(m, t); }
  };

  // ----- Auth -----
  R('POST', '/auth/login', function (c) {
    var b = c.body;
    if (!b.usuario || !b.password) fallo(400, 'Usuario y contraseña son requeridos');
    var u = DB.usuarios.filter(function (x) { return x.usuario === b.usuario && x.activo; })[0];
    if (!u || u.password !== b.password) fallo(400, 'Usuario o contraseña incorrectos. En la demo la contraseña de todos es: demo');
    c.user = u; bitacora(c, 'login', 'usuarios', u.id);
    return { token: 'demo-token-' + u.id + '-' + Date.now(), usuario: { id: u.id, nombre: u.nombre, rol: u.rol, sucursal_id: u.sucursal_id, nombre_mostrador: u.nombre_mostrador || null } };
  });
  R('PUT', '/auth/cambiar-password', function (c) {
    var b = c.body;
    if (!b.password_actual || !b.password_nueva) fallo(400, 'La contraseña actual y la nueva son requeridas');
    if (b.password_nueva.length < 6) fallo(400, 'La nueva contraseña debe tener al menos 6 caracteres');
    if (c.user.password !== b.password_actual) fallo(401, 'La contraseña actual es incorrecta');
    c.user.password = b.password_nueva; return { ok: true };
  });
  R('POST', '/auth/logout', function (c) { bitacora(c, 'logout', 'usuarios', c.user.id); return { ok: true }; });

  // ----- Configuración -----
  R('GET', '/configuracion', function () { return clonar(DB.configuracion); });
  var VALID_CONFIG = {
    ancho_ticket: function (v) { return ['58mm', '80mm'].indexOf(v) !== -1 || 'Ancho de ticket inválido'; },
    tipo_codigo_escaneo: function (v) { return ['qr', 'barras', 'ambos'].indexOf(v) !== -1 || 'Tipo de código de escaneo inválido'; },
    tamano_letra: function (v) { return ['normal', 'grande'].indexOf(v) !== -1 || 'Tamaño de letra inválido'; },
    tipo_fuente: function (v) { return ['monospace', 'sans-serif'].indexOf(v) !== -1 || 'Tipo de fuente inválido'; },
    promos_intervalo_segundos: function (v) { var n = Number(v); return (isFinite(n) && n >= 3 && n <= 120) || 'El intervalo de anuncios debe ser un número entre 3 y 120 segundos'; },
    etiqueta_modo: function (v) { return ['auto', 'sistema'].indexOf(v) !== -1 || 'Modo de etiqueta inválido'; },
    ancho_etiqueta: function (v) { return ['40mm', '50mm', '58mm'].indexOf(v) !== -1 || 'Ancho de etiqueta inválido'; },
    bascula_tipo_dato: function (v) { return ['peso', 'precio'].indexOf(v) !== -1 || 'Tipo de dato de báscula inválido'; }
  };
  R('PUT', '/configuracion', function (c) {
    requiereAdmin(c);
    Object.keys(c.body).forEach(function (k) {
      if (k === 'sucursal_id') return;
      if (VALID_CONFIG[k]) { var r = VALID_CONFIG[k](c.body[k]); if (r !== true) fallo(400, r); }
    });
    Object.keys(c.body).forEach(function (k) { if (k !== 'sucursal_id' && c.body[k] !== undefined) DB.configuracion[k] = c.body[k]; });
    bitacora(c, 'actualizar_configuracion', 'configuracion', 1);
    return clonar(DB.configuracion);
  });

  // ----- Turnos (cada cajero abre y cierra el suyo) -----
  function esSupervisor(u) { return ['jefe_general', 'dueno', 'gerente'].indexOf(u.rol) !== -1; }
  var FORMAS_PAGO = ['efectivo', 'tarjeta', 'transferencia', 'dolares', 'cheque', 'vales'];
  // Igual que construirResumenTurno() de backend/routes/turnos.js (versión 1.2.1).
  function resumenTurno(turno) {
    var tks = DB.tickets.filter(function (t) { return t.turno_id === turno.id && t.estado === 'pagado'; }).sort(function (a, b) { return a.id - b.id; });
    var formas = { efectivo: 0, tarjeta: 0, transferencia: 0, dolares: 0, cheque: 0, vales: 0, credito: 0 };
    var bruto = 0, descuentos = 0, conDesc = 0, deptos = {}, gan = 0, sinCosto = 0, descGlobal = 0, clientes = {};
    tks.forEach(function (t) {
      var descItems = 0; itemsDe(t.id).forEach(function (d) { descItems += num(d.descuento_monto); });
      var total = num(t.total), desc = num(t.descuento_monto) + descItems, neto = total - desc;
      bruto += total; descuentos += desc; if (desc > 0) conDesc++; descGlobal += num(t.descuento_monto);
      var ef = num(t.monto_efectivo), tj = num(t.monto_tarjeta);
      formas.efectivo += ef;
      if (t.metodo_pago === 'transferencia') formas.transferencia += tj;
      else if (t.metodo_pago === 'dolares') formas.dolares += tj;
      else if (t.metodo_pago === 'cheque') formas.cheque += tj;
      else if (t.metodo_pago === 'vale_despensa') formas.vales += tj;
      else if (t.metodo_pago === 'credito') formas.credito += neto;
      else formas.tarjeta += tj;
      itemsDe(t.id).forEach(function (d) {
        var p = d.producto_id ? porId(DB.productos, d.producto_id) : null;
        var nom = d.tipo === 'kit' ? 'Kits' : (p ? (catNombre(p.categoria_id) || 'Sin departamento') : 'Sin departamento');
        var neta = num(d.subtotal) - num(d.descuento_monto);
        deptos[nom] = (deptos[nom] || 0) + neta;
        if (p && num(p.precio_costo) > 0) gan += neta - num(p.precio_costo) * num(d.cantidad); else sinCosto++;
      });
      if (t.cliente_id) {
        var cl = porId(DB.clientes, t.cliente_id);
        if (cl) { var x = clientes[cl.id] || (clientes[cl.id] = { nombre: cl.nombre, ventas: 0, monto: 0 }); x.ventas++; x.monto += neto; }
      }
    });
    Object.keys(formas).forEach(function (k) { formas[k] = redondea(formas[k]); });
    var totalFormas = 0; Object.keys(formas).forEach(function (k) { totalFormas += formas[k]; });
    var dep = 0, ret = 0;
    var movs = DB.movimientos_caja.filter(function (m) { return m.turno_id === turno.id; }).sort(function (a, b) { return a.fecha < b.fecha ? -1 : 1; });
    movs.forEach(function (m) { if (m.tipo === 'ingreso') dep += num(m.monto); else ret += num(m.monto); });
    var devs = (DB.devoluciones || []).filter(function (d) { return Number(d.turno_id) === turno.id; });
    var devTotal = 0, devEf = 0; devs.forEach(function (d) { devTotal += num(d.monto_total); if (d.metodo_reembolso === 'efectivo') devEf += num(d.monto_total); });
    var abonos = DB.creditos_abono.filter(function (a) { return Number(a.turno_id) === turno.id; }).sort(function (a, b) { return a.fecha < b.fecha ? -1 : 1; });
    var abonosEf = 0; abonos.forEach(function (a) { if ((a.metodo_pago || 'efectivo') === 'efectivo') abonosEf += num(a.monto); });
    // Recargas reales y exitosas (las de modo prueba —todas las de la demo— no cuentan en el corte).
    var rec = { cantidad: 0, total: 0, cargos: 0, efectivo: 0, tarjeta: 0, recargas: 0, servicios: 0 };
    (DB.recargas_ventas || []).forEach(function (r) {
      if (r.turno_id !== turno.id || r.estado !== 'exitosa' || r.modo_prueba) return;
      rec.cantidad++; rec.total += num(r.total); rec.cargos += num(r.cargo);
      if (r.metodo_pago === 'efectivo') rec.efectivo += num(r.total); else rec.tarjeta += num(r.total);
      if (r.tipo === 'recarga') rec.recargas += num(r.monto); else rec.servicios += num(r.monto);
    });
    Object.keys(rec).forEach(function (k) { if (k !== 'cantidad') rec[k] = redondea(rec[k]); });
    var fin = turno.fecha_cierre ? new Date(turno.fecha_cierre).getTime() : Date.now();
    var canceladas = DB.tickets.filter(function (t) { var f = new Date(t.fecha_creacion).getTime(); return t.estado === 'cancelado' && f >= new Date(turno.fecha_apertura).getTime() && f <= fin; }).length;
    var ventaNeta = redondea(bruto - descuentos), n = tks.length, fondo = num(turno.fondo_inicial);
    return {
      turno: { id: turno.id, estado: turno.estado, fecha_apertura: turno.fecha_apertura, fecha_cierre: turno.fecha_cierre, cajero: usuarioNombre(turno.usuario_id), cerrado_por: turno.cerrado_por ? usuarioNombre(turno.cerrado_por) : null },
      caja: { fondo_inicial: redondea(fondo), efectivo_ventas: formas.efectivo, depositos: redondea(dep), retiros: redondea(ret),
        abonos_efectivo: redondea(abonosEf), recargas_efectivo: rec.efectivo, devoluciones_efectivo: redondea(devEf),
        salidas: redondea(Math.max(0, ret - devEf)), saldo_efectivo: redondea(fondo + formas.efectivo + dep - ret + abonosEf + rec.efectivo) },
      formas: formas, total_formas: redondea(totalFormas),
      ventas: { subtotal: redondea(bruto), descuentos: redondea(descuentos), venta_neta: ventaNeta, devoluciones: redondea(devTotal),
        ganancia: redondea(gan - descGlobal), ganancia_sin_costo: sinCosto,
        por_departamento: Object.keys(deptos).map(function (k) { return { nombre: k, monto: redondea(deptos[k]) }; }).sort(function (a, b) { return b.monto - a.monto; }) },
      cuentas: { normales: n, canceladas: canceladas, con_descuento: conDesc, promedio: n ? redondea(ventaNeta / n) : 0, folio_inicial: n ? tks[0].folio : null, folio_final: n ? tks[n - 1].folio : null },
      movimientos: movs.map(function (m) { return { tipo: m.tipo, monto: redondea(num(m.monto)), concepto: m.concepto, fecha: m.fecha, es_devolucion: m.tipo === 'egreso' && /^Devolución ticket /.test(m.concepto || '') }; }),
      recargas: rec,
      pagos_creditos: abonos.map(function (a) { var cl = porId(DB.clientes, a.cliente_id); return { cliente: cl ? cl.nombre : '', monto: redondea(num(a.monto)), metodo: a.metodo_pago || 'efectivo', fecha: a.fecha }; }),
      clientes_top: Object.keys(clientes).map(function (k) { var x = clientes[k]; return { nombre: x.nombre, ventas: x.ventas, monto: redondea(x.monto) }; }).sort(function (a, b) { return b.monto - a.monto; }).slice(0, 5),
      declaracion: turno.declaracion || null
    };
  }
  // Lo que "debería haber" por cada forma de pago al cerrar (efectivo = saldo de caja).
  function esperadoPorForma(r) {
    function abonoPor(f) { var s = 0; (r.pagos_creditos || []).forEach(function (a) { if (a.metodo === f) s += a.monto; }); return redondea(s); }
    return {
      efectivo: r.caja.saldo_efectivo,
      tarjeta: redondea(r.formas.tarjeta + abonoPor('tarjeta') + ((r.recargas && r.recargas.tarjeta) || 0)),
      transferencia: redondea(r.formas.transferencia + abonoPor('transferencia')),
      dolares: r.formas.dolares, cheque: r.formas.cheque, vales: r.formas.vales
    };
  }
  function armarDeclaracion(esperado, declarado, usd, tc) {
    var difs = {}, totD = 0, totE = 0;
    FORMAS_PAGO.forEach(function (k) { declarado[k] = redondea(declarado[k] || 0); difs[k] = redondea(declarado[k] - esperado[k]); totD += declarado[k]; totE += esperado[k]; });
    totD = redondea(totD); totE = redondea(totE);
    return { importes: declarado, dolares_usd: usd === undefined ? null : usd, tipo_cambio: tc === undefined ? null : tc, esperado: esperado, diferencias: difs, total_declarado: totD, total_esperado: totE, diferencia: redondea(totD - totE) };
  }
  // Cortes de ejemplo: cada turno cerrado con su declaración completa (como los guarda la versión 1.2.1).
  // El más reciente cuadra; el anterior tiene el caso típico: no se escribió lo de tarjeta y faltan $100 en efectivo.
  function completarCortesDeEjemplo() {
    var cerrados = DB.turnos.filter(function (t) { return t.estado === 'cerrado'; }).sort(function (a, b) { return a.fecha_apertura < b.fecha_apertura ? 1 : -1; });
    // Una salida registrada y un abono en algunos cortes, para que se vean esas secciones.
    if (cerrados[2]) DB.movimientos_caja.push({ id: sig('mov_caja'), turno_id: cerrados[2].id, usuario_id: 2, tipo: 'egreso', monto: 200, concepto: 'Pago al proveedor de tortillas', fecha: iso(new Date(new Date(cerrados[2].fecha_apertura).getTime() + 3 * 3600000)) });
    if (cerrados[1]) DB.movimientos_caja.push({ id: sig('mov_caja'), turno_id: cerrados[1].id, usuario_id: 2, tipo: 'egreso', monto: 120, concepto: 'Compra de bolsas y servilletas', fecha: iso(new Date(new Date(cerrados[1].fecha_apertura).getTime() + 5 * 3600000)) });
    cerrados.forEach(function (t, i) {
      var r = resumenTurno(t), esp = esperadoPorForma(r), dec = clonar(esp);
      var ajuste = i === 0 ? 0 : redondea(num(t.saldo_contado) - num(t.saldo_teorico));
      if (i === 1) { dec.tarjeta = 0; ajuste = -100; }      // ← el corte con "¿Por qué no cuadra?"
      dec.efectivo = redondea(esp.efectivo + ajuste);
      t.declaracion = armarDeclaracion(esp, dec);
      t.saldo_teorico = esp.efectivo; t.saldo_contado = dec.efectivo;
    });
  }

  R('GET', '/turnos/actual', function (c) {
    var t = DB.turnos.filter(function (x) { return x.estado === 'abierto' && x.usuario_id === c.user.id; }).sort(function (a, b) { return a.fecha_apertura < b.fecha_apertura ? 1 : -1; })[0];
    return t ? clonar(t) : null;
  });
  R('POST', '/turnos/abrir', function (c) {
    requierePermiso(c, 'CAJA_ABRIR');
    if (DB.turnos.some(function (t) { return t.estado === 'abierto' && t.usuario_id === c.user.id; })) fallo(400, 'Ya tienes un turno abierto');
    var t = { id: sig('turno'), sucursal_id: 1, usuario_id: c.user.id, fondo_inicial: num(c.body.fondo_inicial), estado: 'abierto', fecha_apertura: iso(ahora()), fecha_cierre: null, saldo_teorico: null, saldo_contado: null, declaracion: null, cerrado_por: null };
    DB.turnos.push(t); bitacora(c, 'abrir_turno', 'turnos', t.id, { fondo_inicial: t.fondo_inicial });
    return clonar(t);
  });
  R('POST', '/turnos/registrar-apertura-cajon', function (c) { requierePermiso(c, 'CAJA_MOVIMIENTO'); return { ok: true }; });
  R('GET', '/turnos/historial', function (c) {
    var q = c.query, desde = parseFechaParam(q.desde), hasta = parseFechaParam(q.hasta);
    var uid = esSupervisor(c.user) ? parseInt(q.usuario_id, 10) : c.user.id;
    var lim = Math.min(parseInt(q.limite, 10) || 50, 500);
    return DB.turnos.filter(function (t) {
      var f = new Date(t.fecha_apertura), dia = new Date(f.getFullYear(), f.getMonth(), f.getDate());
      if (desde && dia < desde) return false;
      if (hasta && dia > hasta) return false;
      if (uid > 0 && t.usuario_id !== uid) return false;
      if ((q.estado === 'abierto' || q.estado === 'cerrado') && t.estado !== q.estado) return false;
      return true;
    }).sort(function (a, b) { return a.fecha_apertura < b.fecha_apertura ? 1 : -1; }).slice(0, lim)
      .map(function (t) { var o = clonar(t); o.usuario_nombre = usuarioNombre(t.usuario_id); return o; });
  });
  R('GET', '/turnos/reporte', function (c) {
    var hoyS = fechaLocalStr(ahora());
    var desdeS = /^\d{4}-\d{2}-\d{2}$/.test(c.query.desde || '') ? c.query.desde : hoyS.slice(0, 8) + '01';
    var hastaS = /^\d{4}-\d{2}-\d{2}$/.test(c.query.hasta || '') ? c.query.hasta : hoyS;
    if (desdeS > hastaS) fallo(400, 'La fecha "desde" no puede ser después de "hasta"');
    var uid = esSupervisor(c.user) ? parseInt(c.query.usuario_id, 10) : c.user.id;
    var enPeriodo = function (t) { var d = fechaLocalStr(t.fecha_apertura); return d >= desdeS && d <= hastaS && (!(uid > 0) || t.usuario_id === uid); };
    var turnos = DB.turnos.filter(function (t) { return t.estado === 'cerrado' && enPeriodo(t); })
      .sort(function (a, b) { return a.fecha_apertura < b.fecha_apertura ? 1 : -1; })
      .map(function (t) {
        var r = resumenTurno(t), f = r.formas;
        var dif = t.declaracion && t.declaracion.diferencia != null ? redondea(t.declaracion.diferencia) : (t.saldo_contado != null ? redondea(num(t.saldo_contado) - num(t.saldo_teorico)) : null);
        var dec = t.declaracion || {};
        var esperado = dec.total_esperado != null ? redondea(dec.total_esperado) : (t.saldo_teorico != null ? redondea(num(t.saldo_teorico)) : null);
        var contado = dec.total_declarado != null ? redondea(dec.total_declarado) : (t.saldo_contado != null ? redondea(num(t.saldo_contado)) : null);
        return { id: t.id, usuario_id: t.usuario_id, cajero: usuarioNombre(t.usuario_id), dia: fechaLocalStr(t.fecha_apertura), esperado: esperado, contado: contado,
          fecha_apertura: t.fecha_apertura, fecha_cierre: t.fecha_cierre, tickets: r.cuentas.normales,
          efectivo: f.efectivo, tarjeta: f.tarjeta, transferencia: f.transferencia, credito: f.credito, otros: redondea(f.dolares + f.cheque + f.vales),
          descuentos: r.ventas.descuentos, venta_neta: r.ventas.venta_neta, declarado: !!t.declaracion || t.saldo_contado != null, diferencia: dif };
      });
    var abiertos = DB.turnos.filter(function (t) { return t.estado === 'abierto' && enPeriodo(t); }).length;
    return { desde: desdeS, hasta: hastaS, abiertos: abiertos, turnos: turnos };
  });
  // Suma los cortes de varios turnos en uno solo (corte del día), igual que combinarResumenes() del servidor.
  function combinarResumenes(lista, fecha) {
    function suma(f) { var s = 0; lista.forEach(function (r) { s += num(f(r)); }); return redondea(s); }
    var formas = {};
    Object.keys(lista[0].formas).forEach(function (k) { formas[k] = suma(function (r) { return r.formas[k]; }); });
    var deptos = {}, clientes = {};
    lista.forEach(function (r) { r.ventas.por_departamento.forEach(function (d) { deptos[d.nombre] = redondea((deptos[d.nombre] || 0) + d.monto); }); });
    lista.forEach(function (r) { (r.clientes_top || []).forEach(function (c) { var x = clientes[c.nombre] || (clientes[c.nombre] = { nombre: c.nombre, ventas: 0, monto: 0 }); x.ventas += c.ventas; x.monto = redondea(x.monto + c.monto); }); });
    var normales = 0; lista.forEach(function (r) { normales += r.cuentas.normales; });
    var ventaNeta = suma(function (r) { return r.ventas.venta_neta; });
    var conFolio = lista.filter(function (r) { return r.cuentas.folio_inicial; });
    var todos = lista.every(function (r) { return r.turno.estado === 'cerrado'; });
    var decls = lista.map(function (r) { return r.declaracion; }).filter(Boolean);
    var cajeros = []; lista.forEach(function (r) { if (r.turno.cajero && cajeros.indexOf(r.turno.cajero) === -1) cajeros.push(r.turno.cajero); });
    var aperturas = lista.map(function (r) { return r.turno.fecha_apertura; }).sort();
    var cierres = lista.map(function (r) { return r.turno.fecha_cierre; }).filter(Boolean).sort();
    var recargas = {};
    ['cantidad', 'total', 'cargos', 'efectivo', 'tarjeta', 'recargas', 'servicios'].forEach(function (k) { recargas[k] = k === 'cantidad' ? lista.reduce(function (x, r) { return x + ((r.recargas && r.recargas.cantidad) || 0); }, 0) : suma(function (r) { return r.recargas && r.recargas[k]; }); });
    var cajaK = ['fondo_inicial', 'efectivo_ventas', 'depositos', 'retiros', 'abonos_efectivo', 'recargas_efectivo', 'devoluciones_efectivo', 'salidas', 'saldo_efectivo'], caja = {};
    cajaK.forEach(function (k) { caja[k] = suma(function (r) { return r.caja[k]; }); });
    var movs = [], pagos = [];
    lista.forEach(function (r) { r.movimientos.forEach(function (m) { var o = clonar(m); o.cajero = r.turno.cajero; movs.push(o); }); r.pagos_creditos.forEach(function (p) { var o = clonar(p); o.cajero = r.turno.cajero; pagos.push(o); }); });
    movs.sort(function (a, b) { return new Date(a.fecha) - new Date(b.fecha); });
    return {
      turno: { id: 'DIA ' + fecha, dia: fecha, turnos: lista.length, estado: todos ? 'cerrado' : 'abierto', fecha_apertura: aperturas[0] || null,
        fecha_cierre: todos ? cierres[cierres.length - 1] : null, cajero: cajeros.length === 1 ? cajeros[0] : 'Todos los cajeros', cerrado_por: null },
      caja: caja, formas: formas, total_formas: suma(function (r) { return r.total_formas; }),
      ventas: { subtotal: suma(function (r) { return r.ventas.subtotal; }), descuentos: suma(function (r) { return r.ventas.descuentos; }), venta_neta: ventaNeta,
        devoluciones: suma(function (r) { return r.ventas.devoluciones; }), ganancia: suma(function (r) { return r.ventas.ganancia; }),
        ganancia_sin_costo: lista.reduce(function (x, r) { return x + (r.ventas.ganancia_sin_costo || 0); }, 0),
        por_departamento: Object.keys(deptos).map(function (n) { return { nombre: n, monto: deptos[n] }; }).sort(function (a, b) { return b.monto - a.monto; }) },
      cuentas: { normales: normales, canceladas: lista.reduce(function (x, r) { return x + r.cuentas.canceladas; }, 0), con_descuento: lista.reduce(function (x, r) { return x + r.cuentas.con_descuento; }, 0),
        promedio: normales ? redondea(ventaNeta / normales) : 0, folio_inicial: conFolio.length ? conFolio[0].cuentas.folio_inicial : null, folio_final: conFolio.length ? conFolio[conFolio.length - 1].cuentas.folio_final : null },
      movimientos: movs, recargas: recargas, pagos_creditos: pagos,
      clientes_top: Object.keys(clientes).map(function (k) { return clientes[k]; }).sort(function (a, b) { return b.monto - a.monto; }).slice(0, 5),
      declaracion: todos && decls.length === lista.length ? { total_declarado: suma(function (r) { return r.declaracion.total_declarado; }), total_esperado: suma(function (r) { return r.declaracion.total_esperado; }),
        diferencia: suma(function (r) { return r.declaracion.diferencia; }), importes: {}, esperado: {}, diferencias: {} } : null
    };
  }
  R('GET', '/turnos/dia', function (c) {
    var fecha = /^\d{4}-\d{2}-\d{2}$/.test(c.query.fecha || '') ? c.query.fecha : fechaLocalStr(ahora());
    var sup = esSupervisor(c.user);
    var turnos = DB.turnos.filter(function (t) { return fechaLocalStr(t.fecha_apertura) === fecha && (sup || t.usuario_id === c.user.id); })
      .sort(function (a, b) { return a.fecha_apertura < b.fecha_apertura ? -1 : 1; });
    var res = turnos.map(resumenTurno);
    var filas = res.map(function (r) {
      return { id: r.turno.id, cajero: r.turno.cajero, estado: r.turno.estado, fecha_apertura: r.turno.fecha_apertura, fecha_cierre: r.turno.fecha_cierre,
        ventas: r.cuentas.normales, total_vendido: redondea(r.total_formas - r.ventas.devoluciones),
        diferencia: r.declaracion && r.declaracion.diferencia !== undefined ? redondea(r.declaracion.diferencia) : null };
    });
    return {
      fecha: fecha, turnos: filas,
      totales: { turnos: filas.length, abiertos: filas.filter(function (f) { return f.estado === 'abierto'; }).length,
        ventas: filas.reduce(function (x, f) { return x + f.ventas; }, 0), total_vendido: redondea(filas.reduce(function (x, f) { return x + f.total_vendido; }, 0)),
        ganancia: sup ? redondea(res.reduce(function (x, r) { return x + r.ventas.ganancia; }, 0)) : null,
        diferencia: redondea(filas.reduce(function (x, f) { return x + (f.diferencia || 0); }, 0)) },
      dia: sup && res.length ? combinarResumenes(res, fecha) : null
    };
  });
  R('GET', '/turnos/:id/resumen', function (c) {
    var t = porId(DB.turnos, c.params.id);
    if (!t) fallo(404, 'Turno no encontrado');
    if (!esSupervisor(c.user) && t.usuario_id !== c.user.id) fallo(403, 'Este turno es de otro cajero');
    return resumenTurno(t);
  });
  R('POST', '/turnos/:id/cerrar', function (c) {
    requierePermiso(c, 'CAJA_CERRAR');
    var t = porId(DB.turnos, c.params.id);
    if (!t) fallo(404, 'Turno no encontrado');
    if (t.estado !== 'abierto') fallo(400, 'Este turno ya fue cerrado anteriormente');
    if (!esSupervisor(c.user) && t.usuario_id !== c.user.id) fallo(403, 'Solo el cajero de este turno (o un gerente) puede cerrarlo');
    var b = c.body || {}, entrada = b.declaracion || {};
    var declarado = { efectivo: 0, tarjeta: 0, transferencia: 0, dolares: 0, cheque: 0, vales: 0 };
    FORMAS_PAGO.forEach(function (k) {
      var v = parseFloat(k === 'efectivo' && b.declaracion === undefined ? b.saldo_contado : entrada[k]);
      if (isFinite(v)) { if (v < 0) fallo(400, 'Los importes declarados no pueden ser negativos'); declarado[k] = v; }
    });
    var usd = isFinite(parseFloat(entrada.dolares_usd)) ? parseFloat(entrada.dolares_usd) : null, tc = null;
    if (usd !== null) { tc = num(DB.configuracion.tipo_cambio_dolar); declarado.dolares = tc > 0 ? usd * tc : 0; }
    var antes = resumenTurno(t);
    t.declaracion = armarDeclaracion(esperadoPorForma(antes), declarado, usd, tc);
    var difs = t.declaracion.diferencias;
    t.estado = 'cerrado'; t.saldo_teorico = antes.caja.saldo_efectivo; t.saldo_contado = declarado.efectivo; t.fecha_cierre = iso(ahora()); t.cerrado_por = c.user.id;
    bitacora(c, 'cerrar_turno', 'turnos', t.id, { saldo_teorico: t.saldo_teorico, saldo_contado: t.saldo_contado, diferencia_total: t.declaracion.diferencia, diferencias: difs });
    var o = clonar(t);
    o.resumen = { fondo_inicial: antes.caja.fondo_inicial, ventas_efectivo: antes.caja.efectivo_ventas, ventas_tarjeta: antes.formas.tarjeta, ingresos: antes.caja.depositos, egresos: antes.caja.retiros, diferencia: t.declaracion.diferencia };
    o.corte = resumenTurno(t);
    return o;
  });

  // ----- Movimientos de caja -----
  R('POST', '/movimientos', function (c) {
    requierePermiso(c, 'CAJA_MOVIMIENTO');
    var b = c.body;
    if (!b.turno_id || !b.tipo || !b.monto) fallo(400, 'Turno, tipo y monto son requeridos');
    if (['ingreso', 'egreso'].indexOf(b.tipo) === -1) fallo(400, 'Tipo inválido');
    var m = { id: sig('mov_caja'), turno_id: parseInt(b.turno_id, 10), usuario_id: c.user.id, tipo: b.tipo, monto: num(b.monto), concepto: b.concepto || '', fecha: iso(ahora()) };
    DB.movimientos_caja.push(m); return clonar(m);
  });
  R('GET', '/movimientos/turno/:turno_id', function (c) {
    var tid = parseInt(c.params.turno_id, 10);
    return DB.movimientos_caja.filter(function (m) { return m.turno_id === tid; }).sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; })
      .map(function (m) { var o = clonar(m); o.usuario_nombre = usuarioNombre(m.usuario_id); return o; });
  });

  // ----- Productos -----
  function listaProductosActivos() {
    return DB.productos.filter(function (p) { return p.activo; }).sort(function (a, b) {
      if (a.favorito !== b.favorito) return a.favorito ? -1 : 1;
      if ((a.orden || 0) !== (b.orden || 0)) return (a.orden || 0) - (b.orden || 0);
      return a.nombre.localeCompare(b.nombre, 'es');
    });
  }
  R('GET', '/productos', function (c) {
    var todos = listaProductosActivos();
    if (c.query.limit) {
      var l = parseInt(c.query.limit, 10), o = parseInt(c.query.offset || '0', 10);
      return { productos: todos.slice(o, o + l).map(productoFila), total: todos.length };
    }
    return todos.map(productoFila);
  });
  R('GET', '/productos/categorias', function () { return clonar(DB.categorias).sort(function (a, b) { return (a.orden - b.orden) || a.nombre.localeCompare(b.nombre, 'es'); }); });
  R('GET', '/productos/sin-imagen', function () { return []; });
  R('GET', '/productos/buscar-externo/:codigo', function () { fallo(404, 'La búsqueda en la base de datos pública no está disponible en la demo'); });
  R('GET', '/productos/codigo/:codigo', function (c) {
    var cod = decodeURIComponent(c.params.codigo);
    var p = DB.productos.filter(function (x) { return x.codigo_barras === cod && x.activo; })[0];
    if (!p) fallo(404, 'No existe un producto con ese código');
    return clonar(p);
  });
  R('POST', '/productos/importar', function (c) {
    requierePermiso(c, 'PRODUCTOS_CREAR');
    if (!Array.isArray(c.body.productos) || !c.body.productos.length) fallo(400, 'No se recibieron productos para importar');
    return { creados: 0, actualizados: 0, omitidos: c.body.productos.length, errores: ['La importación masiva no está disponible en la demo'] };
  });
  R('POST', '/productos/cambiar-tipo-venta-lote', function (c) {
    requierePermiso(c, 'PRODUCTOS_EDITAR');
    var ids = c.body.producto_ids;
    if (!Array.isArray(ids) || !ids.length) fallo(400, 'Selecciona al menos un producto');
    if (['peso', 'unidad'].indexOf(c.body.tipo_venta) === -1) fallo(400, 'Tipo de venta inválido');
    var n = 0; DB.productos.forEach(function (p) { if (ids.map(Number).indexOf(p.id) !== -1) { p.tipo_venta = c.body.tipo_venta; n++; } });
    return { actualizados: n };
  });
  R('POST', '/productos/:id/actualizar-imagen-externa', function () { return { actualizado: false, motivo: 'No disponible en la demo' }; });
  function codigoEnUso(cod, exceptoId) {
    return !!cod && DB.productos.some(function (p) { return p.codigo_barras === cod && p.id !== exceptoId; });
  }
  R('POST', '/productos', function (c) {
    requierePermiso(c, 'PRODUCTOS_CREAR');
    var b = c.body;
    if (!b.nombre || !b.precio) fallo(400, 'Nombre y precio son requeridos');
    if (b.tipo_venta && ['peso', 'unidad'].indexOf(b.tipo_venta) === -1) fallo(400, 'Tipo de venta inválido');
    if (codigoEnUso(b.codigo_barras)) fallo(400, 'Ese código de barras ya está en uso');
    var p = {
      id: sig('producto'), sucursal_id: 1, categoria_id: b.categoria_id ? parseInt(b.categoria_id, 10) : null, nombre: b.nombre, precio: num(b.precio),
      imagen_url: b.imagen_url || null, favorito: !!b.favorito, orden: b.orden || 0, activo: true, codigo_barras: b.codigo_barras || null,
      tipo_venta: b.tipo_venta || 'peso', precio_costo: b.precio_costo ? num(b.precio_costo) : null, ganancia_porcentaje: b.ganancia_porcentaje ? num(b.ganancia_porcentaje) : null,
      precio_mayoreo: b.precio_mayoreo ? num(b.precio_mayoreo) : null, usa_inventario: b.usa_inventario !== false
    };
    DB.productos.push(p);
    if (p.usa_inventario && (b.existencia_inicial !== undefined || b.stock_minimo !== undefined || b.stock_maximo !== undefined)) {
      DB.inventario[p.id] = { existencia_actual: num(b.existencia_inicial), stock_minimo: num(b.stock_minimo), stock_maximo: b.stock_maximo ? num(b.stock_maximo) : null };
    }
    bitacora(c, 'crear_producto', 'productos', p.id, { nombre: p.nombre, precio: p.precio, tipo_venta: p.tipo_venta });
    return clonar(p);
  });
  R('PUT', '/productos/:id', function (c) {
    var b = c.body;
    var otros = [b.nombre, b.categoria_id, b.imagen_url, b.favorito, b.orden, b.activo, b.codigo_barras, b.tipo_venta, b.precio_costo, b.ganancia_porcentaje, b.precio_mayoreo, b.usa_inventario].some(function (x) { return x !== undefined; });
    if (otros && !tienePermiso(c.user, 'PRODUCTOS_EDITAR')) fallo(403, 'No tienes el permiso "PRODUCTOS_EDITAR" para cambiar estos datos del producto.');
    if (b.precio !== undefined && !tienePermiso(c.user, 'PRODUCTOS_PRECIO') && !tienePermiso(c.user, 'PRODUCTOS_EDITAR')) fallo(403, 'No tienes el permiso "PRODUCTOS_PRECIO" para cambiar el precio.');
    var p = porId(DB.productos, c.params.id);
    if (!p) fallo(404, 'Producto no encontrado');
    if (codigoEnUso(b.codigo_barras, p.id)) fallo(400, 'Ese código de barras ya está en uso');
    function co(campo, v, conv) { if (v !== undefined && v !== null) p[campo] = conv ? conv(v) : v; }
    co('nombre', b.nombre); co('precio', b.precio, num); co('imagen_url', b.imagen_url); co('favorito', b.favorito); co('orden', b.orden);
    co('activo', b.activo); co('tipo_venta', b.tipo_venta); co('precio_costo', b.precio_costo, num); co('ganancia_porcentaje', b.ganancia_porcentaje, num);
    co('precio_mayoreo', b.precio_mayoreo, num); co('usa_inventario', b.usa_inventario);
    p.categoria_id = b.categoria_id ? parseInt(b.categoria_id, 10) : null;
    p.codigo_barras = b.codigo_barras || null;
    bitacora(c, 'editar_producto', 'productos', p.id, { nombre: p.nombre, precio: p.precio });
    return clonar(p);
  });
  R('DELETE', '/productos/:id', function (c) {
    requiereAdmin(c);
    var p = porId(DB.productos, c.params.id); if (p) p.activo = false; return { ok: true };
  });

  // ----- Promociones -----
  R('GET', '/promociones/:producto_id', function (c) {
    var pid = parseInt(c.params.producto_id, 10);
    return clonar(DB.promociones.filter(function (p) { return p.producto_id === pid && p.activo; }).sort(function (a, b) { return a.cantidad_minima - b.cantidad_minima; }));
  });
  R('POST', '/promociones/:producto_id', function (c) {
    if (!tienePermiso(c.user, 'PRODUCTOS_PRECIO') && !tienePermiso(c.user, 'PRODUCTOS_EDITAR')) fallo(403, 'No tienes permiso para configurar promociones de precio');
    var b = c.body;
    if (!b.cantidad_minima || b.cantidad_minima <= 0 || !b.precio_promocional || b.precio_promocional <= 0) fallo(400, 'Cantidad mínima y precio promocional deben ser mayores a 0');
    var p = porId(DB.productos, c.params.producto_id);
    if (!p) fallo(404, 'Producto no encontrado');
    if (num(b.precio_promocional) >= num(p.precio)) fallo(400, 'El precio promocional debe ser menor al precio normal del producto');
    var pr = { id: sig('promocion'), producto_id: p.id, cantidad_minima: num(b.cantidad_minima), precio_promocional: num(b.precio_promocional), activo: true };
    DB.promociones.push(pr); return clonar(pr);
  });
  R('DELETE', '/promociones/escalon/:id', function (c) { var p = porId(DB.promociones, c.params.id); if (p) p.activo = false; return { ok: true }; });

  // ----- Departamentos -----
  R('GET', '/departamentos', function () { return clonar(DB.categorias).sort(function (a, b) { return (a.orden - b.orden) || a.nombre.localeCompare(b.nombre, 'es'); }); });
  R('POST', '/departamentos', function (c) {
    requierePermiso(c, 'PRODUCTOS_CREAR');
    if (!c.body.nombre) fallo(400, 'El nombre es requerido');
    var d = { id: sig('categoria'), nombre: c.body.nombre, orden: c.body.orden || 0 };
    DB.categorias.push(d); return clonar(d);
  });
  R('PUT', '/departamentos/:id', function (c) {
    requierePermiso(c, 'PRODUCTOS_EDITAR');
    var d = porId(DB.categorias, c.params.id); if (!d) fallo(404, 'Departamento no encontrado');
    if (c.body.nombre) d.nombre = c.body.nombre;
    if (c.body.orden !== undefined && c.body.orden !== null) d.orden = c.body.orden;
    return clonar(d);
  });
  R('DELETE', '/departamentos/:id', function (c) {
    requierePermiso(c, 'PRODUCTOS_EDITAR');
    var id = parseInt(c.params.id, 10);
    DB.productos.forEach(function (p) { if (p.categoria_id === id) p.categoria_id = null; });
    DB.categorias = DB.categorias.filter(function (d) { return d.id !== id; });
    return { ok: true };
  });

  // ----- Kits -----
  R('GET', '/kits', function () { return DB.kits.filter(function (k) { return k.activo; }).sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); }).map(kitFila); });
  R('GET', '/kits/codigo/:codigo', function (c) {
    var cod = decodeURIComponent(c.params.codigo);
    var k = DB.kits.filter(function (x) { return x.codigo_barras === cod && x.activo; })[0];
    if (!k) fallo(404, 'No existe un kit con ese código');
    return clonar(k);
  });
  R('POST', '/kits', function (c) {
    requiereAdmin(c);
    var b = c.body;
    if (!b.nombre || !b.precio_kit || !b.productos || !b.productos.length) fallo(400, 'Nombre, precio y al menos un producto son requeridos');
    if (b.codigo_barras && DB.kits.some(function (k) { return k.codigo_barras === b.codigo_barras; })) fallo(400, 'Ese código de barras ya está en uso');
    var k = { id: sig('kit'), sucursal_id: 1, nombre: b.nombre, precio_kit: num(b.precio_kit), imagen_url: b.imagen_url || null, codigo_barras: b.codigo_barras || null, activo: true };
    DB.kits.push(k);
    b.productos.forEach(function (p) { DB.kit_productos.push({ kit_id: k.id, producto_id: parseInt(p.producto_id, 10), cantidad: num(p.cantidad) }); });
    bitacora(c, 'crear_kit', 'kits', k.id, { nombre: k.nombre, precio_kit: k.precio_kit });
    return clonar(k);
  });
  R('DELETE', '/kits/:id', function (c) { requiereAdmin(c); var k = porId(DB.kits, c.params.id); if (k) k.activo = false; return { ok: true }; });

  // ----- Tickets -----
  function generarFolio() { return 'S1-' + Date.now().toString(36).toUpperCase().slice(-6); }
  R('POST', '/tickets', function (c) {
    requierePermiso(c, 'VENTAS_CREAR');
    var items = c.body.items;
    if (!items || !items.length) fallo(400, 'El ticket necesita al menos un producto');
    var total = 0; items.forEach(function (it) { total += num(it.cantidad) * num(it.precio_unitario); });
    var folio = generarFolio();
    while (DB.tickets.some(function (t) { return t.folio === folio; })) folio = folio + 'X';
    var t = {
      id: sig('ticket'), folio: folio, sucursal_id: 1, mostrador_usuario_id: c.user.id, cajero_usuario_id: null, estado: 'pendiente', total: redondea(total),
      descuento_monto: 0, descuento_motivo: null, descuento_autorizado_por: null, metodo_pago: null, monto_efectivo: 0, monto_tarjeta: 0, turno_id: null,
      cliente_id: null, fecha_creacion: iso(ahora()), fecha_pago: null, efectivo_recibido: null
    };
    DB.tickets.push(t);
    var guardados = items.map(function (it) {
      var tipo = it.tipo === 'kit' ? 'kit' : 'producto', sub = redondea(num(it.cantidad) * num(it.precio_unitario));
      var d = { id: sig('ticket_detalle'), ticket_id: t.id, tipo: tipo, producto_id: tipo === 'producto' ? (it.producto_id || null) : null, kit_id: tipo === 'kit' ? (it.kit_id || null) : null, nombre_producto: it.nombre_producto, cantidad: num(it.cantidad), precio_unitario: num(it.precio_unitario), subtotal: sub, descuento_monto: 0, descuento_motivo: null, cantidad_devuelta: 0 };
      DB.ticket_detalle.push(d); return d;
    });
    var o = clonar(t); o.items = clonar(guardados); return o;
  });
  R('GET', '/tickets/pendientes', function () {
    return clonar(DB.tickets.filter(function (t) { return t.estado === 'pendiente'; }).sort(function (a, b) { return a.fecha_creacion < b.fecha_creacion ? -1 : 1; }));
  });
  R('GET', '/tickets/folio/:folio', function (c) {
    var f = decodeURIComponent(c.params.folio).trim().toUpperCase();
    var t = DB.tickets.filter(function (x) { return x.folio.toUpperCase() === f; })[0];
    if (!t) fallo(404, 'Ticket no encontrado');
    return ticketConItems(t);
  });
  R('GET', '/tickets/ultimo-pagado', function () {
    var t = DB.tickets.filter(function (x) { return x.estado === 'pagado'; }).sort(function (a, b) { return a.fecha_pago < b.fecha_pago ? 1 : -1; })[0];
    if (!t) fallo(404, 'No se ha cobrado ningún ticket todavía');
    return ticketConItems(t);
  });
  R('GET', '/tickets/historial-dia', function (c) {
    var fecha = c.query.fecha || fechaLocalStr(ahora());
    var cajero = c.query.cajero_id ? parseInt(c.query.cajero_id, 10) : null;
    return DB.tickets.filter(function (t) {
      if (['pagado', 'cancelado'].indexOf(t.estado) === -1) return false;
      var f = t.fecha_pago || t.fecha_creacion;
      if (fechaLocalStr(f) !== fecha && String(f).slice(0, 10) !== fecha) return false;
      return cajero === null || t.cajero_usuario_id === cajero;
    }).sort(function (a, b) { return (a.fecha_pago || a.fecha_creacion) < (b.fecha_pago || b.fecha_creacion) ? 1 : -1; }).map(function (t) {
      return { id: t.id, folio: t.folio, total: t.total, estado: t.estado, metodo_pago: t.metodo_pago, fecha_pago: t.fecha_pago, fecha_creacion: t.fecha_creacion, cajero_nombre: usuarioNombre(t.cajero_usuario_id), num_articulos: String(itemsDe(t.id).length) };
    });
  });
  R('POST', '/tickets/:id/agregar-item', function (c) {
    requierePermiso(c, 'VENTAS_CREAR');
    var b = c.body;
    if (!b.nombre_producto || !b.cantidad || !b.precio_unitario) fallo(400, 'Faltan datos del producto a agregar');
    var t = porId(DB.tickets, c.params.id);
    if (!t || t.estado !== 'pendiente') fallo(404, 'El ticket no existe o ya no está pendiente (puede que ya se haya cobrado)');
    var tipo = b.tipo === 'kit' ? 'kit' : 'producto', sub = redondea(num(b.cantidad) * num(b.precio_unitario));
    var d = { id: sig('ticket_detalle'), ticket_id: t.id, tipo: tipo, producto_id: tipo === 'producto' ? (b.producto_id || null) : null, kit_id: tipo === 'kit' ? (b.kit_id || null) : null, nombre_producto: b.nombre_producto, cantidad: num(b.cantidad), precio_unitario: num(b.precio_unitario), subtotal: sub, descuento_monto: 0, descuento_motivo: null, cantidad_devuelta: 0 };
    DB.ticket_detalle.push(d); recalcTotal(t);
    return { ticket: clonar(t), item: clonar(d) };
  });
  R('PUT', '/tickets/item/:itemId/descuento', function (c) {
    requierePermiso(c, 'DESCUENTO_APLICAR');
    var b = c.body;
    if (!b.motivo) fallo(400, 'El motivo del descuento es obligatorio');
    if (!b.porcentaje && !b.monto) fallo(400, 'Especifica un porcentaje o un monto de descuento');
    var d = porId(DB.ticket_detalle, c.params.itemId); if (!d) fallo(404, 'Producto del ticket no encontrado');
    var t = porId(DB.tickets, d.ticket_id);
    if (t.estado !== 'pendiente') fallo(400, 'El ticket ya no está pendiente');
    var desc = b.porcentaje ? num(d.subtotal) * (num(b.porcentaje) / 100) : num(b.monto);
    if (desc <= 0 || desc > num(d.subtotal)) fallo(400, 'El descuento debe ser mayor a 0 y no puede superar el subtotal de ese producto');
    verificarAutorizacionDescuento(desc / num(d.subtotal) * 100, b.autorizacion, c.user);
    d.descuento_monto = redondea(desc); d.descuento_motivo = b.motivo;
    return { ok: true, descuento_monto: d.descuento_monto };
  });
  R('PUT', '/tickets/item/:itemId', function (c) {
    var cant = num(c.body.cantidad);
    if (!cant || cant <= 0) fallo(400, 'Cantidad inválida');
    var d = porId(DB.ticket_detalle, c.params.itemId); if (!d) fallo(404, 'Item no encontrado');
    d.cantidad = cant; d.subtotal = redondea(cant * num(d.precio_unitario));
    var t = porId(DB.tickets, d.ticket_id); return { ok: true, nuevo_total: recalcTotal(t) };
  });
  R('DELETE', '/tickets/item/:itemId', function (c) {
    var d = porId(DB.ticket_detalle, c.params.itemId); if (!d) fallo(404, 'Item no encontrado');
    DB.ticket_detalle = DB.ticket_detalle.filter(function (x) { return x.id !== d.id; });
    var t = porId(DB.tickets, d.ticket_id); return { ok: true, nuevo_total: recalcTotal(t) };
  });
  R('PUT', '/tickets/:id/descuento', function (c) {
    requierePermiso(c, 'DESCUENTO_APLICAR');
    var b = c.body;
    if (!b.motivo) fallo(400, 'El motivo del descuento es obligatorio');
    if (!b.porcentaje && !b.monto) fallo(400, 'Especifica un porcentaje o un monto de descuento');
    var t = porId(DB.tickets, c.params.id);
    if (!t || t.estado !== 'pendiente') fallo(404, 'Ticket no encontrado o ya no está pendiente');
    var desc = b.porcentaje ? num(t.total) * (num(b.porcentaje) / 100) : num(b.monto);
    if (desc <= 0 || desc > num(t.total)) fallo(400, 'El descuento debe ser mayor a 0 y no puede superar el total del ticket');
    var autor = verificarAutorizacionDescuento(desc / num(t.total) * 100, b.autorizacion, c.user);
    t.descuento_monto = redondea(desc); t.descuento_motivo = b.motivo; t.descuento_autorizado_por = autor;
    bitacora(c, 'aplicar_descuento', 'tickets', t.id, { descuento_monto: t.descuento_monto, motivo: b.motivo });
    return { ok: true, descuento_monto: t.descuento_monto, total_final: num(t.total) - t.descuento_monto };
  });
  R('POST', '/tickets/:id/pagar', function (c) {
    var b = c.body;
    if (b.metodo_pago === 'credito' && !b.cliente_id) fallo(400, 'Selecciona un cliente para autorizar el fiado');
    var t = porId(DB.tickets, c.params.id);
    if (!t || t.estado !== 'pendiente') fallo(409, 'Este ticket ya fue pagado, cancelado, o no existe');
    var items = itemsDe(t.id), descItems = 0;
    items.forEach(function (d) { descItems += num(d.descuento_monto); });
    var neto = redondea(num(t.total) - num(t.descuento_monto) - descItems);
    var cli = null;
    if (b.metodo_pago === 'credito') {
      cli = porId(DB.clientes, b.cliente_id);
      if (!cli) fallo(404, 'Cliente no encontrado');
      if (num(cli.saldo_actual) + neto > num(cli.limite_credito)) fallo(400, 'Límite de crédito excedido. Saldo actual: $' + cli.saldo_actual + ', límite: $' + cli.limite_credito);
    }
    t.estado = 'pagado'; t.cajero_usuario_id = c.user.id; t.metodo_pago = b.metodo_pago; t.monto_efectivo = num(b.monto_efectivo); t.monto_tarjeta = num(b.monto_tarjeta);
    t.turno_id = b.turno_id || null; t.cliente_id = b.metodo_pago === 'credito' ? parseInt(b.cliente_id, 10) : null; t.fecha_pago = iso(ahora()); t.efectivo_recibido = b.efectivo_recibido || null;
    if (cli) {
      DB.creditos_cargo.push({ id: sig('cargo'), cliente_id: cli.id, ticket_id: t.id, monto: neto, autorizado_por: c.user.id, fecha: iso(ahora()) });
      cli.saldo_actual = redondea(num(cli.saldo_actual) + neto);
    }
    var agotados = [];
    items.forEach(function (it) {
      if (it.tipo === 'producto' && it.producto_id) descontarProducto(it.producto_id, num(it.cantidad), t, c, agotados);
      else if (it.tipo === 'kit' && it.kit_id) {
        DB.kit_productos.filter(function (kp) { return kp.kit_id === it.kit_id; }).forEach(function (kp) { descontarProducto(kp.producto_id, num(kp.cantidad) * num(it.cantidad), t, c, agotados); });
      }
    });
    bitacora(c, 'cobrar_ticket', 'tickets', t.id, { folio: t.folio, total: t.total, metodo_pago: t.metodo_pago });
    var o = clonar(t); o.total_neto = neto; o.productos_agotados = agotados.filter(function (x, i) { return agotados.indexOf(x) === i; });
    return o;
  });
  R('POST', '/tickets/:id/cancelar', function (c) {
    requierePermiso(c, 'VENTAS_CANCELAR');
    var t = porId(DB.tickets, c.params.id);
    if (t && t.estado === 'pendiente') { t.estado = 'cancelado'; bitacora(c, 'cancelar_ticket', 'tickets', t.id, { folio: t.folio, motivo: c.body.motivo || 'Sin motivo especificado' }); }
    return { ok: true };
  });

  // ----- Fichas (turnos de espera) -----
  function fichasHoy() { var h = fechaLocalStr(ahora()); return DB.fichas.filter(function (f) { return fechaLocalStr(f.fecha_creacion) === h; }); }
  function limpiarFichasViejas() {
    var h = fechaLocalStr(ahora());
    DB.fichas.forEach(function (f) { if (f.estado === 'esperando' && fechaLocalStr(f.fecha_creacion) < h) f.estado = 'cancelado'; });
  }
  R('POST', '/fichas', function () {
    limpiarFichasViejas();
    var max = 0; fichasHoy().forEach(function (f) { if (f.numero > max) max = f.numero; });
    var f = { id: sig('ficha'), sucursal_id: 1, numero: max + 1, estado: 'esperando', mostrador_asignado: null, fecha_creacion: iso(ahora()), fecha_llamado: null };
    DB.fichas.push(f); return clonar(f);
  });
  R('GET', '/fichas/ultima', function () {
    var l = fichasHoy().sort(function (a, b) { return a.fecha_creacion < b.fecha_creacion ? 1 : -1; })[0];
    if (!l) fallo(404, 'No se ha generado ninguna ficha hoy');
    return clonar(l);
  });
  R('GET', '/fichas/actual', function () {
    var l = DB.fichas.filter(function (f) { return f.estado === 'llamado'; }).sort(function (a, b) { return a.fecha_llamado < b.fecha_llamado ? 1 : -1; })[0];
    return l ? clonar(l) : null;
  });
  R('GET', '/fichas/recientes', function () {
    return clonar(DB.fichas.filter(function (f) { return f.estado === 'llamado' || f.estado === 'atendido'; }).sort(function (a, b) { return a.fecha_llamado < b.fecha_llamado ? 1 : -1; }).slice(0, 8));
  });
  R('GET', '/fichas/pendientes-count', function () { return { total: fichasHoy().filter(function (f) { return f.estado === 'esperando'; }).length }; });
  R('POST', '/fichas/llamar-siguiente', function (c) {
    if (!c.body.mostrador) fallo(400, 'Especifica qué mostrador está llamando');
    limpiarFichasViejas();
    var s = DB.fichas.filter(function (f) { return f.estado === 'esperando'; }).sort(function (a, b) { return a.fecha_creacion < b.fecha_creacion ? -1 : 1; })[0];
    if (!s) fallo(404, 'No hay turnos esperando en este momento');
    // La ficha que estaba "llamada" pasa a "atendida" para el historial
    DB.fichas.forEach(function (f) { if (f.estado === 'llamado') f.estado = 'atendido'; });
    s.estado = 'llamado'; s.mostrador_asignado = c.body.mostrador; s.fecha_llamado = iso(ahora());
    return clonar(s);
  });

  // ----- Clientes -----
  R('GET', '/clientes', function (c) {
    var todos = DB.clientes.filter(function (x) { return x.activo; }).sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
    if (c.query.limit) {
      var l = parseInt(c.query.limit, 10), o = parseInt(c.query.offset || '0', 10);
      return { clientes: clonar(todos.slice(o, o + l)), total: todos.length };
    }
    return clonar(todos);
  });
  R('GET', '/clientes/buscar/:texto', function (c) {
    var q = decodeURIComponent(c.params.texto).toLowerCase();
    return clonar(DB.clientes.filter(function (x) { return x.activo && x.nombre.toLowerCase().indexOf(q) !== -1; }).sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); }).slice(0, 10));
  });
  R('POST', '/clientes', function (c) {
    requierePermiso(c, 'CLIENTES_CREAR');
    if (!c.body.nombre) fallo(400, 'El nombre es requerido');
    var cl = { id: sig('cliente'), sucursal_id: 1, nombre: c.body.nombre, telefono: c.body.telefono || null, limite_credito: num(c.body.limite_credito), saldo_actual: 0, activo: true };
    DB.clientes.push(cl); bitacora(c, 'crear_cliente', 'clientes', cl.id, { nombre: cl.nombre });
    return clonar(cl);
  });
  R('GET', '/clientes/:id/estado-cuenta', function (c) {
    var cl = porId(DB.clientes, c.params.id); if (!cl) fallo(404, 'Cliente no encontrado');
    var cargos = DB.creditos_cargo.filter(function (x) { return x.cliente_id === cl.id; }).sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; })
      .map(function (x) { var o = clonar(x); var t = porId(DB.tickets, x.ticket_id); o.folio = t ? t.folio : null; return o; });
    var abonos = DB.creditos_abono.filter(function (x) { return x.cliente_id === cl.id; }).sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; });
    return { cliente: clonar(cl), cargos: cargos, abonos: clonar(abonos) };
  });
  R('POST', '/clientes/:id/abono', function (c) {
    requierePermiso(c, 'CREDITO_ABONO');
    var m = num(c.body.monto);
    if (!m || m <= 0) fallo(400, 'Monto inválido');
    var cl = porId(DB.clientes, c.params.id); if (!cl) fallo(404, 'Cliente no encontrado');
    DB.creditos_abono.push({ id: sig('abono'), cliente_id: cl.id, monto: m, metodo_pago: c.body.metodo_pago || 'efectivo', turno_id: c.body.turno_id || null, recibido_por: c.user.id, fecha: iso(ahora()) });
    cl.saldo_actual = redondea(num(cl.saldo_actual) - m);
    bitacora(c, 'abono_cliente', 'clientes', cl.id, { monto: m });
    return clonar(cl);
  });
  R('PUT', '/clientes/:id', function (c) {
    requiereAdmin(c);
    var cl = porId(DB.clientes, c.params.id); if (!cl) fallo(404, 'Cliente no encontrado');
    var b = c.body;
    if (b.nombre) cl.nombre = b.nombre;
    if (b.telefono) cl.telefono = b.telefono;
    if (b.limite_credito !== undefined && b.limite_credito !== null) cl.limite_credito = num(b.limite_credito);
    if (b.activo !== undefined && b.activo !== null) cl.activo = !!b.activo;
    return clonar(cl);
  });

  // ----- Inventario -----
  function filaInv(p) {
    var i = inv(p.id);
    return { producto_id: p.id, nombre: p.nombre, tipo_venta: p.tipo_venta, imagen_url: p.imagen_url, codigo_barras: p.codigo_barras, precio_costo: p.precio_costo, precio: p.precio, precio_mayoreo: p.precio_mayoreo, existencia_actual: num(i.existencia_actual), stock_minimo: num(i.stock_minimo) };
  }
  R('GET', '/inventario/valorizado', function (c) {
    requierePermiso(c, 'INVENTARIO_VER');
    var filas = listaProductosActivos().sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); }).map(function (p) {
      var ex = num(inv(p.id).existencia_actual), cp = costoPromedio(p.id);
      return { producto_id: p.id, nombre: p.nombre, tipo_venta: p.tipo_venta, precio: p.precio, existencia_actual: ex, costo_promedio: cp || null, valor_costo: cp ? ex * cp : null, valor_venta_potencial: ex * num(p.precio) };
    });
    var tc = 0, tv = 0; filas.forEach(function (r) { tc += r.valor_costo || 0; tv += r.valor_venta_potencial; });
    return { productos: filas, totales: { valor_costo: tc, valor_venta_potencial: tv, margen_potencial: tv - tc } };
  });
  R('GET', '/inventario/reporte', function (c) {
    requierePermiso(c, 'INVENTARIO_VER');
    var cat = c.query.categoria_id ? parseInt(c.query.categoria_id, 10) : null;
    var filas = listaProductosActivos().filter(function (p) { return p.usa_inventario && (cat === null || p.categoria_id === cat); })
      .sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); }).map(function (p) {
        var i = inv(p.id);
        return { id: p.id, codigo_barras: p.codigo_barras, nombre: p.nombre, precio_costo: p.precio_costo, precio: p.precio, categoria_id: p.categoria_id, tipo_venta: p.tipo_venta, categoria_nombre: catNombre(p.categoria_id), existencia: num(i.existencia_actual), stock_minimo: num(i.stock_minimo), stock_maximo: num(i.stock_maximo) };
      });
    var ct = 0, qt = 0; filas.forEach(function (r) { ct += r.precio_costo ? num(r.precio_costo) * r.existencia : 0; qt += r.existencia; });
    return { productos: filas, totales: { costo_total: ct, cantidad_total: qt } };
  });
  R('GET', '/inventario', function (c) {
    requierePermiso(c, 'INVENTARIO_VER');
    return listaProductosActivos().sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); }).map(filaInv);
  });
  R('GET', '/inventario/alertas', function () {
    return listaProductosActivos().filter(function (p) { var i = inv(p.id); return num(i.existencia_actual) <= num(i.stock_minimo); })
      .map(function (p) { var i = inv(p.id); return { producto_id: p.id, nombre: p.nombre, existencia_actual: num(i.existencia_actual), stock_minimo: num(i.stock_minimo) }; });
  });
  R('POST', '/inventario/ajuste', function (c) {
    var b = c.body;
    if (!b.producto_id || !b.cantidad || b.cantidad <= 0) fallo(400, 'Producto y cantidad son requeridos');
    if (['merma', 'ajuste_manual', 'entrada_manual'].indexOf(b.tipo) === -1) fallo(400, 'Tipo de ajuste inválido');
    var perm = b.tipo === 'merma' ? 'INVENTARIO_MERMA' : 'INVENTARIO_AJUSTAR';
    if (!tienePermiso(c.user, perm)) fallo(403, 'No tienes el permiso "' + perm + '" para esta acción. Pide a tu gerente que te lo asigne en Equipo.');
    var pid = parseInt(b.producto_id, 10), p = porId(DB.productos, pid);
    var signed = b.tipo === 'entrada_manual' ? num(b.cantidad) : -num(b.cantidad);
    var i = inv(pid); i.existencia_actual = Math.max(redondea3(num(i.existencia_actual) + signed), 0);
    DB.movimientos_inventario.push({ id: sig('mov_inv'), producto_id: pid, tipo: b.tipo, cantidad: signed, motivo: b.motivo || null, referencia_id: null, usuario_id: c.user.id, fecha: iso(ahora()) });
    if (p && b.tipo === 'entrada_manual') {
      if (b.precio_costo) p.precio_costo = num(b.precio_costo);
      if (b.precio) p.precio = num(b.precio);
      if (b.precio_mayoreo) p.precio_mayoreo = num(b.precio_mayoreo);
    }
    bitacora(c, b.tipo === 'merma' ? 'registrar_merma' : (b.tipo === 'entrada_manual' ? 'entrada_manual_inventario' : 'ajustar_inventario'), 'inventario', pid, { cantidad: b.cantidad, motivo: b.motivo });
    return { ok: true };
  });
  R('PUT', '/inventario/:producto_id/minimo', function (c) {
    requiereAdmin(c);
    var i = inv(parseInt(c.params.producto_id, 10));
    if (c.body.stock_minimo !== undefined && c.body.stock_minimo !== null) i.stock_minimo = num(c.body.stock_minimo);
    if (c.body.stock_maximo !== undefined && c.body.stock_maximo !== null) i.stock_maximo = num(c.body.stock_maximo);
    return { ok: true };
  });
  R('GET', '/inventario/:producto_id/movimientos', function (c) {
    var pid = parseInt(c.params.producto_id, 10);
    return DB.movimientos_inventario.filter(function (m) { return m.producto_id === pid; }).sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; }).slice(0, 50)
      .map(function (m) { var o = clonar(m); o.usuario_nombre = usuarioNombre(m.usuario_id); return o; });
  });

  // ----- Dashboard -----
  function stockBajoYAgotados() {
    var bajo = [], ago = [];
    listaProductosActivos().forEach(function (p) {
      var i = inv(p.id), ex = num(i.existencia_actual), mn = num(i.stock_minimo);
      if (ex <= 0) ago.push({ nombre: p.nombre, existencia_actual: ex });
      else if (ex <= mn) bajo.push({ nombre: p.nombre, existencia_actual: ex, stock_minimo: mn });
    });
    bajo.sort(function (a, b) { return a.existencia_actual - b.existencia_actual; });
    ago.sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
    return { bajo: bajo.slice(0, 10), ago: ago.slice(0, 10) };
  }
  function utilidad(tickets) {
    var vp = 0, ce = 0;
    tickets.forEach(function (t) { itemsDe(t.id).forEach(function (d) { if (d.tipo === 'producto') { vp += num(d.subtotal); ce += num(d.cantidad) * (d.producto_id ? costoPromedio(d.producto_id) : 0); } }); });
    return { ventas_productos: vp, costo_estimado: ce, ganancia: vp - ce };
  }
  R('GET', '/dashboard/resumen', function () {
    var ini = inicioDelDia(), r = { desde: ini, hasta: new Date(ini.getTime() + 86400000) };
    var hoy = pagadosEn(r), tot = 0; hoy.forEach(function (t) { tot += num(t.total); });
    var horas = {}; hoy.forEach(function (t) { var h = new Date(t.fecha_pago).getHours(); horas[h] = (horas[h] || 0) + num(t.total); });
    var porHora = Object.keys(horas).map(Number).sort(function (a, b) { return a - b; }).map(function (h) { return { hora: String(h), total: String(redondea(horas[h])) }; });
    var fiado = 0; DB.clientes.forEach(function (c) { if (c.activo) fiado += num(c.saldo_actual); });
    var sb = stockBajoYAgotados();
    var cerca = DB.clientes.filter(function (c) { return c.activo && num(c.limite_credito) > 0 && num(c.saldo_actual) >= num(c.limite_credito) * 0.9; })
      .map(function (c) { return { nombre: c.nombre, saldo_actual: c.saldo_actual, limite_credito: c.limite_credito }; });
    var act = [];
    DB.tickets.filter(function (t) { return t.estado === 'pagado'; }).forEach(function (t) { act.push({ tipo: 'venta', referencia: t.folio, monto: t.total, fecha: t.fecha_pago }); });
    DB.compras.forEach(function (c) { var pr = porId(DB.proveedores, c.proveedor_id); act.push({ tipo: 'compra', referencia: pr ? pr.nombre : '', monto: c.total, fecha: c.fecha }); });
    DB.creditos_abono.forEach(function (a) { var cl = porId(DB.clientes, a.cliente_id); act.push({ tipo: 'abono', referencia: cl ? cl.nombre : '', monto: a.monto, fecha: a.fecha }); });
    DB.movimientos_inventario.filter(function (m) { return m.tipo === 'merma' || m.tipo === 'ajuste_manual'; }).forEach(function (m) { var p = porId(DB.productos, m.producto_id); act.push({ tipo: m.tipo, referencia: p ? p.nombre : '', monto: m.cantidad, fecha: m.fecha }); });
    act.sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; });
    return {
      ventas_hoy: { total: String(redondea(tot)), num_tickets: String(hoy.length) },
      utilidad_hoy: utilidad(hoy), ventas_por_hora: porHora, fiado_total: fiado,
      stock_bajo: sb.bajo, agotados: sb.ago, creditos_cerca_limite: cerca, actividad_reciente: act.slice(0, 15)
    };
  });
  R('GET', '/dashboard/general', function (c) { requiereRol(c, ['jefe_general']); return { sucursales: [], totales: { ventas_hoy: 0, tickets_hoy: 0, fiado_total: 0, stock_bajo_count: 0, agotados_count: 0 } }; });

  // ----- Reportes -----
  function textoNum(o) { var x = {}; Object.keys(o).forEach(function (k) { x[k] = (typeof o[k] === 'number') ? String(redondea(o[k])) : o[k]; }); return x; }
  R('GET', '/reportes/ventas', function (c) {
    requierePermiso(c, 'REPORTES_VER');
    var r = resolverRango(c.query), ts = pagadosEn(r), total = 0;
    var met = {}; ts.forEach(function (t) { total += num(t.total); var k = t.metodo_pago || 'otro'; met[k] = met[k] || { metodo_pago: k, total: 0, num_tickets: 0 }; met[k].total += num(t.total); met[k].num_tickets++; });
    var cat = {}, top = {};
    ts.forEach(function (t) {
      itemsDe(t.id).forEach(function (d) {
        var p = d.producto_id ? porId(DB.productos, d.producto_id) : null, cn = (p && catNombre(p.categoria_id)) || 'Sin categoría';
        cat[cn] = (cat[cn] || 0) + num(d.subtotal);
        top[d.nombre_producto] = top[d.nombre_producto] || { nombre_producto: d.nombre_producto, cantidad_total: 0, monto_total: 0 };
        top[d.nombre_producto].cantidad_total += num(d.cantidad); top[d.nombre_producto].monto_total += num(d.subtotal);
      });
    });
    var emp = {}; ts.forEach(function (t) { var n = usuarioNombre(t.cajero_usuario_id) || 'Sin cajero'; emp[n] = emp[n] || { empleado: n, total: 0, num_tickets: 0 }; emp[n].total += num(t.total); emp[n].num_tickets++; });
    var u = utilidad(ts);
    u.nota = 'Aproximación con costo promedio de compras; no incluye componentes de Kits.';
    return {
      rango: { desde: iso(r.desde), hasta: iso(r.hasta) },
      total_general: { total: String(redondea(total)), num_tickets: String(ts.length) },
      por_metodo_pago: Object.keys(met).map(function (k) { return textoNum(met[k]); }),
      por_categoria: Object.keys(cat).map(function (k) { return { categoria: k, total: String(redondea(cat[k])) }; }).sort(function (a, b) { return b.total - a.total; }),
      por_empleado: Object.keys(emp).map(function (k) { return textoNum(emp[k]); }).sort(function (a, b) { return b.total - a.total; }),
      top_productos: Object.keys(top).map(function (k) { return textoNum(top[k]); }).sort(function (a, b) { return b.monto_total - a.monto_total; }).slice(0, 10),
      ganancia_estimada: u
    };
  });
  R('GET', '/reportes/ventas/exportar-csv', function (c) {
    requierePermiso(c, 'REPORTES_VER');
    var r = resolverRango(c.query);
    var filas = pagadosEn(r).sort(function (a, b) { return a.fecha_pago < b.fecha_pago ? -1 : 1; }).map(function (t) {
      return [t.folio, t.fecha_pago, t.metodo_pago, t.total, t.descuento_monto || 0, usuarioNombre(t.cajero_usuario_id) || ''].join(',');
    });
    return { __texto: 'Folio,Fecha,Metodo de Pago,Total,Descuento,Cajero\n' + filas.join('\n'), __tipo: 'text/csv' };
  });
  R('GET', '/reportes/compras', function (c) {
    requierePermiso(c, 'REPORTES_VER');
    var r = resolverRango(c.query), cs = DB.compras.filter(function (x) { return enRango(x.fecha, r.desde, r.hasta); }), tot = 0, pp = {};
    cs.forEach(function (x) { tot += num(x.total); var pr = porId(DB.proveedores, x.proveedor_id), n = pr ? pr.nombre : '?'; pp[n] = pp[n] || { proveedor: n, total: 0, num_compras: 0 }; pp[n].total += num(x.total); pp[n].num_compras++; });
    return { total_general: { total: String(tot), num_compras: String(cs.length) }, por_proveedor: Object.keys(pp).map(function (k) { return textoNum(pp[k]); }).sort(function (a, b) { return b.total - a.total; }), evolucion_costo: [] };
  });
  R('GET', '/reportes/clientes', function (c) {
    requierePermiso(c, 'REPORTES_VER');
    var r = resolverRango(c.query), deuda = 0; DB.clientes.forEach(function (x) { if (x.activo) deuda += num(x.saldo_actual); });
    var ab = DB.creditos_abono.filter(function (a) { return enRango(a.fecha, r.desde, r.hasta); }), at = 0; ab.forEach(function (a) { at += num(a.monto); });
    var fr = {}; pagadosEn(r).forEach(function (t) { if (!t.cliente_id) return; var cl = porId(DB.clientes, t.cliente_id); if (!cl) return; fr[cl.nombre] = fr[cl.nombre] || { nombre: cl.nombre, num_tickets: 0, total_comprado: 0 }; fr[cl.nombre].num_tickets++; fr[cl.nombre].total_comprado += num(t.total); });
    return {
      deuda_activa_total: deuda,
      mayor_deuda: DB.clientes.filter(function (x) { return x.activo && num(x.saldo_actual) > 0; }).sort(function (a, b) { return b.saldo_actual - a.saldo_actual; }).map(function (x) { return { nombre: x.nombre, saldo_actual: x.saldo_actual, limite_credito: x.limite_credito }; }),
      abonos_rango: { total: String(at), num_abonos: String(ab.length) },
      mas_frecuentes: Object.keys(fr).map(function (k) { return textoNum(fr[k]); }).sort(function (a, b) { return b.num_tickets - a.num_tickets; })
    };
  });

  // ----- Compras / proveedores -----
  R('GET', '/proveedores', function () { return clonar(DB.proveedores.filter(function (p) { return p.activo; }).sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); })); });
  R('POST', '/proveedores', function (c) {
    requiereAdmin(c);
    if (!c.body.nombre) fallo(400, 'El nombre es requerido');
    var p = { id: sig('proveedor'), sucursal_id: 1, nombre: c.body.nombre, contacto: c.body.contacto || null, telefono: c.body.telefono || null, activo: true };
    DB.proveedores.push(p); return clonar(p);
  });
  R('DELETE', '/proveedores/:id', function (c) { requiereAdmin(c); var p = porId(DB.proveedores, c.params.id); if (p) p.activo = false; return { ok: true }; });
  R('GET', '/compras', function () {
    return DB.compras.slice().sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; }).slice(0, 50).map(function (x) { var o = clonar(x); var p = porId(DB.proveedores, x.proveedor_id); o.proveedor_nombre = p ? p.nombre : null; return o; });
  });
  R('POST', '/compras', function (c) {
    requiereAdmin(c);
    var b = c.body;
    if (!b.proveedor_id || !b.items || !b.items.length) fallo(400, 'Proveedor y al menos un producto son requeridos');
    var total = 0; b.items.forEach(function (it) { total += num(it.cantidad) * num(it.costo_unitario); });
    var cp = { id: sig('compra'), sucursal_id: 1, proveedor_id: parseInt(b.proveedor_id, 10), usuario_id: c.user.id, total: redondea(total), fecha: iso(ahora()) };
    DB.compras.push(cp);
    b.items.forEach(function (it) {
      var pid = parseInt(it.producto_id, 10), cant = num(it.cantidad);
      DB.compra_detalle.push({ id: sig('compra_detalle'), compra_id: cp.id, producto_id: pid, cantidad: cant, costo_unitario: num(it.costo_unitario), precio_venta_nuevo: it.precio_venta_nuevo || null, subtotal: redondea(cant * num(it.costo_unitario)) });
      var p = porId(DB.productos, pid); if (p && it.precio_venta_nuevo) p.precio = num(it.precio_venta_nuevo);
      var i = inv(pid); i.existencia_actual = redondea3(num(i.existencia_actual) + cant);
      DB.movimientos_inventario.push({ id: sig('mov_inv'), producto_id: pid, tipo: 'entrada_compra', cantidad: cant, motivo: null, referencia_id: cp.id, usuario_id: c.user.id, fecha: iso(ahora()) });
    });
    bitacora(c, 'registrar_compra', 'compras', cp.id, { total: cp.total });
    return clonar(cp);
  });

  // ----- Equipo -----
  function usuarioPublico(u) {
    return { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, permisos: u.permisos, activo: u.activo, creado_en: u.creado_en, nombre_mostrador: u.nombre_mostrador, permisos_efectivos: TODOS_PERMISOS.filter(function (p) { return tienePermiso(u, p); }) };
  }
  R('GET', '/usuarios', function (c) { requiereAdmin(c); return DB.usuarios.map(usuarioPublico); });
  R('POST', '/usuarios', function (c) {
    requiereAdmin(c);
    var b = c.body;
    if (!b.nombre || !b.usuario || !b.password || !b.rol) fallo(400, 'Todos los campos son requeridos');
    if (['gerente', 'cajero', 'mostrador'].indexOf(b.rol) === -1) fallo(400, 'Rol inválido');
    if (b.password.length < 6) fallo(400, 'La contraseña debe tener al menos 6 caracteres');
    if (DB.usuarios.some(function (u) { return u.usuario === b.usuario; })) fallo(400, 'Ese nombre de usuario ya está en uso');
    var u = { id: sig('usuario'), sucursal_id: 1, nombre: b.nombre, usuario: b.usuario, password: b.password, rol: b.rol, permisos: {}, activo: true, creado_en: iso(ahora()), nombre_mostrador: null };
    DB.usuarios.push(u); return usuarioPublico(u);
  });
  R('PUT', '/usuarios/:id/restablecer-password', function (c) {
    requiereAdmin(c);
    if (!c.body.password_nueva || c.body.password_nueva.length < 6) fallo(400, 'La nueva contraseña debe tener al menos 6 caracteres');
    var u = porId(DB.usuarios, c.params.id); if (!u) fallo(404, 'Empleado no encontrado');
    if (u.rol === 'dueno') fallo(403, 'No se puede restablecer la contraseña del dueño desde aquí');
    u.password = c.body.password_nueva; return { ok: true };
  });
  R('PUT', '/usuarios/:id', function (c) {
    requiereAdmin(c);
    var b = c.body;
    if (b.rol && ['gerente', 'cajero', 'mostrador'].indexOf(b.rol) === -1) fallo(400, 'Rol inválido');
    var u = porId(DB.usuarios, c.params.id); if (!u) fallo(404, 'Empleado no encontrado');
    if (u.rol === 'dueno') fallo(403, 'No se puede modificar al usuario dueño desde aquí');
    if (b.nombre) u.nombre = b.nombre;
    if (b.rol) u.rol = b.rol;
    if (b.activo !== undefined && b.activo !== null) u.activo = !!b.activo;
    if (b.permisos) u.permisos = Object.assign({}, u.permisos || {}, b.permisos);
    if (b.nombre_mostrador !== undefined) u.nombre_mostrador = b.nombre_mostrador || null;
    return { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, activo: u.activo, permisos: u.permisos, nombre_mostrador: u.nombre_mostrador };
  });

  // ----- Devoluciones -----
  R('GET', '/devoluciones', function () {
    return DB.devoluciones.slice().sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; }).slice(0, 50).map(function (d) { var o = clonar(d); var t = porId(DB.tickets, d.ticket_id); o.folio = t ? t.folio : null; o.usuario_nombre = usuarioNombre(d.usuario_id); return o; });
  });
  R('POST', '/devoluciones', function (c) {
    requierePermiso(c, 'VENTAS_DEVOLVER');
    var b = c.body;
    if (!b.ticket_id || !b.items || !b.items.length || !b.metodo_reembolso) fallo(400, 'Ticket, items y método de reembolso son requeridos');
    if (['efectivo', 'ajuste_credito', 'sin_reembolso'].indexOf(b.metodo_reembolso) === -1) fallo(400, 'Método de reembolso inválido');
    var t = porId(DB.tickets, b.ticket_id);
    if (!t || t.estado !== 'pagado') fallo(404, 'Ticket no encontrado o no está pagado');
    if (b.metodo_reembolso === 'ajuste_credito' && t.metodo_pago !== 'credito') fallo(400, 'Solo se puede ajustar crédito si el ticket original fue Fiado');
    if (b.metodo_reembolso === 'efectivo' && !b.turno_id) fallo(400, 'Se necesita un turno de caja abierto para reembolsar en efectivo');
    var monto = 0, d = { id: sig('devolucion'), ticket_id: t.id, turno_id: b.turno_id || null, usuario_id: c.user.id, motivo: b.motivo || null, monto_total: 0, metodo_reembolso: b.metodo_reembolso, fecha: iso(ahora()) };
    var lineas = b.items.map(function (it) {
      var det = porId(DB.ticket_detalle, it.ticket_detalle_id);
      if (!det || det.ticket_id !== t.id) fallo(404, 'Línea de ticket ' + it.ticket_detalle_id + ' no encontrada');
      var disp = num(det.cantidad) - num(det.cantidad_devuelta), cant = num(it.cantidad_devuelta);
      if (cant <= 0 || cant > disp + 0.0001) fallo(400, 'Cantidad inválida para "' + det.nombre_producto + '" (disponible para devolver: ' + disp + ')');
      return { det: det, cant: cant, regresa: it.regresa_inventario !== false };
    });
    lineas.forEach(function (l) {
      monto += l.cant * num(l.det.precio_unitario);
      l.det.cantidad_devuelta = redondea3(num(l.det.cantidad_devuelta) + l.cant);
      if (l.regresa && l.det.tipo === 'producto' && l.det.producto_id) {
        var i = inv(l.det.producto_id); i.existencia_actual = redondea3(num(i.existencia_actual) + l.cant);
        DB.movimientos_inventario.push({ id: sig('mov_inv'), producto_id: l.det.producto_id, tipo: 'devolucion_venta', cantidad: l.cant, motivo: b.motivo || 'Devolución de venta', referencia_id: d.id, usuario_id: c.user.id, fecha: iso(ahora()) });
      }
    });
    d.monto_total = redondea(monto); DB.devoluciones.push(d);
    if (b.metodo_reembolso === 'efectivo') DB.movimientos_caja.push({ id: sig('mov_caja'), turno_id: parseInt(b.turno_id, 10), usuario_id: c.user.id, tipo: 'egreso', monto: d.monto_total, concepto: 'Devolución ticket ' + t.folio, fecha: iso(ahora()) });
    else if (b.metodo_reembolso === 'ajuste_credito') { var cl = porId(DB.clientes, t.cliente_id); if (cl) cl.saldo_actual = redondea(num(cl.saldo_actual) - d.monto_total); }
    bitacora(c, 'procesar_devolucion', 'devoluciones', d.id, { ticket_folio: t.folio, monto_total: d.monto_total });
    return clonar(d);
  });

  // ----- Bitácora, backups, sistema, imágenes, varios -----
  R('GET', '/bitacora', function (c) {
    requiereAdmin(c);
    var q = c.query;
    return DB.bitacora.filter(function (b) {
      if (q.modulo && b.modulo !== q.modulo) return false;
      if (q.usuario_id && String(b.usuario_id) !== String(q.usuario_id)) return false;
      var d = parseFechaParam(q.desde), h = parseFechaParam(q.hasta);
      if (d && new Date(b.fecha) < d) return false;
      if (h && new Date(b.fecha) > h) return false;
      return true;
    }).sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; }).slice(0, 200).map(function (b) { var o = clonar(b); o.usuario_nombre = usuarioNombre(b.usuario_id); return o; });
  });
  R('GET', '/backups/exportar', function (c) {
    requiereAdmin(c);
    var o = clonar(DB); o.usuarios.forEach(function (u) { delete u.password; }); o.exportado = iso(ahora()); o.nota = 'Respaldo de la DEMO (datos de ejemplo guardados en tu navegador).';
    return o;
  });
  R('POST', '/sistema/reinicio-fabrica', function (c) {
    requiereAdmin(c);
    return { ok: true, mensaje: 'En la demo no se borra nada desde aquí. Usa el botón "Reiniciar demo" de la barra inferior para volver a los datos de ejemplo.' };
  });
  R('POST', '/imagenes/subir', function (c) {
    if (!c.body.imagen_base64) fallo(400, 'Falta la imagen a subir');
    return { url: c.body.imagen_base64 };
  });
  R('POST', '/imagenes/subir-video', function () { fallo(503, 'La subida de videos no está disponible en la demo'); });
  R('GET', '/sucursales', function (c) { requiereRol(c, ['jefe_general']); return { sucursales: [DB.sucursal], tope: 1 }; });

  // ---------- Despachador ----------
  function responder(status, cuerpo, tipo) {
    if (tipo && tipo !== 'application/json' && typeof cuerpo !== 'string') {
      return new Response(cuerpo, { status: status, headers: { 'Content-Type': tipo } }); // Blob (PDF, XML…)
    }
    var texto = (tipo && tipo !== 'application/json') ? cuerpo : JSON.stringify(cuerpo === undefined ? null : cuerpo);
    return new Response(texto, { status: status, headers: { 'Content-Type': tipo || 'application/json' } });
  }
  function dataUrlABlob(u, tipo) {
    var m = /^data:([^;,]*)(;base64)?,(.*)$/.exec(String(u || ''));
    if (!m) return new Blob([String(u || '')], { type: tipo || 'text/plain' });
    var datos = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    var bytes = new Uint8Array(datos.length);
    for (var i = 0; i < datos.length; i++) bytes[i] = datos.charCodeAt(i) & 255;
    return new Blob([bytes], { type: tipo || m[1] || 'application/octet-stream' });
  }
  window.DemoMock.dataUrlABlob = dataUrlABlob;

  // Rutas que el sistema real contesta SIN sesión iniciada.
  var RUTAS_PUBLICAS = /^\/(auth\/login|auth\/info-login|auth\/recuperar\/[a-z]+|facturacion\/publico\/[a-z]+|tienda\/publico\/.+)$/;

  // Registro de llamadas (para las pruebas automáticas y para revisar desde la consola).
  function anotar(metodo, ruta, status) {
    try {
      var l = window.__demoLlamadas = window.__demoLlamadas || [];
      l.push({ m: metodo, r: ruta, s: status });
      if (l.length > 400) l.splice(0, l.length - 400);
    } catch (e) { /* ignorar */ }
  }

  function despachar(url, opciones) {
    var r = despacharInterno(url, opciones);
    try { anotar(((opciones && opciones.method) || 'GET').toUpperCase(), new URL(url).pathname.replace(/^\/api/, ''), r.status); } catch (e) { /* ignorar */ }
    return r;
  }

  function despacharInterno(url, opciones) {
    cargarDB();
    var u = new URL(url);
    var ruta = u.pathname === '/' ? '/' : u.pathname.replace(/\/$/, '');
    var query = {}; u.searchParams.forEach(function (v, k) { query[k] = v; });
    var metodo = ((opciones && opciones.method) || 'GET').toUpperCase();
    var headers = (opciones && opciones.headers) || {};
    function h(n) {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(n);
      for (var k in headers) if (k.toLowerCase() === n.toLowerCase()) return headers[k];
      return null;
    }

    if (ruta === '/health') return responder(200, { status: 'ok', demo: true });
    if (ruta.indexOf('/api') !== 0) return responder(404, { error: 'No encontrado' });
    ruta = ruta.slice(4) || '/';

    var cuerpo = {};
    if (opciones && opciones.body && typeof opciones.body === 'string') { try { cuerpo = JSON.parse(opciones.body) || {}; } catch (e) { cuerpo = {}; } }

    var ctx = { query: query, body: cuerpo, params: {}, user: null, method: metodo };

    var auth = h('Authorization'), token = auth && String(auth).split(' ')[1];
    var mTok = token ? /^demo-token-(\d+)-/.exec(token) : null;
    var usr = mTok ? porId(DB.usuarios, mTok[1]) : null;
    if (!RUTAS_PUBLICAS.test(ruta)) {
      if (!token) return responder(401, { error: 'Token requerido' });
      if (!usr || !usr.activo) return responder(401, { error: 'Token inválido o expirado' });
    }
    ctx.user = usr && usr.activo ? usr : null;

    for (var i = 0; i < RUTAS.length; i++) {
      var r = RUTAS[i];
      if (r.metodo !== metodo) continue;
      var mt = r.rx.exec(ruta);
      if (!mt) continue;
      for (var j = 0; j < r.nombres.length; j++) ctx.params[r.nombres[j]] = mt[j + 1];
      try {
        var salida = r.fn(ctx);
        guardarDB();
        if (salida && salida.__texto !== undefined) return responder(200, salida.__texto, salida.__tipo);
        if (salida && salida.__blob !== undefined) return responder(200, salida.__blob, salida.__tipo || salida.__blob.type);
        return responder(200, salida);
      } catch (err) {
        if (err && err.status) { guardarDB(); return responder(err.status, Object.assign({ error: err.apiError }, err.extra || {})); }
        console.error('[demo] error interno en', metodo, ruta, err);
        return responder(500, { error: 'Error en la demo: ' + (err && err.message) });
      }
    }
    // Endpoint sin implementar: respuesta inofensiva (se anota para revisarlo en pruebas)
    try { (window.__demoSinRuta = window.__demoSinRuta || []).push(metodo + ' ' + ruta); } catch (e) { /* ignorar */ }
    if (metodo === 'GET') return responder(200, []);
    return responder(200, { ok: true });
  }

  // ---------- fetch falso ----------
  var fetchReal = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (entrada, opciones) {
    var url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || String(entrada);
    if (url.indexOf(ORIGEN_API) === 0) {
      var op = opciones || {};
      if (typeof entrada !== 'string' && entrada && entrada.method && !op.method) op = Object.assign({}, op, { method: entrada.method });
      return new Promise(function (resolve) {
        // Pequeña latencia para que se sienta como una aplicación real
        setTimeout(function () {
          try { resolve(despachar(url, op)); }
          catch (e) { console.error('[demo]', e); resolve(responder(500, { error: 'Error en la demo' })); }
        }, 25);
      });
    }
    if (!fetchReal) return Promise.reject(new TypeError('Failed to fetch'));
    return fetchReal(entrada, opciones);
  };

  // ---------- Hardware: impresión, báscula, cámara ----------
  function toastDemo(msg, tipo) {
    if (typeof window.mostrarToast === 'function') { window.mostrarToast(msg, tipo || 'info'); return; }
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#1565C0;color:#fff;padding:10px 16px;border-radius:8px;z-index:100000;font:14px sans-serif;max-width:90vw;box-shadow:0 4px 14px rgba(0,0,0,.3)';
    (document.body || document.documentElement).appendChild(d);
    setTimeout(function () { d.remove(); }, 3500);
  }
  var ultimoAvisoImpresion = 0;
  function impresionSimulada() {
    var t = Date.now();
    if (t - ultimoAvisoImpresion > 1500) { ultimoAvisoImpresion = t; toastDemo('Impresión simulada en la demo', 'info'); }
    return Promise.resolve();
  }
  function aplicarOverridesHardware() {
    var nops = ['imprimirTicketBLE', 'imprimirConDialogoDelSistema', 'imprimirFicha', 'imprimirFichaConDialogoDelSistema', 'imprimirEtiquetaPeso', 'abrirCajonDinero', 'compartirTicketComoTexto', 'enviarBytes', 'enviarBytesPorRed'];
    nops.forEach(function (n) { if (typeof window[n] === 'function') window[n] = impresionSimulada; });
    if (typeof window.impresoraConectada === 'function') window.impresoraConectada = function () { return true; };
    if (typeof window.reconectarSiEsPosible === 'function') window.reconectarSiEsPosible = function () { return Promise.resolve(); };
    ['conectarImpresora', 'conectarImpresoraUSB'].forEach(function (n) {
      if (typeof window[n] === 'function') window[n] = function () { toastDemo('La impresora no se puede conectar en la demo (impresión simulada)', 'info'); return Promise.resolve(); };
    });
    ['conectarBasculaSerial', 'conectarBasculaBluetooth'].forEach(function (n) {
      if (typeof window[n] === 'function') window[n] = function () { toastDemo('La báscula no se puede conectar en la demo: teclea el peso a mano', 'info'); return Promise.resolve(); };
    });
    if (typeof window.basculaConectada === 'function') window.basculaConectada = function () { return false; };
    if (typeof window.intentarReconexionAutomaticaBascula === 'function') window.intentarReconexionAutomaticaBascula = function () { return Promise.resolve(); };
  }
  // Se aplican cuando ya cargaron todos los scripts (DOMContentLoaded) y otra vez en load.
  document.addEventListener('DOMContentLoaded', aplicarOverridesHardware);
  window.addEventListener('load', aplicarOverridesHardware);

  // Web Bluetooth/USB/Serial se ocultan para que la app no ofrezca hardware que no existe en la demo.
  try {
    ['bluetooth', 'usb', 'serial'].forEach(function (k) {
      if (k in navigator) Object.defineProperty(navigator, k, { configurable: true, get: function () { return undefined; } });
    });
  } catch (e) { /* ignorar */ }

  // Preferencias por dispositivo para que nunca pida hardware
  try {
    if (!localStorage.getItem('modo_impresion')) localStorage.setItem('modo_impresion', 'directo');
    localStorage.setItem('bascula_usar_en_mostrador', '0');
  } catch (e) { /* ignorar */ }

  // ---------- Banner de demostración ----------
  function crearBanner() {
    if (document.getElementById('demoBanner')) return;
    if (/\/tienda\.html$/.test(location.pathname)) {
      var et = document.createElement('div'); et.id = 'demoBanner'; et.className = 'demo-tienda-chip'; et.textContent = 'DEMO · tienda de ejemplo';
      et.style.cssText = 'position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:998;background:#1b2a1f;color:#9ee27f;border:1px solid #5FAE46;border-radius:999px;padding:2px 10px;font:700 11px system-ui,Arial,sans-serif;pointer-events:none;opacity:.92';
      document.body.appendChild(et); return;
    }
    var estilo = document.createElement('style');
    estilo.textContent =
      '#demoBanner{position:fixed;left:52px;bottom:10px;z-index:998;display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap;' +
      'width:370px;max-width:calc(100vw - 70px);box-sizing:border-box;background:#1b2a1f;color:#fff;border:1px solid #5FAE46;border-radius:16px;padding:8px 8px 8px 14px;font:12.5px/1.35 system-ui,Segoe UI,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.28)}' +
      'body.con-sidebar #demoBanner,body.con-sidebar #demoChip{left:calc(var(--sidebar-ancho,240px) + 12px)}' +
      'body.con-sidebar.sidebar-colapsado-escritorio #demoBanner,body.con-sidebar.sidebar-colapsado-escritorio #demoChip{left:52px}' +
      '#demoBanner .db-txt{flex:1 1 100%}' +
      '#demoBanner b{color:#9ee27f}' +
      '#demoBanner button,#demoBanner a{font:600 12px system-ui,Segoe UI,Arial,sans-serif;border:0;border-radius:999px;padding:5px 11px;cursor:pointer;text-decoration:none;white-space:nowrap}' +
      '#demoBanner .db-reset{background:#3a4a3f;color:#fff}#demoBanner .db-wa{background:#5FAE46;color:#0d1a10}' +
      '#demoBanner .db-web{color:#bfe9ad;padding:5px 4px}#demoBanner .db-min{background:transparent;color:#cfd8d2;padding:5px 8px}' +
      '#demoChip{position:fixed;left:52px;bottom:10px;z-index:998;display:none;background:#1b2a1f;color:#9ee27f;border:1px solid #5FAE46;border-radius:999px;padding:5px 12px;font:700 12px system-ui,Arial,sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.28)}' +
      '#demoBanner.cerrado{display:none}#demoBanner.cerrado+#demoChip{display:block}' +
      '#demoBanner .db-short{display:none}' +
      '@media (max-width:760px){#demoBanner,#demoChip,body.con-sidebar #demoBanner,body.con-sidebar #demoChip{left:48px;bottom:10px}' +
      '#demoBanner{right:72px;width:auto;max-width:none;border-radius:14px;gap:5px 6px;padding:6px 6px 6px 10px;font-size:11.5px}' +
      '#demoBanner .db-full,#demoBanner .db-web{display:none}#demoBanner .db-short{display:inline;flex:1 1 100%}' +
      '#demoBanner button,#demoBanner a{padding:5px 9px;font-size:11.5px}}' +
      '@media print{#demoBanner,#demoChip{display:none!important}}';
    document.head.appendChild(estilo);
    var b = document.createElement('div');
    b.id = 'demoBanner';
    b.setAttribute('role', 'region'); b.setAttribute('aria-label', 'Aviso de versión de demostración');
    b.innerHTML =
      '<span class="db-txt db-full"><b>Versión de demostración</b> · los datos se guardan solo en tu navegador</span>' +
      '<span class="db-txt db-short"><b>Demo</b> · datos solo en tu navegador</span>' +
      '<button type="button" class="db-reset">Reiniciar demo</button>' +
      '<a class="db-wa" href="' + WA_URL + '" target="_blank" rel="noopener">Quiero este sistema</a>' +
      '<a class="db-web" href="' + SITIO_URL + '" target="_blank" rel="noopener">www.compoint.com.mx</a>' +
      '<button type="button" class="db-min" title="Ocultar aviso" aria-label="Ocultar aviso">&times;</button>';
    var chip = document.createElement('button');
    chip.id = 'demoChip'; chip.type = 'button'; chip.textContent = 'DEMO'; chip.title = 'Mostrar aviso de demostración';
    document.body.appendChild(b); document.body.appendChild(chip);
    var cerrado = false;
    try { cerrado = sessionStorage.getItem('demo_banner_cerrado') === '1'; } catch (e) { /* ignorar */ }
    if (cerrado) b.classList.add('cerrado');
    b.querySelector('.db-reset').addEventListener('click', function () {
      if (confirm('¿Reiniciar la demo? Se borrarán tus cambios y volverán los datos de ejemplo.')) { reiniciarDemo(); location.reload(); }
    });
    b.querySelector('.db-min').addEventListener('click', function () { b.classList.add('cerrado'); try { sessionStorage.setItem('demo_banner_cerrado', '1'); } catch (e) {} });
    chip.addEventListener('click', function () { b.classList.remove('cerrado'); try { sessionStorage.removeItem('demo_banner_cerrado'); } catch (e) {} });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', crearBanner); else crearBanner();

  cargarDB();
})();
