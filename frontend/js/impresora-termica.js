// Módulo compartido de impresión térmica. Soporta dos transportes:
// - Bluetooth (BLE): Chrome/Edge en Android y computadora.
// - USB: Chrome/Edge en computadora (WebUSB) — ideal para impresoras USB-only
//   como la Ghia GTP58, que no tienen radio Bluetooth propio.
// Nota honesta: NO existe una tercera opción "por red/WiFi" — un navegador no
// puede abrir ese tipo de conexión directa por seguridad; requeriría una
// aplicación intermediaria corriendo en la red local, que no está construida.

const SERVICIO_IMPRESORA = '000018f0-0000-1000-8000-00805f9b34fb';
const CARACTERISTICA_IMPRESORA = '00002af1-0000-1000-8000-00805f9b34fb';

let dispositivoBLE = null;
let caracteristicaEscritura = null;
let dispositivoUSB = null;
let endpointSalidaUSB = null;
let transporteActivo = null; // 'bluetooth' | 'usb' | null

function bluetoothDisponible() { return !!navigator.bluetooth; }
function usbDisponible() { return !!navigator.usb; }

// Conecta por Bluetooth — debe llamarse desde un clic directo del usuario
// (requisito de seguridad del navegador para Web Bluetooth).
async function conectarImpresora() {
  if (!bluetoothDisponible()) {
    throw new Error('Este navegador no soporta Bluetooth. Usa Chrome o Edge en Android/computadora.');
  }

  dispositivoBLE = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICIO_IMPRESORA] }],
    optionalServices: [SERVICIO_IMPRESORA]
  });

  dispositivoBLE.addEventListener('gattserverdisconnected', () => {
    caracteristicaEscritura = null;
  });

  const servidor = await dispositivoBLE.gatt.connect();
  const servicio = await servidor.getPrimaryService(SERVICIO_IMPRESORA);
  caracteristicaEscritura = await servicio.getCharacteristic(CARACTERISTICA_IMPRESORA);
  transporteActivo = 'bluetooth';

  localStorage.setItem('impresora_transporte', 'bluetooth');
  return dispositivoBLE.name || 'Impresora (Bluetooth)';
}

// Conecta por USB — también debe llamarse desde un clic directo del usuario.
// Como no conocemos de antemano el fabricante/modelo exacto de cada impresora
// USB, se muestran TODOS los dispositivos USB conectados para que el usuario
// elija la suya (filters: [] + acceptAllDevices).
async function conectarImpresoraUSB() {
  if (!usbDisponible()) {
    throw new Error('Este navegador no soporta USB directo. Usa Chrome o Edge en computadora.');
  }

  dispositivoUSB = await navigator.usb.requestDevice({ filters: [] });
  await dispositivoUSB.open();

  if (!dispositivoUSB.configuration) {
    await dispositivoUSB.selectConfiguration(1);
  }

  // Busca la primera interfaz con un endpoint de salida ("OUT") — es donde
  // se envían los comandos ESC/POS a la impresora.
  let interfazEncontrada = null;
  for (const iface of dispositivoUSB.configuration.interfaces) {
    const alt = iface.alternates[0];
    const endpointSalida = alt.endpoints.find(ep => ep.direction === 'out');
    if (endpointSalida) {
      interfazEncontrada = iface.interfaceNumber;
      endpointSalidaUSB = endpointSalida.endpointNumber;
      break;
    }
  }
  if (interfazEncontrada === null) {
    throw new Error('No se encontró un canal de impresión en este dispositivo USB.');
  }

  await dispositivoUSB.claimInterface(interfazEncontrada);
  transporteActivo = 'usb';
  localStorage.setItem('impresora_transporte', 'usb');
  return dispositivoUSB.productName || 'Impresora (USB)';
}

