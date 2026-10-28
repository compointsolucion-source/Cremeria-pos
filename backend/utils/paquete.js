// Límites del PAQUETE contratado (Básico, Negocio, Pro). Los manda Compoint desde su panel con la consulta
// central de licencia (utils/licenciaCentral.js) y se guardan en la tabla "licencia".
//  - Sin paquete asignado (clientes de antes, sistema propio, programa sin nube) → no se limita nada.
//  - Usuarios: se cuentan los usuarios activos (no eliminados) de todo el negocio, incluido el dueño.
//  - Servicio a domicilio y app del repartidor: solo si el paquete lo incluye (Negocio y Pro).
const pool = require('../db');

const NOMBRES = { basico: 'Básico', negocio: 'Negocio', pro: 'Pro' };
const CONTACTO = 'WhatsApp 33 2590 7090';
const CACHE_MS = 60 * 1000;
let cache = { t: 0, v: null };

function invalidar() { cache = { t: 0, v: null }; }

async function limites() {
  if (cache.v && Date.now() - cache.t < CACHE_MS) return cache.v;
  let v = { paquete: null, nombre: null, max_usuarios: null, con_domicilio: true };
  try {
    const r = await pool.query('SELECT paquete, max_usuarios, con_domicilio FROM licencia WHERE id = 1');
    const f = r.rows[0];
    if (f && NOMBRES[f.paquete]) {
      v = {
        paquete: f.paquete,
        nombre: NOMBRES[f.paquete],
        max_usuarios: Number(f.max_usuarios) > 0 ? Number(f.max_usuarios) : null,
        con_domicilio: f.con_domicilio !== false
      };
    }
  } catch (e) { /* sin tabla o sin columnas todavía: sin límites */ }
  cache = { t: Date.now(), v };
  return v;
}

async function usuariosActivos(db = pool) {
  const r = await db.query('SELECT COUNT(*)::int AS n FROM usuarios WHERE activo = true AND eliminado_en IS NULL');
  return r.rows[0].n;
}

function error(status, mensaje) { const e = new Error(mensaje); e.status = status; e.error = mensaje; return e; }

/** Revisa si se puede tener UN usuario activo más con ese rol. Lanza {status, error} si no se puede. */
async function revisarUsuarioNuevo(rol, db = pool) {
  const l = await limites();
  if (rol === 'repartidor' && !l.con_domicilio) {
    throw error(403, `Tu paquete ${l.nombre} no incluye servicio a domicilio ni app del repartidor. Mejora a Negocio: ${CONTACTO}.`);
  }
  if (l.max_usuarios) {
    const n = await usuariosActivos(db);
    if (n >= l.max_usuarios) {
      throw error(403, `Tu paquete ${l.nombre} incluye ${l.max_usuarios} usuarios y ya los tienes todos. Desactiva uno o agrega otro usuario ($300 al año): ${CONTACTO}.`);
    }
  }
}

/** Corta el servicio a domicilio si el paquete no lo incluye. */
async function revisarDomicilio() {
  const l = await limites();
  if (!l.con_domicilio) {
    throw error(403, `Tu paquete ${l.nombre} no incluye servicio a domicilio ni app del repartidor. Mejora a Negocio: ${CONTACTO}.`);
  }
}

module.exports = { limites, invalidar, usuariosActivos, revisarUsuarioNuevo, revisarDomicilio, NOMBRES };
