// Pruebas de la baja de clientes en la nube, con Neon, Render y el panel FALSOS (nada real se borra).
//   cd herramientas/alta-nube && node --test baja-nube.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const SECRET = 'secreto-compartido-de-prueba';
let falso, base, llamadas, avisos, config;

test.before(async () => {
  falso = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      const json = (cod, obj) => { res.writeHead(cod, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const ruta = req.url; let b = null; try { b = cuerpo ? JSON.parse(cuerpo) : null; } catch (e) { /* vacío */ }
      llamadas.push({ metodo: req.method, ruta, auth: req.headers.authorization });
      if (ruta === '/panel') {
        const firma = crypto.createHmac('sha256', SECRET).update(cuerpo).digest('hex');
        if (req.headers['x-firma'] !== firma) return json(403, { ok: false });
        avisos.push(b); return json(200, { ok: true });
      }
      if (req.method === 'GET' && ruta.startsWith('/render/services?name=')) {
        const n = decodeURIComponent(ruta.split('name=')[1].split('&')[0]);
        const s = config.servicios[n];
        return json(200, s ? [{ service: { id: 'srv-' + n, name: n, repo: s.repo, ownerId: s.ownerId || 'tea-1' } }] : []);
      }
      if (req.method === 'DELETE' && ruta.startsWith('/render/services/')) {
        if (config.renderFalla) return json(500, { message: 'Render caído' });
        return json(204, {});
      }
      if (req.method === 'GET' && ruta.startsWith('/neon/projects/')) {
        const id = ruta.split('/').pop();
        if (!config.proyectos[id]) return json(404, { message: 'not found' });
        return json(200, { project: { id, org_id: config.proyectos[id].org } });
      }
      if (req.method === 'DELETE' && ruta.startsWith('/neon/projects/')) {
        if (config.neonFalla) return json(423, { message: 'proyecto bloqueado' });
        return json(200, { project: {} });
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((ok) => falso.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + falso.address().port;
});
test.after(async () => { await new Promise((ok) => { falso.close(() => ok()); setTimeout(ok, 500); }); });
test.beforeEach(() => {
  llamadas = []; avisos = [];
  const repo = 'https://github.com/compointsolucion-source/Cremeria-pos';
  config = {
    servicios: { 'solutions-pos': { repo }, 'solutions-pos-web': { repo }, 'ajeno-pos': { repo: 'https://github.com/otro/otra-cosa' }, 'otracuenta-pos': { repo, ownerId: 'tea-OTRA' } },
    proyectos: { 'noisy-wildflower-09680800': { org: 'org-1' }, 'proyecto-ajeno-1': { org: 'org-OTRA' } },
    renderFalla: false, neonFalla: false
  };
});

function correr(extra = {}) {
  const env = {
    ...process.env, NEON_API_BASE: base + '/neon', RENDER_API_BASE: base + '/render', NEON_API_KEY: 'k-neon', NEON_ORG_ID: 'org-1',
    RENDER_API_KEY: 'k-render', RENDER_OWNER_ID: 'tea-1', ALTA_SECRET: SECRET, ALTA_CALLBACK_URL: base + '/panel', BAJA_SIN_ESPERA: '1',
    BAJA_CLIENTE_ID: '7', BAJA_NEGOCIO: 'solutions', BAJA_NEON: 'noisy-wildflower-09680800', BAJA_RENDER_API: 'solutions-pos', BAJA_RENDER_WEB: 'solutions-pos-web',
    ...extra
  };
  return new Promise((ok) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'baja-nube.js')], { env }); let salida = '';
    p.stdout.on('data', (d) => { salida += d; }); p.stderr.on('data', (d) => { salida += d; });
    p.on('close', (codigo) => ok({ codigo, salida }));
  });
}
const borrados = () => llamadas.filter((l) => l.metodo === 'DELETE').map((l) => l.ruta);

test('borra la página, el servidor y la base, y avisa «ok»', async () => {
  const r = await correr();
  assert.equal(r.codigo, 0, r.salida);
  assert.deepEqual(borrados(), ['/render/services/srv-solutions-pos-web', '/render/services/srv-solutions-pos', '/neon/projects/noisy-wildflower-09680800']);
  assert.equal(avisos[0].estado, 'en_proceso');
  const ult = avisos[avisos.length - 1];
  assert.equal(ult.estado, 'ok'); assert.equal(ult.accion, 'baja'); assert.equal(ult.cliente_id, 7);
  assert.ok(llamadas.filter((l) => l.ruta.startsWith('/neon')).every((l) => l.auth === 'Bearer k-neon'));
  assert.ok(llamadas.filter((l) => l.ruta.startsWith('/render')).every((l) => l.auth === 'Bearer k-render'));
});

