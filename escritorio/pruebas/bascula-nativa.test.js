// Báscula por COM directo (src/bascula-nativa.js): lista, abre por nombre y busca sola la báscula.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { crearBasculaNativa, pareceLecturaDePeso, rutaValida, opcionesSeguras } = require('../src/bascula-nativa');

const RAPIDO = { escuchar: 25, porComando: 25, entreIntentos: 0 };

// Puerto falso: cada COM tiene un «escenario» (qué báscula hay conectada ahí).
function crearSerialFalso(puertos) {
  const abiertosAhora = new Set();
  class SerialFalso extends EventEmitter {
    static async list() { return puertos.map((p) => ({ path: p.path, friendlyName: p.friendlyName, vendorId: p.vendorId })); }
    constructor(op) { super(); this.op = op; this.isOpen = false; this.esc = (puertos.find((p) => p.path === op.path) || {}).escenario || {}; }
    coincide() { return (!this.esc.baud || this.esc.baud === this.op.baudRate) && (!this.esc.datos || this.esc.datos === this.op.dataBits); }
    open(cb) {
      if (!puertos.some((p) => p.path === this.op.path)) { cb(new Error('File not found')); return; }
      if (this.esc.ocupado || abiertosAhora.has(this.op.path)) { cb(new Error('Opening ' + this.op.path + ': Access denied')); return; }
      this.isOpen = true; abiertosAhora.add(this.op.path); cb(null);
      if (this.esc.continuo) {
        this.timer = setInterval(() => this.emit('data', Buffer.from(this.coincide() ? this.esc.continuo : (this.esc.basura || ''), 'latin1')), 8);
      }
    }
    write(buf, cb) {
      const texto = Buffer.from(buf).toString('latin1');
      if (this.esc.responde && texto === this.esc.responde.a && this.coincide()) setTimeout(() => this.isOpen && this.emit('data', Buffer.from(this.esc.responde.con)), 5);
      else if (this.esc.responde && !this.coincide() && this.esc.basura) setTimeout(() => this.isOpen && this.emit('data', Buffer.from(this.esc.basura, 'latin1')), 5);
      if (cb) cb();
    }
    close(cb) { clearInterval(this.timer); this.isOpen = false; abiertosAhora.delete(this.op.path); this.emit('close'); if (cb) cb(); }
  }
  return SerialFalso;
}

test('reconoce lecturas de báscula y descarta basura', () => {
  const b = (t) => [...Buffer.from(t, 'latin1')];
  assert.equal(pareceLecturaDePeso(b('+001.250kg\r\n')), true);
  assert.equal(pareceLecturaDePeso(b('ST,GS,+01.250kg\r\n')), true);
  assert.equal(pareceLecturaDePeso(b('\x02 001250\x03')), true);
  assert.equal(pareceLecturaDePeso(b('  2.75 lb')), true);
  assert.equal(pareceLecturaDePeso(b('\xf0\xff\x80\x9a\xe1\xfe12')), false, 'velocidad equivocada = basura');
  assert.equal(pareceLecturaDePeso(b('OK\r\n')), false);
  assert.equal(pareceLecturaDePeso([]), false);
});

test('solo acepta nombres de puerto reales y opciones conocidas', () => {
  assert.equal(rutaValida('com4'), 'COM4');
  assert.equal(rutaValida(' COM12 '), 'COM12');
  assert.equal(rutaValida('COM0'), null);
  assert.equal(rutaValida('COM3; del'), null);
  assert.equal(rutaValida('\\\\.\\PIPE\\algo'), null);
  assert.deepEqual(opcionesSeguras({ baudRate: 4800, dataBits: 7, parity: 'even' }), { baudRate: 4800, dataBits: 7, parity: 'even', stopBits: 1 });
  assert.deepEqual(opcionesSeguras({ baudRate: 123, dataBits: 5, parity: 'rara', stopBits: 9 }), { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 });
});

test('lista los puertos de Windows ordenados y con nombre limpio', async () => {
  const SerialPort = crearSerialFalso([
    { path: 'COM10', friendlyName: 'Bluetooth link (COM10)' },
    { path: 'COM4', friendlyName: 'STM32 Virtual ComPort (COM4)', vendorId: '0483' },
    { path: 'COM1', friendlyName: 'Puerto de comunicaciones (COM1)' }
  ]);
  const bn = crearBasculaNativa({ SerialPort, tiempos: RAPIDO });
  const l = await bn.listar();
  assert.deepEqual(l.map((p) => p.ruta), ['COM1', 'COM4', 'COM10']);
  assert.equal(l[1].nombre, 'STM32 Virtual ComPort');
  assert.equal(l[1].usb, true);
});

test('Automático: encuentra la báscula que solo contesta a «P» a 4800 (y prueba primero el USB)', async () => {
  const progreso = [];
  const SerialPort = crearSerialFalso([
    { path: 'COM1', friendlyName: 'Puerto de comunicaciones (COM1)' },
    { path: 'COM4', friendlyName: 'STM32 Virtual ComPort (COM4)', vendorId: '0483', escenario: { baud: 4800, responde: { a: 'P', con: ' 0001.250 kg\r\n' }, basura: '\xf0\x80\xff' } }
  ]);
  const bn = crearBasculaNativa({ SerialPort, tiempos: RAPIDO });
  const r = await bn.buscar((p) => progreso.push(p));
  assert.ok(r.encontrada, 'debió encontrarla');
  assert.equal(r.encontrada.ruta, 'COM4');
  assert.equal(r.encontrada.baudRate, 4800);
  assert.equal(r.encontrada.formato, '8N1');
  assert.equal(r.encontrada.comando, 'P');
  assert.match(r.encontrada.muestra, /1\.250 kg/);
  assert.equal(progreso[0].ruta, 'COM4', 'el puerto USB va primero');
  assert.ok(!progreso.some((p) => p.ruta === 'COM1'), 'ya no hacía falta probar COM1');
});

