// PRIMER ARRANQUE de un cliente en el servidor Compoint (Coolify).
//
// El panel Licencias Punto (compoint.com.mx -> admin) crea la base de datos y el sistema del
// cliente en Coolify, y le pone estas variables con los datos del alta:
//   ALTA_NEGOCIO, ALTA_DUENO, ALTA_USUARIO, ALTA_PASSWORD, ALTA_GIRO, ALTA_SUCURSALES,
//   ALTA_TELEFONO, ALTA_DIRECCION (las dos últimas opcionales)
//
// Al arrancar el contenedor (antes de server.js):
//   - sin ALTA_NEGOCIO              -> no hace nada (clientes que ya existen)
//   - con ALTA_NEGOCIO y base VACÍA -> corre alta-cliente.js (estructura, sucursal, dueño, licencia 12 meses)
//   - con ALTA_NEGOCIO y base con datos -> no hace nada (el alta ya se hizo antes)
// Así es seguro reiniciar o redesplegar: nunca toca una base que ya tiene información.
// Si el alta falla, sale con error para que Coolify lo marque y el panel lo muestre.
require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');

const E = process.env;
const ESPERA_MS = Number(E.PRIMER_ARRANQUE_ESPERA_MS) || 3 * 60 * 1000;
const PAUSA_MS = Number(E.PRIMER_ARRANQUE_PAUSA_MS) || 3000;
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

function usarSsl(url) {
  if (E.DB_SSL) return E.DB_SSL === 'true';
  return !/@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
}

/** Cuántas tablas tiene la base. Espera a que la base acepte conexiones (recién creada puede tardar). */
async function contarTablas() {
  const url = E.DATABASE_URL || '';
  const fin = Date.now() + ESPERA_MS;
  let ultimoError = null;
  while (Date.now() < fin) {
    const pool = new Pool({ connectionString: url, ssl: usarSsl(url) ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10000 });
    try {
      const r = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
      return r.rows[0].n;
    } catch (e) {
      ultimoError = e;
      console.log(`[primer-arranque] La base aún no responde (${e.code || e.message}); reintento…`);
      await esperar(PAUSA_MS);
    } finally {
      await pool.end().catch(() => {});
    }
  }
  throw new Error('La base de datos no respondió a tiempo: ' + (ultimoError ? ultimoError.message : 'sin detalle'));
}

function argumentosAlta() {
  const t = (k, max = 200) => String(E[k] || '').replace(/[\x00-\x1F\x7F]+/g, ' ').trim().slice(0, max);
  const args = ['--negocio', t('ALTA_NEGOCIO', 120), '--dueno', t('ALTA_DUENO', 120), '--usuario', t('ALTA_USUARIO', 40) || 'admin',
    '--password', String(E.ALTA_PASSWORD || ''), '--sucursales', String(Math.max(1, Math.min(50, parseInt(E.ALTA_SUCURSALES, 10) || 1)))];
  if (t('ALTA_GIRO', 30)) args.push('--giro', t('ALTA_GIRO', 30));
  if (t('ALTA_TELEFONO', 30)) args.push('--telefono', t('ALTA_TELEFONO', 30));
  if (t('ALTA_DIRECCION', 200)) args.push('--direccion', t('ALTA_DIRECCION', 200));
  return args;
}

async function main() {
  if (!String(E.ALTA_NEGOCIO || '').trim()) return 0; // cliente ya existente: nada que hacer
  if (!E.DATABASE_URL) { console.error('[primer-arranque] Falta DATABASE_URL.'); return 1; }

  const tablas = await contarTablas();
  if (tablas > 0) { console.log('[primer-arranque] La base ya tiene datos: el alta ya estaba hecha.'); return 0; }

  console.log(`[primer-arranque] Base vacía: creando el cliente «${String(E.ALTA_NEGOCIO).trim()}»…`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'alta-cliente.js'), ...argumentosAlta()], {
    cwd: path.join(__dirname, '..'), env: E, encoding: 'utf8'
  });
  // Nunca se imprime la contraseña (alta-cliente.js no la muestra; por si acaso se tapa).
  const tapar = (s) => (E.ALTA_PASSWORD ? String(s || '').split(String(E.ALTA_PASSWORD)).join('***') : String(s || ''));
  if (r.stdout) process.stdout.write(tapar(r.stdout).replace(/^(DATABASE_URL|JWT_SECRET)=.*$/gm, '$1=***'));
  if (r.stderr) process.stderr.write(tapar(r.stderr));
  if (r.status !== 0) { console.error('[primer-arranque] El alta falló.'); return 1; }
  console.log('[primer-arranque] Cliente creado.');
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => { console.error('[primer-arranque] ' + e.message); process.exit(1); });
}
module.exports = { main, argumentosAlta, contarTablas };
