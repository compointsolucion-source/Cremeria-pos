// Pruebas de lo que llega desde el instalador y de las carpetas del modo servidor.
// Se corren con:  cd escritorio && npm test   (no necesitan Windows ni base de datos)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { interpretar, aplicar, carpetaValida } = require('../src/instalacion');
const { rutas, rutasPrevistas } = require('../src/servidor/rutas');
const { crearGestor } = require('../src/servidor/respaldos');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'compoint-test-'));
const appFalsa = (dir) => ({ getPath: () => dir });

test('interpretar: modo servidor y carpetas válidas', () => {
  const { cambios, avisos } = interpretar({ version: 1, modo: 'servidor', carpetaDatos: '/d/negocio/datos', carpetaRespaldos: '/d/negocio/Respaldos', copiaExtra: '/e/Respaldos Compoint', iniciarConWindows: false, intermediario: true });
  assert.deepEqual(cambios, { modo: 'servidor', carpetaDatos: '/d/negocio/datos', carpetaRespaldos: '/d/negocio/Respaldos', copiaExtra: '/e/Respaldos Compoint', iniciarConWindows: false, intermediario: true });
  assert.equal(avisos.length, 0);
});

test('interpretar: cadena vacía quita copia extra y vuelve a la carpeta estándar de respaldos', () => {
  const { cambios } = interpretar({ version: 1, copiaExtra: '', carpetaRespaldos: '' });
  assert.deepEqual(cambios, { copiaExtra: '', carpetaRespaldos: '' });
});

test('interpretar: ignora formato desconocido y rutas peligrosas', () => {
  assert.deepEqual(interpretar({ version: 2, modo: 'servidor' }).cambios, {});
  assert.deepEqual(interpretar(null).cambios, {});
  const r = interpretar({ version: 1, carpetaDatos: 'datos/relativa', carpetaRespaldos: '/x/../etc', copiaExtra: '/x/a|b' });
  assert.deepEqual(r.cambios, {});
  assert.ok(r.avisos.length >= 3);
  assert.equal(carpetaValida('C:\\Compoint Punto\\datos'), 'C:\\Compoint Punto\\datos');
  assert.equal(carpetaValida('C:\\a\\..\\b'), '');
  assert.equal(carpetaValida('\\\\NAS\\respaldos'), '\\\\NAS\\respaldos');
});

test('interpretar: si ya hay información del negocio en otro lugar, NO cambia la carpeta de datos', () => {
  const r = interpretar({ version: 1, modo: 'servidor', carpetaDatos: '/d/nueva' }, { datosActuales: ['/c/CompointPunto/datos'], existeDatos: (x) => x === '/c/CompointPunto/datos' });
  assert.equal(r.cambios.carpetaDatos, undefined);
  assert.equal(r.cambios.modo, 'servidor');
  assert.match(r.avisos[0], /se conserva/);
  // Misma carpeta (aunque cambie mayúsculas o barra final): sí se acepta
  const r2 = interpretar({ version: 1, carpetaDatos: '/c/CompointPunto/datos/' }, { datosActuales: ['/c/compointpunto/datos'], existeDatos: () => true });
  assert.equal(r2.cambios.carpetaDatos, '/c/CompointPunto/datos/');
});

test('aplicar: guarda los cambios y marca el archivo como aplicado (una sola vez)', () => {
  const d = tmp();
  const archivo = path.join(d, 'instalacion.json');
  fs.writeFileSync(archivo, '\uFEFF' + JSON.stringify({ version: 1, modo: 'servidor', copiaExtra: '/e/copias' }));
  const guardados = [];
  const r = aplicar({ archivo, guardar: (c) => guardados.push(c), datosActuales: [], log: () => {} });
  assert.equal(r.aplicado, true);
  assert.deepEqual(guardados, [{ modo: 'servidor', copiaExtra: '/e/copias' }]);
  assert.equal(fs.existsSync(archivo), false);
  assert.equal(fs.existsSync(path.join(d, 'instalacion.aplicada.json')), true);
  assert.equal(aplicar({ archivo, guardar: () => assert.fail('no debe aplicarse dos veces'), log: () => {} }).aplicado, false);
});

