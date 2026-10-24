// ALTA AUTOMÁTICA DE UN CLIENTE EN LA NUBE (Compoint Punto)
//
// Lo corre el workflow de GitHub «Alta de cliente en la nube» (.github/workflows/alta-cliente-nube.yml),
// que lo dispara el botón del panel (compoint.com.mx -> admin -> Licencias Punto -> Nube).
// Las claves de Neon y Render viven SOLO en los «secrets» de GitHub, nunca en el hosting.
//
// Qué hace, en orden (si algo falla, deshace lo que alcanzó a crear y avisa al panel):
//   1) revisa que los nombres NOMBRE-pos / NOMBRE-pos-web no existan en Render
//   2) crea el proyecto en Neon (base vacía)
//   3) corre backend/scripts/alta-cliente.js (estructura, sucursal, usuario dueño, licencia de 12 meses)
//   4) crea en Render el servidor (Web Service) y la página (Static Site), rama «estable»
//   5) espera a que queden publicados
//   6) avisa al panel (POST firmado con HMAC) con direcciones, usuario, contraseña inicial y token de licencia
//
// Entradas (variables de entorno):
//   ALTA_NEGOCIO, ALTA_SLUG, ALTA_DUENO, ALTA_USUARIO, ALTA_GIRO, ALTA_SUCURSALES, ALTA_TELEFONO, ALTA_DIRECCION, ALTA_CLIENTE_ID
//   secrets: NEON_API_KEY, NEON_ORG_ID, RENDER_API_KEY, RENDER_OWNER_ID, ALTA_SECRET, ALTA_CALLBACK_URL
//   para pruebas: NEON_API_BASE, RENDER_API_BASE, ALTA_REPO, ALTA_ESPERA_MS, ALTA_SIN_ESPERA_SALUD
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');

const E = process.env;
const NEON = (E.NEON_API_BASE || 'https://console.neon.tech/api/v2').replace(/\/$/, '');
const RENDER = (E.RENDER_API_BASE || 'https://api.render.com/v1').replace(/\/$/, '');
const REPO = E.ALTA_REPO || 'https://github.com/compointsolucion-source/Cremeria-pos';
const RAMA = 'estable';
const ESPERA_MAX_MS = Number(E.ALTA_ESPERA_MS) || 20 * 60 * 1000;
const GIROS = ['cremeria', 'carniceria', 'abarrotes', 'fruteria', 'polleria', 'tortilleria', 'panaderia', 'dulceria', 'rosticeria'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const secreto = (v) => { if (v && E.GITHUB_ACTIONS) console.log('::add-mask::' + v); return v; };

// ---------------------------------------------------------------- utilidades
function leerEntradas() {
  const t = (k, max = 200) => String(E[k] || '').replace(/[\x00-\x1F\x7F]+/g, ' ').trim().slice(0, max);
  const entradas = {
    negocio: t('ALTA_NEGOCIO', 120), slug: t('ALTA_SLUG', 30).toLowerCase(), dueno: t('ALTA_DUENO', 120), usuario: t('ALTA_USUARIO', 40) || 'admin',
    giro: t('ALTA_GIRO', 30) || 'cremeria', sucursales: Math.max(1, Math.min(50, parseInt(E.ALTA_SUCURSALES, 10) || 1)),
    telefono: t('ALTA_TELEFONO', 30), direccion: t('ALTA_DIRECCION', 200), clienteId: parseInt(E.ALTA_CLIENTE_ID, 10) || 0
  };
  const errores = [];
  if (!entradas.negocio) errores.push('falta el nombre del negocio');
  if (!SLUG_RE.test(entradas.slug)) errores.push('el nombre corto debe tener 3 a 30 letras minúsculas, números o guiones');
  if (!entradas.dueno) errores.push('falta el nombre del dueño');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(entradas.usuario)) errores.push('el usuario debe tener 3 a 40 letras, números, punto o guion');
  if (!GIROS.includes(entradas.giro)) errores.push('giro no válido');
  if (!entradas.clienteId) errores.push('falta el número de cliente del panel');
  for (const k of ['NEON_API_KEY', 'NEON_ORG_ID', 'RENDER_API_KEY', 'RENDER_OWNER_ID', 'ALTA_SECRET', 'ALTA_CALLBACK_URL']) if (!E[k]) errores.push('falta el secret ' + k);
  return { entradas, errores };
}

function contrasenaInicial() {
  // 12 caracteres sin letras que se confunden (0/O, 1/l/I)
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 12; i++) r += abc[crypto.randomInt(abc.length)];
  return r;
}