async function reconectarSiEsPosible() {
  if (transporteActivo === 'bluetooth' && dispositivoBLE && dispositivoBLE.gatt && !dispositivoBLE.gatt.connected) {
    const servidor = await dispositivoBLE.gatt.connect();
    const servicio = await servidor.getPrimaryService(SERVICIO_IMPRESORA);
    caracteristicaEscritura = await servicio.getCharacteristic(CARACTERISTICA_IMPRESORA);
  } else if (transporteActivo === 'usb' && dispositivoUSB && !dispositivoUSB.opened) {
    await dispositivoUSB.open();
  }
}

// Al cargar cualquier pantalla, intenta reconectar SOLA con el último
// dispositivo autorizado (sin pedirle nada al usuario) — así no hay que
// tocar "Conectar" cada vez que cambias de página. Solo funciona si el
// usuario ya autorizó el dispositivo una vez antes (permiso persistente
// del navegador); si nunca lo autorizó, no hace nada.
async function intentarReconexionAutomatica() {
  const transporteGuardado = localStorage.getItem('impresora_transporte');
  try {
    if (transporteGuardado === 'bluetooth' && bluetoothDisponible() && navigator.bluetooth.getDevices) {
      const dispositivosAutorizados = await navigator.bluetooth.getDevices();
      if (dispositivosAutorizados.length > 0) {
        dispositivoBLE = dispositivosAutorizados[0];
        dispositivoBLE.addEventListener('gattserverdisconnected', () => { caracteristicaEscritura = null; });
        const servidor = await dispositivoBLE.gatt.connect();
        const servicio = await servidor.getPrimaryService(SERVICIO_IMPRESORA);
        caracteristicaEscritura = await servicio.getCharacteristic(CARACTERISTICA_IMPRESORA);
        transporteActivo = 'bluetooth';
      }
    } else if (transporteGuardado === 'usb' && usbDisponible()) {
      const dispositivosAutorizados = await navigator.usb.getDevices();
      if (dispositivosAutorizados.length > 0) {
        dispositivoUSB = dispositivosAutorizados[0];
        await dispositivoUSB.open();
        if (!dispositivoUSB.configuration) await dispositivoUSB.selectConfiguration(1);
        for (const iface of dispositivoUSB.configuration.interfaces) {
          const alt = iface.alternates[0];
          const endpointSalida = alt.endpoints.find(ep => ep.direction === 'out');
          if (endpointSalida) {
            await dispositivoUSB.claimInterface(iface.interfaceNumber);
            endpointSalidaUSB = endpointSalida.endpointNumber;
            break;
          }
        }
        transporteActivo = 'usb';
      }
    }
  } catch (err) {
    // Silencioso a propósito: si falla la reconexión automática, el banner
    // de "Impresora no conectada" seguirá visible y el usuario puede
    // reconectar manualmente — no es un error que deba interrumpir la carga.
    console.warn('Reconexión automática de impresora no disponible:', err.message);
  }
}

function impresoraConectada() {
  if (transporteActivo === 'bluetooth') {
    return !!(dispositivoBLE && dispositivoBLE.gatt && dispositivoBLE.gatt.connected && caracteristicaEscritura);
  }
  if (transporteActivo === 'usb') {
    return !!(dispositivoUSB && dispositivoUSB.opened);
  }
  return false;
}

// Envía bytes al transporte activo. Bluetooth va en trozos pequeños (BLE no
// admite paquetes grandes); USB puede enviar todo de una vez.
async function enviarBytes(bytes) {
  if (transporteActivo === 'bluetooth') {
    const TAMANO_TROZO = 180;
    for (let i = 0; i < bytes.length; i += TAMANO_TROZO) {
      const trozo = bytes.slice(i, i + TAMANO_TROZO);
      await caracteristicaEscritura.writeValueWithoutResponse(trozo);
    }
  } else if (transporteActivo === 'usb') {
    await dispositivoUSB.transferOut(endpointSalidaUSB, bytes);
  } else {
    throw new Error('No hay impresora conectada.');
  }
}

// Intenta reconectar en automático apenas se carga la página.
intentarReconexionAutomatica();