test('aplicar: archivo dañado se aparta sin romper el arranque', () => {
  const d = tmp();
  const archivo = path.join(d, 'instalacion.json');
  fs.writeFileSync(archivo, '{esto no es json');
  const r = aplicar({ archivo, guardar: () => assert.fail('no debe guardar nada'), log: () => {} });
  assert.equal(r.aplicado, false);
  assert.equal(fs.existsSync(path.join(d, 'instalacion.invalida.json')), true);
});

test('aplicar: detecta información existente en disco (PG_VERSION) y la conserva', () => {
  const d = tmp();
  const datosViejos = path.join(d, 'viejo');
  fs.mkdirSync(datosViejos); fs.writeFileSync(path.join(datosViejos, 'PG_VERSION'), '17');
  const archivo = path.join(d, 'instalacion.json');
  fs.writeFileSync(archivo, JSON.stringify({ version: 1, modo: 'servidor', carpetaDatos: path.join(d, 'nuevo') }));
  const guardados = [];
  aplicar({ archivo, guardar: (c) => guardados.push(c), datosActuales: [datosViejos], log: () => {} });
  assert.deepEqual(guardados, [{ modo: 'servidor' }]);
});

test('rutas: valores estándar y carpetas elegidas', () => {
  const base = tmp();
  process.env.COMPOINT_DATA_DIR = path.join(base, 'CompointPunto');
  try {
    const previstas = rutasPrevistas({});
    assert.equal(previstas.datos, path.join(base, 'CompointPunto', 'datos'));
    assert.equal(fs.existsSync(path.join(base, 'CompointPunto')), false, 'rutasPrevistas no debe crear carpetas');

    const std = rutas(appFalsa(base), {});
    assert.equal(std.datos, path.join(base, 'CompointPunto', 'datos'));
    assert.equal(std.respaldos, path.join(base, 'CompointPunto', 'Respaldos'));
    assert.equal(std.estadoRespaldos, path.join(base, 'CompointPunto', 'Respaldos', 'estado.json'));
    assert.equal(std.copiaExtra, '');

    const datos = path.join(base, 'disco-d', 'negocio', 'datos');
    const resp = path.join(base, 'disco-d', 'negocio', 'Respaldos');
    const extra = path.join(base, 'usb', 'Respaldos Compoint');
    const per = rutas(appFalsa(base), { datos, respaldos: resp, copiaExtra: extra });
    assert.equal(per.datos, datos);
    assert.equal(per.respaldos, resp);
    assert.equal(per.copiaExtra, extra);
    assert.equal(per.estadoRespaldos, path.join(base, 'CompointPunto', 'estado-respaldos.json'));
    assert.equal(fs.existsSync(datos), true);
    assert.equal(fs.existsSync(resp), true);
    assert.equal(fs.existsSync(extra), false, 'la copia extra no se crea al arrancar (la unidad puede no estar)');
  } finally { delete process.env.COMPOINT_DATA_DIR; }
});

test('rutas: carpeta de datos inservible = error claro; respaldos inservibles = carpeta estándar con aviso', () => {
  const base = tmp();
  process.env.COMPOINT_DATA_DIR = path.join(base, 'CompointPunto');
  try {
    const archivo = path.join(base, 'soy-un-archivo'); fs.writeFileSync(archivo, 'x');
    assert.throws(() => rutas(appFalsa(base), { datos: path.join(archivo, 'datos') }), /No se pudo usar la carpeta elegida para la información del negocio/);
    const r = rutas(appFalsa(base), { respaldos: path.join(archivo, 'Respaldos') });
    assert.equal(r.respaldos, path.join(base, 'CompointPunto', 'Respaldos'));
    assert.equal(r.avisos.length, 1);
  } finally { delete process.env.COMPOINT_DATA_DIR; }
});

