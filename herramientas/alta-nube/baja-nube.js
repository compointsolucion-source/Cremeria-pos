// BAJA (ELIMINAR POR COMPLETO) DE UN CLIENTE EN LA NUBE (Compoint Punto)
//
// Lo corre el workflow de GitHub «Baja de cliente en la nube» (.github/workflows/baja-cliente-nube.yml),
// que lo dispara el botón «Eliminar» del panel (compoint.com.mx -> admin -> Licencias Punto -> Nube).
// Las claves de Neon y Render viven SOLO en los «secrets» de GitHub, igual que en el alta.
//
// Qué hace, en orden:
//   1) borra la página (Static Site) del cliente en Render
//   2) borra el servidor (Web Service) del cliente en Render
//   3) borra el proyecto del cliente en Neon (la base de datos, con TODA su información)
//   4) avisa al panel (POST firmado con HMAC): «ok» -> el panel borra su ficha y su licencia;
//      «error» -> el panel muestra qué falló y se puede volver a intentar (lo que ya no existe se da por borrado).
//
// Protecciones: nunca toca tu sistema propio ni el demo (lista PROTEGIDOS), solo borra servicios de Render
// que sean de ESTE repositorio y de tu cuenta, y solo proyectos de Neon de tu organización.
//
// Entradas (variables de entorno):
//   BAJA_CLIENTE_ID, BAJA_NEGOCIO, BAJA_NEON, BAJA_RENDER_API, BAJA_RENDER_WEB
//   secrets: NEON_API_KEY, NEON_ORG_ID, RENDER_API_KEY, RENDER_OWNER_ID, ALTA_SECRET, ALTA_CALLBACK_URL
//   para pruebas: NEON_API_BASE, RENDER_API_BASE
const crypto = require('crypto');

const E = process.env;
const NEON = (E.NEON_API_BASE || 'https://console.neon.tech/api/v2').replace(/\/$/, '');
const RENDER = (E.RENDER_API_BASE || 'https://api.render.com/v1').replace(/\/$/, '');
const REPO_NOMBRE = (E.BAJA_REPO_NOMBRE || 'Cremeria-pos').toLowerCase();

// Tu sistema propio y el demo: este programa se niega a borrarlos aunque se lo pidan.
const PROTEGIDOS_NEON = ['hidden-mountain-79543589', 'raspy-recipe-26719111'];
const PROTEGIDOS_RENDER = ['cremeria-pos', 'cremeria-pos-frontend', 'democompoint-pos', 'democompoint-pos-web'];
const NOMBRE_TEC = /^[A-Za-z0-9._-]{3,80}$/;

const secreto = (v) => { if (v && E.GITHUB_ACTIONS) console.log('::add-mask::' + v); return v; };
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function llamar(base, ruta, { metodo = 'GET', clave, ok = [200, 202, 204] } = {}) {
  const resp = await fetch(base + ruta, {
    method: metodo, headers: { Authorization: 'Bearer ' + clave, Accept: 'application/json' }, signal: AbortSignal.timeout(60000)
  });
  const texto = await resp.text();
  let json = null; try { json = texto ? JSON.parse(texto) : null; } catch (e) { /* sin JSON */ }
  if (!ok.includes(resp.status)) {
    const detalle = json && (json.message || json.error || json.msg) ? String(json.message || json.error || json.msg) : texto.slice(0, 200);
    const err = new Error(`${metodo} ${ruta} → ${resp.status}: ${detalle}`);
    err.status = resp.status; throw err;
  }
  return json;
}
const neon = (ruta, o) => llamar(NEON, ruta, { clave: E.NEON_API_KEY, ...o });
const render = (ruta, o) => llamar(RENDER, ruta, { clave: E.RENDER_API_KEY, ...o });

async function avisarPanel(datos) {
  const cuerpo = JSON.stringify({ v: 1, ts: Math.floor(Date.now() / 1000), accion: 'baja', ...datos });
  const firma = crypto.createHmac('sha256', E.ALTA_SECRET).update(cuerpo).digest('hex');
  for (let intento = 1; intento <= 4; intento++) {
    try {
      const r = await fetch(E.ALTA_CALLBACK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Firma': firma, 'User-Agent': 'CompointPunto/baja' },
        body: cuerpo, signal: AbortSignal.timeout(20000)
      });
      if (r.ok) return true;
      console.error(`Aviso al panel: respondió ${r.status} (intento ${intento})`);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) return false;
    } catch (err) { console.error(`Aviso al panel: ${err.message} (intento ${intento})`); }
    await esperar(E.BAJA_SIN_ESPERA ? 20 : intento * 2000);
  }
  return false;
}

