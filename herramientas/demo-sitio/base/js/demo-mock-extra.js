/* ============================================================================
 * Compoint Punto — DEMO: módulos agregados en la versión actual
 * (licencia y prueba de 30 días, facturación, pérdidas, compras, sucursales…)
 * Se carga después de demo-mock.js y registra sus rutas con DemoMock.R().
 * ========================================================================== */
(function () {
  'use strict';
  var M = window.DemoMock;
  if (!M) return;
  var R = M.R, fallo = M.fallo, num = M.num, redondea = M.redondea, clonar = M.clonar;
  var CONTACTO = 'WhatsApp 33 25 90 70 90 · Tel. 33 15 97 04 12 · contacto@compoint.com.mx';
  var ID_EQUIPO = 'DEMO-PUNT-0001';
  var DIAS_PRUEBA = 15;

  function db() { return M.db(); }
  function hoyStr() { return M.fechaLocalStr(M.ahora()); }
  function sumarDias(iso, n) { var d = M.parseFechaParam(iso); d.setDate(d.getDate() + n); return M.fechaLocalStr(d); }
  function difDias(a, b) { return Math.round((M.parseFechaParam(a).getTime() - M.parseFechaParam(b).getTime()) / 86400000); }
  function fechaBonita(iso) { var p = iso.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }

  // ---------- Datos propios de este módulo (se crean la primera vez) ----------
  function asegurar() {
    var D = db();
    if (!D.extra) D.extra = {};
    var X = D.extra;
    if (!X.licencia) {
      // La prueba siempre luce "a la mitad" para el visitante: empieza 3 días antes de su primera visita.
      X.licencia = { inicio: sumarDias(hoyStr(), -3) };
    }
    if (!X.datos_negocio) X.datos_negocio = { datos: {}, completado: false, vista: null, acepto: false };
    if (!X.solicitudes) X.solicitudes = [];
    if (!X.facturas) {
      var pagados = D.tickets.filter(function (t) { return t.estado === 'pagado'; }).slice(-6);
      var ej = [
        ['GOMJ850312AB1', 'JUANA GÓMEZ MARTÍNEZ', '612', '44100', 'G03', 'juana.gomez@ejemplo.com', 'pendiente', null, null],
        ['FDL190405KL2', 'FONDA DOÑA LUPE', '626', '44600', 'G03', 'facturas@fondadonalupe.mx', 'facturada', null, '8F3A2C1E-5B7D-4E21-9A6F-2D1C4B7E9A10'],
        ['RACC900101XY3', 'CARLOS RAMÍREZ CRUZ', '605', '45050', 'S01', 'carlos.ramirez@ejemplo.com', 'rechazada', 'El código postal no coincide con la constancia de situación fiscal.', null]
      ];
      X.facturas = ej.map(function (e, i) {
        var t = pagados[i] || D.tickets[i];
        var creado = M.iso(new Date(M.ahora().getTime() - (i + 1) * 5 * 3600000));
        return { id: i + 1, ticket_id: t.id, folio: t.folio, total: t.total, rfc: e[0], razon_social: e[1], regimen_fiscal: e[2], codigo_postal: e[3],
          uso_cfdi: e[4], correo: e[5], telefono: '33 1234 56' + (10 + i), estado: e[6], nota_admin: e[7], uuid_factura: e[8],
          constancia_nombre: 'constancia-' + e[0] + '.pdf', tiene_constancia: true, creado_en: creado, actualizado_en: creado,
          factura_pdf_nombre: e[6] === 'facturada' ? 'factura-' + t.folio + '.pdf' : null, factura_xml_nombre: e[6] === 'facturada' ? 'factura-' + t.folio + '.xml' : null,
          tiene_pdf: e[6] === 'facturada', tiene_xml: e[6] === 'facturada', factura_rfc: e[6] === 'facturada' ? e[0] : null,
          factura_total: e[6] === 'facturada' ? t.total : null, factura_subida_en: e[6] === 'facturada' ? creado : null,
          clave_descarga: e[6] === 'facturada' ? 'DEMO' + (i + 1) + 'CLAVE' : null, archivos: {} };
      });
    }
    return X;
  }

  // ---------- Licencia (prueba de 30 días) ----------
  function estadoLicencia() {
    var X = asegurar();
    var inicio = X.licencia.inicio, vence = sumarDias(inicio, DIAS_PRUEBA);
    var dias = Math.max(3, difDias(vence, hoyStr())); // en la demo la prueba nunca termina
    vence = sumarDias(hoyStr(), dias);
    return {
      control: true, tipo: 'demo', vence: vence, permanente: false, en_gracia: false, gracia_restante: 0, por_vencer: dias <= 7,
      estado: 'demo', dias: dias, solo_consulta: false, plan: 'nube', inicio: inicio, max_sucursales: null, cliente: null,
      con_codigo: false, desde_nube: null, id_equipo: ID_EQUIPO, local: false, tiene_llave: true, reloj_atrasado: false,
      codigo_invalido: null, puede_vender: true,
      mensaje: 'Versión de prueba: te quedan ' + dias + ' día' + (dias === 1 ? '' : 's') + ' (termina el ' + fechaBonita(vence) + ').'
    };
  }
  var CAMPOS = ['negocio', 'giro', 'nombre_dueno', 'telefono', 'whatsapp', 'email', 'direccion', 'ciudad', 'estado', 'cp', 'rfc', 'razon_social', 'cp_fiscal', 'email_factura'];
  function datosLimpios(e) {
    var d = {};
    e = e || {};
    CAMPOS.forEach(function (k) { d[k] = String(e[k] == null ? '' : e[k]).replace(/\s+/g, ' ').trim().slice(0, 120); });
    d.sucursales = e.sucursales ? parseInt(e.sucursales, 10) || null : null;
    return d;
  }
  function completos(d) { return !!(d.negocio && d.nombre_dueno && (d.whatsapp || d.telefono)); }
  function rolNegocio(c) { M.requiereRol(c, ['dueno', 'jefe_general', 'gerente']); }

  R('GET', '/licencia', function () {
    var e = estadoLicencia();
    delete e.serial;
    e.limite_sucursales = 2; e.contacto = CONTACTO;
    // Paquete contratado (desde la versión 1.2.0): la demo luce como paquete Negocio.
    var activos = db().usuarios.filter(function (u) { return u.activo; }).length;
    e.paquete = { paquete: 'negocio', nombre: 'Negocio', max_usuarios: 8, con_domicilio: true, usuarios_activos: activos };
    return e;
  });
  // Lista oficial de precios (copia de backend/utils/precios.js, 28-oct-2026).
  var PRECIOS = {
    version: '2026-10-28', moneda: 'MXN', origen: 'copia',
    paquetes: {
      basico: { nombre: 'Básico', sucursales: 1, usuarios: 3, usuarios_texto: '3 usuarios', incluye: ['1 sucursal', '3 usuarios', 'Nube incluida'], mensual: 349, semestral: 1745, anual: 3490 },
      negocio: { nombre: 'Negocio', sucursales: 2, usuarios: 8, usuarios_texto: '8 usuarios', incluye: ['2 sucursales', '8 usuarios', 'Servicio a domicilio y app del repartidor', 'Nube incluida'], mensual: 499, semestral: 2495, anual: 4990 },
      pro: { nombre: 'Pro', sucursales: 4, usuarios: null, usuarios_texto: 'Usuarios ilimitados', incluye: ['4 sucursales', 'Usuarios ilimitados', 'Servicio a domicilio y app del repartidor', 'Nube incluida'], mensual: 799, semestral: 3995, anual: 7990 }
    },
    periodos: {
      mensual: { nombre: 'Mensual', meses: 1, ahorro: '' },
      semestral: { nombre: '6 meses', meses: 6, ahorro: 'Ahorras 1 mes' },
      anual: { nombre: 'Anual', meses: 12, ahorro: 'Ahorras 2 meses' }
    },
    extras: { sucursal_anual: 1500, usuario_anual: 300 },
    sin_nube: { nombre: 'Sin nube (pago único)', pago_unico: 2990, sucursales: 1, incluye: 'Es para siempre e incluye 1 año de actualizaciones y soporte.',
      renovacion_anual: 990, renovacion_texto: 'Después, la renovación de actualizaciones y soporte es opcional.' },
    instalacion: { presencial: 600, distancia: 400 },
    prueba: { dias: 15, url: 'https://www.compoint.com.mx/demos/punto' },
    nota: 'Precios en pesos mexicanos. Antes de pagar te confirmamos por escrito el total, el periodo y la fecha de vencimiento. No hay cobros automáticos.'
  };
  R('GET', '/licencia/precios', function () { return clonar(PRECIOS); });
  function textoPaquete(s) {
    if (s.plan === 'local') return PRECIOS.sin_nube.nombre + ' ($' + PRECIOS.sin_nube.pago_unico.toLocaleString('en-US') + ')';
    var pq = PRECIOS.paquetes[s.paquete], pe = PRECIOS.periodos[s.periodo];
    if (!pq && !pe) return '';
    var t = [pq ? pq.nombre : '', pe ? pe.nombre : ''].filter(Boolean).join(' · ');
    return pq && pe ? t + ' ($' + pq[s.periodo].toLocaleString('en-US') + ')' : t;
  }

  R('POST', '/licencia/activar', function () {
    fallo(400, 'En la demo no se activan licencias. Para contratar Compoint Punto escríbenos por WhatsApp al 33 25 90 70 90.');
  });
  R('GET', '/licencia/datos', function (c) {
    rolNegocio(c);
    var X = asegurar(), dn = X.datos_negocio, cfg = db().configuracion;
    var mostrar = !dn.completado && (!dn.vista || difDias(hoyStr(), dn.vista) >= 2);
    return {
      datos: Object.assign(datosLimpios({}), dn.datos), completado: dn.completado, mostrar_bienvenida: mostrar,
      sugerencias: { negocio: cfg.nombre_negocio, direccion: cfg.direccion, telefono: cfg.telefono, sucursales: 1 },
      acepto_privacidad: dn.acepto, aviso_version: 1, dias_prueba: estadoLicencia().dias
    };
  });
  R('PUT', '/licencia/datos', function (c) {
    rolNegocio(c);
    var X = asegurar(), d = datosLimpios(c.body && c.body.datos);
    if (!d.negocio) fallo(400, 'Escribe el nombre de tu negocio.');
    X.datos_negocio.datos = d; X.datos_negocio.completado = completos(d);
    var aplicado = [];
    if (c.body && c.body.aplicar_ticket) {
      var cfg = db().configuracion;
      if (d.negocio) { cfg.nombre_negocio = d.negocio.slice(0, 60); aplicado.push('nombre_negocio'); }
      var dir = [d.direccion, d.ciudad, d.estado].filter(Boolean).join(', ');
      if (dir) { cfg.direccion = dir; aplicado.push('direccion'); }
      if (d.telefono || d.whatsapp) { cfg.telefono = (d.telefono || d.whatsapp).slice(0, 20); aplicado.push('telefono'); }
    }
    M.bitacora(c, 'licencia_datos_negocio', 'licencia', null, { completado: X.datos_negocio.completado, ticket: aplicado });
    return { ok: true, datos: d, completado: X.datos_negocio.completado, ticket_aplicado: aplicado };
  });
  R('POST', '/licencia/datos/despues', function (c) { rolNegocio(c); asegurar().datos_negocio.vista = hoyStr(); return { ok: true }; });

  function respuestaSolicitud(s) {
    var d = s.datos || {};
    var contacto = [d.nombre_dueno, d.whatsapp || d.telefono].filter(Boolean).join(' · ');
    var lineas = ['Hola Compoint, ' + (s.tipo === 'renovar' ? 'quiero renovar' : 'probé la demo y quiero contratar') + ' Compoint Punto.'];
    if (d.negocio) lineas.push('Negocio: ' + d.negocio);
    if (contacto) lineas.push('Contacto: ' + contacto);
    if (d.ciudad) lineas.push('Ciudad: ' + d.ciudad);
    lineas.push('Plan: ' + (s.plan === 'local' ? 'Sin nube' : 'Con nube') + ' · ' + s.sucursales + ' sucursal' + (s.sucursales === 1 ? '' : 'es'));
    if (textoPaquete(s)) lineas.push('Paquete: ' + textoPaquete(s));
    if (s.nota) lineas.push('Nota: ' + s.nota);
    var msg = lineas.join('\n');
    var texto = ['SOLICITUD PARA CONTRATAR COMPOINT PUNTO (desde la demo en línea)', 'Fecha: ' + s.fecha,
      'Plan: ' + (s.plan === 'local' ? 'Sin nube (trabaja sin internet)' : 'Con servicio en la nube'), 'Paquete: ' + (textoPaquete(s) || '-'), 'Sucursales: ' + s.sucursales, '']
      .concat(CAMPOS.filter(function (k) { return d[k]; }).map(function (k) { return k.replace(/_/g, ' ') + ': ' + d[k]; }))
      .concat(s.nota ? ['', 'Nota: ' + s.nota] : []).concat(['', 'WhatsApp 33 25 90 70 90 · contacto@compoint.com.mx']).join('\n');
    return {
      id: s.id, estado: 'rechazada', tipo: s.tipo, plan: s.plan, paquete: s.paquete || null, periodo: s.periodo || null, sucursales: s.sucursales, creada_en: s.creada_en, enviada_en: null, intentos: 1,
      error: 'En la demo la solicitud no se manda por correo.', correo_destino: 'contacto@compoint.com.mx', codigo: s.codigo,
      texto_whatsapp: msg, whatsapp_url: 'https://wa.me/523325907090?text=' + encodeURIComponent(msg), texto_completo: texto
    };
  }
  R('POST', '/licencia/solicitud', function (c) {
    rolNegocio(c);
    var b = c.body || {};
    if (['local', 'nube'].indexOf(b.plan) === -1) fallo(400, 'Elige si quieres el plan sin nube o con nube.');
    if (b.acepto_privacidad !== true) fallo(400, 'Marca la casilla del aviso de privacidad para poder enviar tus datos a Compoint.');
    var d = datosLimpios(b.datos);
    if (!d.negocio) fallo(400, 'Escribe el nombre de tu negocio.');
    if (!d.nombre_dueno) fallo(400, 'Escribe el nombre del dueño o de la persona de contacto.');
    if (!d.whatsapp && !d.telefono) fallo(400, 'Escribe un WhatsApp o teléfono para contactarte.');
    var X = asegurar(), suc = parseInt(b.sucursales || d.sucursales || 1, 10) || 1;
    X.datos_negocio.datos = d; X.datos_negocio.completado = true; X.datos_negocio.acepto = true;
    var s = { id: X.solicitudes.length + 1, tipo: 'contratar', plan: b.plan, sucursales: suc,
      paquete: b.plan === 'nube' && PRECIOS.paquetes[b.paquete] ? b.paquete : null, periodo: b.plan === 'nube' && PRECIOS.periodos[b.periodo] ? b.periodo : null, datos: d, nota: String(b.nota || '').slice(0, 300),
      fecha: hoyStr(), creada_en: M.iso(M.ahora()), codigo: 'CPT-REQ-DEMO-' + Date.now().toString(36).toUpperCase() };
    X.solicitudes.push(s);
    M.bitacora(c, 'licencia_solicitud', 'licencia', s.id, { tipo: s.tipo, plan: s.plan, sucursales: suc });
    return { ok: true, solicitud: respuestaSolicitud(s), ticket_aplicado: [] };
  });
  R('GET', '/licencia/solicitud', function (c) {
    rolNegocio(c);
    var X = asegurar(), s = X.solicitudes[X.solicitudes.length - 1];
    return { solicitud: s ? respuestaSolicitud(s) : null };
  });
  R('POST', '/licencia/solicitud/reintentar', function (c) {
    rolNegocio(c);
    var X = asegurar(), s = X.solicitudes[X.solicitudes.length - 1];
    return { solicitud: s ? respuestaSolicitud(s) : null };
  });

  // ---------- Facturación (solicitudes de factura de los clientes) ----------
  R('GET', '/facturacion', function (c) {
    var X = asegurar(), q = String(c.query.q || '').toLowerCase().trim();
    var lista = X.facturas.filter(function (f) {
      if (['pendiente', 'facturada', 'rechazada'].indexOf(c.query.estado) !== -1 && f.estado !== c.query.estado) return false;
      if (q && [f.folio, f.rfc, f.razon_social, f.correo].join(' ').toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(function (a, b) { return (a.estado === 'pendiente') !== (b.estado === 'pendiente') ? (a.estado === 'pendiente' ? -1 : 1) : (a.creado_en < b.creado_en ? 1 : -1); });
    var resumen = { pendiente: 0, facturada: 0, rechazada: 0 };
    X.facturas.forEach(function (f) { resumen[f.estado]++; });
    return { solicitudes: lista.map(sinArchivos), resumen: resumen };
  });
  R('GET', '/facturacion/:id/constancia', function () {
    fallo(404, 'En la demo las constancias son de ejemplo y no se pueden descargar.');
  });
  R('GET', '/facturacion/:id', function (c) {
    var X = asegurar(), f = M.porId(X.facturas, c.params.id);
    if (!f) fallo(404, 'Solicitud no encontrada');
    var t = M.porId(db().tickets, f.ticket_id) || {};
    var o = sinArchivos(f);
    o.negocio = db().configuracion.nombre_negocio;
    o.avisos = f.factura_subida_en && f.factura_rfc ? revisarCfdi({ uuid: f.uuid_factura, rfc: f.factura_rfc, total: f.factura_total }, f) : [];
    o.ticket = { folio: t.folio, total: t.total, metodo_pago: t.metodo_pago, fecha_pago: t.fecha_pago, descuento_monto: t.descuento_monto };
    o.items = M.itemsDe(f.ticket_id).map(function (d) { return { nombre_producto: d.nombre_producto, cantidad: d.cantidad, precio_unitario: d.precio_unitario, subtotal: d.subtotal }; });
    return o;
  });
  R('PUT', '/facturacion/:id', function (c) {
    M.requiereRol(c, ['dueno', 'jefe_general', 'gerente']);
    var X = asegurar(), f = M.porId(X.facturas, c.params.id), b = c.body || {};
    if (!f) fallo(404, 'Solicitud no encontrada');
    if (['pendiente', 'facturada', 'rechazada'].indexOf(b.estado) === -1) fallo(400, 'Estado inválido');
    var nota = String(b.nota_admin || '').trim().slice(0, 500);
    if (b.estado === 'rechazada' && !nota) fallo(400, 'Escribe el motivo del rechazo (el cliente lo podrá ver)');
    f.estado = b.estado; f.nota_admin = nota || null; f.uuid_factura = String(b.uuid_factura || '').trim().slice(0, 60) || null; f.actualizado_en = M.iso(M.ahora());
    M.bitacora(c, 'factura_' + b.estado, 'facturacion', f.id, { folio: f.folio, estado: f.estado });
    return sinArchivos(f);
  });
  R('GET', '/facturacion/publico/catalogos', function () {
    return {
      regimenes: [['601', 'General de Ley Personas Morales'], ['605', 'Sueldos y Salarios'], ['606', 'Arrendamiento'], ['612', 'Personas Físicas con Actividades Empresariales y Profesionales'], ['616', 'Sin obligaciones fiscales'], ['626', 'Régimen Simplificado de Confianza']].map(function (r) { return { clave: r[0], descripcion: r[1] }; }),
      usos: [['G01', 'Adquisición de mercancías'], ['G03', 'Gastos en general'], ['S01', 'Sin efectos fiscales']].map(function (r) { return { clave: r[0], descripcion: r[1] }; })
    };
  });
  // ----- Factura subida por el negocio (PDF y XML), desde la versión 1.2.1 -----
  function sinArchivos(f) { var o = clonar(f); delete o.archivos; return o; }
  function revisarCfdi(cfdi, sol) {
    var av = [];
    if (!cfdi.uuid) av.push('El XML no tiene folio fiscal: parece que la factura no está timbrada.');
    if (cfdi.rfc && cfdi.rfc !== sol.rfc) av.push('El RFC del XML es ' + cfdi.rfc + ' y el cliente pidió ' + sol.rfc + '.');
    if (cfdi.total !== null && cfdi.total !== undefined && Math.abs(num(cfdi.total) - num(sol.total)) > 0.02) av.push('El total del XML es $' + num(cfdi.total).toFixed(2) + ' y el ticket es $' + num(sol.total).toFixed(2) + '.');
    return av;
  }
  function leerCfdi(texto) {
    var comp = (texto.match(/<(?:[\w-]+:)?Comprobante\b[^>]*>/) || [])[0];
    if (!comp) return null;
    function atr(et, n) { var m = et && et.match(new RegExp('\\s' + n + '\\s*=\\s*"([^"]*)"')); return m ? m[1].trim() : null; }
    var rec = (texto.match(/<(?:[\w-]+:)?Receptor\b[^>]*>/) || [])[0], tim = (texto.match(/<(?:[\w-]+:)?TimbreFiscalDigital\b[^>]*>/) || [])[0];
    var total = Number(atr(comp, 'Total'));
    return { uuid: (atr(tim, 'UUID') || '').toUpperCase() || null, rfc: (atr(rec, 'Rfc') || '').toUpperCase() || null, total: isFinite(total) ? Math.round(total * 100) / 100 : null };
  }
  function decodificar(base64) {
    var b = String(base64 || '').replace(/^data:[^;]*;base64,/, '');
    try { return atob(b); } catch (e) { return ''; }
  }
  // PDF y XML de ejemplo para la factura "facturada" de muestra (se arman al vuelo, no ocupan espacio).
  function pdfDeEjemplo(f) {
    var txt = 'Factura de ejemplo - Demo Compoint Punto - Ticket ' + f.folio + ' - ' + f.razon_social;
    txt = txt.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[()\\]/g, '');
    var flujo = 'BT /F1 14 Tf 40 760 Td (' + txt + ') Tj ET';
    var objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      '<< /Length ' + flujo.length + ' >>\nstream\n' + flujo + '\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    var out = '%PDF-1.4\n', pos = [];
    objs.forEach(function (o, i) { pos.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
    var x = out.length;
    out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + pos.map(function (p) { return String(p).padStart(10, '0') + ' 00000 n \n'; }).join('') +
      'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + x + '\n%%EOF';
    return new Blob([out], { type: 'application/pdf' });
  }
  function xmlDeEjemplo(f) {
    return new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Total="' + num(f.total).toFixed(2) + '">\n' +
      '  <cfdi:Receptor Rfc="' + f.rfc + '" Nombre="' + f.razon_social + '"/>\n  <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="' + (f.uuid_factura || '') + '"/></cfdi:Complemento>\n' +
      '  <!-- Factura de EJEMPLO de la demo de Compoint Punto: no tiene validez fiscal -->\n</cfdi:Comprobante>\n'], { type: 'text/plain;charset=utf-8' });
  }
  var MAX_ARCHIVO_DEMO = 400 * 1024; // el navegador guarda poco: en la demo solo archivos chicos
  R('POST', '/facturacion/:id/archivos', function (c) {
    M.requiereRol(c, ['dueno', 'jefe_general', 'gerente']);
    var X = asegurar(), f = M.porId(X.facturas, c.params.id), b = c.body || {};
    if (!f) fallo(404, 'Solicitud no encontrada');
    if (!(b.pdf && b.pdf.base64) && !(b.xml && b.xml.base64)) fallo(400, 'Elige el PDF o el XML de la factura');
    var lectura = null;
    f.archivos = f.archivos || {};
    ['pdf', 'xml'].forEach(function (tipo) {
      var a = b[tipo]; if (!a || !a.base64) return;
      var datos = decodificar(a.base64);
      if (!datos.length) fallo(400, 'El ' + tipo.toUpperCase() + ' está vacío');
      if (datos.length > MAX_ARCHIVO_DEMO) fallo(400, 'En la demo solo se pueden subir archivos de hasta 400 KB (en tu sistema, hasta 3 MB).');
      if (tipo === 'pdf' && datos.slice(0, 5) !== '%PDF-') fallo(400, 'El archivo de la factura no es un PDF');
      if (tipo === 'xml') {
        var txt; try { txt = decodeURIComponent(escape(datos)); } catch (e) { txt = datos; }
        lectura = leerCfdi(txt.replace(/^\uFEFF/, ''));
        if (!lectura) fallo(400, 'El archivo no es el XML de una factura (CFDI). Sube el .xml que te dio el SAT o tu programa.');
        f.factura_rfc = lectura.rfc; f.factura_total = lectura.total; if (lectura.uuid) f.uuid_factura = lectura.uuid;
      }
      f.archivos[tipo] = 'data:' + (tipo === 'pdf' ? 'application/pdf' : 'text/plain') + ';base64,' + btoa(datos);
      f['factura_' + tipo + '_nombre'] = String(a.nombre || ('factura.' + tipo)).slice(0, 120);
      f['tiene_' + tipo] = true;
    });
    f.factura_subida_en = M.iso(M.ahora()); f.actualizado_en = f.factura_subida_en;
    if (!f.clave_descarga) f.clave_descarga = 'DEMO' + Date.now().toString(36).toUpperCase();
    M.bitacora(c, 'subir_factura', 'facturacion', f.id, { folio: f.folio, pdf: !!b.pdf, xml: !!b.xml });
    return { ok: true, lectura: lectura, avisos: lectura ? revisarCfdi(lectura, f) : [] };
  });
  R('GET', '/facturacion/:id/archivos/:tipo', function (c) {
    var X = asegurar(), f = M.porId(X.facturas, c.params.id), tipo = c.params.tipo;
    if (!f || ['pdf', 'xml'].indexOf(tipo) === -1) fallo(404, 'Solicitud no encontrada');
    if (!f['tiene_' + tipo]) fallo(404, 'Esta solicitud no tiene ' + tipo.toUpperCase());
    var guardado = f.archivos && f.archivos[tipo];
    var blob = guardado ? M.dataUrlABlob(guardado, tipo === 'pdf' ? 'application/pdf' : 'text/plain;charset=utf-8') : (tipo === 'pdf' ? pdfDeEjemplo(f) : xmlDeEjemplo(f));
    return { __blob: blob, __tipo: tipo === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8' };
  });
  R('DELETE', '/facturacion/:id/archivos/:tipo', function (c) {
    M.requiereRol(c, ['dueno', 'jefe_general', 'gerente']);
    var X = asegurar(), f = M.porId(X.facturas, c.params.id), tipo = c.params.tipo;
    if (!f || ['pdf', 'xml'].indexOf(tipo) === -1) fallo(404, 'Solicitud no encontrada');
    if (f.archivos) delete f.archivos[tipo];
    f['tiene_' + tipo] = false; f['factura_' + tipo + '_nombre'] = null;
    if (tipo === 'xml') { f.factura_rfc = null; f.factura_total = null; }
    f.actualizado_en = M.iso(M.ahora());
    return { ok: true };
  });

  R('POST', '/facturacion/publico/validar', function (c) {
    var folio = String((c.body && c.body.folio) || '').trim().toUpperCase();
    var t = db().tickets.filter(function (x) { return String(x.folio).toUpperCase() === folio && x.estado === 'pagado'; })[0];
    if (!t) fallo(404, 'No encontramos un ticket pagado con ese folio. Revisa que esté completo.');
    return { ok: true, folio: t.folio, total: t.total, fecha: t.fecha_pago };
  });
  R('POST', '/facturacion/publico/solicitar', function () {
    fallo(400, 'En la demo no se reciben solicitudes de factura reales. En tu negocio, tus clientes la piden desde aquí con el folio de su ticket.');
  });
  R('POST', '/facturacion/publico/estado', function () { fallo(404, 'En la demo no hay solicitudes reales que consultar.'); });

  // ---------- Compras ----------
  R('GET', '/compras/resumen-proveedores', function () {
    var por = {};
    db().compras.forEach(function (c) {
      var r = por[c.proveedor_id] || (por[c.proveedor_id] = { proveedor_id: c.proveedor_id, num_compras: 0, total_comprado: 0, ultima_compra: c.fecha });
      r.num_compras++; r.total_comprado = redondea(r.total_comprado + num(c.total)); if (c.fecha > r.ultima_compra) r.ultima_compra = c.fecha;
    });
    return Object.keys(por).map(function (k) { return por[k]; });
  });
  R('GET', '/compras/:id/detalle', function (c) {
    var id = parseInt(c.params.id, 10);
    return db().compra_detalle.filter(function (d) { return d.compra_id === id; }).map(function (d) {
      var p = M.porId(db().productos, d.producto_id) || {};
      return { producto_id: d.producto_id, nombre: p.nombre, tipo_venta: p.tipo_venta, cantidad: d.cantidad, costo_unitario: d.costo_unitario, precio_venta_nuevo: d.precio_venta_nuevo, subtotal: d.subtotal };
    });
  });

  // ---------- Reporte de pérdidas (cancelaciones y devoluciones) ----------
  R('GET', '/reportes/perdidas', function (c) {
    var D = db(), r = M.resolverRango(c.query);
    var canc = D.tickets.filter(function (t) { return t.estado === 'cancelado' && M.enRango(t.fecha_creacion, r.desde, r.hasta); });
    var devo = D.devoluciones.filter(function (d) { return M.enRango(d.fecha, r.desde, r.hasta); });
    var ventas = M.pagadosEn(r);
    var serie = {}, motivos = {}, usuarios = {}, porHora = [];
    for (var h = 0; h < 24; h++) porHora.push({ hora: h, cancelaciones: 0, monto: 0 });
    function fila(f) { var k = M.fechaLocalStr(f); return serie[k] || (serie[k] = { clave: k, cancelaciones: 0, monto_cancelado: 0, devoluciones: 0, monto_devuelto: 0, fichas: 0, fichas_atendidas: 0, ventas: 0, tickets_pagados: 0 }); }
    for (var d = new Date(r.desde); d < r.hasta && Object.keys(serie).length < 400; d.setDate(d.getDate() + 1)) fila(d);
    function suma(mapa, clave, campo, monto, extra) { var o = mapa[clave] || (mapa[clave] = Object.assign({ cancelaciones: 0, devoluciones: 0, monto: 0 }, extra)); o[campo]++; o.monto = redondea(o.monto + monto); }
    var montoC = 0, montoD = 0, vendido = 0;
    canc.forEach(function (t) {
      var m = num(t.total); montoC += m; var f = fila(t.fecha_creacion); f.cancelaciones++; f.monto_cancelado += m;
      var hh = new Date(t.fecha_creacion).getHours(); porHora[hh].cancelaciones++; porHora[hh].monto += m;
      var mot = t.motivo_cancelacion || 'Sin motivo', us = M.usuarioNombre(t.cajero_usuario_id || t.mostrador_usuario_id) || 'Sin usuario';
      suma(motivos, mot, 'cancelaciones', m, { motivo: mot }); suma(usuarios, us, 'cancelaciones', m, { usuario: us });
    });
    devo.forEach(function (x) {
      var m = num(x.monto_total); montoD += m; var f = fila(x.fecha); f.devoluciones++; f.monto_devuelto += m;
      var mot = x.motivo || 'Sin motivo', us = M.usuarioNombre(x.usuario_id) || 'Sin usuario';
      suma(motivos, mot, 'devoluciones', m, { motivo: mot }); suma(usuarios, us, 'devoluciones', m, { usuario: us });
    });
    ventas.forEach(function (t) { var f = fila(t.fecha_pago); f.ventas += num(t.total); f.tickets_pagados++; vendido += num(t.total); });
    var perdido = montoC + montoD;
    var ordenar = function (o) { return Object.keys(o).map(function (k) { return o[k]; }).sort(function (a, b) { return b.monto - a.monto; }).slice(0, 10); };
    return {
      granularidad: 'dia',
      resumen: { cancelaciones: canc.length, monto_cancelado: redondea(montoC), devoluciones: devo.length, monto_devuelto: redondea(montoD), fichas_canceladas: 0,
        total_perdido: redondea(perdido), total_vendido: redondea(vendido), porcentaje_sobre_ventas: (vendido + perdido) > 0 ? perdido / (vendido + perdido) * 100 : 0 },
      serie: Object.keys(serie).sort().map(function (k) { return serie[k]; }),
      por_hora: porHora, por_usuario: ordenar(usuarios), motivos: ordenar(motivos), top_productos: [],
      ultimas_cancelaciones: canc.slice(-15).reverse().map(function (t) { return { folio: t.folio, fecha: t.fecha_creacion, total: num(t.total), usuario: M.usuarioNombre(t.cajero_usuario_id || t.mostrador_usuario_id), motivo: t.motivo_cancelacion || null }; })
    };
  });

  // ---------- Otros que agregó la versión actual ----------
  R('PUT', '/kits/:id', function (c) {
    M.requierePermiso(c, 'PRODUCTOS_EDITAR');
    var D = db(), k = M.porId(D.kits, c.params.id), b = c.body || {};
    if (!k) fallo(404, 'Kit no encontrado');
    ['nombre', 'precio_kit', 'codigo_barras', 'imagen_url', 'activo'].forEach(function (f) { if (b[f] !== undefined) k[f] = f === 'precio_kit' ? num(b[f]) : b[f]; });
    if (Array.isArray(b.productos)) {
      D.kit_productos = D.kit_productos.filter(function (kp) { return kp.kit_id !== k.id; });
      b.productos.forEach(function (p) { D.kit_productos.push({ kit_id: k.id, producto_id: parseInt(p.producto_id, 10), cantidad: num(p.cantidad) }); });
    }
    M.bitacora(c, 'editar_kit', 'kits', k.id);
    return clonar(k);
  });
  R('DELETE', '/usuarios/:id', function (c) {
    M.requiereRol(c, ['dueno', 'jefe_general', 'gerente']);
    var u = M.porId(db().usuarios, c.params.id);
    if (!u) fallo(404, 'Usuario no encontrado');
    if (u.id === c.user.id) fallo(400, 'No puedes eliminar tu propio usuario');
    if (u.id <= 4) fallo(400, 'En la demo no se pueden eliminar los usuarios de prueba. Crea uno nuevo y elimina ese.');
    u.activo = false; M.bitacora(c, 'eliminar_usuario', 'usuarios', u.id);
    return { ok: true };
  });
  R('POST', '/sucursales', function (c) {
    M.requiereRol(c, ['jefe_general']);
    fallo(400, 'En la demo hay una sola sucursal. En tu negocio puedes tener varias, cada una con su propio catálogo.');
  });
  R('PUT', '/sucursales/:id', function (c) {
    M.requiereRol(c, ['jefe_general']);
    var s = db().sucursal, b = c.body || {};
    ['nombre', 'direccion', 'telefono'].forEach(function (f) { if (b[f] !== undefined) s[f] = b[f]; });
    return clonar(s);
  });
  R('GET', '/fichas/proximas', function () {
    return (db().fichas || []).filter(function (f) { return f.estado === 'esperando' || f.estado === 'pendiente'; }).slice(0, 5)
      .map(function (f) { return { id: f.id, numero: f.numero }; });
  });
  R('POST', '/clientes/importar', function (c) {
    M.requierePermiso(c, 'CLIENTES_CREAR');
    var lista = (c.body && c.body.clientes) || [];
    return { creados: 0, actualizados: 0, omitidos: lista.length, errores: ['La importación de clientes no está disponible en la demo'] };
  });
  R('POST', '/tickets/venta-offline', function () { fallo(400, 'La venta sin internet no aplica en la demo.'); });
  R('POST', '/tickets/pendiente-offline', function () { fallo(400, 'La venta sin internet no aplica en la demo.'); });

  // ======================================================================
  // Versión 1.2.1: entrada (versión visible), términos, correo del dueño,
  // recargas y pago de servicios en MODO PRÁCTICA.
  // ======================================================================
  var VERSION_SISTEMA = '1.3.0';

  // Pantalla de entrada: negocio, sucursal, licencia y versión (sin sesión iniciada).
  R('GET', '/auth/info-login', function () {
    var l = estadoLicencia(), D = db();
    return { negocio: D.configuracion.nombre_negocio, sucursal: D.sucursal ? D.sucursal.nombre : null,
      licencia: { estado: l.estado, tipo: l.tipo, dias: l.dias }, version: VERSION_SISTEMA };
  });
  // Recuperar contraseña por correo: en la demo no se manda nada (la contraseña de todos es «demo»).
  ['solicitar', 'verificar', 'restablecer'].forEach(function (paso) {
    R('POST', '/auth/recuperar/' + paso, function () {
      fallo(400, 'En la demo no se mandan códigos por correo: la contraseña de todos los usuarios es «demo».');
    });
  });
  R('GET', '/auth/mi-correo', function (c) {
    M.requiereRol(c, ['dueno']);
    var X = asegurar(); return { correo: X.correo_dueno || null };
  });
  R('PUT', '/auth/mi-correo', function (c) {
    M.requiereRol(c, ['dueno']);
    var b = c.body || {}, correo = String(b.correo || '').trim().toLowerCase();
    if (!b.password_actual || b.password_actual !== c.user.password) fallo(401, 'La contraseña actual es incorrecta');
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) fallo(400, 'El correo no es válido');
    var X = asegurar(); X.correo_dueno = correo || null;
    return { ok: true, correo: X.correo_dueno };
  });

  // Términos y condiciones: en la demo ya están aceptados (la ventana nunca sale).
  R('GET', '/terminos/estado', function () {
    return { version: '2026-10-28', aceptado: true, aceptado_por: 'Demo Dueño', aceptado_en: M.iso(M.haceHoras(24)), puede_aceptar: false, sin_dato: false };
  });
  R('POST', '/terminos/aceptar', function () { return { ok: true, ya_estaba: true, version: '2026-10-28' }; });

  // ----- Recargas de tiempo aire, paquetes y pago de servicios (modo práctica) -----
  // Copia del catálogo de backend/utils/proveedorRecargas.js (CATALOGO_REFERENCIA).
  var MONTOS_COMUNES = [10, 20, 30, 50, 100, 150, 200, 300, 500];
  var DETALLE_PAQ = 'Llamadas, mensajes, redes e internet';
  function paq(cia, nombre, montos, detalle) { return montos.map(function (m) { return { codigo: cia + '-' + m, nombre: nombre, monto: m, detalle: detalle }; }); }
  var CATALOGO = [
    { codigo: 'telcel', nombre: 'Telcel', tipo: 'recarga', color: '#0A3D91', montos: [10, 20, 30, 50, 80, 100, 150, 200, 300, 500],
      paquetes: paq('telcel', 'Amigo Sin Límite', [50, 100, 150, 200, 300, 500], DETALLE_PAQ) },
    { codigo: 'att', nombre: 'AT&T', tipo: 'recarga', color: '#0095D9', montos: MONTOS_COMUNES,
      paquetes: paq('att', 'Unidos', [50, 100, 150, 200, 300], DETALLE_PAQ) },
    { codigo: 'movistar', nombre: 'Movistar', tipo: 'recarga', color: '#019DF4', montos: MONTOS_COMUNES,
      paquetes: paq('movistar', 'Internet + redes', [50, 100, 150, 200], DETALLE_PAQ) },
    { codigo: 'unefon', nombre: 'Unefon', tipo: 'recarga', color: '#E5A800', montos: MONTOS_COMUNES,
      paquetes: paq('unefon', 'Paquete', [50, 100, 150, 200], DETALLE_PAQ) },
    { codigo: 'bait', nombre: 'Bait', tipo: 'recarga', color: '#1D4F9C', montos: [30, 50, 100, 150, 200, 300],
      paquetes: paq('bait', 'Paquete', [100, 150, 200], DETALLE_PAQ) },
    { codigo: 'virgin', nombre: 'Virgin', tipo: 'recarga', color: '#D7192D', montos: [20, 30, 50, 100, 150, 200] },
    { codigo: 'cfe', nombre: 'CFE (luz)', tipo: 'servicio', color: '#00843D', etiqueta: 'Número de servicio (12 dígitos del recibo)' },
    { codigo: 'telmex', nombre: 'Telmex', tipo: 'servicio', color: '#0066B3', etiqueta: 'Teléfono a 10 dígitos' },
    { codigo: 'siapa', nombre: 'SIAPA (agua)', tipo: 'servicio', color: '#1C8DD0', etiqueta: 'Número de cuenta del recibo' },
    { codigo: 'izzi', nombre: 'izzi', tipo: 'servicio', color: '#00A19B', etiqueta: 'Número de cuenta' },
    { codigo: 'totalplay', nombre: 'Totalplay', tipo: 'servicio', color: '#7AB929', etiqueta: 'Número de cuenta' },
    { codigo: 'megacable', nombre: 'Megacable', tipo: 'servicio', color: '#E4002B', etiqueta: 'Número de contrato' },
    { codigo: 'sky', nombre: 'SKY', tipo: 'servicio', color: '#0B4EA2', etiqueta: 'Número de cuenta' }
  ];
  var SERVICIO_MAX = 10000, MINUTOS_REPETIDA = 3;
  function configRecargas() {
    var X = asegurar();
    if (!X.recargas_config) X.recargas_config = { activo: true, cargo_servicio: 10, comision_pct: 0 };
    return X.recargas_config;
  }
  function ventasRecargas() { var D = db(); if (!D.recargas_ventas) D.recargas_ventas = []; return D.recargas_ventas; }
  R('GET', '/recargas/estado', function () {
    var cfg = configRecargas();
    return { configurado: false, modo: 'prueba', activo: !!cfg.activo, cargo_servicio: num(cfg.cargo_servicio), comision_pct: num(cfg.comision_pct) };
  });
  R('GET', '/recargas/catalogo', function () { return clonar(CATALOGO); });
  R('GET', '/recargas/saldo', function (c) { M.requiereRol(c, ['jefe_general', 'dueno', 'gerente']); return { saldo: 5000, prueba: true }; });
  R('PUT', '/recargas/config', function (c) {
    M.requiereRol(c, ['jefe_general', 'dueno', 'gerente']);
    var cfg = configRecargas(), b = c.body || {};
    var activo = b.activo === undefined ? cfg.activo : b.activo === true;
    var cargo = b.cargo_servicio === undefined ? cfg.cargo_servicio : Number(b.cargo_servicio);
    var pct = b.comision_pct === undefined ? cfg.comision_pct : Number(b.comision_pct);
    if (!(isFinite(cargo) && cargo >= 0 && cargo <= 200)) fallo(400, 'La comisión por servicio debe ser de $0 a $200');
    if (!(isFinite(pct) && pct >= 0 && pct <= 30)) fallo(400, 'El porcentaje del proveedor debe ser de 0 a 30');
    cfg.activo = activo; cfg.cargo_servicio = redondea(cargo); cfg.comision_pct = redondea(pct);
    M.bitacora(c, 'config_recargas', 'recargas', null, clonar(cfg));
    return clonar(cfg);
  });
  R('POST', '/recargas/vender', function (c) {
    M.requierePermiso(c, 'RECARGAS_VENDER');
    var b = c.body || {}, cfg = configRecargas(), D = db();
    if (!cfg.activo) fallo(403, 'Las recargas están apagadas. El dueño las puede encender en Configuración.');
    var item = CATALOGO.filter(function (x) { return x.codigo === String(b.compania || ''); })[0];
    if (!item) fallo(400, 'Elige una compañía de la lista');
    var referencia = String(b.referencia || '').replace(/[\s-]/g, '');
    var paquete = null;
    if (b.paquete !== undefined && b.paquete !== null && b.paquete !== '') {
      paquete = item.tipo === 'recarga' ? (item.paquetes || []).filter(function (p) { return p.codigo === String(b.paquete); })[0] || null : null;
      if (!paquete) fallo(400, 'Ese paquete no existe para ' + item.nombre);
    }
    var monto = Number(b.monto);
    if (item.tipo === 'recarga') {
      if (!/^\d{10}$/.test(referencia)) fallo(400, 'El número de celular debe tener 10 dígitos');
      if (paquete) monto = paquete.monto;
      else if (item.montos.indexOf(monto) === -1) fallo(400, 'Ese monto no existe para ' + item.nombre);
    } else {
      if (!/^[0-9A-Za-z]{6,30}$/.test(referencia)) fallo(400, 'Revisa el número del recibo: solo números y letras, de 6 a 30');
      if (!(isFinite(monto) && monto >= 1 && monto <= SERVICIO_MAX)) fallo(400, 'El monto del recibo debe ser de $1 a $' + SERVICIO_MAX.toLocaleString('es-MX'));
      monto = redondea(monto);
    }
    var metodo = String(b.metodo_pago || 'efectivo');
    if (['efectivo', 'tarjeta'].indexOf(metodo) === -1) fallo(400, 'Forma de pago no válida (efectivo o tarjeta)');
    var clave = b.clave === undefined || b.clave === null || b.clave === '' ? null : String(b.clave);
    if (clave !== null && !/^[A-Za-z0-9-]{8,40}$/.test(clave)) fallo(400, 'Clave de operación no válida');
    // Turno abierto del propio cajero (igual que al cobrar)
    var turno = M.porId(D.turnos, b.turno_id);
    if (!turno || turno.estado !== 'abierto') fallo(400, 'Necesitas un turno de caja abierto para vender recargas. Abre tu caja primero.');
    if (turno.usuario_id !== c.user.id && ['dueno', 'gerente', 'jefe_general'].indexOf(c.user.rol) === -1) fallo(403, 'Ese turno es de otro cajero');
    var cargo = item.tipo === 'servicio' ? redondea(cfg.cargo_servicio) : 0, total = redondea(monto + cargo);
    var lista = ventasRecargas();
    if (clave) {
      var ya = lista.filter(function (r) { return r.clave === clave; })[0];
      if (ya) { var o1 = clonar(ya); o1.repetida_clic = true; o1.modo = 'prueba'; return o1; }
    }
    if (b.confirmar_repetida !== true) {
      var limite = Date.now() - MINUTOS_REPETIDA * 60000;
      var rep = lista.filter(function (r) { return r.referencia === referencia && r.monto === monto && (r.estado === 'exitosa' || r.estado === 'pendiente') && new Date(r.fecha).getTime() > limite; })[0];
      if (rep) { var e = new Error('rep'); e.status = 409; e.apiError = 'Hace menos de ' + MINUTOS_REPETIDA + ' minutos ya se hizo esta misma ' + (item.tipo === 'recarga' ? 'recarga' : 'operación') + ' a ese número. ¿Seguro que quieres hacerla otra vez?'; e.extra = { repetida: true }; throw e; }
    }
    var id = M.sig('recarga');
    // Simulación del proveedor: un número que termina en 0000 sale "rechazado" para poder probar ese caso.
    var rechazada = /0000$/.test(referencia);
    var fila = { id: id, sucursal_id: 1, turno_id: turno.id, usuario_id: c.user.id, tipo: item.tipo, compania: item.codigo, referencia: referencia,
      monto: monto, cargo: cargo, total: total, metodo_pago: metodo, estado: rechazada ? 'fallida' : 'exitosa', modo_prueba: true, clave: clave,
      producto: paquete ? paquete.nombre : null, folio_proveedor: rechazada ? null : 'PRUEBA-' + String(id).padStart(6, '0'),
      mensaje: rechazada ? 'Número rechazado por la compañía (simulado)' : 'Venta de práctica de la demo: no se envió saldo real', fecha: M.iso(M.ahora()) };
    lista.push(fila);
    if (lista.length > 200) lista.splice(0, lista.length - 200);
    M.bitacora(c, item.tipo === 'recarga' ? 'venta_recarga' : 'pago_servicio', 'recargas', id, { compania: item.codigo, paquete: fila.producto, referencia: referencia, monto: monto, total: total, estado: fila.estado, prueba: true });
    var o = clonar(fila); o.modo = 'prueba'; return o;
  });
  R('GET', '/recargas/ventas', function (c) {
    var sup = ['dueno', 'gerente', 'jefe_general'].indexOf(c.user.rol) !== -1, tid = parseInt(c.query.turno_id, 10);
    var desde = M.inicioDelDia().getTime() - 86400000;
    return ventasRecargas().filter(function (r) {
      if (tid > 0) { if (r.turno_id !== tid) return false; } else if (new Date(r.fecha).getTime() < desde) return false;
      return sup || r.usuario_id === c.user.id;
    }).sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; }).slice(0, 200).map(function (r) {
      return { id: r.id, tipo: r.tipo, compania: r.compania, referencia: r.referencia, monto: r.monto, cargo: r.cargo, total: r.total, metodo_pago: r.metodo_pago,
        estado: r.estado, modo_prueba: r.modo_prueba, folio_proveedor: r.folio_proveedor, mensaje: r.mensaje, fecha: r.fecha, producto: r.producto, cajero: M.usuarioNombre(r.usuario_id) };
    });
  });
})();
