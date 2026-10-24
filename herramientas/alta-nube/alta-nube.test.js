// Pruebas del alta automática de clientes en la nube, con Neon, Render y el panel FALSOS (nada real se crea).
// El alta de la estructura sí corre de verdad en una base de pruebas local. Necesitan:
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba"   (solo se usa para crear bases temporales)
//   y haber corrido  npm ci  en backend/.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('alta de cliente en la nube: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}
const { Pool } = require(path.join(__dirname, '..', '..', 'backend', 'node_modules', 'pg'));
const bcrypt = require(path.join(__dirname, '..', '..', 'backend', 'node_modules', 'bcryptjs'));

const SECRET = 'secreto-compartido-de-prueba';
let falso, base, admin, llamadas, avisos, config;
const baseDatos = new URL(URL_BD);

async function crearBdTemporal() {
  const nombre = 'alta_' + crypto.randomBytes(5).toString('hex');
  await admin.query(`CREATE DATABASE ${nombre}`);
  const u = new URL(URL_BD); u.pathname = '/' + nombre;
  return { nombre, uri: u.toString() };
}

test.before(async () => {
  admin = new Pool({ connectionString: URL_BD });
  falso = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', async () => {
      const json = (cod, obj) => { res.writeHead(cod, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const ruta = req.url; let b = null; try { b = cuerpo ? JSON.parse(cuerpo) : null; } catch (e) { /* vacío */ }
      llamadas.push({ metodo: req.method, ruta, auth: req.headers.authorization, cuerpo: b });
      // --- panel (aviso firmado)
      if (ruta === '/panel') {
        const firma = crypto.createHmac('sha256', SECRET).update(cuerpo).digest('hex');
        if (req.headers['x-firma'] !== firma) return json(403, { ok: false });
        avisos.push(b); return json(200, { ok: true });
      }
      // --- Neon
      if (req.method === 'POST' && ruta === '/neon/projects') {
        if (config.neonFalla) return json(500, { message: 'cuota agotada' });
        const bd = config.uriMala ? { uri: URL_BD.replace(/\/[^/]*$/, '/no_existe_' + Date.now()) } : await crearBdTemporal();
        return json(201, { project: { id: 'proyecto-prueba-123', name: b.project.name }, connection_uris: [{ connection_uri: bd.uri }] });
      }
      if (req.method === 'DELETE' && ruta.startsWith('/neon/projects/')) return json(200, { project: {} });
      // --- Render
      if (req.method === 'GET' && ruta.startsWith('/render/services?name=')) {
        const n = decodeURIComponent(ruta.split('name=')[1].split('&')[0]);
        return json(200, config.existentes.includes(n) ? [{ service: { id: 'srv-viejo', name: n } }] : []);
      }
      if (req.method === 'POST' && ruta === '/render/services') {
        if (b.type === 'static_site' && config.webFalla) return json(402, { message: 'sin saldo' });
        const id = b.type === 'web_service' ? 'srv-api-1' : 'srv-web-1';
        return json(201, { service: { id, name: b.name, serviceDetails: { url: config.urlRara ? `https://${b.name}-x9k2.onrender.com` : `https://${b.name}.onrender.com` } }, deployId: 'dep-' + id });
      }
      if (req.method === 'GET' && /^\/render\/services\/[^/]+\/deploys/.test(ruta)) {
        const k = (config.sondeos[ruta] = (config.sondeos[ruta] || 0) + 1);
        const estado = config.deployMalo ? 'build_failed' : (k < 2 ? 'build_in_progress' : 'live');
        return json(200, [{ deploy: { id: 'd', status: estado } }]);
      }
      if (req.method === 'DELETE' && ruta.startsWith('/render/services/')) return json(204, {});
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((ok) => falso.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + falso.address().port;
});
test.after(async () => {
  await new Promise((ok) => { falso.close(() => ok()); setTimeout(ok, 500); });
  const r = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'alta\\_%'");
  for (const x of r.rows) await admin.query(`DROP DATABASE IF EXISTS ${x.datname} WITH (FORCE)`).catch(() => {});
  await admin.end();
});
test.beforeEach(() => {
  llamadas = []; avisos = [];
  config = { existentes: [], sondeos: {}, neonFalla: false, uriMala: false, webFalla: false, deployMalo: false, urlRara: false };
});

function correr(extra = {}) {
  const env = {
    ...process.env,
    NEON_API_BASE: base + '/neon', RENDER_API_BASE: base + '/render', NEON_API_KEY: 'k-neon', NEON_ORG_ID: 'org-1',
    RENDER_API_KEY: 'k-render', RENDER_OWNER_ID: 'tea-1', ALTA_SECRET: SECRET, ALTA_CALLBACK_URL: base + '/panel',
    ALTA_ESPERA_MS: '3000', ALTA_SIN_ESPERA_SALUD: '1', ALTA_REPO: 'https://github.com/x/y',
    ALTA_NEGOCIO: 'Cremería "La Vaca" <Feliz>', ALTA_SLUG: 'lavaca', ALTA_DUENO: 'Juan Pérez', ALTA_USUARIO: 'juan', ALTA_GIRO: 'cremeria',
    ALTA_SUCURSALES: '2', ALTA_TELEFONO: '3311112222', ALTA_DIRECCION: 'Av. Juárez 10', ALTA_CLIENTE_ID: '42',
    ...extra
  };
  return new Promise((ok) => {
    const hijo = spawn(process.execPath, [path.join(__dirname, 'alta-nube.js')], { env });
    let salida = '';
    hijo.stdout.on('data', (d) => { salida += d; }); hijo.stderr.on('data', (d) => { salida += d; });
    hijo.on('close', (codigo) => ok({ codigo, salida }));
  });
}
const ultimo = () => avisos[avisos.length - 1];

test('flujo completo: crea Neon, la estructura real, el dueño, los 2 servicios en Render y avisa al panel', async () => {
  const r = await correr();
  assert.equal(r.codigo, 0, r.salida);
  // Neon y Render con las claves y datos correctos
  const neon = llamadas.find((l) => l.ruta === '/neon/projects' && l.metodo === 'POST');
  assert.equal(neon.auth, 'Bearer k-neon'); assert.equal(neon.cuerpo.project.org_id, 'org-1'); assert.equal(neon.cuerpo.project.region_id, 'aws-us-east-2');
  const srv = llamadas.filter((l) => l.ruta === '/render/services' && l.metodo === 'POST');
  assert.equal(srv.length, 2);
  const [api, web] = srv.map((s) => s.cuerpo);
  assert.equal(api.type, 'web_service'); assert.equal(api.name, 'lavaca-pos'); assert.equal(api.branch, 'estable'); assert.equal(api.ownerId, 'tea-1');
  assert.equal(api.serviceDetails.plan, 'free'); assert.equal(api.serviceDetails.envSpecificDetails.startCommand, 'cd backend && npm start');
  const vars = Object.fromEntries(api.envVars.map((e) => [e.key, e.value]));
  assert.match(vars.DATABASE_URL, /^postgres/); assert.match(vars.JWT_SECRET, /^[0-9a-f]{64}$/); assert.equal(vars.MAX_SUCURSALES, '2'); assert.match(vars.COMPOINT_LICENCIA_TOKEN, /^[0-9a-f]{48}$/);
  assert.equal(web.type, 'static_site'); assert.equal(web.name, 'lavaca-pos-web'); assert.equal(web.serviceDetails.publishPath, 'frontend'); assert.equal(web.branch, 'estable');
  // aviso final firmado, con lo que el panel necesita
  const f = ultimo();
  assert.equal(f.estado, 'ok'); assert.equal(f.cliente_id, 42);
  assert.equal(f.url_sistema, 'https://lavaca-pos-web.onrender.com'); assert.equal(f.url_api, 'https://lavaca-pos.onrender.com');
  assert.equal(f.neon_proyecto, 'proyecto-prueba-123'); assert.equal(f.render_api, 'lavaca-pos'); assert.equal(f.render_web, 'lavaca-pos-web');
  assert.equal(f.usuario, 'juan'); assert.match(f.password, /^[A-Za-z2-9]{12}$/); assert.equal(f.token, vars.COMPOINT_LICENCIA_TOKEN);
  assert.ok(avisos.some((a) => a.estado === 'en_proceso'), 'avisó el avance');
  assert.ok(avisos.every((a) => a.v === 1 && Math.abs(a.ts - Date.now() / 1000) < 600));
  // la contraseña no aparece en el registro de la ejecución
  assert.ok(!r.salida.includes(f.password), 'la contraseña no sale en los logs');
  // la base de verdad quedó lista: usuario dueño con esa contraseña, 2 sucursales => jefe_general, licencia anual
  const bd = new Pool({ connectionString: vars.DATABASE_URL });
  try {
    const u = (await bd.query("SELECT usuario, rol, password_hash FROM usuarios WHERE usuario = 'juan'")).rows[0];
    assert.equal(u.rol, 'jefe_general'); assert.ok(await bcrypt.compare(f.password, u.password_hash));
    const l = (await bd.query('SELECT tipo, plan, cliente FROM licencia')).rows[0];
    assert.equal(l.tipo, 'anual'); assert.equal(l.cliente, 'Cremería "La Vaca" <Feliz>');
    assert.ok((await bd.query('SELECT count(*)::int n FROM categorias')).rows[0].n > 0);
  } finally { await bd.end(); }
  assert.ok(!llamadas.some((l) => l.metodo === 'DELETE'), 'no borró nada');
});

test('si el nombre ya existe en Render, no crea nada y avisa', async () => {
  config.existentes = ['lavaca-pos-web'];
  const r = await correr();
  assert.equal(r.codigo, 1);
  assert.ok(!llamadas.some((l) => l.ruta === '/neon/projects'), 'no tocó Neon');
  assert.ok(!llamadas.some((l) => l.metodo === 'POST' && l.ruta === '/render/services'));
  assert.equal(ultimo().estado, 'error'); assert.match(ultimo().mensaje, /lavaca-pos-web/);
});

test('datos inválidos: avisa el error y no llama a Neon ni a Render', async () => {
  const r = await correr({ ALTA_SLUG: 'Mal Nombre!', ALTA_GIRO: 'zapateria' });
  assert.equal(r.codigo, 1);
  assert.ok(!llamadas.some((l) => l.ruta.startsWith('/neon') || l.ruta.startsWith('/render')));
  assert.equal(ultimo().estado, 'error'); assert.match(ultimo().mensaje, /nombre corto/);
});

test('falta un secret: se detiene sin llamar a nadie', async () => {
  const r = await correr({ RENDER_API_KEY: '' });
  assert.equal(r.codigo, 1); assert.match(r.salida, /RENDER_API_KEY/);
  assert.ok(!llamadas.some((l) => l.ruta.startsWith('/neon')));
});

test('si Neon falla, avisa y no crea servicios', async () => {
  config.neonFalla = true;
  const r = await correr();
  assert.equal(r.codigo, 1);
  assert.ok(!llamadas.some((l) => l.metodo === 'POST' && l.ruta === '/render/services'));
  assert.match(ultimo().mensaje, /cuota agotada/);
});

test('si falla la estructura de la base, borra el proyecto de Neon', async () => {
  config.uriMala = true;
  const r = await correr();
  assert.equal(r.codigo, 1);
  assert.ok(llamadas.some((l) => l.metodo === 'DELETE' && l.ruta === '/neon/projects/proyecto-prueba-123'), 'borró el proyecto de Neon');
  assert.ok(!llamadas.some((l) => l.metodo === 'POST' && l.ruta === '/render/services'));
  assert.equal(ultimo().estado, 'error');
});

test('si falla la página en Render, deshace el servidor y el proyecto de Neon', async () => {
  config.webFalla = true;
  const r = await correr();
  assert.equal(r.codigo, 1);
  assert.ok(llamadas.some((l) => l.metodo === 'DELETE' && l.ruta === '/render/services/srv-api-1'), 'borró el servidor');
  assert.ok(llamadas.some((l) => l.metodo === 'DELETE' && l.ruta === '/neon/projects/proyecto-prueba-123'), 'borró Neon');
  assert.equal(ultimo().estado, 'error'); assert.match(ultimo().mensaje, /sin saldo/);
});

test('si el despliegue falla en Render, lo deshace todo', async () => {
  config.deployMalo = true;
  const r = await correr();
  assert.equal(r.codigo, 1);
  const borrados = llamadas.filter((l) => l.metodo === 'DELETE').map((l) => l.ruta).sort();
  assert.deepEqual(borrados, ['/neon/projects/proyecto-prueba-123', '/render/services/srv-api-1', '/render/services/srv-web-1']);
  assert.match(ultimo().mensaje, /build_failed/);
});

test('si Render pone otra dirección, lo avisa (la página no encontraría a su servidor)', async () => {
  config.urlRara = true;
  const r = await correr();
  assert.equal(r.codigo, 0, r.salida);
  assert.equal(ultimo().estado, 'ok'); assert.match(ultimo().mensaje, /config\.js/);
});

test('un aviso con firma mala es rechazado por el panel falso (la firma se calcula bien)', async () => {
  const r = await correr({ ALTA_SECRET: 'otro-secreto' });
  assert.equal(r.codigo, 0, 'el alta termina aunque el panel rechace el aviso');
  assert.equal(avisos.length, 0);
});
