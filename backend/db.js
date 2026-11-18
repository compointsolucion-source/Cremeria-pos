const { Pool } = require('pg');

// SSL: en la nube (Neon) se usa; en una base local (modo servidor del negocio)
// no. Se puede forzar con DB_SSL=true / DB_SSL=false.
const url = process.env.DATABASE_URL || '';
const esLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
const usarSsl = process.env.DB_SSL ? process.env.DB_SSL === 'true' : !esLocal;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: usarSsl ? { rejectUnauthorized: false } : false,
  // Si la base no contesta en 15 s, la solicitud falla con un mensaje en vez de quedarse esperando para siempre.
  connectionTimeoutMillis: 15000
});

// Si la base se reinicia o se detiene, las conexiones que estaban libres avisan con un error. Sin este
// manejador ese aviso tumba todo el servidor (y en la computadora del negocio, el programa completo).
pool.on('error', (e) => {
  console.error(`[${new Date().toISOString()}] Conexión con la base de datos perdida:`, e && e.message);
});

module.exports = pool;
