// Módulo de báscula (peso en vivo). Soporta dos transportes:
// - USB (puerto serie): la mayoría de básculas comerciales (Torrey, Rhino,
//   CAS, Dibatec, Kretz, etc.) se conectan por un cable USB que en realidad
//   es un chip USB-a-serial — el navegador las ve como "puerto serie" (Web
//   Serial API), no como un dispositivo USB crudo (por eso este módulo NO
//   reutiliza el WebUSB de impresora-termica.js).
// - Bluetooth (BLE): algunas básculas más nuevas traen radio Bluetooth. No
//   existe un estándar único de servicio BLE para básculas (a diferencia de
//   impresoras, que casi todas usan el mismo servicio) — se intenta una
//   lista de servicios candidatos, de los fabricantes más comunes, y si
//   ninguno funciona, se usa el primer servicio que el navegador encuentre.
//
// Nota honesta sobre compatibilidad: NO existe un protocolo único que todas
// las marcas de básculas compartan. La mayoría (puestas en modo "salida
// continua" en la propia báscula, revisa su manual) mandan repetidamente
// una línea de texto con el peso, ej. "+001.250kg" o "ST,GS,+01.250kg" — el
// formato exacto varía por marca/modelo. Este módulo NO intenta reconocer
// el protocolo de cada marca; en vez de eso, busca el primer número
// decimal (con signo) dentro de cada línea recibida, lo cual funciona con
// la gran mayoría de básculas en modo continuo, pero puede necesitar
// ajuste fino (baud rate, o el regex de abajo) según el modelo real que se
// conecte. Si el peso no se lee bien con una báscula en particular, se
// puede seguir usando el teclado numérico normal como respaldo — esto es
// un complemento, no un reemplazo.

function basculaSerialDisponible() { return !!(navigator.serial); }
function basculaBluetoothDisponible() { return !!(navigator.bluetooth); }

// Servicios BLE candidatos conocidos en básculas comerciales/IoT genéricas.
// Se intentan en orden; si ninguno existe en el dispositivo elegido, se cae
// al primer servicio primario que el navegador exponga (mejor esfuerzo).
const SERVICIOS_BASCULA_BLE = [
  { servicio: '0000ffe0-0000-1000-8000-00805f9b34fb', caracteristica: '0000ffe1-0000-1000-8000-00805f9b34fb' }, // módulo serial BLE genérico (HM-10 y similares, común en básculas chinas/OEM)
  { servicio: '0000fff0-0000-1000-8000-00805f9b34fb', caracteristica: '0000fff1-0000-1000-8000-00805f9b34fb' }
];

function estadoInicialBascula() {
  return {
    puertoSerial: null,
    lectorSerial: null,
    transporteActivo: null, // 'serial' | 'bluetooth' | null
    dispositivoBLE: null,
    caracteristicaBLE: null,
    ultimoPeso: null, // número en kg, o null si aún no hay lectura
    conectando: false
  };
}

const basculaEstado = estadoInicialBascula();

// ---------- Pub/sub: para que Mostrador (u otra pantalla) reaccione a cada
// lectura nueva sin tener que preguntar ("polling") ----------
const suscriptoresPeso = [];
function suscribirsePeso(callback) {
  suscriptoresPeso.push(callback);
  return () => {
    const idx = suscriptoresPeso.indexOf(callback);
    if (idx !== -1) suscriptoresPeso.splice(idx, 1);
  };
}
function notificarPeso(peso) {
  basculaEstado.ultimoPeso = peso;
  suscriptoresPeso.forEach(cb => {
    try { cb(peso); } catch (err) { console.error('Error en suscriptor de peso:', err); }
  });
}
function ultimoPesoBascula() { return basculaEstado.ultimoPeso; }