function leerEntradas() {
  const t = (k, max = 80) => String(E[k] || '').replace(/[\x00-\x1F\x7F]+/g, ' ').trim().slice(0, max);
  const x = { clienteId: parseInt(E.BAJA_CLIENTE_ID, 10) || 0, negocio: t('BAJA_NEGOCIO', 120), neon: t('BAJA_NEON'), api: t('BAJA_RENDER_API'), web: t('BAJA_RENDER_WEB') };
  const errores = [];
  if (!x.clienteId) errores.push('falta el número de cliente del panel');
  for (const [k, v] of [['proyecto de Neon', x.neon], ['servidor de Render', x.api], ['página de Render', x.web]]) {
    if (v && !NOMBRE_TEC.test(v)) errores.push(`nombre no válido en ${k}`);
  }
  if (!x.neon && !x.api && !x.web) errores.push('no hay nada en la nube que borrar');
  if (PROTEGIDOS_NEON.includes(x.neon.toLowerCase())) errores.push('ese proyecto de Neon está protegido (es tu sistema propio o el demo)');
  for (const n of [x.api, x.web]) if (n && PROTEGIDOS_RENDER.includes(n.toLowerCase())) errores.push(`«${n}» está protegido (es tu sistema propio o el demo)`);
  for (const k of ['NEON_API_KEY', 'RENDER_API_KEY', 'ALTA_SECRET', 'ALTA_CALLBACK_URL']) if (!E[k]) errores.push('falta el secret ' + k);
  return { x, errores };
}

/** Borra un servicio de Render por nombre exacto. Devuelve texto de lo que pasó. */
async function borrarRender(nombre, etiqueta) {
  if (!nombre) return { ok: true, texto: `${etiqueta}: no tenía` };
  const r = await render(`/services?name=${encodeURIComponent(nombre)}&limit=20`);
  const lista = (Array.isArray(r) ? r : []).map((s) => s.service || s).filter((s) => s && s.name === nombre);
  if (!lista.length) return { ok: true, texto: `${etiqueta} «${nombre}»: ya no existía` };
  const s = lista[0];
  const repo = String(s.repo || '').toLowerCase().replace(/\.git$/, '');
  if (!repo.endsWith('/' + REPO_NOMBRE)) throw new Error(`«${nombre}» en Render no es de este repositorio (${s.repo || 'sin repo'}); no se borra`);
  if (E.RENDER_OWNER_ID && s.ownerId && s.ownerId !== E.RENDER_OWNER_ID) throw new Error(`«${nombre}» en Render es de otra cuenta; no se borra`);
  await render(`/services/${s.id}`, { metodo: 'DELETE' });
  return { ok: true, texto: `${etiqueta} «${nombre}»: borrado` };
}

async function borrarNeon(id) {
  if (!id) return { ok: true, texto: 'Neon: no tenía' };
  let p;
  try { p = await neon(`/projects/${encodeURIComponent(id)}`); } catch (err) {
    if (err.status === 404) return { ok: true, texto: `Neon «${id}»: ya no existía` };
    throw err;
  }
  const org = p && p.project && p.project.org_id;
  if (org && E.NEON_ORG_ID && org !== E.NEON_ORG_ID) throw new Error(`El proyecto de Neon «${id}» es de otra organización; no se borra`);
  await neon(`/projects/${encodeURIComponent(id)}`, { metodo: 'DELETE' });
  return { ok: true, texto: `Neon «${id}»: borrado` };
}

async function main() {
  const { x, errores } = leerEntradas();
  if (errores.length) {
    console.error('No se puede eliminar el cliente: ' + errores.join('; '));
    if (E.ALTA_SECRET && E.ALTA_CALLBACK_URL && x.clienteId) await avisarPanel({ cliente_id: x.clienteId, estado: 'error', mensaje: 'No se eliminó: ' + errores.join('; ') });
    return 1;
  }
  secreto(E.NEON_API_KEY); secreto(E.RENDER_API_KEY);
  console.log(`Baja de «${x.negocio}»: Render ${x.web || '—'} / ${x.api || '—'} · Neon ${x.neon || '—'}`);
  await avisarPanel({ cliente_id: x.clienteId, estado: 'en_proceso', mensaje: 'Borrando en Render y Neon…' });

  const pasos = [['la página', () => borrarRender(x.web, 'Página')], ['el servidor', () => borrarRender(x.api, 'Servidor')], ['la base de datos', () => borrarNeon(x.neon)]];
  const fallas = [];
  for (const [que, f] of pasos) {
    try { const r = await f(); console.log('  ' + r.texto); } catch (err) {
      console.error(`  No se pudo borrar ${que}: ${err.message}`);
      fallas.push(`${que}: ${String(err.message).slice(0, 140)}`);
    }
  }
  if (fallas.length) {
    await avisarPanel({ cliente_id: x.clienteId, estado: 'error', mensaje: ('No se pudo borrar todo (' + fallas.join(' | ') + '). Lo demás sí se borró; puedes volver a intentarlo.').slice(0, 480) });
    return 1;
  }
  console.log('Todo borrado.');
  await avisarPanel({ cliente_id: x.clienteId, estado: 'ok', mensaje: 'Eliminado.' });
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c));
module.exports = { main, leerEntradas, PROTEGIDOS_NEON, PROTEGIDOS_RENDER };
