// Recepción de la información del servidor local del negocio (copia espejo en la nube).
//
// El servidor del negocio (la computadora con Compoint Punto en modo servidor) manda aquí,
// por lotes, todo lo que registra. Así la nube queda como COPIA / CONSULTA de lo que pasa en
// el local, aunque el internet se haya ido por horas o días: al regresar, se pone al día sola.
//
// Seguridad: solo funciona si el servidor de la nube tiene la variable SYNC_KEY (mínimo 16
// caracteres) y el local manda esa misma clave en el encabezado X-Sync-Key.
// Sin SYNC_KEY este módulo está apagado (responde 503).
//
// IMPORTANTE: la nube que recibe esta copia es un ESPEJO: lo que se capture directamente en
// ella se sobrescribe con lo del servidor local.
const express = require('express');
const crypto = require('crypto');
const pool = require('../db');

const router = express.Router();
const EXCLUIDAS = new Set(['licencia', 'schema_migrations']);
const q = (n) => '"' + String(n).replace(/"/g, '""') + '"';

// ------------------------------------------------------------ autenticación
function hash(t) { return crypto.createHash('sha256').update(String(t || '')).digest(); }
function autenticar(req, res, next) {
  const clave = process.env.SYNC_KEY || '';
  if (clave.length < 16) return res.status(503).json({ error: 'La sincronización no está activada en este servidor (falta SYNC_KEY).' });
  if (!crypto.timingSafeEqual(hash(clave), hash(req.get('X-Sync-Key')))) {
    return res.status(401).json({ error: 'Clave de sincronización incorrecta.' });
  }
  next();
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
