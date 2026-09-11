// Módulo compartido de impresión térmica por Bluetooth (BLE).
// Compatible con Chrome/Edge en Android y computadora. Safari/iOS no soporta
// Web Bluetooth — en ese caso se debe usar la opción "Compartir texto" como respaldo.

// UUIDs estándar de la mayoría de impresoras térmicas BLE económicas (perfil "escritura sin respuesta").
const SERVICIO_IMPRESORA = '000018f0-0000-1000-8000-00805f9b34fb';
const CARACTERISTICA_IMPRESORA = '00002af1-0000-1000-8000-00805f9b34fb';

let dispositivoBLE = null;
let caracteristicaEscritura = null;

function bluetoothDisponible() {
  return !!navigator.bluetooth;
}

// Conecta con la impresora — debe llamarse desde un clic directo del usuario
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

  localStorage.setItem('impresora_conectada', 'true');
  return dispositivoBLE.name || 'Impresora';
}

async function reconectarSiEsPosible() {
  if (dispositivoBLE && dispositivoBLE.gatt && !dispositivoBLE.gatt.connected) {
    const servidor = await dispositivoBLE.gatt.connect();
    const servicio = await servidor.getPrimaryService(SERVICIO_IMPRESORA);
    caracteristicaEscritura = await servicio.getCharacteristic(CARACTERISTICA_IMPRESORA);
  }
}

function impresoraConectada() {
  return !!(dispositivoBLE && dispositivoBLE.gatt && dispositivoBLE.gatt.connected && caracteristicaEscritura);
}

// Envía bytes en trozos pequeños (el Bluetooth de bajo consumo no admite paquetes grandes)
async function enviarBytes(bytes) {
  const TAMANO_TROZO = 180;
  for (let i = 0; i < bytes.length; i += TAMANO_TROZO) {
    const trozo = bytes.slice(i, i + TAMANO_TROZO);
    await caracteristicaEscritura.writeValueWithoutResponse(trozo);
  }
}

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
