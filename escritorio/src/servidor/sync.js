// Sincronización del servidor local con la nube (una sola dirección: local → nube).
//
// - Todo cambio en la base local (altas, cambios, bajas) se anota en una cola
//   (esquema compoint_sync) mediante disparadores de la base de datos. Funciona igual
//   con o sin internet y no depende de que el programa esté abierto en ese momento.
// - Cada 30 segundos, si hay algo en la cola, se manda por lotes a la nube
//   (POST /api/sync/aplicar). Si no hay internet, la cola crece y se vacía sola al regresar.
// - "Copia completa": vacía el espejo en la nube y lo vuelve a llenar con todo lo local.
//   Se hace la primera vez, y después de restaurar un respaldo.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Pool } = require('pg');
const { leerJson, guardarJson } = require('./rutas');

const ESQ = 'compoint_sync';
// sync_vinculo es la clave de la NUBE: no existe en la base local, pero por si acaso nunca se copia.
const EXCLUIDAS = new Set(['licencia', 'instalacion', 'schema_migrations', 'sync_vinculo']);
const LOTE = 300;
const MAX_LOTES_POR_VUELTA = 60;
const CADA_MS = 30 * 1000;
const q = (n) => '"' + String(n).replace(/"/g, '""') + '"';

// ---------------------------------------------------------------- dirección de la nube
// Acepta la dirección de la página (https://xxx.onrender.com) o la del servidor (…/api).
async function resolverApi(texto) {
  let t = String(texto || '').trim();
  if (!t) throw new Error('Escribe la dirección de tu sistema en la nube.');
  if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
  let u;
  try { u = new URL(t); } catch (e) { throw new Error('La dirección no es válida.'); }
  const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error('La dirección de la nube debe empezar con https://');
  if (/\/api\/?$/.test(u.pathname)) return u.origin + '/api';
  // ¿es la página del sistema? Su config.js dice a qué servidor habla.
  try {
    const r = await fetch(u.origin + '/js/config.js', { signal: AbortSignal.timeout(20000) });
    if (r.ok) {
      const codigo = (await r.text()) + '\n;typeof API_URL !== "undefined" ? API_URL : ""';
      const api = vm.runInNewContext(codigo, { location: { hostname: u.hostname, origin: u.origin, protocol: u.protocol } }, { timeout: 500 });
      if (typeof api === 'string' && /^https?:\/\//.test(api)) return api.replace(/\/$/, '');
    }
  } catch (e) { /* se prueba como dirección del servidor */ }
  return u.origin + '/api';
}

// ---------------------------------------------------------------- vincular con el usuario dueño
// El dueño escribe una sola vez su usuario y contraseña de la nube. Con ellos se inicia sesión y se le pide
// a la nube una clave de sincronización nueva (la nube guarda solo su hash). La contraseña NO se guarda.
// Los errores con respuesta de la nube llevan .http; los de red (sin internet / nube dormida) no.
async function llamarNube(api, ruta, { cuerpo, token, timeout = 90000 } = {}) {
  const r = await fetch(api + ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(cuerpo || {}),
    signal: AbortSignal.timeout(timeout)
  });
  let datos = {};
  try { datos = await r.json(); } catch (e) { /* respuesta sin JSON */ }
  return { ok: r.ok, status: r.status, datos };
}
const errorNube = (mensaje, http) => { const e = new Error(mensaje); e.http = http; return e; };

async function vincularConUsuario(api, usuario, password) {
  const u = String(usuario || '').trim();
  if (!u || !password) throw errorNube('Escribe el usuario y la contraseña del dueño de tu sistema en la nube.', 400);
  const login = await llamarNube(api, '/auth/login', { cuerpo: { usuario: u, password: String(password) } });
  if (!login.ok) {
    if (login.status === 401) throw errorNube('Usuario o contraseña incorrectos. Usa los del dueño con los que entras a tu sistema en la nube.', 401);
    if (login.status === 429) throw errorNube(login.datos.error || 'Demasiados intentos. Espera unos minutos e intenta de nuevo.', 429);
    if (login.status === 404) throw errorNube('No se encontró el sistema en esa dirección. Revisa que sea la dirección de tu sistema en la nube.', 404);
    throw errorNube(login.datos.error || ('La nube respondió con error ' + login.status + '.'), login.status);
  }
  const rol = login.datos.usuario && login.datos.usuario.rol;
  if (!login.datos.token) throw errorNube('La nube no devolvió una sesión válida. Revisa la dirección.', 502);
  if (rol !== 'dueno' && rol !== 'jefe_general') throw errorNube('Ese usuario no es el dueño del negocio. Usa el usuario del dueño.', 403);
  const v = await llamarNube(api, '/sync/vincular', { token: login.datos.token });
  if (!v.ok) {
    if (v.status === 404) throw errorNube('Tu sistema en la nube todavía no tiene la actualización para sincronizar. Pídele a Compoint que lo actualice.', 404);
    if (v.status === 403) throw errorNube('Solo el dueño puede conectar la sincronización.', 403);
    throw errorNube(v.datos.error || ('La nube respondió con error ' + v.status + '.'), v.status);
  }
  if (typeof v.datos.clave !== 'string' || v.datos.clave.length < 16) throw errorNube('La nube no devolvió una clave válida.', 502);
  return { clave: v.datos.clave, reemplazo: !!v.datos.reemplazo };
}

async function pedir(api, clave, ruta, opciones = {}) {
  const r = await fetch(api + '/sync' + ruta, {
    method: opciones.cuerpo ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Sync-Key': clave },
    body: opciones.cuerpo ? JSON.stringify(opciones.cuerpo) : undefined,
    signal: AbortSignal.timeout(opciones.timeout || 120000)
  });
  let datos = {};
  try { datos = await r.json(); } catch (e) { /* respuesta sin JSON */ }
  if (!r.ok) {
    const err = new Error(datos.error || ('La nube respondió con error ' + r.status + '.'));
    err.http = r.status;
    throw err;
  }
  return datos;
}

const esRed = (e) => !e.http; // sin respuesta de la nube = sin internet / nube dormida / caída

// ---------------------------------------------------------------- sincronizador
function crearSincronizador({ url, rutas, log, obtenerConfig, descifrar = (t) => t }) {
  const archivoEstado = path.join(rutas.base, 'sync-estado.json');
  let estado = leerJson(archivoEstado, {});
  const guardarEstado = (c) => { estado = { ...estado, ...c }; try { guardarJson(archivoEstado, estado); } catch (e) { /* sin disco */ } };

  let pool = null;
  let timer = null;
  let ocupado = false;
  let detenido = false;
  let ultimaInstalacion = 0;
  let progreso = '';
  const intentos = new Map(); // tabla|pk → veces que falló

  const conf = () => {
    const c = obtenerConfig() || {};
    if (!c.api || !c.clave_cifrada) return null;
    let clave = '';
    try { clave = descifrar(c.clave_cifrada); } catch (e) { return null; }
    return clave ? { api: c.api, texto: c.texto || c.api, clave } : null;
  };
  const getPool = () => (pool || (pool = new Pool({ connectionString: url, max: 2 })));

  // ----- disparadores en la base local
  async function tablasConPk() {
    const r = await getPool().query(`SELECT c.relname AS tabla, a.attname AS col FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary AND c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace`);
    return r.rows.filter((x) => !EXCLUIDAS.has(x.tabla));
  }
  async function instalarDisparadores() {
    const p = getPool();
    await p.query(`CREATE SCHEMA IF NOT EXISTS ${ESQ}`);
    await p.query(`CREATE TABLE IF NOT EXISTS ${ESQ}.cola (id BIGSERIAL PRIMARY KEY, tabla TEXT NOT NULL, pk TEXT NOT NULL)`);
    await p.query(`CREATE OR REPLACE FUNCTION ${ESQ}.registrar() RETURNS trigger LANGUAGE plpgsql AS $f$
      DECLARE v TEXT;
      BEGIN
        IF TG_OP = 'DELETE' THEN v := to_jsonb(OLD) ->> TG_ARGV[0]; ELSE v := to_jsonb(NEW) ->> TG_ARGV[0]; END IF;
        INSERT INTO ${ESQ}.cola (tabla, pk) VALUES (TG_TABLE_NAME, v);
        RETURN NULL;
      END $f$`);
    const ya = new Set((await p.query(`SELECT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      WHERE g.tgname = 'compoint_sync_trg' AND NOT g.tgisinternal`)).rows.map((r) => r.t));
    for (const t of await tablasConPk()) {
      if (ya.has(t.tabla)) continue;
      await p.query(`CREATE TRIGGER compoint_sync_trg AFTER INSERT OR UPDATE OR DELETE ON ${q(t.tabla)}
        FOR EACH ROW EXECUTE FUNCTION ${ESQ}.registrar(${"'" + t.col.replace(/'/g, "''") + "'"})`);
    }
    ultimaInstalacion = Date.now();
  }
  async function quitarDisparadores() {
    const p = getPool();
    for (const t of await tablasConPk()) await p.query(`DROP TRIGGER IF EXISTS compoint_sync_trg ON ${q(t.tabla)}`);
    await p.query(`DROP SCHEMA IF EXISTS ${ESQ} CASCADE`);
  }

  async function ordenTablas() {
    const p = getPool();
    const tablas = (await tablasConPk()).map((t) => t.tabla);
    const set = new Set(tablas);
    const dep = {}; tablas.forEach((t) => { dep[t] = new Set(); });
    const rf = await p.query(`SELECT c.conrelid::regclass::text AS hijo, c.confrelid::regclass::text AS padre
      FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`);
    for (const r of rf.rows) {
      const h = r.hijo.replace(/"/g, ''); const pa = r.padre.replace(/"/g, '');
      if (h !== pa && set.has(h) && set.has(pa)) dep[h].add(pa);
    }
    const orden = []; const listo = new Set(); let pend = [...tablas].sort();
    while (pend.length) {
      const sig = pend.filter((t) => [...dep[t]].every((x) => listo.has(x)));
      for (const t of (sig.length ? sig : [pend[0]])) { orden.push(t); listo.add(t); }
      pend = pend.filter((t) => !listo.has(t));
    }
    return orden;
  }

  // ----- envío
  async function reencolar(fallidos) {
    if (!fallidos.length) return;
    const p = getPool();
    for (const f of fallidos) {
      const k = f.t + '|' + f.pk;
      intentos.set(k, (intentos.get(k) || 0) + 1);
      await p.query(`INSERT INTO ${ESQ}.cola (tabla, pk) VALUES ($1, $2)`, [f.t, f.pk]);
    }
  }

  async function enviarCola(c) {
    const p = getPool();
    let enviados = 0; const fallidosTotal = [];
    for (let n = 0; n < MAX_LOTES_POR_VUELTA; n++) {
      const cola = (await p.query(`SELECT id, tabla, pk FROM ${ESQ}.cola ORDER BY id LIMIT $1`, [LOTE * 4])).rows;
      if (!cola.length) break;
      const claves = new Map(); // tabla|pk → { t, pk, ids }
      for (const r of cola) {
        const k = r.tabla + '|' + r.pk;
        if (!claves.has(k)) { if (claves.size >= LOTE) continue; claves.set(k, { t: r.tabla, pk: r.pk, ids: [] }); }
        claves.get(k).ids.push(Number(r.id));
      }
      const usados = [...claves.values()];
      // Estado actual de cada registro (si ya no existe → fila null = borrar en la nube)
      const porTabla = {};
      usados.forEach((x) => { (porTabla[x.t] = porTabla[x.t] || []).push(x); });
      const info = await tablasConPk();
      const pkCol = Object.fromEntries(info.map((t) => [t.tabla, t.col]));
      for (const [t, lista] of Object.entries(porTabla)) {
        if (!pkCol[t]) { lista.forEach((x) => { x.fila = null; x.ignorar = true; }); continue; }
        const r = await p.query(`SELECT row_to_json(x) AS j, x.${q(pkCol[t])}::text AS k FROM ${q(t)} x WHERE x.${q(pkCol[t])}::text = ANY($1)`, [lista.map((x) => x.pk)]);
        const m = new Map(r.rows.map((f) => [f.k, f.j]));
        lista.forEach((x) => { x.fila = m.get(x.pk) || null; });
      }
      const resp = await pedir(c.api, c.clave, '/aplicar', { cuerpo: { lote: usados.filter((x) => !x.ignorar).map((x) => ({ t: x.t, pk: x.pk, fila: x.fila })) } });
      const malos = new Set((resp.fallidos || []).map((f) => f.t + '|' + f.pk));
      const idsOk = []; const falla = [];
      for (const x of usados) {
        if (malos.has(x.t + '|' + x.pk)) falla.push(x); else { idsOk.push(...x.ids); intentos.delete(x.t + '|' + x.pk); }
      }
      // Los que fallaron salen del frente y se anotan al final de la cola (se reintentan después).
      const idsMalos = falla.flatMap((x) => x.ids);
      if (idsOk.length || idsMalos.length) await p.query(`DELETE FROM ${ESQ}.cola WHERE id = ANY($1)`, [[...idsOk, ...idsMalos]]);
      await reencolar(falla);
      (resp.fallidos || []).forEach((f) => fallidosTotal.push(f));
      enviados += idsOk.length ? usados.length - falla.length : 0;
      if (falla.length === usados.length) break; // nada avanzó: no insistir en esta vuelta
    }
    return { enviados, fallidos: fallidosTotal };
  }

  async function copiaCompleta(c) {
    const p = getPool();
    progreso = 'Preparando la nube…';
    await pedir(c.api, c.clave, '/completo/iniciar', { cuerpo: {} });
    // Lo anotado hasta ahora queda cubierto por la copia completa que se lee a continuación.
    const corte = (await p.query(`SELECT COALESCE(MAX(id), 0) AS m FROM ${ESQ}.cola`)).rows[0].m;
    await p.query(`DELETE FROM ${ESQ}.cola WHERE id <= $1`, [corte]);
    const info = Object.fromEntries((await tablasConPk()).map((t) => [t.tabla, t.col]));
    const orden = await ordenTablas();
    const fallidos = [];
    let total = 0;
    for (const t of orden) {
      const col = info[t];
      const cuantos = Number((await p.query(`SELECT COUNT(*) AS n FROM ${q(t)}`)).rows[0].n);
      let ultimo = null; let hechos = 0;
      for (;;) {
        const r = ultimo === null
          ? await p.query(`SELECT row_to_json(x) AS j, x.${q(col)}::text AS k FROM ${q(t)} x ORDER BY x.${q(col)} LIMIT ${LOTE}`)
          : await p.query(`SELECT row_to_json(x) AS j, x.${q(col)}::text AS k FROM ${q(t)} x WHERE x.${q(col)} > $1 ORDER BY x.${q(col)} LIMIT ${LOTE}`, [ultimo]);
        if (!r.rows.length) break;
        const resp = await pedir(c.api, c.clave, '/aplicar', { cuerpo: { lote: r.rows.map((f) => ({ t, pk: f.k, fila: f.j })) } });
        (resp.fallidos || []).forEach((f) => fallidos.push(f));
        ultimo = r.rows[r.rows.length - 1].k;
        hechos += r.rows.length; total += r.rows.length;
        progreso = `Copia completa: ${t} (${hechos}/${cuantos})`;
      }
    }
    await reencolar(fallidos);
    return { total, fallidos: fallidos.length };
  }

  // ----- ciclo
  async function vuelta({ forzarCompleto = false } = {}) {
    if (ocupado || detenido) return { ok: false, error: 'Ya hay una sincronización en curso.' };
    const c = conf();
    if (!c) return { ok: false, error: 'La sincronización no está configurada.' };
    ocupado = true;
    guardarEstado({ ultimo_intento: new Date().toISOString() });
    try {
      if (Date.now() - ultimaInstalacion > 3600 * 1000) await instalarDisparadores();
      if (forzarCompleto) guardarEstado({ completo_pendiente: true });
      if (estado.completo_pendiente) {
        const r = await copiaCompleta(c);
        guardarEstado({ completo_pendiente: false, ultimo_completo: new Date().toISOString(), sin_conexion: false, error: '', problemas: r.fallidos });
        log(`Sincronización: copia completa enviada (${r.total} registros, ${r.fallidos} con problema).`);
      }
      const r = await enviarCola(c);
      const quedan = Number((await getPool().query(`SELECT COUNT(*) AS n FROM ${ESQ}.cola`)).rows[0].n);
      const cambios = { sin_conexion: false, error: '', problemas: quedan ? [...intentos.keys()].length : 0 };
      if (r.fallidos.length) cambios.error = `${r.fallidos.length} registro(s) no se pudieron aplicar en la nube (se reintentan). Ejemplo: ${r.fallidos[0].t} #${r.fallidos[0].pk}: ${r.fallidos[0].error || ''}`;
      if (!quedan || r.enviados) cambios.ultimo_ok = new Date().toISOString();
      guardarEstado(cambios);
      if (r.enviados) log(`Sincronización: ${r.enviados} registro(s) enviados a la nube.`);
      return { ok: true, enviados: r.enviados };
    } catch (e) {
      const sinNet = esRed(e);
      guardarEstado({ sin_conexion: sinNet, error: sinNet ? '' : String(e.message).slice(0, 300) });
      if (!sinNet) log('Sincronización con error: ' + e.message);
      return { ok: false, sinConexion: sinNet, error: sinNet ? 'Sin conexión con la nube; se reintenta sola.' : e.message };
    } finally { progreso = ''; ocupado = false; }
  }

  function programar() {
    clearInterval(timer);
    timer = setInterval(() => { vuelta().catch(() => {}); }, CADA_MS);
    setTimeout(() => { vuelta().catch(() => {}); }, 15 * 1000);
  }

  return {
    async iniciar() {
      detenido = false;
      if (!conf()) return; // sin configurar: no se anota nada
      try { await instalarDisparadores(); } catch (e) { log('Sincronización: no se pudieron preparar los disparadores: ' + e.message); }
      programar();
    },
    async probar(api, clave) { return pedir(api, clave, '/estado', { timeout: 90000 }); },
    // Avisa a la nube que se deja de sincronizar (borra la clave guardada allá). Si no hay internet, no pasa nada.
    async desvincular() {
      const c = conf();
      if (!c) return false;
      try { await pedir(c.api, c.clave, '/desvincular', { cuerpo: {}, timeout: 10000 }); return true; }
      catch (e) { log('Sincronización: no se pudo avisar a la nube al desvincular (' + e.message + ').'); return false; }
    },
    resolverApi,
    // Guarda y arranca. La primera vez se hace una copia completa.
    async activar() {
      detenido = false;
      await instalarDisparadores();
      guardarEstado({ completo_pendiente: true, error: '', sin_conexion: false });
      programar();
      vuelta().catch(() => {});
    },
    async desactivar() {
      clearInterval(timer); timer = null;
      try { await quitarDisparadores(); } catch (e) { log('Sincronización: ' + e.message); }
      guardarEstado({ completo_pendiente: false, error: '', sin_conexion: false, problemas: 0 });
    },
    // Tras restaurar un respaldo la base cambió por completo: hay que volver a copiar todo.
    marcarCompleto() { guardarEstado({ completo_pendiente: true }); },
    ahora: (completo = false) => vuelta({ forzarCompleto: completo }),
    async estado() {
      const c = conf();
      const base = { configurado: !!c, direccion: c ? c.texto : '', ocupado, progreso, ...estado };
      if (!c) return base;
      try {
        const n = await getPool().query(`SELECT COUNT(*) AS n FROM ${ESQ}.cola`);
        base.pendientes = Number(n.rows[0].n);
      } catch (e) { base.pendientes = null; }
      return base;
    },
    async detener() {
      detenido = true; clearInterval(timer); timer = null;
      const esperar = Date.now() + 20000;
      while (ocupado && Date.now() < esperar) await new Promise((ok) => setTimeout(ok, 200));
      if (pool) { try { await pool.end(); } catch (e) { /* ya cerrada */ } pool = null; }
    },
    // Último intento al cerrar el programa (máx. unos segundos)
    async ultimoEnvio(ms = 15000) {
      if (!conf() || ocupado) return;
      detenido = false;
      await Promise.race([vuelta(), new Promise((ok) => setTimeout(ok, ms))]);
    }
  };
}

module.exports = { crearSincronizador, resolverApi, vincularConUsuario };