test('lo que ya no existe se da por borrado (se puede reintentar)', async () => {
  config.servicios = {}; config.proyectos = {};
  const r = await correr();
  assert.equal(r.codigo, 0, r.salida);
  assert.deepEqual(borrados(), []);
  assert.equal(avisos[avisos.length - 1].estado, 'ok');
});

test('si Neon falla, avisa error, NO dice ok, y lo demás sí se borró', async () => {
  config.neonFalla = true;
  const r = await correr();
  assert.equal(r.codigo, 1);
  const ult = avisos[avisos.length - 1];
  assert.equal(ult.estado, 'error'); assert.match(ult.mensaje, /base de datos/); assert.match(ult.mensaje, /volver a intentar/);
  assert.ok(borrados().includes('/render/services/srv-solutions-pos'));
});

test('si Render falla, igual intenta Neon y avisa error', async () => {
  config.renderFalla = true;
  const r = await correr();
  assert.equal(r.codigo, 1);
  assert.equal(avisos[avisos.length - 1].estado, 'error');
  assert.ok(borrados().includes('/neon/projects/noisy-wildflower-09680800'));
});

test('tu sistema propio y el demo están protegidos: no se llama a ninguna API de borrado', async () => {
  for (const extra of [{ BAJA_NEON: 'hidden-mountain-79543589' }, { BAJA_RENDER_API: 'Cremeria-pos' }, { BAJA_RENDER_WEB: 'cremeria-pos-frontend' }, { BAJA_NEON: 'raspy-recipe-26719111' }, { BAJA_RENDER_API: 'democompoint-pos' }]) {
    llamadas = []; avisos = [];
    const r = await correr(extra);
    assert.equal(r.codigo, 1, JSON.stringify(extra));
    assert.deepEqual(borrados(), [], JSON.stringify(extra));
    assert.match(avisos[avisos.length - 1].mensaje, /protegido/);
  }
});

test('no borra un servicio de Render que no es de este repositorio ni de otra cuenta, ni un Neon de otra organización', async () => {
  let r = await correr({ BAJA_RENDER_API: 'ajeno-pos', BAJA_RENDER_WEB: '', BAJA_NEON: '' });
  assert.equal(r.codigo, 1); assert.deepEqual(borrados(), []); assert.match(avisos[avisos.length - 1].mensaje, /no es de este repositorio/);
  llamadas = []; avisos = [];
  r = await correr({ BAJA_RENDER_API: 'otracuenta-pos', BAJA_RENDER_WEB: '', BAJA_NEON: '' });
  assert.equal(r.codigo, 1); assert.deepEqual(borrados(), []); assert.match(avisos[avisos.length - 1].mensaje, /otra cuenta/);
  llamadas = []; avisos = [];
  r = await correr({ BAJA_RENDER_API: '', BAJA_RENDER_WEB: '', BAJA_NEON: 'proyecto-ajeno-1' });
  assert.equal(r.codigo, 1); assert.deepEqual(borrados(), []); assert.match(avisos[avisos.length - 1].mensaje, /otra organización/);
});

test('rechaza nombres raros y entradas vacías sin tocar nada', async () => {
  for (const extra of [{ BAJA_RENDER_API: 'a b; rm -rf' }, { BAJA_NEON: '../x' }, { BAJA_CLIENTE_ID: '' }, { BAJA_NEON: '', BAJA_RENDER_API: '', BAJA_RENDER_WEB: '' }]) {
    llamadas = []; avisos = [];
    const r = await correr(extra);
    assert.equal(r.codigo, 1, JSON.stringify(extra));
    assert.deepEqual(borrados(), []);
  }
});

test('el aviso lleva firma válida y sin secret ALTA_SECRET no hay aviso pero tampoco borrado', async () => {
  const r = await correr({ ALTA_SECRET: '' });
  assert.equal(r.codigo, 1); assert.deepEqual(borrados(), []); assert.equal(avisos.length, 0);
});
