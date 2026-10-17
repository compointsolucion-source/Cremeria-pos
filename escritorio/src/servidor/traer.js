// Traer a esta computadora TODA la información del sistema en la nube del cliente.
// Es el camino contrario a la sincronización (que sube de la computadora a la nube).
//
//   1) abrirSesionNube : con la dirección + usuario y contraseña del dueño, entra a la nube y revisa que
//                        tenga las rutas para bajar la información (si no, avisa que falta actualizarla).
//   2) traerDeNube     : deja la base local con las tablas al día y baja cada tabla por pedazos.
//
// Se escribe todo en UNA transacción: si algo falla (se va el internet, la nube se duerme…), no se guarda nada.
// La contraseña del dueño se usa solo para iniciar sesión y no se guarda.
const { Client } = require('pg');
const { resolverApi, iniciarSesionDueno, leerNube, errorNube, EXCLUIDAS } = require('./sync');
const { prepararBase, vaciarBase } = require('./negocio');

const LOTE = 500;
const q = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const filas = (t) => (t && Number.isFinite(t.filas) ? t.filas : 0);

// Mensaje entendible para quien no sabe de computadoras.
function mensajeAmable(err) {
  const msg = String((err && err.message) || err || '');
  if (err && err.http) return msg;
  if (/fetch failed|abort|timeout|ENOTFOUND|ECONN|EAI_AGAIN|network/i.test(msg)) {
    return 'No hay conexión con la nube (revisa el internet y la dirección). Si tu sistema está en el plan gratis de Render puede tardar ~1 minuto en despertar: intenta de nuevo.';
  }
  return msg;
}

// Entra a la nube con el dueño y averigua qué hay para bajar. No toca esta computadora.
async function abrirSesionNube({ texto, usuario, password }) {
  const api = await resolverApi(texto);
  const { token } = await iniciarSesionDueno(api, usuario, password);
  let estructura;
  try {
    estructura = await leerNube(api, '/sync/exportar/estructura', { token });
  } catch (e) {
    if (e.http === 404) {
      throw errorNube('Tu sistema en la nube todavía no tiene la actualización para bajar la información. Pídele a Compoint que lo actualice e intenta de nuevo.', 404);
    }
    throw e;
  }
  if (!estructura || typeof estructura.tablas !== 'object' || !Array.isArray(estructura.orden)) {
    throw errorNube('La nube no devolvió la lista de su información. Intenta de nuevo; si sigue igual, avisa a Compoint.', 502);
  }
  let licencia = null;
  try { licencia = await leerNube(api, '/sync/licencia', { token, timeout: 30000 }); } catch (e) { licencia = null; }
  const t = estructura.tablas;
  return {
    api, texto: String(texto).trim(), token, estructura, licencia,
    resumen: { productos: filas(t.productos), ventas: filas(t.tickets), clientes: filas(t.clientes), usuarios: filas(t.usuarios), total: Number(estructura.total) || 0 }
  };
}

// Tablas de esta base: llave, columnas y cuáles no se pueden escribir (generadas).
async function estructuraLocal(c) {
  const tablas = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => r.tablename);
  const set = new Set(tablas);
  const out = {};
  for (const t of tablas) out[t] = { pk: null, cols: [], generadas: new Set() };
  const rp = await c.query(`SELECT c.relname AS tabla, a.attname AS col FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE i.indisprimary AND c.relnamespace = 'public'::regnamespace`);
  for (const r of rp.rows) if (set.has(r.tabla)) out[r.tabla].pk = r.col;
  const rc = await c.query(`SELECT table_name, column_name, is_generated, identity_generation FROM information_schema.columns
    WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`);
  for (const r of rc.rows) {
    if (!set.has(r.table_name)) continue;
    out[r.table_name].cols.push(r.column_name);
    if (r.is_generated === 'ALWAYS' || r.identity_generation === 'ALWAYS') out[r.table_name].generadas.add(r.column_name);
  }
  return out;
}

