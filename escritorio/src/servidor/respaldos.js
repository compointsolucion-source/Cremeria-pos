// Respaldos automáticos del negocio.
//  - Se guardan en el disco local (C:\CompointPunto\Respaldos), los últimos 30.
//  - Si hay internet y Cloudinary está configurado, se sube una copia (1 por día, los últimos 10 días).
//  - Si no hay internet, la copia en la nube queda pendiente y se reintenta sola.
// Formato: archivo .json.gz con todas las tablas (se restaura con restaurarRespaldo).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Pool, Client } = require('pg');
const { pipeline } = require('stream/promises');
const { leerJson, guardarJson } = require('./rutas');

const MAX_LOCALES = 30;
const DIAS_NUBE = 10;
const FORMATO = 1;

const dos = (n) => String(n).padStart(2, '0');
function sello(d = new Date()) { return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`; }
function selloHora(d = new Date()) { return `${sello(d)}_${dos(d.getHours())}${dos(d.getMinutes())}${dos(d.getSeconds())}`; }
const slug = (t) => String(t || 'negocio').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'negocio';
const comillas = (n) => '"' + String(n).replace(/"/g, '""') + '"';

// ---------------------------------------------------------------- volcado
async function volcar(url, destino, log) {
  const pool = new Pool({ connectionString: url, max: 1 });
  const c = await pool.connect();
  const tablas = {};
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const lista = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows.map(r => r.tablename);
    const gz = zlib.createGzip({ level: 6 });
    const salida = fs.createWriteStream(destino);
    const fin = pipeline(gz, salida);
    gz.write(`{"formato":${FORMATO},"creado":${JSON.stringify(new Date().toISOString())},"tablas":{`);
    let primera = true;
    for (const t of lista) {
      const r = await c.query(`SELECT row_to_json(x)::text AS j FROM ${comillas(t)} x`);
      tablas[t] = r.rows.length;
      gz.write((primera ? '' : ',') + JSON.stringify(t) + ':[' + r.rows.map(f => f.j).join(',') + ']');
      primera = false;
    }
    gz.write('}}');
    gz.end();
    await fin;
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); await pool.end(); }
  return tablas;
}

function verificar(archivo, tablasEsperadas) {
  const datos = JSON.parse(zlib.gunzipSync(fs.readFileSync(archivo)).toString('utf8'));
  if (datos.formato !== FORMATO || !datos.tablas) throw new Error('El respaldo no tiene el formato esperado.');
  for (const [t, n] of Object.entries(tablasEsperadas)) {
    if (!Array.isArray(datos.tablas[t]) || datos.tablas[t].length !== n) throw new Error(`Verificación fallida en la tabla ${t}.`);
  }
  return true;
}

// ---------------------------------------------------------------- nube (Cloudinary)
function cloudinaryConfigurado(nube) { return !!(nube && nube.cloud_name && nube.api_key && nube.api_secret); }
function clienteCloudinary(nube) {
  const { v2 } = require('cloudinary');
  v2.config({ cloud_name: nube.cloud_name, api_key: nube.api_key, api_secret: nube.api_secret, secure: true });
  return v2;
}
const carpetaNube = (nombreNegocio) => `compoint-respaldos/${slug(nombreNegocio)}`;

async function subirANube({ nube, archivo, nombreNegocio, fecha }) {
  const cl = clienteCloudinary(nube);
  const carpeta = carpetaNube(nombreNegocio);
  // Un archivo por día: si se respalda varias veces el mismo día, el último reemplaza al anterior.
  await cl.uploader.upload(archivo, {
    resource_type: 'raw', type: 'authenticated', public_id: `${carpeta}/respaldo-${fecha}.json.gz`,
    overwrite: true, invalidate: true
  });
  // Rotación: se conservan solo los últimos DIAS_NUBE días.
  const lista = await cl.api.resources({ resource_type: 'raw', type: 'authenticated', prefix: carpeta + '/', max_results: 200 });
  const ordenados = (lista.resources || []).map(r => r.public_id).sort().reverse();
  const sobrantes = ordenados.slice(DIAS_NUBE);
  if (sobrantes.length) await cl.api.delete_resources(sobrantes, { resource_type: 'raw', type: 'authenticated' });
  return { guardados: Math.min(ordenados.length, DIAS_NUBE), borrados: sobrantes.length };
}

async function probarNube(nube, nombreNegocio) {
  if (!cloudinaryConfigurado(nube)) throw new Error('Faltan datos de Cloudinary (nombre de la nube, API key y API secret).');
  const cl = clienteCloudinary(nube);
  await cl.api.ping();
  return true;
}

// ---------------------------------------------------------------- respaldo completo
function crearGestor({ rutas, urlBase, obtenerNegocio, obtenerNube, log }) {
  let enCurso = null;

  function estado() { return leerJson(rutas.estadoRespaldos, {}); }
  function guardarEstado(cambios) { guardarJson(rutas.estadoRespaldos, { ...estado(), ...cambios }); }

  function listarLocales() {
    return fs.readdirSync(rutas.respaldos).filter(f => /^respaldo-.*\.json\.gz$/.test(f)).sort().reverse()
      .map(f => { const st = fs.statSync(path.join(rutas.respaldos, f)); return { archivo: f, ruta: path.join(rutas.respaldos, f), tamano: st.size, fecha: st.mtime.toISOString() }; });
  }

  async function intentarNube(archivo, fecha) {
    const nube = obtenerNube();
    if (!cloudinaryConfigurado(nube)) { guardarEstado({ nube: { configurada: false } }); return { estado: 'sin-configurar' }; }
    try {
      const r = await subirANube({ nube, archivo, nombreNegocio: obtenerNegocio(), fecha });
      guardarEstado({ nube: { configurada: true, ultimo_ok: new Date().toISOString(), ultimo_archivo: path.basename(archivo), pendiente: false, error: null } });
      return { estado: 'ok', ...r };
    } catch (e) {
      const msg = String(e && (e.message || (e.error && e.error.message)) || e).slice(0, 300);
      log('Respaldo en la nube pendiente: ' + msg);
      guardarEstado({ nube: { ...(estado().nube || {}), configurada: true, pendiente: true, error: msg, ultimo_intento: new Date().toISOString() } });
      return { estado: 'pendiente', error: msg };
    }
  }

  async function hacerRespaldo(motivo = 'manual') {
    if (enCurso) return enCurso;
    enCurso = (async () => {
      const ahora = new Date();
      const nombre = `respaldo-${selloHora(ahora)}.json.gz`;
      const final = path.join(rutas.respaldos, nombre);
      const tmp = final + '.parcial';
      try {
        const tablas = await volcar(urlBase, tmp, log);
        verificar(tmp, tablas);
        fs.renameSync(tmp, final);
        const filas = Object.values(tablas).reduce((a, b) => a + b, 0);
        // Rotación local
        for (const viejo of listarLocales().slice(MAX_LOCALES)) { try { fs.unlinkSync(viejo.ruta); } catch (e) { /* ignorar */ } }
        guardarEstado({ local: { ultimo_ok: ahora.toISOString(), archivo: nombre, tamano: fs.statSync(final).size, filas, motivo, error: null } });
        log(`Respaldo local listo: ${nombre} (${filas} filas, ${motivo})`);
        const nube = await intentarNube(final, sello(ahora));
        return { ok: true, archivo: nombre, ruta: final, filas, nube };
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* nada */ }
        guardarEstado({ local: { ...(estado().local || {}), error: String(e.message || e).slice(0, 300), ultimo_intento: ahora.toISOString() } });
        log('Respaldo FALLÓ: ' + (e.message || e));
        return { ok: false, error: String(e.message || e) };
      } finally { enCurso = null; }
    })();
    return enCurso;
  }

  // Reintenta subir a la nube el último respaldo local si quedó pendiente.
  async function reintentarNube() {
    const est = estado();
    if (!est.nube || !est.nube.pendiente) return null;
    const ultimo = listarLocales()[0];
    if (!ultimo) return null;
    return intentarNube(ultimo.ruta, sello(new Date(ultimo.fecha)));
  }

  // ¿Toca un respaldo automático? (si el último tiene más de `horas` horas)
  function tocaRespaldo(horas = 12) {
    const u = (estado().local || {}).ultimo_ok;
    return !u || (Date.now() - new Date(u).getTime()) > horas * 3600 * 1000;
  }

  return { hacerRespaldo, reintentarNube, tocaRespaldo, listarLocales, estado };
}

// ---------------------------------------------------------------- restaurar
// Restaura TODO el negocio desde un respaldo. Debe llamarse con el servidor web apagado.
async function restaurarRespaldo({ url, archivo, dirServidor, log }) {
  const datos = JSON.parse(zlib.gunzipSync(fs.readFileSync(archivo)).toString('utf8'));
  if (datos.formato !== FORMATO || !datos.tablas) throw new Error('Este archivo no es un respaldo válido de Compoint Punto.');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    // 1) Estructura limpia: esquema + migraciones de esta versión del programa
    await c.query('DROP SCHEMA public CASCADE');
    await c.query('CREATE SCHEMA public');
    await c.query(fs.readFileSync(path.join(dirServidor, 'backend', 'scripts', 'schema.sql'), 'utf8'));
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (nombre TEXT PRIMARY KEY, aplicada_en TIMESTAMP NOT NULL DEFAULT NOW())`);
    const dirMig = path.join(dirServidor, 'backend', 'migrations');
    for (const f of fs.existsSync(dirMig) ? fs.readdirSync(dirMig).filter(x => /^\d+.*\.sql$/.test(x)).sort() : []) {
      await c.query(fs.readFileSync(path.join(dirMig, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (nombre) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
    }
    // 2) Datos (sin revisar llaves foráneas mientras se carga)
    await c.query("SET LOCAL session_replication_role = 'replica'");
    const existentes = new Set((await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map(r => r.tablename));
    let filas = 0;
    // Primero se vacían TODAS juntas (si se vaciaran una por una, el CASCADE borraría lo ya cargado).
    if (existentes.size) await c.query(`TRUNCATE ${[...existentes].map(comillas).join(', ')}`);
    for (const [tabla, registros] of Object.entries(datos.tablas)) {
      if (!existentes.has(tabla)) { log && log(`Tabla ${tabla} ya no existe en esta versión; se omite.`); continue; }
      for (let i = 0; i < registros.length; i += 500) {
        const lote = registros.slice(i, i + 500);
        await c.query(`INSERT INTO ${comillas(tabla)} SELECT * FROM json_populate_recordset(null::${comillas(tabla)}, $1::json)`, [JSON.stringify(lote)]);
      }
      filas += registros.length;
    }
    // 3) Contadores de ids (para que los siguientes registros no choquen)
    const seqs = await c.query(`SELECT c.relname AS tabla, a.attname AS col, pg_get_serial_sequence('"' || c.relname || '"', a.attname) AS seq
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace`);
    for (const s of seqs.rows) {
      if (!s.seq) continue;
      await c.query(`SELECT setval($1, COALESCE((SELECT MAX(${comillas(s.col)}) FROM ${comillas(s.tabla)}), 0) + 1, false)`, [s.seq]);
    }
    await c.query('COMMIT');
    return { filas, creado: datos.creado };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { await c.end(); }
}

module.exports = { crearGestor, restaurarRespaldo, probarNube, cloudinaryConfigurado, volcar, verificar, slug };
