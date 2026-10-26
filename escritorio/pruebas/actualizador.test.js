// El actualizador automático se prueba con piezas de mentira (sin abrir Electron ni bajar nada).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { crear } = require('../src/actualizador');

function armar(opciones = {}) {
  const au = new EventEmitter();
  au.checkForUpdates = async () => { au.llamadas = (au.llamadas || 0) + 1; };
  au.quitAndInstall = (silencioso, abrir) => { au.instalo = [silencioso, abrir]; };
  const cuadros = [];
  const respuestas = opciones.respuestas || [0];
  const dialog = { showMessageBox: async (...a) => { const o = a[a.length - 1]; cuadros.push(o); return { response: respuestas.shift() ?? 1 }; } };
  const logs = [];
  const tareas = [];
  const salida = [];
  const act = crear({
    autoUpdater: au, dialog, app: { getVersion: () => '1.1.5' }, log: (t) => logs.push(t),
    prepararSalida: async () => { salida.push('preparada'); },
    programar: { esperar: (f, ms) => tareas.push(['esperar', ms, f]), repetir: (f, ms) => tareas.push(['repetir', ms, f]) },
    ...opciones.extra
  });
  return { au, act, cuadros, logs, tareas, salida };
}
const pausa = () => new Promise((r) => setImmediate(r));

test('configura la descarga automática y la instalación al cerrar', () => {
  const { au } = armar();
  assert.equal(au.autoDownload, true);
  assert.equal(au.autoInstallOnAppQuit, true);
  assert.equal(au.autoRunAppAfterInstall, true);
  assert.equal(au.allowDowngrade, false);
});

test('revisa poco después de abrir y luego cada 4 horas', () => {
  const { act, tareas } = armar();
  act.iniciar();
  assert.deepEqual(tareas.map((t) => [t[0], t[1]]), [['esperar', 45000], ['repetir', 4 * 3600 * 1000]]);
});

test('al bajar una versión nueva avisa y, si se acepta, prepara la salida y reinstala en silencio', async () => {
  const { au, cuadros, salida } = armar({ respuestas: [0] });
  au.emit('update-downloaded', { version: '1.1.9' });
  await pausa(); await pausa();
  assert.equal(cuadros.length, 1);
  assert.match(cuadros[0].message, /1\.1\.9/);
  assert.deepEqual(cuadros[0].buttons, ['Reiniciar ahora', 'Después']);
  assert.deepEqual(salida, ['preparada']);
  assert.deepEqual(au.instalo, [true, true]);
});

test('si elige «Después» no reinicia (se instala al cerrar el programa)', async () => {
  const { au, cuadros, salida } = armar({ respuestas: [1] });
  au.emit('update-downloaded', { version: '1.1.9' });
  await pausa(); await pausa();
  assert.equal(cuadros.length, 1);
  assert.equal(au.instalo, undefined);
  assert.deepEqual(salida, []);
});

test('no repite el aviso de la misma versión en las revisiones siguientes', async () => {
  const { au, cuadros } = armar({ respuestas: [1, 1] });
  au.emit('update-downloaded', { version: '1.1.9' });
  await pausa(); await pausa();
  au.emit('update-downloaded', { version: '1.1.9' });
  await pausa(); await pausa();
  assert.equal(cuadros.length, 1);
  au.emit('update-downloaded', { version: '1.1.10' });
  await pausa(); await pausa();
  assert.equal(cuadros.length, 2);
});

test('los errores (sin internet, etc.) no molestan: solo quedan en el log', async () => {
  const { au, cuadros, logs } = armar();
  au.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  await pausa();
  assert.equal(cuadros.length, 0);
  assert.ok(logs.some((l) => /ERR_INTERNET_DISCONNECTED/.test(l)));
});

test('«Buscar actualizaciones» a mano: avisa si ya está al día y si hubo error', async () => {
  const a = armar();
  const p = a.act.buscarAhora();
  a.au.emit('update-not-available', {});
  await p; await pausa();
  assert.equal(a.cuadros.length, 1);
  assert.match(a.cuadros[0].message, /última versión \(1\.1\.5\)/);

  const b = armar();
  b.act.buscarAhora();
  b.au.emit('error', new Error('sin red'));
  await pausa();
  assert.equal(b.cuadros.length, 1);
  assert.match(b.cuadros[0].message, /No se pudo buscar/);
});

test('si la revisión automática no encuentra nada, no muestra ningún cuadro', async () => {
  const { au, cuadros } = armar();
  au.emit('update-not-available', {});
  await pausa();
  assert.equal(cuadros.length, 0);
});

test('con la actualización ya descargada, «Buscar» a mano vuelve a ofrecer reiniciar', async () => {
  const { au, act, cuadros } = armar({ respuestas: [1, 1] });
  au.emit('update-downloaded', { version: '1.1.9' });
  await pausa(); await pausa();
  act.buscarAhora();
  await pausa(); await pausa();
  assert.equal(cuadros.length, 2);
});

test('reiniciar dos veces seguidas solo instala una vez', async () => {
  const { act, au, salida } = armar();
  await act.reiniciar(); await act.reiniciar();
  assert.deepEqual(salida, ['preparada']);
  assert.deepEqual(au.instalo, [true, true]);
});
