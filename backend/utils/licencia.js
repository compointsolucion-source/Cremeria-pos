// Licencia de ESTA instalación: prueba gratis de 15 días, renta anual o permanente,
// con o sin servicio en la nube. Todo el cálculo vive aquí; el middleware
// (middleware/licencia.js) y las rutas (routes/licencia.js) solo lo usan.
//
// Cómo decide el sistema:
//   - Sin fila en la tabla "licencia" y en la nube (Render)  → SIN CONTROL (tu sistema propio).
//   - Sin fila y en una computadora del cliente (servidor local) → empieza la prueba gratis de 15 días.
//   - Con fila: manda la fecha de vencimiento. Si se activó con un código firmado,
//     los datos se toman del CÓDIGO (se comprueba la firma cada vez), no de las columnas.
//
// Estados:  demo · activa · por_vencer (≤7 días) · gracia (5 días, se puede vender)
//           · solo_consulta (se puede ver y respaldar, no registrar ventas ni cambios)
//
// Si la base de datos falla al consultar, NO se bloquea nada (nunca dejar a un cliente
// sin sistema por un error técnico nuestro).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../db');
const codigo = require('./licenciaCodigo');
const clavePublicaArchivo = require('./licencia-clave-publica');

const DIAS_AVISO = 7;
const GRACIA_PAGO = 5;     // días extra, tras vencer, en que todavía se puede vender
const GRACIA_DEMO = 0;     // la prueba termina el último día (después, solo consulta)
const DEMO_DIAS = 15;      // las pruebas que ya existían conservan su fecha guardada
const CACHE_MS = 60 * 1000;
const CACHE_TICKET_MS = 30 * 60 * 1000;
const SIN_FIN = '2099-12-31';
const ZONA = 'America/Mexico_City';
const CONTACTO = 'WhatsApp 33 25 90 70 90 · Tel. 33 15 97 04 12 · contacto@compoint.com.mx';

// ---------- reloj y fechas ----------
let reloj = () => new Date();
const formatoHoy = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });
const hoy = () => formatoHoy.format(reloj());
const msDia = 86400000;
const aMs = (iso) => { const [a, m, d] = iso.split('-').map(Number); return Date.UTC(a, m - 1, d); };
const diferenciaDias = (a, b) => Math.round((aMs(a) - aMs(b)) / msDia);
const sumarDias = (iso, n) => new Date(aMs(iso) + n * msDia).toISOString().slice(0, 10);
const masReciente = (...fechas) => fechas.filter(Boolean).reduce((m, f) => (f > m ? f : m), '0000-00-00');
const fechaBonita = (iso) => { const [a, m, d] = iso.split('-'); return `${d}/${m}/${a}`; };

// ---------- llave pública (solo se cambia a mano en pruebas) ----------
let llavePublica = codigo.llavePublicaDesdeHex(clavePublicaArchivo.CLAVE_PUBLICA_HEX);

// ---------- ¿es el servidor local de un cliente? ----------
// La app de escritorio pone COMPOINT_ID_EQUIPO (identificador de la computadora) y COMPOINT_MARCAS
// (archivos donde se recuerda cuándo empezó la prueba). En la nube (Render) no existen.
const esLocal = () => !!process.env.COMPOINT_ID_EQUIPO;

let cache = { t: 0, valor: null };
let enCurso = null;
let idInstalacionCache = null;
let ticketCache = { t: 0, f: null };

function invalidarCache() { cache = { t: 0, valor: cache.valor }; ticketCache = { t: 0, f: null }; }