// Baja las tablas de la nube y las escribe en la base local (que ya debe tener sus tablas).
async function importar({ url, sesion, avisar = () => {}, log = () => {}, lote: tamLote = LOTE }) {
  const { api, token, estructura: nube } = sesion;
  const c = new Client({ connectionString: url });
  await c.connect();
  const recibidas = {};
  try {
    const local = await estructuraLocal(c);
    // Solo tablas que existen en las dos partes (la nube puede estar más vieja o más nueva que este programa).
    const tablas = nube.orden.filter((t) => nube.tablas[t] && local[t] && local[t].pk && !EXCLUIDAS.has(t));
    const total = tablas.reduce((a, t) => a + filas(nube.tablas[t]), 0);
    let hechas = 0; let ultimoAviso = 0;
    const avance = (texto) => { const ahora = Date.now(); if (ahora - ultimoAviso > 400) { ultimoAviso = ahora; avisar(texto); } };

    await c.query('BEGIN');
    // Que no se disparen cálculos ni bitácoras al meter registros ya hechos (solo con permisos de administrador de la base).
    await c.query('SAVEPOINT rep');
    try { await c.query("SET LOCAL session_replication_role = 'replica'"); } catch (e) { await c.query('ROLLBACK TO SAVEPOINT rep'); }
    if (tablas.length) await c.query(`TRUNCATE ${tablas.map(q).join(', ')} RESTART IDENTITY CASCADE`);

    for (const t of tablas) {
      const cols = nube.tablas[t].cols.filter((x) => local[t].cols.includes(x) && !local[t].generadas.has(x));
      recibidas[t] = 0;
      if (!cols.length) continue;
      const lista = cols.map(q).join(', ');
      const sql = `INSERT INTO ${q(t)} (${lista}) SELECT ${lista} FROM json_populate_recordset(null::${q(t)}, $1::json)`;
      let desde = null;
      for (;;) {
        const ruta = `/sync/exportar/${encodeURIComponent(t)}?limite=${tamLote}` + (desde !== null ? '&desde=' + encodeURIComponent(desde) : '');
        const r = await leerNube(api, ruta, { token });
        const lote = Array.isArray(r.filas) ? r.filas : [];
        if (lote.length) {
          await c.query(sql, [JSON.stringify(lote)]);
          recibidas[t] += lote.length; hechas += lote.length;
        }
        avance(`Bajando tu información de la nube… ${total ? Math.min(99, Math.floor((hechas / total) * 100)) : 100}%`);
        if (!r.siguiente || !lote.length) break;
        desde = String(r.siguiente);
      }
    }

    // Los contadores de folios/ids siguen donde se quedó la nube.
    for (const t of tablas) {
      const s = (await c.query('SELECT pg_get_serial_sequence($1, $2) AS seq', [q(t), local[t].pk])).rows[0];
      if (s && s.seq) await c.query(`SELECT setval($1, COALESCE((SELECT MAX(${q(local[t].pk)}) FROM ${q(t)}), 0) + 1, false)`, [s.seq]);
    }

    // Comprobación: lo que quedó escrito es lo que se recibió.
    for (const t of tablas) {
      const n = Number((await c.query(`SELECT COUNT(*) AS n FROM ${q(t)}`)).rows[0].n);
      if (n !== recibidas[t]) throw new Error(`La tabla ${t} quedó incompleta (${n} de ${recibidas[t]}).`);
    }
    // Debe haber al menos un usuario dueño para poder entrar.
    if (local.usuarios) {
      const d = await c.query("SELECT COUNT(*)::int AS n FROM usuarios WHERE rol IN ('dueno','jefe_general') AND activo IS NOT FALSE");
      if (!d.rows[0].n) throw new Error('La información que bajó de la nube no trae al usuario dueño. No se guardó nada.');
    }
    await c.query('COMMIT');
    log(`Información traída de la nube: ${hechas} registros en ${tablas.length} tablas.`);
    return { tablas: tablas.length, registros: hechas, porTabla: recibidas };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { await c.end().catch(() => {}); }
}

// Todo el trabajo: (opcional) prepara las tablas y baja la información.
//  - Negocio nuevo (prepararAntes + limpiarSiFalla): si falla, la base queda VACÍA (como nueva) para volver a intentar desde cero.
//  - Computadora que ya tenía información: no se prepara nada y, si falla, la transacción se deshace y lo de aquí queda intacto.
async function traerDeNube({ url, dirServidor, sesion, avisar = () => {}, log = () => {}, prepararAntes = true, limpiarSiFalla = true, lote }) {
  try {
    avisar('Preparando esta computadora…');
    if (prepararAntes) await prepararBase(url, dirServidor);
    return await importar({ url, sesion, avisar, log, lote });
  } catch (e) {
    if (limpiarSiFalla) { try { await vaciarBase(url); } catch (e2) { log('No se pudo dejar la base limpia tras el error: ' + e2.message); } }
    const err = new Error('No se pudo traer la información de la nube: ' + mensajeAmable(e) + '\n\n' +
      (limpiarSiFalla ? 'No se guardó nada en esta computadora. Vuelve a abrir el programa e intenta de nuevo.' : 'Tu información de esta computadora quedó como estaba.'));
    err.original = e;
    throw err;
  }
}

module.exports = { abrirSesionNube, traerDeNube, importar, estructuraLocal, mensajeAmable };