// Llena solo un campo de peso mientras la persona no haya tecleado nada a mano.
// escribir(peso) pone el valor; tecleo() dice si ya se escribió a mano. Devuelve la función para dejar de escuchar.
function llenarConBascula(escribir, tecleo) {
  if (typeof basculaConectada !== 'function' || !basculaConectada()) return () => {};
  if (localStorage.getItem('bascula_usar_en_mostrador') === '0') return () => {};
  let anterior = null;
  const poner = (peso) => {
    if (tecleo()) return;
    if (!(peso > 0)) return;
    if (anterior !== null && Math.abs(anterior - peso) < 0.0005) escribir(peso); // dos lecturas iguales = estable
    anterior = peso;
  };
  if (basculaEstado.ultimoPeso > 0) { anterior = basculaEstado.ultimoPeso; escribir(basculaEstado.ultimoPeso); }
  return suscribirsePeso(poner);
}

// Busca el primer número decimal con signo opcional dentro de una línea de
// texto recibida de la báscula (ej. de "ST,GS,+001.250kg" extrae 1.25).
// Devuelve null si la línea no trae ningún número reconocible (ruido,
// encabezados de estado, etc. — se ignora esa línea y se espera la siguiente).
function parsearPesoDeTexto(linea) {
  const coincidencia = linea.match(/[-+]?\d+\.?\d*/);
  if (!coincidencia) return null;
  const numero = parseFloat(coincidencia[0]);
  if (isNaN(numero)) return null;
  return numero;
}

function basculaConectada() {
  if (basculaEstado.transporteActivo === 'serial') {
    return !!basculaEstado.puertoSerial;
  }
  if (basculaEstado.transporteActivo === 'bluetooth') {
    return !!(basculaEstado.dispositivoBLE && basculaEstado.dispositivoBLE.gatt && basculaEstado.dispositivoBLE.gatt.connected);
  }
  return false;
}

// ---------- Conexión por puerto serie (USB) ----------
// Hay básculas que mandan el peso SOLAS todo el tiempo ("salida continua") y otras que solo lo mandan
// cuando se les PIDE con una letra (Torrey y muchas mexicanas: "P"; otras: ENQ o "W").
// En modo «automático» primero se escucha; si no llega nada, se prueban esas letras una por una
// y se queda la que sí contesta. Todo lo que llega se guarda para verlo en Configuración.
const COMANDOS_PEDIR_PESO = { P: 'P', ENQ: '\x05', W: 'W', P_CR: 'P\r\n', W_CR: 'W\r\n' };
const ORDEN_AUTOMATICO = ['P', 'ENQ', 'W', 'P_CR', 'W_CR'];
const ESPERA_SIN_PEDIR_MS = 1500;   // primero se escucha si la manda sola
const PRUEBA_POR_COMANDO_MS = 1600; // cuánto se prueba cada letra
const PEDIR_CADA_MS = 450;          // con qué frecuencia se pide el peso

function opcionesPuertoBascula(baudRate) {
  const formato = localStorage.getItem('bascula_formato') || '8N1';
  return formato === '7E1'
    ? { baudRate, dataBits: 7, parity: 'even', stopBits: 1 }
    : { baudRate, dataBits: 8, parity: 'none', stopBits: 1 };
}

// Datos crudos para el diagnóstico de Configuración.
const suscriptoresCrudo = [];
function suscribirseCrudoBascula(cb) { suscriptoresCrudo.push(cb); return () => { const k = suscriptoresCrudo.indexOf(cb); if (k !== -1) suscriptoresCrudo.splice(k, 1); }; }
function diagnosticoBascula() {
  return { bytes: basculaEstado.bytesRecibidos || 0, crudo: basculaEstado.crudo || '', comando: basculaEstado.comandoEnUso || null, modo: basculaEstado.modoLectura || null };
}
function avisarCrudo() { const d = diagnosticoBascula(); suscriptoresCrudo.forEach((cb) => { try { cb(d); } catch (e) { /* pantalla */ } }); }

// Peso en kg a partir de una línea: entiende "+001.250kg", "ST,GS, 1.250 kg", "1250 g", "2.75 lb".
function pesoEnKgDeTexto(linea) {
  const n = parsearPesoDeTexto(linea);
  if (n === null) return null;
  if (/\d\s*g\b/i.test(linea) && !/kg/i.test(linea)) return n / 1000;
  if (/lb/i.test(linea)) return Math.round(n * 0.45359237 * 1000) / 1000;
  return n;
}