// ---------- ID de este equipo ----------
async function idInstalacion() {
  if (idInstalacionCache) return idInstalacionCache;
  const leer = async () => (await pool.query('SELECT id_instalacion FROM instalacion WHERE id = 1')).rows[0];
  let fila;
  try { fila = await leer(); } catch (err) {
    if (err.code !== '42P01') throw err;
    await pool.query(`CREATE TABLE IF NOT EXISTS instalacion (id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      id_instalacion TEXT NOT NULL, creada_en TIMESTAMP NOT NULL DEFAULT NOW())`);
  }
  if (!fila) {
    await pool.query('INSERT INTO instalacion (id, id_instalacion) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [crypto.randomUUID()]);
    fila = await leer();
  }
  idInstalacionCache = fila.id_instalacion;
  return idInstalacionCache;
}

async function idEquipo() {
  const crudo = process.env.COMPOINT_ID_EQUIPO || await idInstalacion();
  const valor = codigo.idEquipoValor(crudo);
  return { valor, texto: codigo.formatearIdEquipo(valor) };
}

// ---------- marcas contra reiniciar la prueba (solo servidor local) ----------
function rutasMarcas() {
  try {
    const j = JSON.parse(process.env.COMPOINT_MARCAS || '[]');
    return Array.isArray(j) ? j.filter((x) => typeof x === 'string' && x) : [];
  } catch (e) { return []; }
}
const firmaMarca = (idEq, i, v) =>
  crypto.createHmac('sha256', 'cpt-marca-v1|' + idEq).update(i + '|' + v).digest('hex').slice(0, 32);

function leerMarcas(idEq) {
  const validas = [];
  for (const ruta of rutasMarcas()) {
    try {
      const j = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      if (/^\d{4}-\d{2}-\d{2}$/.test(j.i) && /^\d{4}-\d{2}-\d{2}$/.test(j.v) && j.h === firmaMarca(idEq, j.i, j.v)) validas.push({ i: j.i, v: j.v });
    } catch (e) { /* no existe o está dañada: se ignora */ }
  }
  return validas;
}

function escribirMarcas(idEq, i, v) {
  const contenido = JSON.stringify({ i, v, h: firmaMarca(idEq, i, v) });
  for (const ruta of rutasMarcas()) {
    try { fs.mkdirSync(path.dirname(ruta), { recursive: true }); fs.writeFileSync(ruta, contenido); } catch (e) { /* sin permiso: queda en las demás */ }
  }
}

// ---------- lectura de la fila ----------
async function leerFila() {
  const r = await pool.query(
    `SELECT cliente, tipo, plan, max_sucursales, codigo_activacion, serial, desde_nube, nube_id_equipo,
            to_char(fecha_inicio,'YYYY-MM-DD') AS inicio,
            to_char(fecha_vencimiento,'YYYY-MM-DD') AS vence,
            to_char(ultima_fecha_vista,'YYYY-MM-DD') AS visto
     FROM licencia WHERE id = 1`);
  return r.rows[0] || null;
}

async function fechaUltimoTicket() {
  if (Date.now() - ticketCache.t < CACHE_TICKET_MS) return ticketCache.f;
  let f = null;
  try {
    const r = await pool.query(`SELECT to_char(MAX(fecha_creacion),'YYYY-MM-DD') AS f FROM tickets`);
    f = r.rows[0] && r.rows[0].f ? sumarDias(r.rows[0].f, -1) : null; // un día de holgura por zonas horarias
  } catch (e) { f = null; }
  ticketCache = { t: Date.now(), f };
  return f;
}

// ---------- cálculo puro del estado ----------
function calcularEstado({ tipo, vence }, hoyEfectivo) {
  const permanente = tipo === 'permanente';
  const gracia = tipo === 'demo' ? GRACIA_DEMO : GRACIA_PAGO;
  const base = { tipo, vence: permanente ? null : vence, permanente, en_gracia: false, gracia_restante: 0, por_vencer: false };
  if (permanente) return { ...base, estado: 'activa', dias: null, solo_consulta: false };
  const dias = diferenciaDias(vence, hoyEfectivo);
  if (dias >= 0) {
    const por_vencer = dias <= DIAS_AVISO;
    return { ...base, dias, por_vencer, estado: tipo === 'demo' ? 'demo' : (por_vencer ? 'por_vencer' : 'activa'), solo_consulta: false };
  }
  if (dias >= -gracia) return { ...base, dias, en_gracia: true, gracia_restante: gracia + dias, estado: 'gracia', solo_consulta: false };
  return { ...base, dias, estado: 'solo_consulta', solo_consulta: true };
}

function mensajeEstado(est) {
  if (!est.control) return '';
  const cuando = (d) => (d === 0 ? 'hoy' : d === 1 ? 'mañana' : `en ${d} días`);
  const contacto = ' Para continuar comunícate con Compoint: ' + CONTACTO;
  if (est.suspendida) {
    return 'Tu servicio de Compoint Punto está suspendido. El sistema está en modo solo consulta: puedes ver tus reportes y respaldar tu información, pero no registrar ventas ni cambios.' + contacto;
  }
  if (est.codigo_invalido) {
    return 'El código de activación guardado no corresponde a este equipo. Estás en modo solo consulta: puedes ver tus reportes y respaldar tu información, pero no registrar ventas.' + contacto;
  }
  switch (est.estado) {
    case 'demo': return `Versión de prueba: ${est.dias === 0 ? 'hoy es tu último día' : `te quedan ${est.dias} día${est.dias === 1 ? '' : 's'}`} (termina el ${fechaBonita(est.vence)}).`;
    case 'por_vencer': return `Tu licencia vence ${cuando(est.dias)} (${fechaBonita(est.vence)}). Para renovar comunícate con Compoint: ${CONTACTO}`;
    case 'gracia': return `Tu licencia venció el ${fechaBonita(est.vence)}. Todavía puedes vender ${est.gracia_restante === 0 ? 'solo hoy' : `${est.gracia_restante} día${est.gracia_restante === 1 ? '' : 's'} más`}. Renueva con Compoint: ${CONTACTO}`;
    case 'solo_consulta':
      return (est.tipo === 'demo'
        ? `Tu prueba gratis terminó el ${fechaBonita(est.vence)}.`
        : `Tu licencia venció el ${fechaBonita(est.vence)}.`) +
        ' El sistema está en modo solo consulta: puedes ver tus reportes y respaldar tu información, pero no registrar ventas ni cambios.' + contacto;
    default: return '';
  }
}

// ---------- cálculo completo (con base de datos) ----------
async function crearDemoLocal(idEq, hoyReal) {
  let inicio = hoyReal;
  for (const m of leerMarcas(idEq)) if (m.i < inicio) inicio = m.i; // si ya hubo una prueba en esta computadora, sigue contando desde entonces
  await pool.query(
    `INSERT INTO licencia (id, cliente, fecha_inicio, fecha_vencimiento, tipo, plan, ultima_fecha_vista)
     VALUES (1, NULL, $1, $2, 'demo', 'nube', $3) ON CONFLICT (id) DO NOTHING`,
    [inicio, sumarDias(inicio, DEMO_DIAS), hoyReal]);
  escribirMarcas(idEq, inicio, hoyReal);
  return leerFila();
}

async function calcular() {
  const hoyReal = hoy();
  const eq = await idEquipo();
  let fila = await leerFila();
  const local = esLocal();

  if (!fila) {
    if (!local) return { control: false, id_equipo: eq.texto, local, tiene_llave: !!llavePublica };
    fila = await crearDemoLocal(eq.texto, hoyReal);
  }

  // De dónde salen los datos: del código firmado (si lo hay) o de la fila.
  let lic = { tipo: fila.tipo || 'anual', plan: fila.plan || 'nube', maxSucursales: fila.max_sucursales || null, inicio: fila.inicio, vence: fila.vence, origen: 'fila' };
  let codigoInvalido = null;
  if (fila.codigo_activacion) {
    const r = codigo.verificarCodigo(fila.codigo_activacion, llavePublica);
    // Un código tomado de la nube del cliente está ligado al ID de ESA nube, no al de esta computadora.
    const valorEsperado = fila.nube_id_equipo ? codigo.leerIdEquipo(fila.nube_id_equipo) : eq.valor;
    if (r.ok && valorEsperado !== null && r.datos.idEquipoValor === valorEsperado) {
      lic = { tipo: r.datos.tipo, plan: r.datos.plan, maxSucursales: r.datos.maxSucursales, inicio: r.datos.emitida, vence: r.datos.vence || SIN_FIN, origen: 'codigo', serial: r.datos.serial };
    } else {
      codigoInvalido = r.ok ? 'equipo' : r.motivo;
    }
  }

  // Prueba sin código en un servidor local: la fecha de inicio no puede adelantarse (marcas).
  let marcas = [];
  if (local) {
    marcas = leerMarcas(eq.texto);
    if (lic.tipo === 'demo' && lic.origen === 'fila') {
      const masVieja = marcas.reduce((m, x) => (x.i < m ? x.i : m), lic.inicio);
      if (masVieja < lic.inicio) {
        lic.inicio = masVieja; lic.vence = sumarDias(masVieja, DEMO_DIAS);
        await pool.query('UPDATE licencia SET fecha_inicio = $1, fecha_vencimiento = $2, actualizado_en = NOW() WHERE id = 1', [lic.inicio, lic.vence]);
      }
    }
  }

  // Candado contra atrasar el reloj (solo en la computadora del cliente; la nube tiene su propio reloj).
  let hoyEf = hoyReal;
  let relojAtrasado = false;
  if (local) {
    const visto = masReciente(fila.visto, await fechaUltimoTicket(), ...marcas.map((m) => m.v));
    hoyEf = masReciente(hoyReal, visto);
    relojAtrasado = diferenciaDias(visto, hoyReal) >= 2;
    if (hoyReal > (fila.visto || '') && !relojAtrasado) {
      await pool.query('UPDATE licencia SET ultima_fecha_vista = $1 WHERE id = 1', [hoyReal]);
      escribirMarcas(eq.texto, marcas.reduce((m, x) => (x.i < m ? x.i : m), lic.inicio), hoyReal);
    } else if (!marcas.length) {
      escribirMarcas(eq.texto, lic.inicio, masReciente(fila.visto, hoyReal));
    }
  }

  const calc = calcularEstado(lic, hoyEf);
  const est = {
    control: true,
    ...calc,
    plan: lic.plan,
    inicio: lic.inicio,
    max_sucursales: lic.maxSucursales,
    cliente: fila.cliente || null,
    serial: lic.serial || (fila.serial != null ? Number(fila.serial) : null),
    con_codigo: lic.origen === 'codigo',
    desde_nube: fila.desde_nube || null,
    suspendida: fila.desde_nube === 'central_suspendida',
    id_equipo: eq.texto,
    local,
    tiene_llave: !!llavePublica,
    reloj_atrasado: relojAtrasado,
    codigo_invalido: codigoInvalido
  };
  if (codigoInvalido) { est.estado = 'solo_consulta'; est.solo_consulta = true; est.en_gracia = false; est.por_vencer = false; }
  est.puede_vender = !est.solo_consulta;
  est.mensaje = mensajeEstado(est);
  return est;
}

async function estado() {
  if (Date.now() - cache.t < CACHE_MS && cache.valor) return cache.valor;
  if (enCurso) return enCurso;
  enCurso = (async () => {
    try {
      const valor = await calcular();
      cache = { t: Date.now(), valor };
      return valor;
    } catch (err) {
      console.error('Licencia: no se pudo calcular el estado:', err.message);
      return cache.valor || { control: false };
    } finally { enCurso = null; }
  })();
  return enCurso;
}

// Tope de sucursales: el del código de activación (o de la fila) si lo hay; si no, la variable MAX_SUCURSALES.
async function limiteSucursales() {
  const est = await estado();
  const porLicencia = est.control && est.max_sucursales;
  return porLicencia || parseInt(process.env.MAX_SUCURSALES, 10) || 4;
}

// ---------- activar con un código ----------
class ErrorLicencia extends Error {
  constructor(mensaje, motivo) { super(mensaje); this.motivo = motivo; this.http = 400; }
}

async function activar(texto, { usuarioId } = {}) {
  const eq = await idEquipo();
  const r = codigo.verificarCodigo(texto, llavePublica);
  if (!r.ok) throw new ErrorLicencia(r.mensaje, r.motivo);
  const d = r.datos;
  if (d.idEquipoValor !== eq.valor) {
    throw new ErrorLicencia(`Este código es para otro equipo (${d.idEquipo}). El ID de este equipo es ${eq.texto}. Pide a Compoint un código nuevo con este ID.`, 'equipo');
  }
  const hoyReal = hoy();
  const vence = d.vence || SIN_FIN;
  if (d.vence && d.vence < hoyReal) {
    throw new ErrorLicencia(`Este código ya venció el ${fechaBonita(d.vence)}. Pide a Compoint uno nuevo.`, 'vencido');
  }
  const actual = await estado();
  if (actual.control && actual.con_codigo && !actual.codigo_invalido) {
    const venceActual = actual.vence || SIN_FIN;
    if (vence < venceActual || (vence === venceActual && d.serial < (actual.serial || 0))) {
      throw new ErrorLicencia(`Ya tienes una licencia más reciente (${actual.vence ? 'vence el ' + fechaBonita(actual.vence) : 'permanente'}). Ese código es anterior.`, 'anterior');
    }
  }
  await pool.query(
    `INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan, max_sucursales, codigo_activacion, serial, ultima_fecha_vista, actualizado_en)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (id) DO UPDATE SET fecha_inicio = EXCLUDED.fecha_inicio, fecha_vencimiento = EXCLUDED.fecha_vencimiento,
       tipo = EXCLUDED.tipo, plan = EXCLUDED.plan, max_sucursales = EXCLUDED.max_sucursales,
       codigo_activacion = EXCLUDED.codigo_activacion, serial = EXCLUDED.serial, actualizado_en = NOW(),
       desde_nube = NULL, nube_id_equipo = NULL,
       ultima_fecha_vista = GREATEST(licencia.ultima_fecha_vista, EXCLUDED.ultima_fecha_vista)`,
    [d.emitida, vence, d.tipo, d.plan, d.maxSucursales, textoLimpio(texto), d.serial, hoyReal]);
  invalidarCache();
  const nuevo = await estado();
  return { estado: nuevo, datos: d, anterior: actual };
}

// ---------- licencia que viene de la nube del cliente ----------
// Lado NUBE: lo que se le entrega al servidor local del cliente cuando se conecta con el usuario dueño.
async function infoParaNube() {
  const eq = await idEquipo();
  const est = await estado();
  if (!est.control) return { control: false, cliente: null, id_equipo: eq.texto };
  const fila = await leerFila();
  const codigoValido = fila && fila.codigo_activacion && est.con_codigo && !est.codigo_invalido;
  return {
    control: true,
    cliente: est.cliente || null,
    tipo: est.tipo,
    plan: est.plan,
    vence: est.permanente ? null : est.vence,
    estado: est.estado,
    max_sucursales: est.max_sucursales || null,
    codigo: codigoValido ? fila.codigo_activacion : null,
    id_equipo: eq.texto
  };
}

// Lado LOCAL: el servidor del cliente toma la licencia de su nube y deja la prueba. Devuelve { adoptada, motivo }.
// SOLO se toma un código de activación FIRMADO por Compoint: se comprueba la firma aquí también (no se confía
// a ciegas en lo que conteste la nube) y que sea de ESA nube. Cualquier respuesta sin código firmado
// (nube "sin control", o licencia puesta a mano sin código) NO da ni alarga nada: esta computadora se queda
// con la prueba o la licencia que ya tenía. Para que se tome sola, Compoint activa la nube con un código.
// Nunca se baja de categoría: si esta computadora ya tiene una licencia propia igual o más larga, se queda con ella.
async function adoptarDeNube(info) {
  if (!info || typeof info !== 'object') return { adoptada: false, motivo: 'sin_datos' };
  const hoyReal = hoy();
  if (!info.codigo) {
    return { adoptada: false, motivo: info.control === false ? 'nube_sin_control' : 'sin_codigo_firmado' };
  }
  const r = codigo.verificarCodigo(String(info.codigo), llavePublica);
  if (!r.ok) return { adoptada: false, motivo: 'codigo_invalido', detalle: r.mensaje };
  const d = r.datos;
  const idNube = codigo.leerIdEquipo(info.id_equipo);
  if (idNube === null || d.idEquipoValor !== idNube) return { adoptada: false, motivo: 'codigo_de_otra_nube' };
  if (d.tipo === 'demo') return { adoptada: false, motivo: 'es_prueba' };
  const nueva = { tipo: d.tipo, plan: d.plan, maxSuc: d.maxSucursales, inicio: d.emitida, vence: d.vence || SIN_FIN, codigo: textoLimpio(info.codigo),
    serial: d.serial, origen: 'codigo', idNube: codigo.formatearIdEquipo(idNube) };

  // ¿Esta computadora ya tiene algo igual o mejor?
  const actual = await estado();
  const venceActual = actual.control ? (actual.permanente ? SIN_FIN : actual.vence) : null;
  const sirveActual = actual.control && actual.tipo !== 'demo' && !actual.codigo_invalido && actual.estado !== 'solo_consulta' && !actual.en_gracia;
  const demoVigente = actual.control && actual.tipo === 'demo' && actual.estado === 'demo';
  // Una licencia ya vencida en la nube solo se toma si esta computadora no tiene nada vigente (para mostrar el aviso correcto).
  if (nueva.vence < hoyReal && (sirveActual || demoVigente)) return { adoptada: false, motivo: 'vencida' };
  // La licencia activada aquí con un código propio no se cambia por otra igual o más corta.
  if (sirveActual && !actual.desde_nube && venceActual >= nueva.vence) return { adoptada: false, motivo: 'ya_tiene_licencia_propia' };
  // Las que vienen de la nube con código firmado no retroceden.
  if (sirveActual && actual.desde_nube === 'codigo') {
    if (venceActual > nueva.vence) return { adoptada: false, motivo: 'ya_tiene_una_mas_larga' };
    if (venceActual === nueva.vence && nueva.serial !== null && nueva.serial < (actual.serial || 0)) return { adoptada: false, motivo: 'ya_tiene_una_mas_reciente' };
  }

  const cliente = info.cliente ? String(info.cliente).slice(0, 200) : null;
  await pool.query(
    `INSERT INTO licencia (id, cliente, fecha_inicio, fecha_vencimiento, tipo, plan, max_sucursales, codigo_activacion, serial,
        ultima_fecha_vista, desde_nube, nube_id_equipo, actualizado_en)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (id) DO UPDATE SET cliente = COALESCE(EXCLUDED.cliente, licencia.cliente),
       fecha_inicio = EXCLUDED.fecha_inicio, fecha_vencimiento = EXCLUDED.fecha_vencimiento, tipo = EXCLUDED.tipo, plan = EXCLUDED.plan,
       max_sucursales = EXCLUDED.max_sucursales, codigo_activacion = EXCLUDED.codigo_activacion, serial = EXCLUDED.serial,
       desde_nube = EXCLUDED.desde_nube, nube_id_equipo = EXCLUDED.nube_id_equipo, actualizado_en = NOW(),
       ultima_fecha_vista = GREATEST(licencia.ultima_fecha_vista, EXCLUDED.ultima_fecha_vista)`,
    [cliente, nueva.inicio, nueva.vence, nueva.tipo, nueva.plan, nueva.maxSuc, nueva.codigo, nueva.serial, hoyReal, nueva.origen, nueva.idNube]);
  invalidarCache();
  return { adoptada: true, origen: nueva.origen, estado: await estado() };
}

// Guarda el código en su forma estándar (sin el texto que lo rodeaba).
function textoLimpio(texto) {
  const ex = String(texto).toUpperCase();
  const m = /CPT[1IL]-/.exec(ex);
  const caracteres = [];
  for (let k = m.index + m[0].length; k < ex.length && caracteres.length < codigo.CARACTERES; k++) {
    const c = ex[k];
    if (/[-\s ]/.test(c)) continue;
    caracteres.push(c.replace('O', '0').replace(/[IL]/, '1'));
  }
  return 'CPT1-' + caracteres.join('').match(/.{1,5}/g).join('-');
}

// ---------- ayudas para pruebas ----------
function _usarClavePublica(hex) { llavePublica = codigo.llavePublicaDesdeHex(hex); invalidarCache(); }
function _fijarReloj(f) { reloj = f || (() => new Date()); invalidarCache(); }
function _reiniciar() { cache = { t: 0, valor: null }; enCurso = null; idInstalacionCache = null; ticketCache = { t: 0, f: null }; }

module.exports = {
  DIAS_AVISO, GRACIA_PAGO, GRACIA_DEMO, DEMO_DIAS, SIN_FIN, CONTACTO,
  estado, activar, adoptarDeNube, infoParaNube, limiteSucursales, idEquipo, invalidarCache, calcularEstado, mensajeEstado, ErrorLicencia,
  hoy, sumarDias, diferenciaDias, fechaBonita,
  _usarClavePublica, _fijarReloj, _reiniciar
};