// Convierte texto a bytes ESC/POS básicos: inicializa, imprime texto, corta el papel.
function construirComandosTexto(lineas) {
  const ESC = 0x1B, GS = 0x1D;
  const partes = [new Uint8Array([ESC, 0x40])]; // inicializar impresora
  const encoder = new TextEncoder();

  lineas.forEach(linea => {
    partes.push(encoder.encode(linea + '\n'));
  });

  partes.push(new Uint8Array([0x0A, 0x0A, 0x0A])); // espacio antes de cortar
  partes.push(new Uint8Array([GS, 0x56, 0x00])); // cortar papel (si la impresora lo soporta)

  const total = partes.reduce((sum, p) => sum + p.length, 0);
  const resultado = new Uint8Array(total);
  let offset = 0;
  partes.forEach(p => { resultado.set(p, offset); offset += p.length; });
  return resultado;
}

// Convierte un canvas (con una imagen en blanco y negro, ej. un QR) a los
// comandos ESC/POS de imagen raster (GS v 0) que la mayoría de impresoras
// térmicas entienden para imprimir gráficos.
function canvasAComandosRaster(canvas) {
  const ctx = canvas.getContext('2d');
  const ancho = canvas.width;
  const alto = canvas.height;
  const datos = ctx.getImageData(0, 0, ancho, alto).data;
  const anchoBytes = Math.ceil(ancho / 8);

  const encabezado = new Uint8Array([
    0x1D, 0x76, 0x30, 0x00,
    anchoBytes & 0xFF, (anchoBytes >> 8) & 0xFF,
    alto & 0xFF, (alto >> 8) & 0xFF
  ]);

  const cuerpo = new Uint8Array(anchoBytes * alto);
  let puntero = 0;
  for (let y = 0; y < alto; y++) {
    for (let bx = 0; bx < anchoBytes; bx++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = bx * 8 + bit;
        if (x < ancho) {
          const idx = (y * ancho + x) * 4;
          const brillo = (datos[idx] + datos[idx + 1] + datos[idx + 2]) / 3;
          if (brillo < 128) byte |= (1 << (7 - bit));
        }
      }
      cuerpo[puntero++] = byte;
    }
  }

  const resultado = new Uint8Array(encabezado.length + cuerpo.length);
  resultado.set(encabezado, 0);
  resultado.set(cuerpo, encabezado.length);
  return resultado;
}

// Genera un QR con el folio en un canvas oculto, usando la librería QRCode
// (cargada por separado en la página). Devuelve el canvas listo para imprimir.
function generarCanvasQR(texto, tamanoPx) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    QRCode.toCanvas(canvas, texto, { width: tamanoPx, margin: 1 }, (err) => {
      if (err) reject(err);
      else resolve(canvas);
    });
  });
}

function bytesJuntos(listaDeArrays) {
  const total = listaDeArrays.reduce((sum, a) => sum + a.length, 0);
  const resultado = new Uint8Array(total);
  let offset = 0;
  listaDeArrays.forEach(a => { resultado.set(a, offset); offset += a.length; });
  return resultado;
}

function bytesDeLineas(lineas) {
  const encoder = new TextEncoder();
  return bytesJuntos(lineas.map(l => encoder.encode(l + '\n')));
}

// Arma un ticket de texto plano, ajustado al ancho de papel (32 caracteres para
// 58mm, 48 para 80mm), centrando el título y alineando montos a la derecha.
function formatearEncabezadoTicket({ ancho_ticket, negocio, folio, fecha }) {
  const columnas = ancho_ticket === '58mm' ? 32 : 48;
  const centrar = (texto) => {
    const espacios = Math.max(0, Math.floor((columnas - texto.length) / 2));
    return ' '.repeat(espacios) + texto;
  };
  const separador = '-'.repeat(columnas);

  const lineas = [];
  if (negocio.nombre) lineas.push(centrar(negocio.nombre));
  if (negocio.direccion) lineas.push(centrar(negocio.direccion));
  if (negocio.telefono) lineas.push(centrar(`Tel: ${negocio.telefono}`));
  lineas.push(separador);
  lineas.push(`Folio: ${folio}`);
  lineas.push(`Fecha: ${fecha}`);
  lineas.push(separador);
  return lineas;
}

