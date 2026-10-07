// Control de licencia (renta anual) de ESTA instalación.
//
// - Si la tabla "licencia" no tiene ninguna fila, NO hay control (así tu
//   propio sistema, el demo y las instalaciones sin renta no se ven afectados).
// - Si hay fila: al pasar fecha_vencimiento (inclusive ese día) el sistema se
//   bloquea con código 402 y un mensaje claro. Desde 7 días antes, cada
//   respuesta lleva el encabezado X-Licencia-Dias para que la pantalla
//   muestre el aviso.
// - Si la base de datos falla al consultar, NO se bloquea (nunca dejar a un
//   cliente sin sistema por un error técnico nuestro).
// Para renovar: ver backend/scripts/LEEME-LICENCIA.txt
const pool = require('../db');

const DIAS_AVISO = 7;
const CACHE_MS = 60 * 1000;
let cache = { t: 0, valor: null };

async function asegurarTabla() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS licencia (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      cliente TEXT,
      fecha_inicio DATE NOT NULL,
      fecha_vencimiento DATE NOT NULL,
      actualizado_en TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  } catch (err) {
    console.error('No se pudo asegurar la tabla licencia:', err.message);
  }
}

async function estadoLicencia() {
  if (Date.now() - cache.t < CACHE_MS) return cache.valor;
  let valor = null; // null = sin control de licencia
  try {
    const r = await pool.query(
      `SELECT to_char(fecha_vencimiento,'YYYY-MM-DD') AS vence,
              (fecha_vencimiento - (NOW() AT TIME ZONE 'America/Mexico_City')::date) AS dias
       FROM licencia WHERE id = 1`);
    if (r.rows.length) valor = { vence: r.rows[0].vence, dias: Number(r.rows[0].dias) };
  } catch (err) {
    return cache.valor; // ante error, conserva lo último conocido (o sin control)
  }
  cache = { t: Date.now(), valor };
  return valor;
}

async function verificarLicencia(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  // Cerrar sesión siempre debe poder hacerse.
  if (req.originalUrl.startsWith('/api/auth/logout')) return next();
  const est = await estadoLicencia();
  if (!est) return next();
  if (est.dias < 0) {
    return res.status(402).json({
      error: 'Licencia vencida el ' + est.vence + '. Para renovar, comunícate con Compoint: WhatsApp 33 25 90 70 90 · Tel. 33 15 97 04 12 · contacto@compoint.com.mx',
      licencia_vencida: true
    });
  }
  if (est.dias <= DIAS_AVISO) {
    res.set('X-Licencia-Dias', String(est.dias));
    res.set('X-Licencia-Vence', est.vence);
  }
  next();
}

module.exports = { verificarLicencia, asegurarTabla };