test('Automático: báscula de salida continua a 9600 en formato 7E1', async () => {
  const SerialPort = crearSerialFalso([
    { path: 'COM3', friendlyName: 'USB-SERIAL CH340 (COM3)', vendorId: '1a86', escenario: { baud: 9600, datos: 7, continuo: 'ST,GS,+001.500kg\r\n', basura: '\xf8\xe0\x80' } }
  ]);
  const bn = crearBasculaNativa({ SerialPort, tiempos: RAPIDO });
  const r = await bn.buscar();
  assert.equal(r.encontrada && r.encontrada.ruta, 'COM3');
  assert.equal(r.encontrada.formato, '7E1');
  assert.equal(r.encontrada.comando, 'continuo');
});

test('Automático: dice qué pasó con cada puerto cuando no la encuentra', async () => {
  const SerialPort = crearSerialFalso([
    { path: 'COM1', friendlyName: 'Puerto de comunicaciones (COM1)' },
    { path: 'COM2', friendlyName: 'Otro programa lo usa (COM2)', escenario: { ocupado: true } },
    { path: 'COM5', friendlyName: 'Aparato raro (COM5)', escenario: { continuo: '\xf0\xff\x80\x9a', basura: '\xf0\xff\x80\x9a' } }
  ]);
  const bn = crearBasculaNativa({ SerialPort, tiempos: RAPIDO });
  const r = await bn.buscar();
  assert.equal(r.encontrada, null);
  const por = Object.fromEntries(r.revisados.map((x) => [x.ruta, x.resultado]));
  assert.deepEqual(por, { COM1: 'sin respuesta', COM2: 'ocupado', COM5: 'datos sin peso' });
});

test('Manual: abre el COM escrito, manda comandos, entrega datos y cierra por ventana', async () => {
  const SerialPort = crearSerialFalso([
    { path: 'COM7', friendlyName: 'Sin nombre (COM7)', escenario: { responde: { a: 'P', con: '+002.000kg\r\n' } } },
    { path: 'COM8', friendlyName: 'Otra (COM8)' }
  ]);
  const bn = crearBasculaNativa({ SerialPort, tiempos: RAPIDO });
  const llegadas = []; const cerrados = [];
  const a = await bn.abrir('com7', { baudRate: 9600 }, 'ventana-1', (id, d) => llegadas.push(Buffer.from(d).toString()), (id) => cerrados.push(id));
  assert.equal(a.ruta, 'COM7');
  await bn.escribir(a.id, [...Buffer.from('P')]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(llegadas.join(''), '+002.000kg\r\n');
  const b = await bn.abrir('COM8', {}, 'ventana-2', () => {}, () => {});
  await bn.cerrarDe('ventana-1');
  assert.deepEqual(cerrados, [a.id]);
  assert.equal(await bn.escribir(a.id, [80]), false, 'ya cerrado');
  assert.equal(await bn.cerrar(b.id), true);
});

test('Manual: mensajes claros si el puerto no sirve', async () => {
  const SerialPort = crearSerialFalso([{ path: 'COM2', escenario: { ocupado: true } }]);
  const bn = crearBasculaNativa({ SerialPort, tiempos: RAPIDO });
  await assert.rejects(bn.abrir('COMx', {}, 'v', () => {}, () => {}), /no es un puerto COM válido/);
  await assert.rejects(bn.abrir('COM2', {}, 'v', () => {}, () => {}), /lo está usando otro programa/);
  await assert.rejects(bn.abrir('COM9', {}, 'v', () => {}, () => {}), /no existe en esta computadora/);
});

// Con la librería real y puertos virtuales (socat): solo donde socat existe (Linux), no en Windows.
const { spawnSync, spawn } = require('node:child_process');
const haySocat = process.platform !== 'win32' && spawnSync('which', ['socat']).status === 0;
test('con la librería serialport real y una báscula virtual que contesta a «P»', { skip: !haySocat && 'sin socat' }, async () => {
  const fs = require('node:fs');
  const a = '/dev/shm/compoint-bascula-a', b = '/dev/shm/compoint-bascula-b';
  const socat = spawn('socat', [`pty,raw,echo=0,link=${a}`, `pty,raw,echo=0,link=${b}`]);
  try {
    for (let k = 0; k < 50 && !(fs.existsSync(a) && fs.existsSync(b)); k++) await new Promise((r) => setTimeout(r, 50));
    const { SerialPort } = require('serialport');
    const bascula = new SerialPort({ path: b, baudRate: 9600 });
    bascula.on('data', (d) => { if (d.toString().includes('P')) bascula.write('+000.875kg\r\n'); });
    await new Promise((r) => bascula.on('open', r));
    const bn = crearBasculaNativa({ tiempos: { escuchar: 150, porComando: 200, entreIntentos: 0 } });
    const r = await bn.buscar(() => {}, [a]);
    assert.equal(r.encontrada && r.encontrada.ruta, a);
    assert.equal(r.encontrada.comando, 'P');
    // Y abrir a mano ese mismo puerto: llega el peso al pedirlo.
    const llegadas = [];
    const ab = await bn.abrir(a, { baudRate: 9600 }, 'v', (id, d) => llegadas.push(Buffer.from(d).toString()), () => {});
    await bn.escribir(ab.id, [...Buffer.from('P')]);
    for (let k = 0; k < 40 && !llegadas.join('').includes('kg'); k++) await new Promise((r) => setTimeout(r, 25));
    assert.match(llegadas.join(''), /0\.875kg/);
    await bn.cerrarTodo();
    await new Promise((r) => bascula.close(r));
  } finally { socat.kill(); }
});