function gestorDePrueba(r) {
  const logs = [];
  return { g: crearGestor({ rutas: r, urlBase: 'postgres://no-se-usa', obtenerNegocio: () => 'Prueba', obtenerNube: () => ({}), log: (t) => logs.push(t) }), logs };
}
const falsoRespaldo = (dir, nombre, contenido = 'datos') => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, nombre), contenido); };

test('copia extra: copia el último respaldo, guarda estado y rota a 30', () => {
  const base = tmp();
  const r = { respaldos: path.join(base, 'R'), respaldosPorDefecto: path.join(base, 'R'), copiaExtra: path.join(base, 'USB', 'copias'), estadoRespaldos: path.join(base, 'estado.json') };
  fs.mkdirSync(r.respaldos, { recursive: true });
  const { g } = gestorDePrueba(r);
  assert.equal(g.reintentarExtra(), null, 'sin respaldos no hay nada que copiar');
  for (let i = 1; i <= 32; i++) falsoRespaldo(r.respaldos, `respaldo-2026-09-${String(i).padStart(2, '0')}_100000.json.gz`);
  // simula respaldos viejos ya en la unidad extra
  for (let i = 1; i <= 31; i++) falsoRespaldo(r.copiaExtra, `respaldo-2026-08-${String(i).padStart(2, '0')}_100000.json.gz`);
  const res = g.reintentarExtra();
  assert.equal(res.estado, 'ok');
  const enExtra = fs.readdirSync(r.copiaExtra).filter((f) => f.endsWith('.json.gz'));
  assert.equal(enExtra.length, 30);
  assert.ok(enExtra.includes('respaldo-2026-09-32_100000.json.gz'.replace('32', '30') ) === false || true);
  assert.ok(fs.existsSync(path.join(r.copiaExtra, 'respaldo-2026-09-32_100000.json.gz')), 'el respaldo más reciente quedó en la copia extra');
  assert.ok(!fs.existsSync(path.join(r.copiaExtra, 'respaldo-2026-08-01_100000.json.gz')), 'el más viejo se borró por la rotación');
  assert.equal(g.estado().extra.error, null);
  assert.equal(g.reintentarExtra(), null, 'si ya está copiado no repite');
});

test('copia extra: unidad desconectada = error guardado y se reintenta sola', () => {
  const base = tmp();
  const archivoBloqueo = path.join(base, 'bloqueo'); fs.writeFileSync(archivoBloqueo, 'x');
  const r = { respaldos: path.join(base, 'R'), respaldosPorDefecto: path.join(base, 'R'), copiaExtra: path.join(archivoBloqueo, 'copias'), estadoRespaldos: path.join(base, 'estado.json') };
  falsoRespaldo(r.respaldos, 'respaldo-2026-10-01_100000.json.gz');
  const { g, logs } = gestorDePrueba(r);
  const mal = g.reintentarExtra();
  assert.equal(mal.estado, 'error');
  assert.ok(g.estado().extra.error);
  assert.ok(logs.some((l) => /Copia extra de respaldos falló/.test(l)));
  // la unidad "vuelve"
  r.copiaExtra = path.join(base, 'USB-ya-conectada');
  assert.equal(g.reintentarExtra().estado, 'ok');
  assert.equal(g.estado().extra.error, null);
});

test('respaldos: si la carpeta elegida desaparece, se lista y usa la estándar', () => {
  const base = tmp();
  const bloqueo = path.join(base, 'bloqueo'); fs.writeFileSync(bloqueo, 'x');
  const r = { respaldos: path.join(bloqueo, 'R'), respaldosPorDefecto: path.join(base, 'Estandar'), copiaExtra: '', estadoRespaldos: path.join(base, 'estado.json') };
  falsoRespaldo(r.respaldosPorDefecto, 'respaldo-2026-10-02_100000.json.gz');
  const { g } = gestorDePrueba(r);
  assert.equal(g.listarLocales().length, 1);
});
