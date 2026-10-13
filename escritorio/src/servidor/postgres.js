// Base de datos PostgreSQL real incluida en el programa (embedded-postgres).
// Escucha solo en esta PC (127.0.0.1); las demás cajas hablan con el servidor web, no con la base.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Client } = require('pg');

const USUARIO = 'compoint';
const BASE = 'compoint';

function urlConexion({ puerto, password }, base = BASE) {
  return `postgresql://${USUARIO}:${encodeURIComponent(password)}@127.0.0.1:${puerto}/${base}`;
}

async function responde(cfg) {
  const c = new Client({ connectionString: urlConexion(cfg, 'postgres'), connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.query('SELECT 1'); return true; } catch (e) { return false; } finally { c.end().catch(() => {}); }
}

async function cargarModulo() {
  // El paquete es ESM: se carga con import() dinámico.
  return (await import('embedded-postgres')).default;
}

async function binarios() {
  const nombre = process.platform === 'win32' ? 'windows-x64' : (process.platform === 'darwin' ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64') : 'linux-' + process.arch);
  return await import('@embedded-postgres/' + nombre);
}

/** Arranca (o reutiliza) la base. Devuelve { url, detener() }. */
async function iniciarPostgres({ dirDatos, puerto, password, log, opcionesExtra = {} }) {
  const cfg = { puerto, password };
  const nuevo = !fs.existsSync(path.join(dirDatos, 'PG_VERSION'));
  const EmbeddedPostgres = await cargarModulo();
  const pg = new EmbeddedPostgres({
    databaseDir: dirDatos, user: USUARIO, password, port: puerto, persistent: true, authMethod: 'password',
    initdbFlags: ['--encoding=UTF8'], postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=60', '-c', 'fsync=on'],
    onLog: (m) => log && log('[pg] ' + String(m).trim().slice(0, 300)),
    onError: (m) => log && log('[pg!] ' + String(m && m.message || m).trim().slice(0, 300)),
    ...opcionesExtra
  });
  if (nuevo) { log && log('Creando la base de datos del negocio (primera vez)…'); await pg.initialise(); }

  let propia = false;
  if (!(await responde(cfg))) { await pg.start(); propia = true; } else log && log('La base ya estaba encendida; se reutiliza.');

  if (nuevo) { try { await pg.createDatabase(BASE); } catch (e) { log && log('createDatabase: ' + e.message); } }
  // Si la base no existe (instalación a medias), se crea.
  const c = new Client({ connectionString: urlConexion(cfg, 'postgres') });
  await c.connect();
  try {
    const ya = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [BASE]);
    if (!ya.rows.length) await c.query(`CREATE DATABASE ${BASE} ENCODING 'UTF8' TEMPLATE template0`);
  } finally { await c.end(); }

  async function detener() {
    // Apagado limpio ("fast"): no se pierde nada y no hay recuperación al encender.
    try {
      const { pg_ctl } = await binarios();
      await new Promise((ok) => execFile(pg_ctl, ['-D', dirDatos, 'stop', '-m', 'fast', '-w', '-t', '25'], { windowsHide: true }, () => ok()));
    } catch (e) { log && log('pg_ctl stop: ' + e.message); }
    try { if (propia) await Promise.race([pg.stop(), new Promise((ok) => setTimeout(ok, 3000))]); } catch (e) { /* ya estaba apagada */ }
  }
  return { url: urlConexion(cfg), detener };
}

module.exports = { iniciarPostgres, urlConexion, responde, USUARIO, BASE };