function formatearCuerpoTicket({ ancho_ticket, items, total, piePagina }) {
  const columnas = ancho_ticket === '58mm' ? 32 : 48;
  const centrar = (texto) => {
    const espacios = Math.max(0, Math.floor((columnas - texto.length) / 2));
    return ' '.repeat(espacios) + texto;
  };
  const separador = '-'.repeat(columnas);
  const filaMonto = (etiqueta, monto) => {
    const montoTexto = `$${monto}`;
    const espacios = Math.max(1, columnas - etiqueta.length - montoTexto.length);
    return etiqueta + ' '.repeat(espacios) + montoTexto;
  };

  const lineas = [''];
  items.forEach(item => {
    lineas.push(item.nombre_producto);
    lineas.push(filaMonto(`  ${item.detalle}`, item.subtotal));
  });

  lineas.push(separador);
  lineas.push(filaMonto('TOTAL', total));
  lineas.push(separador);

  if (piePagina) lineas.push(centrar(piePagina));
  lineas.push('');
  return lineas;
}

// Mantiene compatibilidad con quien todavía use formatearTicket() completo
// (ej. el respaldo de texto compartido, que no imprime imagen QR).
function formatearTicket(datosTicket) {
  return [...formatearEncabezadoTicket(datosTicket), ...formatearCuerpoTicket(datosTicket)];
}

// Imprime un ticket completo, incluyendo un QR gráfico escaneable con el folio.
// Lanza error si no hay impresora conectada — quien llama debe mostrar el
// banner de "Reconectar" en ese caso.
async function imprimirTicketBLE(datosTicket) {
  if (!impresoraConectada()) {
    await reconectarSiEsPosible();
  }
  if (!impresoraConectada()) {
    throw new Error('No hay impresora conectada. Toca "Conectar impresora" primero.');
  }

  const ESC = 0x1B;
  const inicializar = new Uint8Array([ESC, 0x40]);
  const encabezado = bytesDeLineas(formatearEncabezadoTicket(datosTicket));
  const cuerpo = bytesDeLineas(formatearCuerpoTicket(datosTicket));
  const cierre = new Uint8Array([0x0A, 0x0A, 0x0A, 0x1D, 0x56, 0x00]); // espacio + cortar papel

  let comandosQR = new Uint8Array(0);
  try {
    if (typeof QRCode !== 'undefined') {
      const anchoPx = datosTicket.ancho_ticket === '58mm' ? 240 : 350;
      const canvasQR = await generarCanvasQR(datosTicket.folio, anchoPx);
      comandosQR = bytesJuntos([canvasAComandosRaster(canvasQR), new Uint8Array([0x0A])]);
    }
  } catch (err) {
    console.error('No se pudo generar el QR, se imprime solo el folio en texto:', err.message);
  }

  const comandosFinales = bytesJuntos([inicializar, encabezado, comandosQR, cuerpo, cierre]);
  await enviarBytes(comandosFinales);
}

// Respaldo cuando no hay impresora BLE conectada o el navegador no la soporta:
// comparte el ticket como texto plano (funciona con apps como RawBT en Android,
// o simplemente para copiar/enviar por WhatsApp mientras se resuelve la impresora).
async function compartirTicketComoTexto(datosTicket) {
  const lineas = formatearTicket(datosTicket);
  const texto = lineas.join('\n');

  if (navigator.share) {
    await navigator.share({ text: texto, title: `Ticket ${datosTicket.folio}` });
  } else {
    await navigator.clipboard.writeText(texto);
    alert('Tu navegador no soporta compartir directo. El ticket se copió al portapapeles.');
  }
}
