// Datos del negocio y "código de solicitud" para contratar o renovar Compoint Punto.
// Todo aquí es puro (sin base de datos ni red), para poder probarlo fácil.
//
// El CÓDIGO DE SOLICITUD es lo que el cliente le manda a Compoint (por correo automático,
// WhatsApp, copiado o archivo). Lleva el ID del equipo y los datos del negocio, para que
// el "Activador Compoint" arme el código de activación sin volver a capturar nada.
//
// Formato:   CPT-REQ-<base64url( deflate-raw( JSON ))>.<4 caracteres de control>
//   - JSON (UTF-8):  { v:1, tipo, plan, sucursales, id_equipo, fecha, app, prueba_dias_restantes,
//                      negocio:{...}, nota, paquete?, periodo? }   (paquete/periodo: desde 2026-10-28)
//   - Control: primeros 4 caracteres hexadecimales de sha256 del texto base64url (detecta
//     que el código llegó cortado o con un caracter cambiado).
// No está firmado ni cifrado: no necesita estarlo (es una solicitud, no una licencia). Quien
// lo vea solo ve los datos que el propio cliente decidió enviar.
const zlib = require('zlib');
const precios = require('./precios');
const crypto = require('crypto');

const PREFIJO = 'CPT-REQ-';
const VERSION_AVISO = 1; // sube si cambia el texto del aviso de privacidad

// Campos del negocio: [clave, largo máximo]
const LIMITES = {
  negocio: 60, giro: 60, nombre_dueno: 80, telefono: 20, whatsapp: 20, email: 80,
  direccion: 120, ciudad: 60, estado: 40, cp: 5,
  rfc: 13, razon_social: 100, cp_fiscal: 5, email_factura: 80
};
const CAMPOS = Object.keys(LIMITES);

const ETIQUETAS = {
  negocio: 'Nombre del negocio', giro: 'Giro', nombre_dueno: 'Nombre del dueño o contacto',
  telefono: 'Teléfono', whatsapp: 'WhatsApp', email: 'Correo', direccion: 'Dirección',
  ciudad: 'Ciudad', estado: 'Estado', cp: 'Código postal',
  rfc: 'RFC', razon_social: 'Razón social', cp_fiscal: 'C.P. fiscal', email_factura: 'Correo para factura'
};

const PLANES = { local: 'Sin nube (trabaja sin internet)', nube: 'Con servicio en la nube' };

// Texto de una sola línea, sin caracteres raros, recortado.
function limpiarLinea(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const reEmail = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const reRfc = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

/**
 * Limpia y valida los datos del negocio.
 * @param {object} entrada  lo que mandó la pantalla
 * @param {{contratar?:boolean}} opciones  contratar=true exige nombre, contacto y teléfono/WhatsApp
 * @returns {{ok:boolean, datos:object, errores:object}}  errores = { campo: 'mensaje' }
 */
function normalizarDatos(entrada, { contratar = false } = {}) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const datos = {};
  const errores = {};
  for (const c of CAMPOS) datos[c] = limpiarLinea(e[c], LIMITES[c]);

  datos.rfc = datos.rfc.replace(/\s+/g, '').toUpperCase();
  datos.cp = datos.cp.replace(/\s+/g, '');
  datos.cp_fiscal = datos.cp_fiscal.replace(/\s+/g, '');
  datos.email = datos.email.toLowerCase();
  datos.email_factura = datos.email_factura.toLowerCase();

  const sucursales = e.sucursales === undefined || e.sucursales === null || e.sucursales === '' ? null : Number(e.sucursales);
  if (sucursales !== null && (!Number.isInteger(sucursales) || sucursales < 1 || sucursales > 50)) {
    errores.sucursales = 'Las sucursales deben ser un número entre 1 y 50.';
  }
  datos.sucursales = sucursales;

  if (!datos.negocio) errores.negocio = 'Escribe el nombre de tu negocio.';
  for (const c of ['telefono', 'whatsapp']) {
    if (datos[c] && (!/^[0-9 +()\-.]+$/.test(datos[c]) || datos[c].replace(/\D/g, '').length < 10)) {
      errores[c] = 'Escribe el número completo, con lada (10 dígitos).';
    }
  }
  for (const c of ['email', 'email_factura']) {
    if (datos[c] && !reEmail.test(datos[c])) errores[c] = 'Ese correo no parece correcto.';
  }
  if (datos.cp && !/^\d{5}$/.test(datos.cp)) errores.cp = 'El código postal tiene 5 números.';
  if (datos.cp_fiscal && !/^\d{5}$/.test(datos.cp_fiscal)) errores.cp_fiscal = 'El código postal tiene 5 números.';
  if (datos.rfc && !reRfc.test(datos.rfc)) errores.rfc = 'El RFC no parece correcto (12 o 13 caracteres, sin espacios).';

  if (contratar) {
    if (!datos.nombre_dueno) errores.nombre_dueno = 'Escribe tu nombre para saber con quién hablar.';
    if (!datos.telefono && !datos.whatsapp) errores.whatsapp = 'Escribe un WhatsApp o teléfono para poder contactarte.';
  }
  return { ok: Object.keys(errores).length === 0, datos, errores };
}

