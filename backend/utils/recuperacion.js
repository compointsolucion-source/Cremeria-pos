// Recuperar contraseña desde el login: genera el código de 6 dígitos, lo guarda "en huella"
// y pide a compoint.com.mx (recuperar.php) que lo mande por correo desde contacto@compoint.com.mx.
// Así los clientes no tienen que configurar ningún correo en su sistema.
//
// La dirección del servicio se puede cambiar con COMPOINT_RECUPERAR_URL (para pruebas).
const crypto = require('crypto');

const URL_POR_DEFECTO = 'https://www.compoint.com.mx/punto/recuperar.php';
const MINUTOS_VIGENCIA = 15;
const MAX_INTENTOS = 5;
const ESPERA_ENTRE_ENVIOS_SEG = 60;
const TIEMPO_MAX_MS = 12000;

const urlServicio = () => process.env.COMPOINT_RECUPERAR_URL || URL_POR_DEFECTO;

function generarCodigo() {
  return String(crypto.randomInt(100000, 1000000));
}

// Huella del código: atada al usuario y al secreto del servidor (un código de un usuario no sirve en otro).
function huella(codigo, usuarioId) {
  const sal = process.env.JWT_SECRET || '';
  return crypto.createHash('sha256').update(`${String(codigo).trim()}:${usuarioId}:${sal}`).digest('hex');
}

function huellaCoincide(guardada, codigo, usuarioId) {
  const a = Buffer.from(String(guardada || ''), 'hex');
  const b = Buffer.from(huella(codigo, usuarioId), 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

const REGEX_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function correoValido(c) {
  return typeof c === 'string' && c.length <= 120 && REGEX_CORREO.test(c);
}

// "rosa@abarrotes.com" -> "ro•••@abarrotes.com"
function enmascarar(correo) {
  const [u, d] = String(correo).split('@');
  if (!d) return '';
  const vis = u.slice(0, Math.min(2, Math.max(1, u.length - 1)));
  return `${vis}${'•'.repeat(Math.max(2, Math.min(5, u.length - vis.length)))}@${d}`;
}

/**
 * Pide a Compoint que mande el código por correo.
 * @returns {{ok:true}|{ok:false, error:string}}
 */
async function enviarCodigo({ correo, codigo, nombre, negocio }) {
  let resp;
  try {
    resp = await fetch(urlServicio(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'CompointPunto/recuperar' },
      body: JSON.stringify({ v: 1, web: '', correo, codigo, nombre: nombre || '', negocio: negocio || '', minutos: MINUTOS_VIGENCIA }),
      signal: AbortSignal.timeout(TIEMPO_MAX_MS)
    });
  } catch (err) {
    return { ok: false, error: 'No pudimos conectar con el servicio de correo. Revisa tu internet e intenta de nuevo.' };
  }
  let cuerpo = null;
  try { cuerpo = await resp.json(); } catch (e) { cuerpo = null; }
  if (resp.ok && cuerpo && cuerpo.ok === true) return { ok: true };
  if (resp.status === 429) return { ok: false, error: 'Se pidieron demasiados códigos. Espera unos minutos e intenta de nuevo.' };
  return { ok: false, error: 'No pudimos enviar el correo por ahora. Intenta de nuevo en unos minutos o escríbenos por WhatsApp.' };
}

module.exports = { generarCodigo, huella, huellaCoincide, correoValido, enmascarar, enviarCodigo, MINUTOS_VIGENCIA, MAX_INTENTOS, ESPERA_ENTRE_ENVIOS_SEG };