async function conectarBasculaSerial(baudRate = 9600) {
  if (!basculaSerialDisponible()) {
    throw new Error('Este navegador no soporta conexión por puerto serie (USB). Usa Chrome o Edge en computadora — no está disponible en celulares.');
  }
  const puerto = await navigator.serial.requestPort();
  await abrirPuertoConReintentos(puerto, baudRate);
  await recordarPuertoElegido(puerto);

  basculaEstado.puertoSerial = puerto;
  basculaEstado.transporteActivo = 'serial';
  localStorage.setItem('bascula_transporte', 'serial');
  localStorage.setItem('bascula_baud_rate', String(baudRate));

  iniciarLecturaSerial(puerto);
  return 'Báscula (puerto serie)';
}

// Se recuerda CUÁL puerto se eligió (fabricante/modelo del cable y su lugar en la lista), para que en
// Mostrador y Caja se abra el mismo (antes se abría el primero autorizado, que podía ser otro COM).
async function recordarPuertoElegido(puerto) {
  try {
    const info = puerto.getInfo ? puerto.getInfo() : {};
    const todos = navigator.serial.getPorts ? await navigator.serial.getPorts() : [];
    localStorage.setItem('bascula_puerto', JSON.stringify({ v: info.usbVendorId || null, p: info.usbProductId || null, i: Math.max(0, todos.indexOf(puerto)) }));
  } catch (e) { /* sin datos del puerto */ }
}
function elegirPuertoRecordado(puertos) {
  let g = null; try { g = JSON.parse(localStorage.getItem('bascula_puerto') || 'null'); } catch (e) { g = null; }
  if (!g || !puertos.length) return puertos[0] || null;
  const iguales = puertos.filter((x) => { const i = x.getInfo ? x.getInfo() : {}; return (i.usbVendorId || null) === g.v && (i.usbProductId || null) === g.p; });
  if (iguales.length === 1) return iguales[0];
  if (puertos[g.i]) return puertos[g.i];
  return iguales[0] || puertos[0];
}
// Al cambiar de pantalla el puerto puede tardar un instante en soltarse: se reintenta.
async function abrirPuertoConReintentos(puerto, baudRate) {
  let ultimoError = null;
  for (let k = 0; k < 6; k++) {
    try { await puerto.open(opcionesPuertoBascula(baudRate)); return; } catch (e) {
      ultimoError = e;
      if (/already open/i.test(e.message || '')) return; // ya estaba abierto
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw ultimoError;
}
// Al salir de la pantalla se suelta el puerto para que la siguiente lo pueda abrir.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pagehide', () => {
    try { detenerPedidoPeso(); } catch (e) {}
    try { if (basculaEstado.lectorSerial) basculaEstado.lectorSerial.cancel(); } catch (e) {}
    try { if (basculaEstado.puertoSerial) basculaEstado.puertoSerial.close(); } catch (e) {}
  });
}

function detenerPedidoPeso() {
  if (basculaEstado.temporizadorPedir) { clearInterval(basculaEstado.temporizadorPedir); basculaEstado.temporizadorPedir = null; }
  if (basculaEstado.temporizadorAuto) { clearTimeout(basculaEstado.temporizadorAuto); basculaEstado.temporizadorAuto = null; }
}

async function mandarComandoBascula(clave) {
  const w = basculaEstado.escritorSerial; if (!w) return;
  const texto = COMANDOS_PEDIR_PESO[clave]; if (!texto) return;
  try { await w.write(new TextEncoder().encode(texto)); } catch (e) { /* puerto cerrado */ }
}

function pedirPesoCon(clave) {
  detenerPedidoPeso();
  basculaEstado.comandoEnUso = clave;
  basculaEstado.modoLectura = 'pedir';
  mandarComandoBascula(clave);
  basculaEstado.temporizadorPedir = setInterval(() => mandarComandoBascula(clave), PEDIR_CADA_MS);
  avisarCrudo();
}

