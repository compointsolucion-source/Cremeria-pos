// Recepción de la información del servidor local del negocio (copia espejo en la nube).
//
// El servidor del negocio (la computadora con Compoint Punto en modo servidor) manda aquí,
// por lotes, todo lo que registra. Así la nube queda como COPIA / CONSULTA de lo que pasa en
// el local, aunque el internet se haya ido por horas o días: al regresar, se pone al día sola.
//
// Seguridad: el local manda una clave en el encabezado X-Sync-Key. Esa clave puede venir de dos lados:
//  1) Vinculación con el usuario dueño (lo normal): el dueño inicia sesión una vez desde el panel del
//     servidor local (POST /api/sync/vincular); la nube crea una clave al azar, guarda solo su hash en la
//     tabla sync_vinculo y se la entrega al local. No hay que entrar a Render.
//  2) Variable SYNC_KEY (mínimo 16 caracteres) en el servidor de la nube: sigue funcionando como antes.
// Sin ninguna de las dos, este módulo está apagado (responde 503).
//
// IMPORTANTE: la nube que recibe esta copia es un ESPEJO: lo que se capture directamente en
// ella se sobrescribe con lo del servidor local.
const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

const router = express.Router();
// sync_vinculo guarda la clave de ESTA nube: nunca se copia ni se vacía con el espejo.
const EXCLUIDAS = new Set(['licencia', 'instalacion', 'datos_negocio', 'licencia_solicitud', 'schema_migrations', 'sync_vinculo']);
const q = (n) => '"' + String(n).replace(/"/g, '""') + '"';

// ------------------------------------------------------------ autenticación
function hash(t) { return crypto.createHash('sha256').update(String(t || '')).digest(); }

// La tabla normalmente la crea la migración 006; esto la asegura por si esa no corrió.
let tablaLista = null;
function asegurarTabla() {
  if (!tablaLista) {
    tablaLista = pool.query(`CREATE TABLE IF NOT EXISTS sync_vinculo (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      clave_hash TEXT NOT NULL,
      vinculado_por TEXT,
      vinculado_en TIMESTAMP NOT NULL DEFAULT NOW())`).catch((e) => { tablaLista = null; throw e; });
  }
  return tablaLista;
}
async function hashGuardado() {
  await asegurarTabla();
  const r = await pool.query('SELECT clave_hash FROM sync_vinculo WHERE id = 1');
  return r.rows.length ? String(r.rows[0].clave_hash || '') : '';
}

async function autenticar(req, res, next) {
  const recibida = req.get('X-Sync-Key') || '';
  const env = process.env.SYNC_KEY || '';
  try {
    if (recibida && env.length >= 16 && crypto.timingSafeEqual(hash(env), hash(recibida))) {
      req.syncVia = 'variable';
      return next();
    }
    const guardado = await hashGuardado();
    const esperado = /^[0-9a-f]{64}$/i.test(guardado) ? Buffer.from(guardado, 'hex') : null;
    if (recibida && esperado && crypto.timingSafeEqual(esperado, hash(recibida))) {
      req.syncVia = 'guardada';
      return next();
    }
    if (env.length < 16 && !esperado) {
      return res.status(503).json({ error: 'La sincronización todavía no está vinculada con esta nube. Conéctala desde el panel del servidor con el usuario dueño.' });
    }
    return res.status(401).json({ error: 'La nube ya no reconoce a esta computadora (se vinculó otra o se cambió la clave). Vuelve a conectar con el usuario dueño.' });
  } catch (e) {
    console.error('sync/autenticar:', e.message);
    return res.status(500).json({ error: 'No se pudo leer la base de datos de la nube.' });
  }
}

// ------------------------------------------------------------ estructura de la base
let cache = null;
async function estructura() {
  if (cache && Date.now() - cache.t < 5 * 60 * 1000) return cache;
  const tablas = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows
    .map((r) => r.tablename).filter((t) => !EXCLUIDAS.has(t));
  const set = new Set(tablas);
  const pk = {};
  const rp = await pool.query(`SELECT c.relname AS tabla, a.attname AS col FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE i.indisprimary AND c.relnamespace = 'public'::regnamespace`);
  for (const r of rp.rows) if (set.has(r.tabla)) pk[r.tabla] = r.col;
  const cols = {};
  const rc = await pool.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`);
  for (const r of rc.rows) if (set.has(r.table_name)) (cols[r.table_name] = cols[r.table_name] || []).push(r.column_name);
  // Orden: primero las tablas "padre" (a las que otras apuntan).
  const dep = {};
  tablas.forEach((t) => { dep[t] = new Set(); });
  const rf = await pool.query(`SELECT c.conrelid::regclass::text AS hijo, c.confrelid::regclass::text AS padre
    FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`);
  for (const r of rf.rows) {
    const h = r.hijo.replace(/"/g, ''); const p = r.padre.replace(/"/g, '');
    if (h !== p && set.has(h) && set.has(p)) dep[h].add(p);
  }
  const orden = []; const listo = new Set();
  let pendientes = [...tablas].sort();
  while (pendientes.length) {
    const sig = pendientes.filter((t) => [...dep[t]].every((p) => listo.has(p)));
    const tomar = sig.length ? sig : [pendientes[0]]; // ciclo inesperado: se sigue de todos modos
    for (const t of tomar) { orden.push(t); listo.add(t); }
    pendientes = pendientes.filter((t) => !listo.has(t));
  }
  cache = { t: Date.now(), tablas, pk, cols, orden };
  return cache;
}

function sqlUpsert(m, t) {
  const pk = m.pk[t];
  const otras = m.cols[t].filter((c) => c !== pk);
  const base = `INSERT INTO ${q(t)} SELECT * FROM json_populate_recordset(null::${q(t)}, $1::json) ON CONFLICT (${q(pk)})`;
  return otras.length ? `${base} DO UPDATE SET ${otras.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ')}` : `${base} DO NOTHING`;
}

async function ajustarContadores(c, m, tablas) {
  for (const t of tablas) {
    const pk = m.pk[t];
    if (!pk) continue;
    const s = (await c.query('SELECT pg_get_serial_sequence($1, $2) AS seq', [q(t), pk])).rows[0];
    if (s && s.seq) await c.query(`SELECT setval($1, COALESCE((SELECT MAX(${q(pk)}) FROM ${q(t)}), 0) + 1, false)`, [s.seq]);
  }
}

// ------------------------------------------------------------ rutas
// Vincular con el usuario dueño: el panel del servidor local inicia sesión (POST /api/auth/login) y con ese
// token pide aquí una clave nueva. Se guarda solo su hash; la clave en claro se entrega UNA vez.
// Vincular otra vez reemplaza la clave anterior (la computadora vinculada antes deja de poder subir).
router.post('/vincular', verificarToken, requiereRol('dueno', 'jefe_general'), async (req, res) => {
  try {
    await asegurarTabla();
    const previa = await pool.query('SELECT 1 FROM sync_vinculo WHERE id = 1');
    const clave = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO sync_vinculo (id, clave_hash, vinculado_por, vinculado_en) VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET clave_hash = EXCLUDED.clave_hash, vinculado_por = EXCLUDED.vinculado_por, vinculado_en = NOW()`,
      [hash(clave).toString('hex'), String(req.usuario.usuario || req.usuario.nombre || '')]
    );
    await registrarBitacora(pool, { usuario_id: req.usuario.id, accion: 'sync_vincular', modulo: 'sistema' });
    res.json({ ok: true, clave, reemplazo: previa.rows.length > 0 });
  } catch (e) {
    console.error('sync/vincular:', e.message);
    res.status(500).json({ error: 'No se pudo vincular con la nube. Intenta de nuevo.' });
  }
});

// Desvincular (lo usa el panel al «Dejar de sincronizar»): borra la clave guardada. Solo con esa misma clave.
// Si la clave vino de la variable SYNC_KEY de Render, no hay nada guardado que borrar.
router.post('/desvincular', autenticar, async (req, res) => {
  try {
    if (req.syncVia === 'guardada') await pool.query('DELETE FROM sync_vinculo WHERE id = 1');
    res.json({ ok: true });
  } catch (e) {
    console.error('sync/desvincular:', e.message);
    res.status(500).json({ error: 'No se pudo desvincular en la nube.' });
  }
});

// Probar conexión y clave.
router.get('/estado', autenticar, async (req, res) => {
  try {
    const m = await estructura();
    res.json({ ok: true, version: 1, tablas: m.orden.length });
  } catch (e) {
    console.error('sync/estado:', e.message);
    res.status(500).json({ error: 'No se pudo leer la base de datos de la nube.' });
  }
});

// Inicio de una copia COMPLETA: vacía las tablas espejo para volver a llenarlas desde el local.
router.post('/completo/iniciar', autenticar, async (req, res) => {
  try {
    const m = await estructura();
    await pool.query(`TRUNCATE ${m.tablas.map(q).join(', ')}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('sync/completo/iniciar:', e.message);
    res.status(500).json({ error: 'No se pudo preparar la nube para la copia completa.' });
  }
});

// Aplica un lote: [{ t: tabla, pk: id, fila: {…} | null }]  (fila null = el registro ya no existe)
router.post('/aplicar', autenticar, async (req, res) => {
  const lote = Array.isArray(req.body && req.body.lote) ? req.body.lote : [];
  if (lote.length > 1000) return res.status(413).json({ error: 'Lote demasiado grande.' });
  let m;
  try { m = await estructura(); } catch (e) { return res.status(500).json({ error: 'No se pudo leer la base de datos de la nube.' }); }

  const validos = []; // { t, pk, fila }
  for (const it of lote) {
    if (!it || typeof it.t !== 'string' || !m.pk[it.t]) continue; // tabla desconocida: se ignora
    validos.push({ t: it.t, pk: String(it.pk), fila: it.fila && typeof it.fila === 'object' ? it.fila : null });
  }
  const pos = new Map(m.orden.map((t, i) => [t, i]));
  const ups = validos.filter((x) => x.fila).sort((a, b) => pos.get(a.t) - pos.get(b.t));
  const dels = validos.filter((x) => !x.fila).sort((a, b) => pos.get(b.t) - pos.get(a.t));

  const c = await pool.connect();
  const tocadas = new Set(ups.map((x) => x.t));
  try {
    // Camino rápido: todo el lote junto, agrupado por tabla.
    let ok = false;
    try {
      await c.query('BEGIN');
      await c.query('SAVEPOINT rep');
      try { await c.query("SET LOCAL session_replication_role = 'replica'"); } catch (e) { await c.query('ROLLBACK TO SAVEPOINT rep'); }
      for (let i = 0; i < ups.length;) {
        let j = i; while (j < ups.length && ups[j].t === ups[i].t) j++;
        await c.query(sqlUpsert(m, ups[i].t), [JSON.stringify(ups.slice(i, j).map((x) => x.fila))]);
        i = j;
      }
      for (const d of dels) await c.query(`DELETE FROM ${q(d.t)} WHERE ${q(m.pk[d.t])} = $1`, [d.pk]);
      await ajustarContadores(c, m, tocadas);
      await c.query('COMMIT');
      ok = true;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
    }
    if (ok) return res.json({ ok: true, aplicados: validos.length, fallidos: [] });

    // Camino lento: registro por registro (varias vueltas, por si un registro depende de otro del mismo lote).
    await c.query('BEGIN');
    await c.query('SAVEPOINT rep');
    try { await c.query("SET LOCAL session_replication_role = 'replica'"); } catch (e) { await c.query('ROLLBACK TO SAVEPOINT rep'); }
    let pendientes = [...ups, ...dels];
    const errores = new Map();
    for (let vuelta = 0; vuelta < 3 && pendientes.length; vuelta++) {
      const siguen = [];
      for (const it of pendientes) {
        await c.query('SAVEPOINT fila');
        try {
          if (it.fila) await c.query(sqlUpsert(m, it.t), [JSON.stringify([it.fila])]);
          else await c.query(`DELETE FROM ${q(it.t)} WHERE ${q(m.pk[it.t])} = $1`, [it.pk]);
          await c.query('RELEASE SAVEPOINT fila');
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT fila');
          // Valor único ocupado por otro registro de la nube (ej. dos productos que intercambian código):
          // ese otro registro está desactualizado respecto al local, así que se le libera el valor.
          let arreglado = false;
          if (e.code === '23505' && it.fila) {
            const mt = /Key \(([^,()]+)\)=\((.*)\) already exists/.exec(e.detail || '');
            if (mt && m.cols[it.t].includes(mt[1])) {
              await c.query('SAVEPOINT libera');
              try {
                await c.query(`UPDATE ${q(it.t)} SET ${q(mt[1])} = NULL WHERE ${q(mt[1])}::text = $1 AND ${q(m.pk[it.t])}::text <> $2`, [mt[2], it.pk]);
                await c.query('RELEASE SAVEPOINT libera');
                await c.query('SAVEPOINT fila');
                await c.query(sqlUpsert(m, it.t), [JSON.stringify([it.fila])]);
                await c.query('RELEASE SAVEPOINT fila');
                arreglado = true;
              } catch (e2) { await c.query('ROLLBACK TO SAVEPOINT libera').catch(() => {}); await c.query('ROLLBACK TO SAVEPOINT fila').catch(() => {}); }
            }
          }
          if (!arreglado) {
            errores.set(it.t + '|' + it.pk, String(e.message).slice(0, 160));
            siguen.push(it);
          }
        }
      }
      pendientes = siguen;
    }
    await ajustarContadores(c, m, tocadas);
    await c.query('COMMIT');
    const fallidos = pendientes.map((it) => ({ t: it.t, pk: it.pk, error: errores.get(it.t + '|' + it.pk) }));
    res.json({ ok: true, aplicados: validos.length - fallidos.length, fallidos });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('sync/aplicar:', e.message);
    res.status(500).json({ error: 'No se pudo aplicar el lote en la nube.' });
  } finally {
    c.release();
  }
});

module.exports = router;
