// Términos y condiciones de Compoint Punto que el dueño acepta dentro del sistema.
// Para publicar una versión nueva: cambia VERSION (y el resumen si hace falta). A todos los dueños
// les vuelve a salir la ventana una sola vez (cláusula 1.11 de los términos).
const crypto = require('crypto');

const VERSION = '2026-10-28';
const URL_COMPLETOS = 'https://www.compoint.com.mx/terminos.php';
const URL_PRIVACIDAD = 'https://www.compoint.com.mx/privacidad.php';

// Lo que ve el dueño en la ventana (lo más importante, en palabras sencillas).
const RESUMEN = [
  { icono: '🆓', titulo: 'Prueba gratis de 15 días', texto: 'Sin cobros automáticos: al terminar, el sistema solo deja de vender hasta que contrates.' },
  { icono: '🧾', titulo: 'Tus precios e impuestos son tuyos', texto: 'Tú capturas precios, existencias y facturas; el sistema hace las cuentas con lo que capturas.' },
  { icono: '💾', titulo: 'Tu información es tuya', texto: 'Respaldos diarios. Si cancelas, la puedes descargar durante 30 días.' },
  { icono: '↩️', titulo: 'Cancelas cuando quieras', texto: 'Sin penalización. Si te cobramos doble o fallamos gravemente, te devolvemos el 100%; lo demás, según la política de pagos.' },
  { icono: '🔒', titulo: 'Datos de tus clientes', texto: 'Tu negocio es el responsable; nosotros solo los guardamos por ti y no los usamos para nada más.' }
];

const ACEPTO = 'Leí y acepto los Términos y condiciones, la Política de pagos y reembolsos y el Aviso de privacidad de Compoint.';

// Huella del texto exacto que se acepta: si alguien dice "acepté otra cosa", la huella lo desmiente.
function huella() {
  const canon = JSON.stringify({ version: VERSION, completos: URL_COMPLETOS, privacidad: URL_PRIVACIDAD, resumen: RESUMEN, acepto: ACEPTO });
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

const ROLES_QUE_ACEPTAN = ['dueno', 'jefe_general'];

module.exports = { VERSION, URL_COMPLETOS, URL_PRIVACIDAD, RESUMEN, ACEPTO, huella, ROLES_QUE_ACEPTAN };