// ¿Ya capturó lo mínimo para que Compoint lo pueda contactar?
function datosCompletos(d) {
  return !!(d && d.negocio && d.nombre_dueno && (d.telefono || d.whatsapp));
}

// ---------- código de solicitud ----------
const aBase64Url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deBase64Url = (t) => Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const control = (texto) => crypto.createHash('sha256').update('cpt-req|' + texto).digest('hex').slice(0, 4).toUpperCase();

function negocioCompacto(datos) {
  const salida = {};
  for (const c of CAMPOS) if (datos && datos[c]) salida[c] = datos[c];
  return salida;
}

/**
 * Arma el código de solicitud.
 * @param {{tipo:'contratar'|'renovar', plan:'local'|'nube', sucursales:number, idEquipo:string,
 *          datos:object, nota?:string, fecha:string, app?:string, pruebaDiasRestantes?:number|null}} p
 */
function construirCodigo(p) {
  const json = {
    v: 1,
    tipo: p.tipo === 'renovar' ? 'renovar' : 'contratar',
    plan: p.plan === 'local' ? 'local' : 'nube',
    sucursales: Number(p.sucursales) || 1,
    id_equipo: p.idEquipo,
    fecha: p.fecha,
    negocio: negocioCompacto(p.datos)
  };
  if (json.plan === 'nube' && precios.COPIA.paquetes[p.paquete]) json.paquete = p.paquete;
  if (json.plan === 'nube' && precios.PERIODOS.includes(p.periodo)) json.periodo = p.periodo;
  if (p.app) json.app = String(p.app).slice(0, 20);
  if (p.pruebaDiasRestantes != null) json.prueba_dias_restantes = p.pruebaDiasRestantes;
  const nota = limpiarLinea(p.nota, 300);
  if (nota) json.nota = nota;
  const cuerpo = aBase64Url(zlib.deflateRawSync(Buffer.from(JSON.stringify(json), 'utf8'), { level: 9 }));
  return PREFIJO + cuerpo + '.' + control(cuerpo);
}

/** Lee un código de solicitud (tolera texto alrededor, saltos de línea y espacios). */
function leerCodigo(texto) {
  const t = String(texto || '');
  const i = t.indexOf(PREFIJO);
  if (i < 0) return { ok: false, motivo: 'prefijo', mensaje: 'No encontré un código de solicitud (empieza con CPT-REQ-).' };
  const resto = t.slice(i + PREFIJO.length);
  const m = /^((?:[A-Za-z0-9_\-]\s*)+)\.\s*([0-9A-Fa-f]\s*[0-9A-Fa-f]\s*[0-9A-Fa-f]\s*[0-9A-Fa-f])/.exec(resto);
  if (!m) return { ok: false, motivo: 'formato', mensaje: 'El código de solicitud está incompleto o cortado.' };
  const cuerpo = m[1].replace(/\s+/g, '');
  const ck = m[2].replace(/\s+/g, '').toUpperCase();
  if (ck !== control(cuerpo)) return { ok: false, motivo: 'control', mensaje: 'El código de solicitud llegó dañado (revisa que se copió completo).' };
  try {
    const datos = JSON.parse(zlib.inflateRawSync(deBase64Url(cuerpo), { maxOutputLength: 20000 }).toString('utf8'));
    if (!datos || datos.v !== 1) return { ok: false, motivo: 'version', mensaje: 'Este código de solicitud es de una versión que no conozco.' };
    return { ok: true, datos };
  } catch (e) {
    return { ok: false, motivo: 'formato', mensaje: 'No se pudo leer el código de solicitud.' };
  }
}