async function llamar(base, ruta, { metodo = 'GET', clave, cuerpo, ok = [200, 201, 202, 204] } = {}) {
  const resp = await fetch(base + ruta, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + clave, Accept: 'application/json', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(60000)
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

// ---------------------------------------------------------------- aviso al panel
async function avisarPanel(datos) {
  const cuerpo = JSON.stringify({ v: 1, ts: Math.floor(Date.now() / 1000), ...datos });
  const firma = crypto.createHmac('sha256', E.ALTA_SECRET).update(cuerpo).digest('hex');
  for (let intento = 1; intento <= 4; intento++) {
    try {
      const r = await fetch(E.ALTA_CALLBACK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Firma': firma, 'User-Agent': 'CompointPunto/alta' },
        body: cuerpo, signal: AbortSignal.timeout(20000)
      });
      if (r.ok) return true;
      console.error(`Aviso al panel: respondió ${r.status} (intento ${intento})`);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) return false; // rechazado: repetir no ayuda
    } catch (err) { console.error(`Aviso al panel: ${err.message} (intento ${intento})`); }
    await esperar(intento * 2000);
  }
  return false;
}

// ---------------------------------------------------------------- Render
async function nombreLibre(nombre) {
  const r = await render(`/services?name=${encodeURIComponent(nombre)}&limit=20`);
  return !(Array.isArray(r) ? r : []).some((x) => (x.service || x).name === nombre);
}

async function esperarPublicado(serviceId, deployId, etiqueta) {
  const fin = Date.now() + ESPERA_MAX_MS;
  const malos = ['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'];
  let ultimo = '';
  while (Date.now() < fin) {
    const r = await render(`/services/${serviceId}/deploys?limit=1`);
    const d = (Array.isArray(r) ? r[0] : null);
    const dep = d && (d.deploy || d);
    const estado = dep && dep.status;
    if (estado && estado !== ultimo) { console.log(`  ${etiqueta}: ${estado}`); ultimo = estado; }
    if (estado === 'live') return;
    if (malos.includes(estado)) throw new Error(`${etiqueta}: el despliegue en Render falló (${estado})`);
    await esperar(E.ALTA_ESPERA_MS ? 200 : 10000);
  }
  throw new Error(`${etiqueta}: Render tardó más de ${Math.round(ESPERA_MAX_MS / 60000)} minutos en publicar`);
}

async function esperarSalud(urlApi) {
  if (E.ALTA_SIN_ESPERA_SALUD) return true;
  const fin = Date.now() + 4 * 60 * 1000;
  while (Date.now() < fin) {
    try { const r = await fetch(urlApi + '/health', { signal: AbortSignal.timeout(15000) }); if (r.ok) return true; } catch (e) { /* sigue */ }
    await esperar(8000);
  }
  return false;
}