// Modo automático: escuchar; si no llega nada, probar cada letra hasta que una conteste.
function arrancarModoAutomatico() {
  const preferencia = localStorage.getItem('bascula_comando') || 'auto';
  detenerPedidoPeso();
  if (preferencia === 'continuo') { basculaEstado.modoLectura = 'continuo'; basculaEstado.comandoEnUso = null; avisarCrudo(); return; }
  if (preferencia !== 'auto' && COMANDOS_PEDIR_PESO[preferencia]) { pedirPesoCon(preferencia); return; }
  const recordado = localStorage.getItem('bascula_comando_detectado');
  basculaEstado.modoLectura = 'buscando';
  const bytesAlInicio = () => basculaEstado.bytesRecibidos || 0;
  let base = bytesAlInicio();
  let k = recordado && ORDEN_AUTOMATICO.includes(recordado) ? -1 : 0; // -1 = primero escuchar
  const siguiente = () => {
    if (!basculaEstado.puertoSerial) return;
    if (bytesAlInicio() > base) { // llegó algo
      if (basculaEstado.comandoEnUso) {
        localStorage.setItem('bascula_comando_detectado', basculaEstado.comandoEnUso);
        pedirPesoCon(basculaEstado.comandoEnUso);
      } else { basculaEstado.modoLectura = 'continuo'; localStorage.setItem('bascula_comando_detectado', 'continuo'); avisarCrudo(); }
      return;
    }
    base = bytesAlInicio();
    let clave;
    if (k === -1) { clave = recordado; k = 0; }
    else { clave = ORDEN_AUTOMATICO[k % ORDEN_AUTOMATICO.length]; k++; }
    basculaEstado.comandoEnUso = clave;
    if (basculaEstado.temporizadorPedir) clearInterval(basculaEstado.temporizadorPedir);
    mandarComandoBascula(clave);
    basculaEstado.temporizadorPedir = setInterval(() => mandarComandoBascula(clave), PEDIR_CADA_MS);
    avisarCrudo();
    basculaEstado.temporizadorAuto = setTimeout(siguiente, PRUEBA_POR_COMANDO_MS);
  };
  basculaEstado.comandoEnUso = null;
  avisarCrudo();
  basculaEstado.temporizadorAuto = setTimeout(siguiente, ESPERA_SIN_PEDIR_MS);
}

// Vuelve a empezar la detección (cuando se cambia el modo en Configuración).
function reiniciarLecturaBascula() {
  if (basculaEstado.transporteActivo === 'serial' && basculaEstado.puertoSerial) arrancarModoAutomatico();
}

// Lee continuamente del puerto serie y notifica cada peso reconocido. Separa por salto de línea,
// STX/ETX, o por una pausa corta (básculas que no mandan salto de línea).
async function iniciarLecturaSerial(puerto) {
  const lector = puerto.readable.getReader();
  basculaEstado.lectorSerial = lector;
  try { basculaEstado.escritorSerial = puerto.writable ? puerto.writable.getWriter() : null; } catch (e) { basculaEstado.escritorSerial = null; }
  basculaEstado.bytesRecibidos = 0; basculaEstado.crudo = '';

  let bufer = '', ultimo = 0;
  const procesar = (texto) => { if (!texto.trim()) return; const peso = pesoEnKgDeTexto(texto); if (peso !== null) notificarPeso(peso); };
  const vaciador = setInterval(() => { if (bufer && Date.now() - ultimo > 150) { procesar(bufer); bufer = ''; } }, 100);
  arrancarModoAutomatico();
  try {
    while (true) {
      const { value, done } = await lector.read();
      if (done) break;
      if (!value || !value.length) continue;
      let texto = '';
      for (const b of value) texto += String.fromCharCode(b);
      basculaEstado.bytesRecibidos = (basculaEstado.bytesRecibidos || 0) + value.length;
      basculaEstado.crudo = (basculaEstado.crudo + texto).slice(-160);
      ultimo = Date.now();
      bufer += texto;
      const partes = bufer.split(/[\r\n\x02\x03]+/);
      bufer = partes.pop();
      partes.forEach(procesar);
      avisarCrudo();
    }
  } catch (err) {
    console.warn('Lectura de báscula (serie) interrumpida:', err.message);
  } finally {
    clearInterval(vaciador);
    detenerPedidoPeso();
    try { lector.releaseLock(); } catch (e) {}
    try { if (basculaEstado.escritorSerial) basculaEstado.escritorSerial.releaseLock(); } catch (e) {}
    basculaEstado.escritorSerial = null;
  }
}

