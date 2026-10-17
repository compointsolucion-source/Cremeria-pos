// Mostrador: pedidos por preparar (frontend/js/mostrador-pedidos.js). Las piezas sin pantalla no necesitan base de datos.
const test = require('node:test');
const assert = require('node:assert/strict');

let MP = null;
try { MP = require('../../frontend/js/mostrador-pedidos.js'); } catch (e) { /* el backend solo (sin la carpeta frontend) también debe poder probarse */ }
const conPantalla = (nombre, fn) => test(nombre, { skip: MP ? false : 'no está la carpeta frontend' }, fn);

// "Hoy" fijo para que las pruebas no dependan del reloj: sábado 17 de octubre de 2026, 14:00.
const AHORA = new Date(2026, 9, 17, 14, 0, 0);
const base = (extra = {}) => ({
  id: 192, etiqueta: 'D-0192', folio: 'S1A8F2K', tipo: 'domicilio', estado: 'preparando', pago_modo: 'al_recibir',
  nombre_contacto: 'Juan Pérez López', telefono: '33 1234 5678', calle: 'Av. Siempre Viva 123', colonia: 'Centro', cp: '44100', ciudad: 'Guadalajara',
  referencias: 'Portón negro, esquina con Hidalgo', zona_nombre: 'Centro', notas: 'Queso en bolsas de medio kilo.',
  programado_para: '2026-10-17T14:30', paga_con: 500, total_neto: 496, ticket_total: 496, ticket_estado: 'pendiente',
  items: [
    { id: 1, tipo: 'producto', tipo_venta: 'peso', nombre_producto: 'Queso Oaxaca', cantidad: 1.5, precio_unitario: 180, subtotal: 270 },
    { id: 2, tipo: 'producto', tipo_venta: 'unidad', nombre_producto: 'Crema Lala 1 L', cantidad: 2, precio_unitario: 38, subtotal: 76 },
    { id: 3, tipo: 'producto', tipo_venta: null, nombre_producto: 'Envío a domicilio', cantidad: 1, precio_unitario: 30, subtotal: 30, es_envio: true }
  ],
  ...extra
});

conPantalla('cantidades para el que prepara: kilos con 3 decimales, piezas enteras, singular y plural', () => {
  assert.deepEqual(MP.textoCantidad({ tipo_venta: 'peso', cantidad: 1.5 }), { num: '1.500', unidad: 'kg' });
  assert.deepEqual(MP.textoCantidad({ tipo_venta: 'peso', cantidad: '0.8' }), { num: '0.800', unidad: 'kg' });
  assert.deepEqual(MP.textoCantidad({ tipo_venta: 'unidad', cantidad: 1 }), { num: '1', unidad: 'pza' });
  assert.deepEqual(MP.textoCantidad({ tipo_venta: 'unidad', cantidad: 12 }), { num: '12', unidad: 'pzas' });
  assert.deepEqual(MP.textoCantidad({ tipo: 'kit', cantidad: 2 }), { num: '2', unidad: 'kits' });
});

conPantalla('hora de entrega: hoy, mañana, otro día y sin hora', () => {
  assert.deepEqual(MP.textoEntrega(base(), AHORA), { etiqueta: 'ENTREGAR HOY A LAS', valor: '14:30', hora: '14:30', dia: 'hoy' });
  assert.equal(MP.textoEntrega(base({ tipo: 'recoger' }), AHORA).etiqueta, 'LO RECOGEN HOY A LAS');
  assert.equal(MP.textoEntrega(base({ programado_para: '2026-10-18T09:00' }), AHORA).etiqueta, 'ENTREGAR MAÑANA A LAS');
  assert.equal(MP.textoEntrega(base({ programado_para: '2026-10-25T09:00' }), AHORA).etiqueta, 'ENTREGAR EL 25 OCT A LAS');
  const sin = MP.textoEntrega(base({ programado_para: null }), AHORA);
  assert.equal(sin.valor, 'LO ANTES POSIBLE');
  assert.equal(sin.hora, '');
});

