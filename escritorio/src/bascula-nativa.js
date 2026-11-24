// Báscula por puerto COM directo de Windows (sin la lista de Chrome).
// - listar(): todos los puertos COM que tiene Windows, aunque Chrome no los muestre.
// - abrir()/escribir()/cerrar(): abrir un COM por su nombre (modo Manual y reconexión).
// - buscar(): modo Automático — prueba cada puerto con las velocidades y comandos más comunes
//   y se queda con el primero que contesta algo que parece un peso.
// La pantalla (frontend/js/bascula.js) usa estos puertos como si fueran de Chrome, así la lectura del
// peso, los comandos P/ENQ/W y el diagnóstico siguen siendo los mismos.

// Velocidad + formato, en el orden en que se prueban (de la más común a la menos común).
const COMBINACIONES = [
  { baudRate: 9600, formato: '8N1' },
  { baudRate: 4800, formato: '8N1' },
  { baudRate: 2400, formato: '8N1' },
  { baudRate: 19200, formato: '8N1' },
  { baudRate: 1200, formato: '8N1' },
  { baudRate: 9600, formato: '7E1' },
  { baudRate: 4800, formato: '7E1' }
];
// Las mismas letras que usa la pantalla (COMANDOS_PEDIR_PESO en bascula.js).
const COMANDOS = [
  { clave: 'P', texto: 'P' },
  { clave: 'ENQ', texto: '\x05' },
  { clave: 'W', texto: 'W' },
  { clave: 'P_CR', texto: 'P\r\n' },
  { clave: 'W_CR', texto: 'W\r\n' }
];
const VELOCIDADES = new Set([1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]);

function formatoAOpciones(formato) {
  return formato === '7E1'
    ? { dataBits: 7, parity: 'even', stopBits: 1 }
    : { dataBits: 8, parity: 'none', stopBits: 1 };
}

// Solo nombres de puerto reales: COM1…COM256 en Windows; /dev/tty… en otros sistemas (pruebas).
function rutaValida(ruta) {
  const r = String(ruta || '').trim();
  if (/^COM([1-9]\d{0,2})$/i.test(r)) return r.toUpperCase();
  if (process.platform !== 'win32' && /^\/dev\/[A-Za-z0-9._/-]{1,60}$/.test(r) && !r.includes('..')) return r;
  return null;
}

// Opciones de apertura limpias (lo que manda la pantalla no se usa tal cual).
function opcionesSeguras(o = {}) {
  const baudRate = VELOCIDADES.has(Number(o.baudRate)) ? Number(o.baudRate) : 9600;
  const dataBits = Number(o.dataBits) === 7 ? 7 : 8;
  const parity = ['none', 'even', 'odd'].includes(o.parity) ? o.parity : 'none';
  const stopBits = Number(o.stopBits) === 2 ? 2 : 1;
  return { baudRate, dataBits, parity, stopBits };
}

// «USB-SERIAL CH340 (COM3)» → «USB-SERIAL CH340»
function nombreBonito(p) {
  const n = String(p.friendlyName || p.manufacturer || '').replace(/\s*\(COM\d+\)\s*$/i, '').trim();
  return n.slice(0, 60);
}
function numeroCom(ruta) { const m = /^COM(\d+)$/i.exec(ruta); return m ? Number(m[1]) : 9999; }

// ¿Lo recibido parece una lectura de báscula? Texto casi todo legible, con un número que parezca
// peso: con punto decimal, con unidad (kg/g/lb) o de al menos 3 cifras (básculas que mandan «001250»).
// Con la velocidad equivocada llega basura (bytes ilegibles): eso NO cuenta.
function pareceLecturaDePeso(bytes) {
  if (!bytes || !bytes.length) return false;
  let legibles = 0; let texto = '';
  for (const b of bytes) {
    if ((b >= 32 && b < 127) || b === 10 || b === 13 || b === 2 || b === 3) legibles++;
    texto += (b >= 32 && b < 127) ? String.fromCharCode(b) : ' ';
  }
  if (legibles / bytes.length < 0.85) return false;
  return /[-+]?\d+[.,]\d+/.test(texto) || /\d\s*(kg|lb|g)\b/i.test(texto) || /\d{3,}/.test(texto);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} dep  { SerialPort } — la clase de la librería `serialport` (o una falsa en pruebas).
 */
