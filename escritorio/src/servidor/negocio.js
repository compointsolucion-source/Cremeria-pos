// Prepara la base del negocio la primera vez: crea las tablas y el usuario dueño
// (misma lógica que backend/scripts/alta-cliente.js).
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

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

async function baseVacia(url) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = 'public'");
    return r.rows[0].n === 0;
  } finally { await c.end(); }
}

function validar(d) {
  const err = [];
  if (!d || !String(d.negocio || '').trim()) err.push('Escribe el nombre del negocio.');
  if (!String(d.dueno || '').trim()) err.push('Escribe el nombre del dueño.');
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(String(d.usuario || ''))) err.push('El usuario debe tener de 3 a 30 letras o números (sin espacios).');
  if (String(d.password || '').length < 8) err.push('La contraseña debe tener al menos 8 caracteres.');
  if (d && d.giro && !GIROS[d.giro]) err.push('Giro no válido.');
  return err;
}

async function crearNegocio(url, d, dirServidor) {
  const errores = validar(d);
  if (errores.length) throw new Error(errores.join(' '));
  const schema = fs.readFileSync(path.join(dirServidor, 'backend', 'scripts', 'schema.sql'), 'utf8');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(schema);
    await c.query(`ALTER TABLE configuracion
      ADD COLUMN IF NOT EXISTS etiqueta_modo TEXT NOT NULL DEFAULT 'auto',
      ADD COLUMN IF NOT EXISTS ancho_etiqueta TEXT NOT NULL DEFAULT '50mm',
      ADD COLUMN IF NOT EXISTS bascula_tipo_dato TEXT NOT NULL DEFAULT 'peso'`);
    const suc = await c.query('INSERT INTO sucursales (nombre, direccion, telefono, activo) VALUES ($1,$2,$3,true) RETURNING id',
      [d.negocio.trim(), d.direccion || null, d.telefono || null]);
    const sucursalId = suc.rows[0].id;
    await c.query('INSERT INTO configuracion (sucursal_id, direccion, telefono) VALUES ($1,$2,$3)', [sucursalId, d.direccion || null, d.telefono || null]);
    const hash = await bcrypt.hash(String(d.password), 10);
    await c.query('INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,$2,$3,$4,$5,true)',
      [sucursalId, d.dueno.trim(), d.usuario.trim(), hash, 'dueno']);
    if (d.giro && GIROS[d.giro]) {
      for (let i = 0; i < GIROS[d.giro].length; i++) await c.query('INSERT INTO categorias (nombre, orden) VALUES ($1,$2)', [GIROS[d.giro][i], i + 1]);
    }
    const meses = d.licenciaMeses === undefined ? 0 : parseInt(d.licenciaMeses, 10);
    if (meses > 0) {
      await c.query(`CREATE TABLE IF NOT EXISTS licencia (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), cliente TEXT, fecha_inicio DATE NOT NULL, fecha_vencimiento DATE NOT NULL,
        actualizado_en TIMESTAMP NOT NULL DEFAULT NOW())`);
      await c.query(`INSERT INTO licencia (id, cliente, fecha_inicio, fecha_vencimiento)
        VALUES (1, $1, (NOW() AT TIME ZONE 'America/Mexico_City')::date, (NOW() AT TIME ZONE 'America/Mexico_City')::date + ($2 || ' months')::interval)`,
        [d.negocio.trim(), String(meses)]);
    }
    await c.query('COMMIT');
    return { sucursalId };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { await c.end(); }
}

module.exports = { GIROS, baseVacia, crearNegocio, validar };
