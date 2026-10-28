// Reglas de seguridad compartidas para todo lo que mueve dinero (cobros, devoluciones,
// entradas/salidas de caja, abonos). Así una sola regla protege todas las rutas.

// Formas de pago que entiende el corte de caja. Cualquier otra se rechaza.
const METODOS_PAGO = ['efectivo', 'tarjeta', 'mixto', 'credito', 'transferencia', 'dolares', 'cheque', 'vale_despensa'];
// Formas de pago válidas para un abono a crédito (las que cuenta el corte).
const METODOS_ABONO = ['efectivo', 'tarjeta', 'transferencia'];

const esSupervisor = (u) => !!u && ['jefe_general', 'dueno', 'gerente'].includes(u.rol);

function errorCaja(status, error) {
  const e = new Error(error);
  e.status = status; e.error = error;
  return e;
}

/**
 * Revisa que un turno de caja se pueda usar en esta operación:
 *  - que exista y sea de ESTA sucursal;
 *  - que esté abierto (salvo exigirAbierto:false, p. ej. ventas hechas sin internet que se suben después);
 *  - que sea del propio usuario (dueño, gerente y jefe general pueden usar cualquiera de la sucursal);
 *    con propio:false basta que sea de la sucursal (ventas sin internet que sube otra sesión de la misma caja).
 * Devuelve la fila del turno, o null si no se mandó turno y es opcional. Lanza {status, error} si no sirve.
 */
async function validarTurno(db, { turnoId, sucursalId, usuario, exigirAbierto = true, obligatorio = false, propio = true }) {
  if (turnoId === undefined || turnoId === null || turnoId === '') {
    if (obligatorio) throw errorCaja(400, 'Abre tu turno de caja antes de hacer esta operación');
    return null;
  }
  const id = Number(turnoId);
  if (!Number.isInteger(id) || id <= 0) throw errorCaja(400, 'Turno de caja no válido');
  const r = await db.query('SELECT id, sucursal_id, usuario_id, estado FROM turnos WHERE id = $1', [id]);
  const t = r.rows[0];
  if (!t || Number(t.sucursal_id) !== Number(sucursalId)) throw errorCaja(400, 'Ese turno de caja no es de esta sucursal');
  if (exigirAbierto && t.estado !== 'abierto') throw errorCaja(409, 'Ese turno de caja ya está cerrado. Abre uno nuevo.');
  if (propio && !esSupervisor(usuario) && Number(t.usuario_id) !== Number(usuario.id)) {
    throw errorCaja(403, 'Solo puedes usar tu propio turno de caja');
  }
  return t;
}

/** Número de dinero válido (finito, >= 0). Devuelve el número o null si no sirve. */
function montoNoNegativo(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

module.exports = { METODOS_PAGO, METODOS_ABONO, esSupervisor, validarTurno, montoNoNegativo, errorCaja };