conPantalla('faltan / atraso y "hace N min"', () => {
  assert.equal(MP.minutosPara('2026-10-17T14:30', AHORA), 30);
  assert.equal(MP.minutosPara('2026-10-17T13:50', AHORA), -10);
  assert.equal(MP.minutosPara(null, AHORA), null);
  assert.equal(MP.duracion(25), '25 min');
  assert.equal(MP.duracion(-10), '10 min');
  assert.equal(MP.duracion(70), '1 h 10 min');
  assert.equal(MP.duracion(120), '2 h');
  assert.equal(MP.minutosDesde(new Date(AHORA.getTime() - 4 * 60000).toISOString(), AHORA), 4);
  assert.equal(MP.haceTexto(0), 'hace un momento');
  assert.equal(MP.haceTexto(4), 'hace 4 min');
  assert.equal(MP.haceTexto(null), '');
});

conPantalla('la lista separa nuevos, ya aceptados y listos (los listos, del más reciente al más viejo)', () => {
  const lista = [
    base({ id: 1 }),
    base({ id: 2, aceptado_en: '2026-10-17T19:55:00Z', aceptado_por_nombre: 'Juan' }),
    base({ id: 3, estado: 'listo', listo_en: '2026-10-17T19:00:00Z' }),
    base({ id: 4, estado: 'listo', listo_en: '2026-10-17T19:30:00Z' }),
    base({ id: 5, estado: 'en_camino' })
  ];
  const c = MP.clasificar(lista);
  assert.deepEqual(c.nuevos.map((p) => p.id), [1]);
  assert.deepEqual(c.enPreparacion.map((p) => p.id), [2]);
  assert.deepEqual(c.listos.map((p) => p.id), [4, 3]);
  assert.deepEqual(MP.clasificar(null), { nuevos: [], enPreparacion: [], listos: [] });
  const muchos = Array.from({ length: 10 }, (_, i) => base({ id: 100 + i, estado: 'listo', listo_en: `2026-10-17T1${i}:00:00Z` }));
  assert.equal(MP.clasificar(muchos).listos.length, 6);
});

conPantalla('cobro del ticket: al recibir (con cambio), a crédito, en Caja y para recoger', () => {
  assert.deepEqual(MP.textoCobro(base()), { titulo: 'COBRAR AL RECIBIR', monto: '496.00', detalle: 'Paga con $500.00 - Cambio $4.00' });
  assert.deepEqual(MP.textoCobro(base({ paga_con: null })), { titulo: 'COBRAR AL RECIBIR', monto: '496.00', detalle: '' });
  assert.equal(MP.textoCobro(base({ paga_con: 100 })).detalle, 'Paga con $100.00 - Cambio $0.00');
  assert.equal(MP.textoCobro(base({ pago_modo: 'credito' })).titulo, 'A CREDITO DEL CLIENTE');
  assert.deepEqual(MP.textoCobro(base({ tipo: 'recoger', pago_modo: 'al_recibir' })), { titulo: 'COBRAR EN CAJA AL RECOGER', monto: '496.00', detalle: '' });
});

conPantalla('ERROR GRAVE corregido: «se cobra en Caja» NO es «YA PAGADO» (solo lo es si ya se cobró o si el cliente pagó todo)', () => {
  // Lo que crea la pantalla de «Nuevo pedido» para recoger: pago_modo = "pagado" (= se cobra en Caja) y el ticket sigue pendiente
  const recoger = MP.textoCobro(base({ tipo: 'recoger', pago_modo: 'pagado', ticket_estado: 'pendiente' }));
  assert.equal(recoger.titulo, 'COBRAR EN CAJA AL RECOGER');
  assert.equal(recoger.monto, '496.00');
  assert.doesNotMatch(JSON.stringify(recoger), /PAGADO|No cobrar/i);
  // A domicilio que se cobra en Caja: tampoco dice ya pagado (el repartidor no cobra, pero alguien debe cobrarlo)
  const dom = MP.textoCobro(base({ pago_modo: 'pagado', ticket_estado: 'pendiente' }));
  assert.deepEqual(dom, { titulo: 'COBRAR EN CAJA', monto: '496.00', detalle: 'El repartidor no cobra' });
  // «YA PAGADO» solo cuando Caja ya cobró el ticket
  assert.deepEqual(MP.textoCobro(base({ tipo: 'recoger', pago_modo: 'pagado', ticket_estado: 'pagado' })), { titulo: 'YA PAGADO', monto: null, detalle: 'No cobrar' });
  assert.equal(MP.textoCobro(base({ ticket_estado: 'pagado' })).monto, null);
});