// ---------- textos ----------
function lineasNegocio(d, { fiscal = true } = {}) {
  const l = [];
  const dir = [d.direccion, d.ciudad, d.estado, d.cp ? 'C.P. ' + d.cp : ''].filter(Boolean).join(', ');
  if (d.negocio) l.push(`Negocio: ${d.negocio}`);
  if (d.giro) l.push(`Giro: ${d.giro}`);
  if (d.nombre_dueno) l.push(`Dueño o contacto: ${d.nombre_dueno}`);
  if (d.whatsapp) l.push(`WhatsApp: ${d.whatsapp}`);
  if (d.telefono) l.push(`Teléfono: ${d.telefono}`);
  if (d.email) l.push(`Correo: ${d.email}`);
  if (dir) l.push(`Dirección: ${dir}`);
  if (fiscal && (d.rfc || d.razon_social || d.cp_fiscal || d.email_factura)) {
    l.push('Datos para factura:');
    if (d.razon_social) l.push(`  Razón social: ${d.razon_social}`);
    if (d.rfc) l.push(`  RFC: ${d.rfc}`);
    if (d.cp_fiscal) l.push(`  C.P. fiscal: ${d.cp_fiscal}`);
    if (d.email_factura) l.push(`  Correo para factura: ${d.email_factura}`);
  }
  return l;
}

/** "Negocio · Anual ($4,990)" según lo que eligió (vacío si no eligió paquete/periodo). */
function detallePlan(s, lista) {
  if (s.plan !== 'local' && !s.paquete && !s.periodo) return '';
  const L = lista || precios.COPIA;
  const renovarLocal = s.plan === 'local' && s.tipo === 'renovar';
  const t = s.plan !== 'local' ? precios.textoPlan(L, s.plan, s.paquete, s.periodo) : (renovarLocal ? 'Renovación de actualizaciones y soporte' : 'Pago único');
  const p = renovarLocal ? L.sin_nube.renovacion_anual : precios.precio(L, s.plan, s.paquete, s.periodo);
  return t + (p != null ? ` ($${Number(p).toLocaleString('en-US')})` : '');
}
const planCorto = (s) => (s.plan === 'local' ? 'Sin nube' : 'Con nube') + (detallePlan(s) ? ' · ' + detallePlan(s) : '');

const textoTipo = (tipo) => (tipo === 'renovar' ? 'renovar' : 'contratar');

/** Mensaje de WhatsApp (corto y con el código al final). */
function mensajeWhatsApp(s) {
  const d = s.datos || {};
  const contacto = [d.nombre_dueno, d.whatsapp || d.telefono].filter(Boolean).join(' · ');
  const l = [`Hola Compoint, quiero ${textoTipo(s.tipo)} Compoint Punto.`];
  if (d.negocio) l.push(`Negocio: ${d.negocio}`);
  if (contacto) l.push(`Contacto: ${contacto}`);
  l.push(`Plan: ${planCorto(s)} · ${s.sucursales} sucursal${Number(s.sucursales) === 1 ? '' : 'es'}`);
  l.push(`ID de equipo: ${s.idEquipo}`);
  l.push('Código de solicitud (no lo borres):');
  l.push(s.codigo);
  return l.join('\n');
}

/** Texto completo para copiar o guardar en archivo. */
function textoCompleto(s) {
  const d = s.datos || {};
  return [
    `SOLICITUD PARA ${textoTipo(s.tipo).toUpperCase()} COMPOINT PUNTO`,
    `Fecha: ${s.fecha}`,
    `Plan: ${PLANES[s.plan] || s.plan}${detallePlan(s) ? ' · ' + detallePlan(s) : ''}`,
    `Sucursales: ${s.sucursales}`,
    `ID de equipo: ${s.idEquipo}`,
    '',
    ...lineasNegocio(d),
    ...(s.nota ? ['', `Nota: ${s.nota}`] : []),
    '',
    'Código de solicitud (mándalo completo a Compoint):',
    s.codigo,
    '',
    'WhatsApp 33 25 90 70 90 · contacto@compoint.com.mx'
  ].join('\n');
}

module.exports = {
  PREFIJO, VERSION_AVISO, LIMITES, CAMPOS, ETIQUETAS, PLANES,
  normalizarDatos, datosCompletos, construirCodigo, leerCodigo,
  mensajeWhatsApp, textoCompleto, lineasNegocio, limpiarLinea, detallePlan
};
