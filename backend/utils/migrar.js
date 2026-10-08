// Aplica las migraciones pendientes (backend/migrations/*.sql) al arrancar.
// Cada instalación (cliente) tiene su propia base de datos; al redesplegar,
// cada una se pone al día sola. Registro en la tabla "schema_migrations".
const fs = require('fs');
const path = require('path');
const pool = require('../db');

const DIR = path.join(__dirname, '..', 'migrations');
const LOCK_ID = 727001; // candado para que dos servidores no migren a la vez

async function migrar() {
  if (!fs.existsSync(DIR)) return;
  const archivos = fs.readdirSync(DIR).filter(f => /^\d+.*\.sql$/.test(f)).sort();
  if (!archivos.length) return;

  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      nombre TEXT PRIMARY KEY, aplicada_en TIMESTAMP NOT NULL DEFAULT NOW())`);
  } catch (e) { /* otra instancia pudo crearla al mismo tiempo */ }

  for (const archivo of archivos) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // Candado de transacción (compatible con el pooler de Neon): se libera solo al terminar.
      await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      const ya = await c.query('SELECT 1 FROM schema_migrations WHERE nombre = $1', [archivo]);
      if (ya.rows.length) { await c.query('ROLLBACK'); continue; }
      await c.query(fs.readFileSync(path.join(DIR, archivo), 'utf8'));
      await c.query('INSERT INTO schema_migrations (nombre) VALUES ($1)', [archivo]);
      await c.query('COMMIT');
      console.log(`Migración aplicada: ${archivo}`);
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      console.error(`Migración FALLÓ (${archivo}): ${e.message}. No se aplicarán las siguientes.`);
      throw e;
    } finally {
      c.release();
    }
  }
}

module.exports = { migrar };