conPantalla('cobro del ticket con anticipo: se cobra lo que resta y se ve cuánto dejó; si cubre todo, YA PAGADO', () => {
  const dom = MP.textoCobro(base({ anticipo: 200, anticipo_metodo: 'transferencia' }));
  assert.deepEqual(dom, { titulo: 'COBRAR AL RECIBIR', monto: '296.00', detalle: 'Total $496.00 - Anticipo $200.00 (transferencia) - Paga con $500.00 - Cambio $204.00' });
  assert.equal(MP.textoCobro(base({ anticipo: 200, anticipo_metodo: 'efectivo', paga_con: null })).detalle, 'Total $496.00 - Anticipo $200.00 (efectivo)');
  const caja = MP.textoCobro(base({ tipo: 'recoger', pago_modo: 'pagado', anticipo: 100.5, anticipo_metodo: 'tarjeta' }));
  assert.deepEqual(caja, { titulo: 'COBRAR EN CAJA AL RECOGER', monto: '395.50', detalle: 'Total $496.00 - Anticipo $100.50 (tarjeta)' });
  const pagoTodo = MP.textoCobro(base({ tipo: 'recoger', pago_modo: 'pagado', anticipo: 496, anticipo_metodo: 'transferencia' }));
  assert.deepEqual(pagoTodo, { titulo: 'YA PAGADO', monto: null, detalle: 'No cobrar - Pago $496.00 (transferencia)' });
  assert.equal(MP.textoCobro(base({ pago_modo: 'credito', anticipo: 0 })).titulo, 'A CREDITO DEL CLIENTE');
  // sin anticipo o con anticipo en cero todo sale como siempre
  assert.deepEqual(MP.textoCobro(base({ anticipo: 0 })), MP.textoCobro(base()));
  assert.deepEqual(MP.textoCobro(base({ anticipo: null, anticipo_metodo: null })), MP.textoCobro(base()));
});