// ---------------------------------------------------------------- principal
async function main() {
  const { entradas: x, errores } = leerEntradas();
  if (errores.length) {
    console.error('No se puede crear el cliente: ' + errores.join('; '));
    if (E.ALTA_SECRET && E.ALTA_CALLBACK_URL && x.clienteId) await avisarPanel({ cliente_id: x.clienteId, estado: 'error', mensaje: 'Datos incompletos: ' + errores.join('; ') });
    return 1;
  }
  const nombreApi = `${x.slug}-pos`, nombreWeb = `${x.slug}-pos-web`;
  const creado = { neon: null, api: null, web: null };
  const contrasena = secreto(contrasenaInicial());
  const token = secreto(crypto.randomBytes(24).toString('hex'));
  const jwt = secreto(crypto.randomBytes(32).toString('hex'));

  async function deshacer() {
    for (const [que, f] of [['página Render', () => creado.web && render(`/services/${creado.web}`, { metodo: 'DELETE' })],
      ['servidor Render', () => creado.api && render(`/services/${creado.api}`, { metodo: 'DELETE' })],
      ['proyecto Neon', () => creado.neon && neon(`/projects/${creado.neon}`, { metodo: 'DELETE' })]]) {
      try { await f(); } catch (err) { console.error(`  No se pudo borrar ${que}: ${err.message}`); }
    }
  }

  try {
    console.log(`Alta de «${x.negocio}» (${nombreApi} / ${nombreWeb})`);
    await avisarPanel({ cliente_id: x.clienteId, estado: 'en_proceso', mensaje: 'Revisando nombres en Render…' });

    // 1) nombres libres
    for (const n of [nombreApi, nombreWeb]) if (!(await nombreLibre(n))) throw new Error(`Ya existe un servicio llamado «${n}» en Render. Elige otro nombre corto.`);

    // 2) Neon
    console.log('1/4 Creando proyecto en Neon…');
    await avisarPanel({ cliente_id: x.clienteId, estado: 'en_proceso', mensaje: 'Creando la base de datos en Neon…' });
    const p = await neon('/projects', { metodo: 'POST', cuerpo: { project: { name: x.negocio.slice(0, 64), region_id: 'aws-us-east-2', pg_version: 17, org_id: E.NEON_ORG_ID } } });
    creado.neon = p && p.project && p.project.id;
    const uri = secreto(p && p.connection_uris && p.connection_uris[0] && p.connection_uris[0].connection_uri);
    if (!creado.neon || !uri) throw new Error('Neon no devolvió el proyecto o la dirección de conexión.');
    console.log(`  proyecto ${creado.neon}`);

    // 3) estructura + dueño + licencia
    console.log('2/4 Creando estructura, usuario dueño y licencia…');
    await avisarPanel({ cliente_id: x.clienteId, estado: 'en_proceso', mensaje: 'Creando usuario dueño y licencia…' });
    const backend = path.join(__dirname, '..', '..', 'backend');
    const argsAlta = ['scripts/alta-cliente.js', '--negocio', x.negocio, '--dueno', x.dueno, '--usuario', x.usuario, '--password', contrasena,
      '--giro', x.giro, '--sucursales', String(x.sucursales)];
    if (x.telefono) argsAlta.push('--telefono', x.telefono);
    if (x.direccion) argsAlta.push('--direccion', x.direccion);
    // Neon puede tardar unos segundos en aceptar conexiones recién creado el proyecto: se reintenta.
    let alta;
    for (let i = 1; i <= 5; i++) {
      alta = spawnSync(process.execPath, argsAlta, { cwd: backend, env: { ...E, DATABASE_URL: uri, DB_SSL: undefined }, encoding: 'utf8' });
      if (alta.status === 0) break;
      const sal = String(alta.stderr || '') + String(alta.stdout || '');
      if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|terminating connection|timeout/i.test(sal) && i < 5) { await esperar(E.ALTA_ESPERA_MS ? 100 : 6000); continue; }
      break;
    }
    if (alta.status !== 0) throw new Error('alta-cliente.js falló: ' + String(alta.stderr || alta.stdout || '').replace(contrasena, '***').slice(-400));

    // 4) Render
    console.log('3/4 Creando servicios en Render…');
    await avisarPanel({ cliente_id: x.clienteId, estado: 'en_proceso', mensaje: 'Creando el servidor y la página en Render…' });
    const sApi = await render('/services', { metodo: 'POST', cuerpo: {
      type: 'web_service', name: nombreApi, ownerId: E.RENDER_OWNER_ID, repo: REPO, branch: RAMA, autoDeploy: 'yes', rootDir: '',
      envVars: [
        { key: 'DATABASE_URL', value: uri }, { key: 'JWT_SECRET', value: jwt }, { key: 'MAX_SUCURSALES', value: String(x.sucursales) },
        { key: 'COMPOINT_LICENCIA_TOKEN', value: token }
      ],
      serviceDetails: { runtime: 'node', plan: 'free', region: 'virginia', envSpecificDetails: { buildCommand: 'cd backend && npm install', startCommand: 'cd backend && npm start' } }
    } });
    const api = sApi.service || sApi; creado.api = api.id;
    const apiDeploy = sApi.deployId;
    const sWeb = await render('/services', { metodo: 'POST', cuerpo: {
      type: 'static_site', name: nombreWeb, ownerId: E.RENDER_OWNER_ID, repo: REPO, branch: RAMA, autoDeploy: 'yes', rootDir: '',
      serviceDetails: { buildCommand: 'echo sin-build', publishPath: 'frontend' }
    } });
    const web = sWeb.service || sWeb; creado.web = web.id;
    const urlApi = (api.serviceDetails && api.serviceDetails.url) || `https://${nombreApi}.onrender.com`;
    const urlWeb = (web.serviceDetails && web.serviceDetails.url) || `https://${nombreWeb}.onrender.com`;

    // 5) esperar
    console.log('4/4 Esperando a que Render publique…');
    await avisarPanel({ cliente_id: x.clienteId, estado: 'en_proceso', mensaje: 'Render está publicando (puede tardar unos minutos)…' });
    await esperarPublicado(creado.api, apiDeploy, 'servidor');
    await esperarPublicado(creado.web, sWeb.deployId, 'página');
    const sano = await esperarSalud(urlApi);

    const avisos = [];
    if (urlApi !== `https://${nombreApi}.onrender.com` || urlWeb !== `https://${nombreWeb}.onrender.com`) {
      avisos.push('Render puso direcciones distintas a NOMBRE-pos / NOMBRE-pos-web: la página no encontrará sola a su servidor; hay que editar frontend/js/config.js.');
    }
    if (!sano) avisos.push('El servidor aún no contesta (puede estar arrancando); espera unos minutos.');

    console.log('Cliente creado.');
    await avisarPanel({
      cliente_id: x.clienteId, estado: 'ok', mensaje: avisos.join(' ') || 'Listo.',
      url_sistema: urlWeb, url_api: urlApi, neon_proyecto: creado.neon, render_api: nombreApi, render_web: nombreWeb,
      usuario: x.usuario, password: contrasena, token
    });
    return 0;
  } catch (err) {
    console.error('ERROR: ' + String(err.message).replace(contrasena, '***'));
    console.error('Deshaciendo lo que se alcanzó a crear…');
    await deshacer();
    await avisarPanel({ cliente_id: x.clienteId, estado: 'error', mensaje: String(err.message).replace(contrasena, '***').slice(0, 480) });
    return 1;
  }
}

if (require.main === module) main().then((c) => process.exit(c));
module.exports = { main, leerEntradas, contrasenaInicial, SLUG_RE };
