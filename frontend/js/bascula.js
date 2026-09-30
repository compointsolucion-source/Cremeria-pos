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
// Debe llamarse desde un clic directo del usuario (requisito de seguridad
// del navegador para Web Serial, igual que Bluetooth/USB de impresoras).
async function conectarBasculaSerial(baudRate = 9600) {
  if (!basculaSerialDisponible()) {
    throw new Error('Este navegador no soporta conexión por puerto serie (USB). Usa Chrome o Edge en computadora — no está disponible en celulares.');
  }
  const puerto = await navigator.serial.requestPort();
  await puerto.open({ baudRate });

  basculaEstado.puertoSerial = puerto;
  basculaEstado.transporteActivo = 'serial';
  localStorage.setItem('bascula_transporte', 'serial');
  localStorage.setItem('bascula_baud_rate', String(baudRate));

  iniciarLecturaSerial(puerto);
  return 'Báscula (puerto serie)';
}

// Lee continuamente del puerto serie, línea por línea, y notifica cada peso
// reconocido. Se queda corriendo en segundo plano mientras la báscula esté
// conectada — se detiene solo al desconectar o si el puerto falla.
async function iniciarLecturaSerial(puerto) {
  const decodificador = new TextDecoderStream();
  const cierrePromesa = puerto.readable.pipeTo(decodificador.writable).catch(() => {});
  const lector = decodificador.readable.getReader();
  basculaEstado.lectorSerial = lector;

  let bufer = '';
  try {
    while (true) {
      const { value, done } = await lector.read();
      if (done) break;
      bufer += value;
      const lineas = bufer.split(/[\r\n]+/);
      bufer = lineas.pop(); // guarda el residuo incompleto para la siguiente vuelta
      for (const linea of lineas) {
        if (!linea.trim()) continue;
        const peso = parsearPesoDeTexto(linea);
        if (peso !== null) notificarPeso(peso);
      }
    }
  } catch (err) {
    console.warn('Lectura de báscula (serie) interrumpida:', err.message);
  } finally {
    try { lector.releaseLock(); } catch (e) {}
    await cierrePromesa;
  }
}

async function desconectarBasculaSerial() {
  if (basculaEstado.lectorSerial) {
    try { await basculaEstado.lectorSerial.cancel(); } catch (e) {}
    basculaEstado.lectorSerial = null;
  }
  if (basculaEstado.puertoSerial) {
    try { await basculaEstado.puertoSerial.close(); } catch (e) {}
    basculaEstado.puertoSerial = null;
  }
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
        const puerto = puertosAutorizados[0];
        await puerto.open({ baudRate });
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