async function desconectarBasculaSerial() {
  detenerPedidoPeso();
  if (basculaEstado.lectorSerial) {
    try { await basculaEstado.lectorSerial.cancel(); } catch (e) {}
    basculaEstado.lectorSerial = null;
  }
  if (basculaEstado.escritorSerial) {
    try { basculaEstado.escritorSerial.releaseLock(); } catch (e) {}
    basculaEstado.escritorSerial = null;
  }
  if (basculaEstado.puertoSerial) {
    try { await basculaEstado.puertoSerial.close(); } catch (e) {}
    basculaEstado.puertoSerial = null;
  }
  basculaEstado.modoLectura = null; basculaEstado.comandoEnUso = null;
  avisarCrudo();
}

// ---------- Conexión por Bluetooth (BLE) ----------
async function conectarBasculaBluetooth() {
  if (!basculaBluetoothDisponible()) {
    throw new Error('Este navegador no soporta Bluetooth. Usa Chrome o Edge en Android/computadora.');
  }

  const serviciosConocidos = SERVICIOS_BASCULA_BLE.map(s => s.servicio);
  const dispositivo = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: serviciosConocidos
  });

  dispositivo.addEventListener('gattserverdisconnected', () => {
    basculaEstado.caracteristicaBLE = null;
  });

  const servidor = await dispositivo.gatt.connect();

  // Intenta primero los servicios candidatos conocidos; si ninguno existe
  // en este dispositivo, cae al primer servicio primario disponible (mejor
  // esfuerzo — no hay forma de saber de antemano cuál trae cada báscula).
  let caracteristica = null;
  for (const candidato of SERVICIOS_BASCULA_BLE) {
    try {
      const servicio = await servidor.getPrimaryService(candidato.servicio);
      caracteristica = await servicio.getCharacteristic(candidato.caracteristica);
      break;
    } catch (err) { /* este servicio no existe en el dispositivo, intenta el siguiente */ }
  }
  if (!caracteristica) {
    const servicios = await servidor.getPrimaryServices();
    for (const servicio of servicios) {
      const caracteristicas = await servicio.getCharacteristics();
      caracteristica = caracteristicas.find(c => c.properties.notify || c.properties.indicate);
      if (caracteristica) break;
    }
  }
  if (!caracteristica) {
    throw new Error('Se conectó al dispositivo Bluetooth, pero no se encontró un canal de datos reconocible. Esta báscula podría no ser compatible por Bluetooth — prueba con USB si tiene esa opción.');
  }

  await caracteristica.startNotifications();
  let bufer = '';
  caracteristica.addEventListener('characteristicvaluechanged', (evento) => {
    const texto = new TextDecoder().decode(evento.target.value);
    bufer += texto;
    const lineas = bufer.split(/[\r\n]+/);
    bufer = lineas.pop();
    for (const linea of lineas) {
      if (!linea.trim()) continue;
      const peso = parsearPesoDeTexto(linea);
      if (peso !== null) notificarPeso(peso);
    }
    // Algunas básculas BLE mandan el peso en un solo paquete sin salto de
    // línea — si el bufer ya trae un número reconocible, no hay que
    // esperar a un salto de línea que nunca llegará.
    if (bufer) {
      const pesoParcial = parsearPesoDeTexto(bufer);
      if (pesoParcial !== null) notificarPeso(pesoParcial);
    }
  });

  basculaEstado.dispositivoBLE = dispositivo;
  basculaEstado.caracteristicaBLE = caracteristica;
  basculaEstado.transporteActivo = 'bluetooth';
  localStorage.setItem('bascula_transporte', 'bluetooth');
  return dispositivo.name || 'Báscula (Bluetooth)';
}

