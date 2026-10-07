// Da de alta un cliente NUEVO en una base de datos Neon VACÍA:
//   1) crea la estructura (scripts/schema.sql)
//   2) crea la sucursal, su configuración y el usuario dueño
//   3) opcionalmente crea los departamentos típicos del giro
//   4) imprime las variables para Render y la línea de config.js
//
// Uso:
//   DATABASE_URL="postgresql://(base NUEVA del cliente)" node scripts/alta-cliente.js \
//     --negocio "Cremería La Esperanza" --dueno "Juan Pérez" --usuario juan \
//     --password "Clave-segura-123" [--sucursales 2] [--giro cremeria] [--licencia-meses 12] [--direccion "..."] [--telefono "..."]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const GIROS = {
  cremeria: ['Quesos', 'Cremas y yogurt', 'Embutidos', 'Carnes', 'Lácteos', 'Abarrotes'],
  carniceria: ['Res', 'Cerdo', 'Pollo', 'Embutidos', 'Menudencias', 'Abarrotes'],
  abarrotes: ['Abarrotes', 'Bebidas', 'Botanas', 'Lácteos', 'Limpieza', 'Dulces'],
  fruteria: ['Frutas', 'Verduras', 'Chiles y hierbas', 'Semillas', 'Abarrotes'],
  polleria: ['Pollo', 'Huevo', 'Menudencias', 'Abarrotes'],
  tortilleria: ['Tortilla', 'Masa', 'Totopos y tostadas', 'Abarrotes'],
  panaderia: ['Pan dulce', 'Pan blanco', 'Pasteles', 'Bebidas', 'Abarrotes'],
  dulceria: ['Dulces', 'Chocolates', 'Botanas', 'Bebidas', 'Piñatas y fiesta'],
  rosticeria: ['Pollo rostizado', 'Guarniciones', 'Salsas', 'Bebidas']
};

function args() {
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) if (v[i].startsWith('--')) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true;
  return a;
}
const a = args();
const falta = ['negocio', 'dueno', 'usuario', 'password'].filter(k => !a[k]);
if (!process.env.DATABASE_URL || falta.length) {
  console.error('Faltan datos: ' + [!process.env.DATABASE_URL && 'DATABASE_URL', ...falta.map(f => '--' + f)].filter(Boolean).join(', '));
  console.error('Ejemplo: DATABASE_URL="postgresql://..." node scripts/alta-cliente.js --negocio "Mi Negocio" --dueno "Nombre" --usuario admin --password "Clave123"');
  process.exit(1);
}
if (String(a.password).length < 8) { console.error('La contraseña debe tener al menos 8 caracteres.'); process.exit(1); }
if (a.giro && a.giro !== true && !GIROS[a.giro]) { console.error('Giro no válido. Opciones: ' + Object.keys(GIROS).join(', ')); process.exit(1); }

const schemaPath = path.join(__dirname, 'schema.sql');
if (!fs.existsSync(schemaPath)) { console.error('No existe scripts/schema.sql. Primero corre exportar-esquema.js contra tu base actual.'); process.exit(1); }

const totalSucursales = Math.max(1, parseInt(a.sucursales, 10) || 1);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });

(async () => {
  const c = await pool.connect();
  try {
    const existentes = await c.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = 'public'");
    if (existentes.rows[0].n > 0) throw new Error('La base de datos NO está vacía (ya tiene tablas). Usa una base nueva para cada cliente.');

    await c.query('BEGIN');
    await c.query(fs.readFileSync(schemaPath, 'utf8'));

    // Columnas nuevas que pueden faltar si la base de la que se copió el
    // esquema aún no tenía aplicada alguna migración (es idempotente).
    await c.query(`ALTER TABLE configuracion
      ADD COLUMN IF NOT EXISTS etiqueta_modo TEXT NOT NULL DEFAULT 'auto',
      ADD COLUMN IF NOT EXISTS ancho_etiqueta TEXT NOT NULL DEFAULT '50mm',
      ADD COLUMN IF NOT EXISTS bascula_tipo_dato TEXT NOT NULL DEFAULT 'peso'`);

    const suc = await c.query('INSERT INTO sucursales (nombre, direccion, telefono, activo) VALUES ($1,$2,$3,true) RETURNING id',
      [a.negocio, a.direccion || null, a.telefono || null]);
    const sucursalId = suc.rows[0].id;

    await c.query('INSERT INTO configuracion (sucursal_id, direccion, telefono) VALUES ($1,$2,$3)', [sucursalId, a.direccion || null, a.telefono || null]);

    // Con 2 o más sucursales el dueño entra como "jefe_general" (ve y opera
    // todas, sin sucursal fija). Con una sola, como "dueno" de esa sucursal.
    const hash = await bcrypt.hash(String(a.password), 10);
    const multi = totalSucursales > 1;
    await c.query('INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,$2,$3,$4,$5,true)',
      [multi ? null : sucursalId, a.dueno, a.usuario, hash, multi ? 'jefe_general' : 'dueno']);

    if (a.giro && GIROS[a.giro]) {
      for (let i = 0; i < GIROS[a.giro].length; i++) await c.query('INSERT INTO categorias (nombre, orden) VALUES ($1,$2)', [GIROS[a.giro][i], i + 1]);
    }

    // Licencia (renta anual): por defecto 12 meses desde hoy. Con
    // --licencia-meses 0 se crea SIN control de licencia.
    const mesesLic = a['licencia-meses'] === undefined ? 12 : parseInt(a['licencia-meses'], 10);
    if (mesesLic > 0) {
      await c.query(`CREATE TABLE IF NOT EXISTS licencia (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        cliente TEXT, fecha_inicio DATE NOT NULL, fecha_vencimiento DATE NOT NULL,
        actualizado_en TIMESTAMP NOT NULL DEFAULT NOW())`);
      await c.query(`INSERT INTO licencia (id, cliente, fecha_inicio, fecha_vencimiento)
        VALUES (1, $1, (NOW() AT TIME ZONE 'America/Mexico_City')::date,
                (NOW() AT TIME ZONE 'America/Mexico_City')::date + ($2 || ' months')::interval)`, [a.negocio, String(mesesLic)]);
    }
    await c.query('COMMIT');

    console.log('\n=== CLIENTE CREADO ===');
    console.log(`Negocio: ${a.negocio}  (sucursal #${sucursalId})`);
    console.log(`Usuario: ${a.usuario} (${totalSucursales > 1 ? 'jefe_general: ve todas las sucursales' : 'dueño'}) - la contraseña es la que escribiste`);
    if (totalSucursales > 1) console.log(`Sucursal #1 creada. Las otras ${totalSucursales - 1} se crean desde el sistema (Sucursales) con este usuario.`);
    console.log(mesesLic > 0 ? `Licencia: ${mesesLic} meses desde hoy (se bloquea al vencer; avisa 7 días antes)` : 'Licencia: SIN control');
    console.log('\n--- Variables de entorno para el backend en Render ---');
    console.log('DATABASE_URL=' + process.env.DATABASE_URL);
    console.log('JWT_SECRET=' + crypto.randomBytes(32).toString('hex'));
    console.log('MAX_SUCURSALES=' + totalSucursales);
    console.log('\n--- frontend/js/config.js ---');
    console.log("const API_URL = 'https://NOMBRE-DEL-BACKEND-DEL-CLIENTE.onrender.com/api';");
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('\nError (no se guardó nada): ' + e.message);
    process.exitCode = 1;
  } finally { c.release(); await pool.end(); }
})();