function crearBasculaNativa(dep = {}) {
  const SerialPort = dep.SerialPort || require('serialport').SerialPort;
  const tiempos = Object.assign({ escuchar: 600, porComando: 380, entreIntentos: 120 }, dep.tiempos || {});
  const abiertos = new Map(); // id → { puerto, dueno, ruta }
  let siguienteId = 1;
  let busquedaCancelada = false;

  async function listar() {
    const lista = await SerialPort.list();
    const vistos = new Set();
    return lista
      .map((p) => ({ ruta: rutaValida(p.path), nombre: nombreBonito(p), usb: !!(p.vendorId || (p.pnpId && /USB/i.test(p.pnpId))) }))
      .filter((p) => p.ruta && !vistos.has(p.ruta) && vistos.add(p.ruta))
      .sort((a, b) => numeroCom(a.ruta) - numeroCom(b.ruta) || a.ruta.localeCompare(b.ruta));
  }

  function abrirPuerto(ruta, opciones) {
    return new Promise((ok, mal) => {
      let puerto;
      try { puerto = new SerialPort({ path: ruta, ...opciones, autoOpen: false }); } catch (e) { mal(e); return; }
      puerto.open((err) => (err ? mal(err) : ok(puerto)));
    });
  }
  function cerrarPuerto(puerto) {
    return new Promise((ok) => {
      try { if (!puerto.isOpen) { ok(); return; } puerto.close(() => ok()); } catch (e) { ok(); }
    });
  }
  function explicar(err) {
    const m = String((err && err.message) || err || '');
    if (/access denied|acceso denegado|busy|EBUSY|resource busy|being used/i.test(m)) return 'ocupado';
    if (/file not found|cannot find|no such file|ENOENT|not exist/i.test(m)) return 'no existe';
    return 'error';
  }

  /** Abre un puerto para la pantalla. alDatos(id, Uint8Array) y alCerrar(id) avisan a esa pantalla. */
  async function abrir(ruta, opciones, dueno, alDatos, alCerrar) {
    const r = rutaValida(ruta);
    if (!r) throw new Error('Ese no es un puerto COM válido. Escríbelo así: COM3');
    for (const [id, a] of [...abiertos]) if (a.ruta === r) await cerrar(id); // se reabre limpio
    let puerto;
    try { puerto = await abrirPuerto(r, opcionesSeguras(opciones)); } catch (e) {
      const tipo = explicar(e);
      if (tipo === 'ocupado') throw new Error(`${r} lo está usando otro programa. Ciérralo y vuelve a intentar.`);
      if (tipo === 'no existe') throw new Error(`${r} no existe en esta computadora. Revisa el número en «Administrador de dispositivos».`);
      throw new Error(`No se pudo abrir ${r}: ${String(e.message || e).slice(0, 120)}`);
    }
    const id = siguienteId++;
    abiertos.set(id, { puerto, dueno, ruta: r });
    puerto.on('data', (buf) => { try { alDatos(id, new Uint8Array(buf)); } catch (e) { /* pantalla cerrada */ } });
    puerto.on('close', () => { abiertos.delete(id); try { alCerrar(id); } catch (e) { /* pantalla cerrada */ } });
    puerto.on('error', () => { /* se reporta al cerrar */ });
    return { id, ruta: r };
  }

  async function escribir(id, bytes) {
    const a = abiertos.get(Number(id));
    if (!a) return false;
    const datos = Buffer.from(Array.from(bytes || []).slice(0, 64).map((b) => Number(b) & 0xff));
    await new Promise((ok) => a.puerto.write(datos, () => ok()));
    return true;
  }

  async function cerrar(id) {
    const a = abiertos.get(Number(id));
    if (!a) return false;
    abiertos.delete(Number(id));
    await cerrarPuerto(a.puerto);
    return true;
  }

  // Cuando una ventana se cierra o cambia de página, se sueltan sus puertos.
  async function cerrarDe(dueno) {
    for (const [id, a] of [...abiertos]) if (a.dueno === dueno) await cerrar(id);
  }
  async function cerrarTodo() { for (const id of [...abiertos.keys()]) await cerrar(id); }

  function muestraDe(bytes) {
    return bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ' ')).join('').replace(/\s+/g, ' ').trim().slice(0, 40);
  }

  // Prueba un puerto con una velocidad/formato: primero escucha; si no llega un peso, pide con cada letra.
  async function probarCombinacion(ruta, combo) {
    let puerto;
    try { puerto = await abrirPuerto(ruta, { baudRate: combo.baudRate, ...formatoAOpciones(combo.formato) }); } catch (e) {
      return { resultado: explicar(e) };
    }
    let recibido = [];
    let total = 0;
    const alDatos = (buf) => { total += buf.length; recibido.push(...buf); if (recibido.length > 512) recibido = recibido.slice(-512); };
    puerto.on('data', alDatos);
    puerto.on('error', () => {});
    try {
      await esperar(tiempos.escuchar);
      if (pareceLecturaDePeso(recibido)) return { resultado: 'encontrada', comando: 'continuo', muestra: muestraDe(recibido) };
      for (const c of COMANDOS) {
        if (busquedaCancelada) break;
        recibido = [];
        await new Promise((ok) => puerto.write(Buffer.from(c.texto, 'latin1'), () => ok()));
        await esperar(tiempos.porComando);
        if (pareceLecturaDePeso(recibido)) return { resultado: 'encontrada', comando: c.clave, muestra: muestraDe(recibido) };
      }
      return { resultado: total > 0 ? 'datos sin peso' : 'sin respuesta' };
    } finally {
      puerto.removeListener('data', alDatos);
      await cerrarPuerto(puerto);
    }
  }

  /**
   * Modo Automático. alProgreso({ ruta, nombre, paso, estado }) se llama mientras busca.
   * Devuelve { encontrada: {ruta,nombre,baudRate,formato,comando,muestra} | null, revisados: [{ruta,nombre,resultado}], cancelada }.
   */
  async function buscar(alProgreso = () => {}, rutasDadas) {
    busquedaCancelada = false;
    await cerrarTodo(); // la báscula conectada se suelta para poder probar su puerto
    let puertos = [];
    try { puertos = await listar(); } catch (e) { puertos = []; } // sin lista: se prueban los que se pidieron
    if (Array.isArray(rutasDadas) && rutasDadas.length) {
      const pedidas = rutasDadas.map(rutaValida).filter(Boolean);
      puertos = pedidas.map((r) => puertos.find((p) => p.ruta === r) || { ruta: r, nombre: '', usb: false });
    }
    // Primero los de USB (casi todas las básculas nuevas), luego los demás.
    puertos.sort((a, b) => (b.usb ? 1 : 0) - (a.usb ? 1 : 0) || numeroCom(a.ruta) - numeroCom(b.ruta));
    const revisados = [];
    for (const p of puertos) {
      if (busquedaCancelada) break;
      let final = 'sin respuesta';
      for (const combo of COMBINACIONES) {
        if (busquedaCancelada) break;
        alProgreso({ ruta: p.ruta, nombre: p.nombre, paso: `${combo.baudRate} · ${combo.formato}`, estado: 'probando' });
        const r = await probarCombinacion(p.ruta, combo);
        if (r.resultado === 'encontrada') {
          const encontrada = { ruta: p.ruta, nombre: p.nombre, baudRate: combo.baudRate, formato: combo.formato, comando: r.comando, muestra: r.muestra };
          revisados.push({ ruta: p.ruta, nombre: p.nombre, resultado: 'encontrada' });
          alProgreso({ ruta: p.ruta, nombre: p.nombre, paso: `${combo.baudRate} · ${combo.formato}`, estado: 'encontrada' });
          return { encontrada, revisados, cancelada: false };
        }
        if (r.resultado === 'ocupado' || r.resultado === 'no existe') { final = r.resultado; break; }
        if (r.resultado === 'datos sin peso') final = 'datos sin peso';
        await esperar(tiempos.entreIntentos);
      }
      revisados.push({ ruta: p.ruta, nombre: p.nombre, resultado: final });
      alProgreso({ ruta: p.ruta, nombre: p.nombre, paso: '', estado: final });
    }
    return { encontrada: null, revisados, cancelada: busquedaCancelada };
  }

  function cancelarBusqueda() { busquedaCancelada = true; }

  return { listar, abrir, escribir, cerrar, cerrarDe, cerrarTodo, buscar, cancelarBusqueda };
}

module.exports = { crearBasculaNativa, pareceLecturaDePeso, rutaValida, opcionesSeguras, COMBINACIONES, COMANDOS };