async function desconectarBasculaBluetooth() {
  if (basculaEstado.caracteristicaBLE) {
    try { await basculaEstado.caracteristicaBLE.stopNotifications(); } catch (e) {}
    basculaEstado.caracteristicaBLE = null;
  }
  if (basculaEstado.dispositivoBLE && basculaEstado.dispositivoBLE.gatt && basculaEstado.dispositivoBLE.gatt.connected) {
    try { basculaEstado.dispositivoBLE.gatt.disconnect(); } catch (e) {}
  }
  basculaEstado.dispositivoBLE = null;
}

// Desconecta lo que esté activo (cualquier transporte) — para el botón
// "Desconectar" único en Configuración.
async function desconectarBascula() {
  if (basculaEstado.transporteActivo === 'serial') await desconectarBasculaSerial();
  if (basculaEstado.transporteActivo === 'bluetooth') await desconectarBasculaBluetooth();
  basculaEstado.transporteActivo = null;
  localStorage.removeItem('bascula_transporte');
}

// Al cargar cualquier pantalla, intenta reconectar SOLA con el último
// puerto/dispositivo autorizado (sin pedirle nada al usuario), igual que
// las impresoras. Solo funciona si el usuario ya autorizó el puerto o
// dispositivo una vez antes (permiso persistente del navegador).
async function intentarReconexionAutomaticaBascula() {
  const transporteGuardado = localStorage.getItem('bascula_transporte');
  try {
    if (transporteGuardado === 'serial' && basculaSerialDisponible() && navigator.serial.getPorts) {
      const puertosAutorizados = await navigator.serial.getPorts();
      if (puertosAutorizados.length > 0) {
        const baudRate = parseInt(localStorage.getItem('bascula_baud_rate') || '9600');
        const puerto = elegirPuertoRecordado(puertosAutorizados);
        await abrirPuertoConReintentos(puerto, baudRate);
        basculaEstado.puertoSerial = puerto;
        basculaEstado.transporteActivo = 'serial';
        iniciarLecturaSerial(puerto);
      }
    } else if (transporteGuardado === 'bluetooth' && basculaBluetoothDisponible() && navigator.bluetooth.getDevices) {
      const dispositivosAutorizados = await navigator.bluetooth.getDevices();
      if (dispositivosAutorizados.length > 0) {
        const dispositivo = dispositivosAutorizados[0];
        dispositivo.addEventListener('gattserverdisconnected', () => { basculaEstado.caracteristicaBLE = null; });
        const servidor = await dispositivo.gatt.connect();
        let caracteristica = null;
        for (const candidato of SERVICIOS_BASCULA_BLE) {
          try {
            const servicio = await servidor.getPrimaryService(candidato.servicio);
            caracteristica = await servicio.getCharacteristic(candidato.caracteristica);
            break;
          } catch (err) {}
        }
        if (!caracteristica) {
          const servicios = await servidor.getPrimaryServices();
          for (const servicio of servicios) {
            const caracteristicas = await servicio.getCharacteristics();
            caracteristica = caracteristicas.find(c => c.properties.notify || c.properties.indicate);
            if (caracteristica) break;
          }
        }
        if (caracteristica) {
          await caracteristica.startNotifications();
          let bufer = '';
          caracteristica.addEventListener('characteristicvaluechanged', (evento) => {
            const texto = new TextDecoder().decode(evento.target.value);
            bufer += texto;
            const lineas = bufer.split(/[\r\n]+/);
            bufer = lineas.pop();
            for (const linea of lineas) {
              if (!linea.trim()) continue;
              const peso = parsearPesoDeTexto(linea);
              if (peso !== null) notificarPeso(peso);
            }
          });
          basculaEstado.dispositivoBLE = dispositivo;
          basculaEstado.caracteristicaBLE = caracteristica;
          basculaEstado.transporteActivo = 'bluetooth';
        }
      }
    }
  } catch (err) {
    // Silencioso a propósito, igual que con impresoras: si falla, la
    // pantalla simplemente muestra "Báscula no conectada" y el usuario
    // puede reconectar manualmente.
    console.warn('Reconexión automática de báscula no disponible:', err.message);
  }
}

intentarReconexionAutomaticaBascula();
