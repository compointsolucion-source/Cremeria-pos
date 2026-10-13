const { Pool } = require('pg');

// SSL: en la nube (Neon) se usa; en una base local (modo servidor del negocio)
// no. Se puede forzar con DB_SSL=true / DB_SSL=false.
const url = process.env.DATABASE_URL || '';
const esLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
const usarSsl = process.env.DB_SSL ? process.env.DB_SSL === 'true' : !esLocal;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: usarSsl ? { rejectUnauthorized: false } : false
});

module.exports = pool;