conPantalla('el ticket armado del pedido trae el cobro con anticipo y sin símbolos raros', () => {
  const t = MP.armarTicketPedido(base({ tipo: 'recoger', pago_modo: 'pagado', anticipo: 150, anticipo_metodo: 'efectivo' }), { ahora: AHORA, quien: 'Mostrador' });
  assert.equal(t.pedido.cobro.titulo, 'COBRAR EN CAJA AL RECOGER');
  assert.equal(t.pedido.cobro.monto, '346.00');
  assert.match(t.pedido.cobro.detalle, /Anticipo \$150\.00 \(efectivo\)/);
  assert.doesNotMatch(JSON.stringify(t.pedido), /[·\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

conPantalla('ticket de un pedido a domicilio: datos del cliente grandes, hora, cobro, notas, productos y pie', () => {
  const t = MP.armarTicketPedido(base({ aceptado_por_nombre: 'Juan Carlos' }), { ahora: AHORA, quien: 'Otra Persona' });
  assert.equal(t.folio, 'S1A8F2K');
  assert.equal(t.total, 496);
  assert.equal(t.pedido.titulo, 'PEDIDO D-0192');
  assert.equal(t.pedido.subtitulo, 'A DOMICILIO');
  assert.deepEqual(t.pedido.entrega, { etiqueta: 'ENTREGAR HOY A LAS', valor: '14:30' });
  const cliente = t.pedido.datos.find((d) => d.etiqueta === 'CLIENTE');
  assert.deepEqual(cliente, { etiqueta: 'CLIENTE', lineas: ['JUAN PÉREZ LÓPEZ', 'TEL: 33 1234 5678'], grande: true });
  const dir = t.pedido.datos.find((d) => d.etiqueta === 'DIRECCION');
  assert.deepEqual(dir.lineas, ['AV. SIEMPRE VIVA 123', 'CENTRO', 'CP 44100 GUADALAJARA']);
  assert.equal(dir.grande, true);
  assert.deepEqual(t.pedido.datos.find((d) => d.etiqueta === 'REFERENCIAS'), { etiqueta: 'REFERENCIAS', lineas: ['Portón negro, esquina con Hidalgo'], grande: false });
  assert.equal(t.pedido.datos.find((d) => d.etiqueta === 'ZONA').lineas[0], 'Centro');
  assert.equal(t.pedido.cobro.titulo, 'COBRAR AL RECIBIR');
  assert.equal(t.pedido.notas, 'Queso en bolsas de medio kilo.');
  assert.equal(t.pedido.pie[0], 'Pedido D-0192 - Ticket S1A8F2K');
  assert.match(t.pedido.pie[1], /^Listo: 14:00 - Preparó: Juan$/); // el primer nombre de quien lo aceptó
  assert.equal(t.items.length, 3);
  assert.equal(t.items.find((i) => i.nombre_producto === 'Envío a domicilio').detalle, '');          // la línea de envío no lleva "1 x $30"
  assert.equal(t.items[0].detalle, undefined);                                                        // los productos usan el detalle de siempre
  assert.ok(t.pie_pagina);                                                                            // nunca vacío (si no, mostrador.js pondría otro texto)
});

conPantalla('ticket de un pedido para recoger: solo nombre y teléfono, cobro en Caja, y sin símbolos raros', () => {
  const t = MP.armarTicketPedido(base({ tipo: 'recoger', calle: null, referencias: null, zona_nombre: null, notas: null }), { ahora: AHORA, quien: 'Mostrador' });
  assert.equal(t.pedido.subtitulo, 'PARA RECOGER');
  assert.equal(t.pedido.entrega.etiqueta, 'LO RECOGEN HOY A LAS');
  assert.deepEqual(t.pedido.datos.map((d) => d.etiqueta), ['CLIENTE']);
  assert.equal(t.pedido.cobro.titulo, 'COBRAR EN CAJA AL RECOGER');
  assert.equal(t.pedido.notas, '');
  assert.match(t.pedido.pie[1], /Preparó: Mostrador/);           // sin aceptado_por_nombre se usa quien imprime
  // Todo el texto que va a la impresora es sencillo (el "·" y los emojis salen como "?" en muchas impresoras)
  const solo = JSON.stringify(t.pedido);
  assert.doesNotMatch(solo, /[·\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

conPantalla('ticket sin datos de más: un pedido sin teléfono ni colonia no deja renglones vacíos ni "undefined"', () => {
  const t = MP.armarTicketPedido(base({ telefono: null, colonia: null, cp: null, ciudad: null, referencias: '', zona_nombre: null }), { ahora: AHORA });
  const solo = JSON.stringify(t.pedido);
  assert.doesNotMatch(solo, /undefined|null|NaN/);
  assert.deepEqual(t.pedido.datos.find((d) => d.etiqueta === 'CLIENTE').lineas, ['JUAN PÉREZ LÓPEZ']);
  assert.deepEqual(t.pedido.datos.find((d) => d.etiqueta === 'DIRECCION').lineas, ['AV. SIEMPRE VIVA 123']);
});

conPantalla('un pedido sin hora dice "LO ANTES POSIBLE" en el ticket', () => {
  const t = MP.armarTicketPedido(base({ programado_para: null }), { ahora: AHORA });
  assert.deepEqual(t.pedido.entrega, { etiqueta: 'ENTREGAR', valor: 'LO ANTES POSIBLE' });
});

conPantalla('los textos que vienen de la base se escapan antes de ponerse en la pantalla', () => {
  assert.equal(MP.esc('<img src=x onerror=alert(1)> & "hola"'), '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;hola&quot;');
  assert.equal(MP.esc(null), '');
});

// ---------- Ticket de domicilio configurable (ahorrar papel) ----------
const almacenFalso = () => {
  const d = {};
  return { d, getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: (k) => { delete d[k]; } };
};

conPantalla('opciones del ticket de domicilio: se completan, se limitan y se reconoce la plantilla', () => {
  assert.equal(MP.normalizarOpciones(null), null);
  assert.equal(MP.normalizarOpciones('hola'), null);
  const raro = MP.normalizarOpciones({ cliente: 'enorme', lineasArriba: '99', lineasAbajo: '-3', barras: 'xx', cobro: 'otro' });
  assert.equal(raro.cliente, 'grande');                    // un valor inválido vuelve al de siempre
  assert.equal(raro.barras, 'normal');
  assert.equal(raro.cobro, 'recuadro');
  assert.equal(raro.lineasArriba, 10);                     // máximo 10 renglones en blanco
  assert.equal(raro.lineasAbajo, 0);
  assert.equal(raro.plantilla, 'personal');
  assert.equal(MP.normalizarOpciones({}).plantilla, 'como_ahora');
  for (const k of Object.keys(MP.PLANTILLAS)) assert.equal(MP.plantillaDe(MP.PLANTILLAS[k]), k);
  assert.equal(MP.plantillaDe({ ...MP.PLANTILLAS.ahorro, zona: true }), 'personal');
});

conPantalla('opciones del ticket de domicilio: se guardan solo en este equipo, se leen y se borran', () => {
  const a = almacenFalso();
  assert.equal(MP.leerOpcionesDomicilio(a), null);          // sin guardar = como siempre
  MP.guardarOpcionesDomicilio(MP.PLANTILLAS.ahorro, a);
  assert.deepEqual(Object.keys(a.d), ['ticket_domicilio_dispositivo']);
  assert.equal(MP.leerOpcionesDomicilio(a).plantilla, 'ahorro');
  a.d.ticket_domicilio_dispositivo = '{esto no es json';    // dato dañado: no truena, vuelve a lo de siempre
  assert.equal(MP.leerOpcionesDomicilio(a), null);
  MP.guardarOpcionesDomicilio(MP.PLANTILLAS.minimo, a);
  MP.borrarOpcionesDomicilio(a);
  assert.equal(MP.leerOpcionesDomicilio(a), null);
  assert.deepEqual(a.d, {});
});

conPantalla('sin opciones guardadas el ticket sale igual que siempre (más la cantidad en texto)', () => {
  const sin = MP.armarTicketPedido(base(), { ahora: AHORA, quien: 'Mostrador' });
  const como = MP.armarTicketPedido(base(), { ahora: AHORA, quien: 'Mostrador', opciones: MP.PLANTILLAS.como_ahora });
  assert.equal(sin.ajustes, undefined);
  assert.equal(sin.pedido.formato, undefined);
  assert.deepEqual(sin.pedido.datos, como.pedido.datos);   // "Como ahora" imprime los mismos datos
  assert.deepEqual(sin.pedido.cobro, como.pedido.cobro);
  assert.equal(sin.items[0].cantidad_texto, '1.500 kg');
  assert.equal(sin.items[1].cantidad_texto, '2 pzas');
  assert.equal(sin.items[2].detalle, '');
});

conPantalla('plantilla "Ahorro de papel": datos del cliente en pocas líneas, sin etiquetas ni adornos', () => {
  const t = MP.armarTicketPedido(base(), { ahora: AHORA, quien: 'Mostrador', opciones: MP.PLANTILLAS.ahorro });
  const datos = t.pedido.datos;
  assert.equal(datos.length, 3);                           // cliente, dirección y referencias (sin zona)
  assert.ok(datos.every((d) => d.etiqueta === '' && d.lineas.length === 1));
  assert.equal(datos[0].lineas[0], 'JUAN PÉREZ LÓPEZ  TEL: 33 1234 5678');
  assert.equal(datos[1].lineas[0], 'AV. SIEMPRE VIVA 123, CENTRO, CP 44100 GUADALAJARA');
  assert.equal(datos[2].lineas[0], 'Ref: Portón negro, esquina con Hidalgo');
  assert.equal(t.pedido.formato.cobro, 'linea');
  assert.equal(t.pedido.formato.barras, 'chico');
  assert.equal(t.ajustes.productoUnaLinea, true);
  assert.equal(t.ajustes.incluirPrecioUnitario, false);
  assert.equal(t.ajustes.lineasInferiores, 2);
  assert.doesNotMatch(JSON.stringify(t), /undefined|NaN/);
  // la hora y el cobro (lo importante para el repartidor) siguen en el ticket
  assert.equal(t.pedido.entrega.valor, '14:30');
  assert.equal(t.pedido.cobro.monto, '496.00');
});

conPantalla('plantilla "Lo mínimo": letra pequeña y un renglón en blanco al final', () => {
  const t = MP.armarTicketPedido(base(), { ahora: AHORA, quien: 'Mostrador', opciones: MP.PLANTILLAS.minimo });
  assert.equal(t.ajustes.tamanoLetra, 'pequena');
  assert.equal(t.ajustes.lineasInferiores, 1);
  assert.equal(t.pedido.formato.cliente, 'normal');
});

conPantalla('las líneas "igual que el ticket normal" no pisan los renglones de la impresora', () => {
  const t = MP.armarTicketPedido(base(), { ahora: AHORA, opciones: MP.normalizarOpciones({ ...MP.PLANTILLAS.ahorro, lineasArriba: '', lineasAbajo: '' }) });
  assert.equal(t.ajustes.lineasSuperiores, undefined);
  assert.equal(t.ajustes.lineasInferiores, undefined);
});

conPantalla('aplicarAjustesPedido pasa las opciones a lo que entiende la impresora', () => {
  const t = MP.armarTicketPedido(base(), { ahora: AHORA, quien: 'Mostrador', opciones: MP.PLANTILLAS.ahorro });
  const datos = { negocio: 'Cremería Don Pepe', nombreTamano: 'doble', mensajeSuperior: 'Hola', lineasSuperiores: 3, lineasInferiores: 3, incluirPrecioUnitario: true, tamanoLetra: 'grande' };
  const r = MP.aplicarAjustesPedido(datos, t);
  assert.equal(r.pedido, t.pedido);
  assert.equal(r.productoUnaLinea, true);
  assert.equal(r.folioUnaLinea, true);
  assert.equal(r.ticketCompacto, true);
  assert.equal(r.incluirPrecioUnitario, false);
  assert.equal(r.tamanoLetra, 'normal');
  assert.equal(r.totalTamano, 'grande');
  assert.equal(r.lineasSuperiores, 0);
  assert.equal(r.lineasInferiores, 2);
  assert.equal(r.nombreTamano, 'normal');                  // solo el nombre del negocio, sin letrero grande
  assert.equal(r.mensajeSuperior, '');
  assert.equal(r.tipoCodigoEscaneo, 'barras');
  assert.equal(r.codigoAlFinal, true);
  // sin ajustes (ticket "de siempre") no se toca nada salvo lo que ya se hacía
  const d2 = { negocio: 'X', nombreTamano: 'doble', lineasInferiores: 3 };
  MP.aplicarAjustesPedido(d2, MP.armarTicketPedido(base(), { ahora: AHORA }));
  assert.equal(d2.nombreTamano, 'doble');
  assert.equal(d2.lineasInferiores, 3);
  assert.equal(d2.productoUnaLinea, undefined);
});

conPantalla('pedido de ejemplo: sirve para la vista previa y la prueba, con folio de prueba', () => {
  const p = MP.pedidoEjemplo(AHORA);
  assert.equal(p.folio, 'PRUEBA-001');
  assert.ok(p.items.length >= 3);
  const t = MP.armarTicketPedido(p, { ahora: AHORA, quien: 'Mostrador', opciones: MP.PLANTILLAS.ahorro });
  assert.equal(t.folio, 'PRUEBA-001');
  assert.doesNotMatch(JSON.stringify([t.pedido, t.ajustes]), /undefined|NaN|null/);
});
