// Módulo compartido de impresión térmica. Soporta dos transportes:
// - Bluetooth (BLE): Chrome/Edge en Android y computadora.
// - USB: Chrome/Edge en computadora (WebUSB) — ideal para impresoras USB-only
//   como la Ghia GTP58, que no tienen radio Bluetooth propio.
// Nota honesta: NO existe una tercera opción "por red/WiFi" — un navegador no
// puede abrir ese tipo de conexión directa por seguridad; requeriría una
// aplicación intermediaria corriendo en la red local, que no está construida.
//
// SOPORTE DE 2 IMPRESORAS INDEPENDIENTES POR DISPOSITIVO: un mismo Mostrador
// puede tener conectada una impresora para el ticket de venta ("ticket") y
// otra distinta para los boletos de turno ("ficha") — por ejemplo una
// impresora adentro para el ticket y otra afuera, de autoservicio, para las
// fichas. Cada canal se conecta, reconecta, y guarda su propia preferencia
// por separado — conectar una no afecta a la otra.

const SERVICIO_IMPRESORA = '000018f0-0000-1000-8000-00805f9b34fb';
const CARACTERISTICA_IMPRESORA = '00002af1-0000-1000-8000-00805f9b34fb';

function estadoInicialCanalImpresora() {
  return { dispositivoBLE: null, caracteristicaEscritura: null, dispositivoUSB: null, endpointSalidaUSB: null, transporteActivo: null };
}

const canalesImpresora = {
  ticket: estadoInicialCanalImpresora(),
  ficha: estadoInicialCanalImpresora()
};

function nombreCanal(canal) { return canal === 'ficha' ? 'de fichas' : 'de tickets'; }
function bluetoothDisponible() { return !!navigator.bluetooth; }
function usbDisponible() { return !!navigator.usb; }

// Conecta por Bluetooth — debe llamarse desde un clic directo del usuario
// (requisito de seguridad del navegador para Web Bluetooth). "canal" indica
// cuál de las 2 impresoras se está conectando: 'ticket' (por defecto) o 'ficha'.
async function conectarImpresora(canal = 'ticket') {
  if (!bluetoothDisponible()) {
    throw new Error('Este navegador no soporta Bluetooth. Usa Chrome o Edge en Android/computadora.');
  }
  const estado = canalesImpresora[canal];

  estado.dispositivoBLE = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICIO_IMPRESORA] }],
    optionalServices: [SERVICIO_IMPRESORA]
  });

  estado.dispositivoBLE.addEventListener('gattserverdisconnected', () => {
    estado.caracteristicaEscritura = null;
  });

  const servidor = await estado.dispositivoBLE.gatt.connect();
  const servicio = await servidor.getPrimaryService(SERVICIO_IMPRESORA);
  estado.caracteristicaEscritura = await servicio.getCharacteristic(CARACTERISTICA_IMPRESORA);
  estado.transporteActivo = 'bluetooth';

  localStorage.setItem(`impresora_transporte_${canal}`, 'bluetooth');
  return estado.dispositivoBLE.name || `Impresora ${nombreCanal(canal)} (Bluetooth)`;
}

// Conecta por USB — también debe llamarse desde un clic directo del usuario.
// Como no conocemos de antemano el fabricante/modelo exacto de cada impresora
// USB, se muestran TODOS los dispositivos USB conectados para que el usuario
// elija la suya (filters: [] + acceptAllDevices).
async function conectarImpresoraUSB(canal = 'ticket') {
  if (!usbDisponible()) {
    throw new Error('Este navegador no soporta USB directo. Usa Chrome o Edge en computadora.');
  }
  const estado = canalesImpresora[canal];

  estado.dispositivoUSB = await navigator.usb.requestDevice({ filters: [] });
  await estado.dispositivoUSB.open();

  if (!estado.dispositivoUSB.configuration) {
    await estado.dispositivoUSB.selectConfiguration(1);
  }

  // Busca la primera interfaz con un endpoint de salida ("OUT") — es donde
  // se envían los comandos ESC/POS a la impresora.
  let interfazEncontrada = null;
  for (const iface of estado.dispositivoUSB.configuration.interfaces) {
    const alt = iface.alternates[0];
    const endpointSalida = alt.endpoints.find(ep => ep.direction === 'out');
    if (endpointSalida) {
      interfazEncontrada = iface.interfaceNumber;
      estado.endpointSalidaUSB = endpointSalida.endpointNumber;
      break;
    }
  }
  if (interfazEncontrada === null) {
    throw new Error('No se encontró un canal de impresión en este dispositivo USB.');
  }

  await estado.dispositivoUSB.claimInterface(interfazEncontrada);
  estado.transporteActivo = 'usb';
  localStorage.setItem(`impresora_transporte_${canal}`, 'usb');
  return estado.dispositivoUSB.productName || `Impresora ${nombreCanal(canal)} (USB)`;
}

async function reconectarSiEsPosible(canal = 'ticket') {
  const estado = canalesImpresora[canal];
  if (estado.transporteActivo === 'bluetooth' && estado.dispositivoBLE && estado.dispositivoBLE.gatt && !estado.dispositivoBLE.gatt.connected) {
    const servidor = await estado.dispositivoBLE.gatt.connect();
    const servicio = await servidor.getPrimaryService(SERVICIO_IMPRESORA);
    estado.caracteristicaEscritura = await servicio.getCharacteristic(CARACTERISTICA_IMPRESORA);
  } else if (estado.transporteActivo === 'usb' && estado.dispositivoUSB && !estado.dispositivoUSB.opened) {
    await estado.dispositivoUSB.open();
  }
}

// Al cargar cualquier pantalla, intenta reconectar SOLA con el último
// dispositivo autorizado de cada canal (sin pedirle nada al usuario) — así
// no hay que tocar "Conectar" cada vez que cambias de página. Solo funciona
// si el usuario ya autorizó el dispositivo una vez antes (permiso
// persistente del navegador); si nunca lo autorizó, no hace nada.
async function intentarReconexionAutomatica(canal = 'ticket') {
  const estado = canalesImpresora[canal];
  const transporteGuardado = localStorage.getItem(`impresora_transporte_${canal}`);
  try {
    if (transporteGuardado === 'bluetooth' && bluetoothDisponible() && navigator.bluetooth.getDevices) {
      const dispositivosAutorizados = await navigator.bluetooth.getDevices();
      if (dispositivosAutorizados.length > 0) {
        estado.dispositivoBLE = dispositivosAutorizados[0];
        estado.dispositivoBLE.addEventListener('gattserverdisconnected', () => { estado.caracteristicaEscritura = null; });
        const servidor = await estado.dispositivoBLE.gatt.connect();
        const servicio = await servidor.getPrimaryService(SERVICIO_IMPRESORA);
        estado.caracteristicaEscritura = await servicio.getCharacteristic(CARACTERISTICA_IMPRESORA);
        estado.transporteActivo = 'bluetooth';
      }
    } else if (transporteGuardado === 'usb' && usbDisponible()) {
      const dispositivosAutorizados = await navigator.usb.getDevices();
      if (dispositivosAutorizados.length > 0) {
        estado.dispositivoUSB = dispositivosAutorizados[0];
        await estado.dispositivoUSB.open();
        if (!estado.dispositivoUSB.configuration) await estado.dispositivoUSB.selectConfiguration(1);
        for (const iface of estado.dispositivoUSB.configuration.interfaces) {
          const alt = iface.alternates[0];
          const endpointSalida = alt.endpoints.find(ep => ep.direction === 'out');
          if (endpointSalida) {
            await estado.dispositivoUSB.claimInterface(iface.interfaceNumber);
            estado.endpointSalidaUSB = endpointSalida.endpointNumber;
            break;
          }
        }
        estado.transporteActivo = 'usb';
      }
    }
  } catch (err) {
    // Silencioso a propósito: si falla la reconexión automática, el banner
    // de "Impresora no conectada" seguirá visible y el usuario puede
    // reconectar manualmente — no es un error que deba interrumpir la carga.
    console.warn(`Reconexión automática de impresora ${nombreCanal(canal)} no disponible:`, err.message);
  }
}

function impresoraConectada(canal = 'ticket') {
  const estado = canalesImpresora[canal];
  if (estado.transporteActivo === 'bluetooth') {
    return !!(estado.dispositivoBLE && estado.dispositivoBLE.gatt && estado.dispositivoBLE.gatt.connected && estado.caracteristicaEscritura);
  }
  if (estado.transporteActivo === 'usb') {
    return !!(estado.dispositivoUSB && estado.dispositivoUSB.opened);
  }
  return false;
}

// Envía bytes al transporte activo de un canal. Bluetooth va en trozos
// pequeños (BLE no admite paquetes grandes); USB puede enviar todo de una vez.
async function enviarBytes(bytes, canal = 'ticket') {
  const estado = canalesImpresora[canal];
  if (estado.transporteActivo === 'bluetooth') {
    const TAMANO_TROZO = 180;
    for (let i = 0; i < bytes.length; i += TAMANO_TROZO) {
      const trozo = bytes.slice(i, i + TAMANO_TROZO);
      await estado.caracteristicaEscritura.writeValueWithoutResponse(trozo);
    }
  } else if (estado.transporteActivo === 'usb') {
    await estado.dispositivoUSB.transferOut(estado.endpointSalidaUSB, bytes);
  } else {
    throw new Error(`No hay impresora ${nombreCanal(canal)} conectada.`);
  }
}

// Intenta reconectar en automático apenas se carga la página — ambos
// canales, cada uno de forma independiente.
intentarReconexionAutomatica('ticket');
intentarReconexionAutomatica('ficha');

// ---------- Impresión por red (IP), vía el intermediario local ----------
// Un navegador no puede abrir una conexión directa por IP a una impresora
// (restricción de seguridad de todos los navegadores, no solo de este
// sistema) — por eso esto pasa por un pequeño servidor que corre en una
// computadora de la misma red local ("intermediario"), que sí puede
// hacerlo. La configuración (URL del intermediario, IP y puerto de la
// impresora) es por dispositivo, igual que todo lo demás de impresión.
function configuracionRedFicha() {
  return {
    urlIntermediario: localStorage.getItem('intermediario_url_ficha') || '',
    ipImpresora: localStorage.getItem('intermediario_ip_impresora_ficha') || '',
    puertoImpresora: parseInt(localStorage.getItem('intermediario_puerto_impresora_ficha') || '9100')
  };
}

function guardarConfiguracionRedFicha(urlIntermediario, ipImpresora, puertoImpresora) {
  localStorage.setItem('intermediario_url_ficha', urlIntermediario);
  localStorage.setItem('intermediario_ip_impresora_ficha', ipImpresora);
  localStorage.setItem('intermediario_puerto_impresora_ficha', puertoImpresora || 9100);
}

async function probarIntermediarioRed(urlIntermediario) {
  const respuesta = await fetch(urlIntermediario.replace(/\/$/, ''), { method: 'GET' });
  if (!respuesta.ok) throw new Error('El intermediario respondió con un error');
  return respuesta.json();
}

async function enviarBytesPorRed(bytes, config) {
  const url = config.urlIntermediario.replace(/\/$/, '') + '/imprimir-red';
  const respuesta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip: config.ipImpresora, puerto: config.puertoImpresora, datos: Array.from(bytes) })
  });
  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    throw new Error(datos.error || 'Error al imprimir por red');
  }
}

// Abre el cajón de dinero conectado a la impresora (puerto RJ11/RJ12) usando
// el comando ESC/POS estándar. Solo funciona con impresión directa
// (Bluetooth/USB) — el método "diálogo del sistema" pasa por el driver de
// Windows y no manda comandos crudos, así que ahí no hay forma de abrirlo.
async function abrirCajonDinero() {
  if (!impresoraConectada()) {
    await reconectarSiEsPosible();
  }
  if (!impresoraConectada()) {
    throw new Error('No hay impresora conectada — el cajón se abre a través de ella. Conéctala primero.');
  }
  // ESC p m t1 t2 — comando estándar "kick out drawer" que reconocen casi
  // todas las impresoras térmicas con conector de cajón.
  const comando = new Uint8Array([0x1B, 0x70, 0x00, 0x19, 0xFA]);
  await enviarBytes(comando);
}

// Imprime una ficha de turno: solo el número, en letra gigante, sin QR ni
// detalle de productos — es un boleto de espera, no un ticket de venta.
async function imprimirFicha(numero, ancho_ticket) {
  const configRed = configuracionRedFicha();
  const usaRed = !!(configRed.urlIntermediario && configRed.ipImpresora);

  if (!usaRed) {
    if (!impresoraConectada('ficha')) {
      await reconectarSiEsPosible('ficha');
    }
    if (!impresoraConectada('ficha')) {
      throw new Error('No hay impresora de fichas conectada. Configúrala en Configuración → Impresora de Fichas.');
    }
  }

  const columnas = ancho_ticket === '58mm' ? 32 : 48;
  const centrar = (texto) => {
    const espacios = Math.max(0, Math.floor((columnas - texto.length) / 2));
    return ' '.repeat(espacios) + texto;
  };
  // El número de la ficha se imprime 4 veces más grande (ancho y alto) que
  // el texto normal — los espacios para centrarlo TAMBIÉN se imprimen a
  // ese tamaño, así que hay que calcular el centrado sobre una cuarta
  // parte de las columnas normales. Antes se centraba como si fuera texto
  // normal, y los espacios de más empujaban el número fuera del papel,
  // partiéndolo entre dos renglones.
  const centrarGrande = (texto) => {
    const columnasEfectivas = Math.max(1, Math.floor(columnas / 4));
    const espacios = Math.max(0, Math.floor((columnasEfectivas - texto.length) / 2));
    return ' '.repeat(espacios) + texto;
  };

  const ESC = 0x1B, GS = 0x1D;
  const inicializar = new Uint8Array([ESC, 0x40]);
  const numeroTexto = String(numero).padStart(3, '0');

  const comandos = bytesJuntos([
    inicializar,
    bytesConEstilo(centrar('SU TURNO'), {}),
    new Uint8Array([0x0A]),
    new Uint8Array([GS, 0x21, 0x33]), // letra muy grande (x4 alto, x4 ancho)
    new TextEncoder().encode(centrarGrande(numeroTexto) + '\n'),
    new Uint8Array([GS, 0x21, 0x00]), // tamaño normal
    new Uint8Array([0x0A]),
    bytesConEstilo(centrar('Espere a ser llamado'), {}),
    bytesDeLineas(['', '', '']),
    new Uint8Array([GS, 0x56, 0x00]) // cortar papel
  ]);

  if (usaRed) {
    await enviarBytesPorRed(comandos, configRed);
  } else {
    await enviarBytes(comandos, 'ficha');
  }
}

// Respaldo de ficha usando el diálogo de impresión del navegador (para
// cuando el dispositivo está configurado en modo "impresora del sistema").
function imprimirFichaConDialogoDelSistema(numero, ancho_ticket) {
  const anchoMM = ancho_ticket === '58mm' ? '58mm' : '80mm';
  const numeroTexto = String(numero).padStart(3, '0');

  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
    <meta charset="UTF-8">
    <title>Ficha ${numeroTexto}</title>
    <style>
      @page { size: ${anchoMM} auto; margin: 2mm; }
      body { font-family: 'Courier New', monospace; text-align: center; margin: 0; }
      .numero { font-size: 60px; font-weight: bold; margin: 10px 0; }
    </style>
    </head>
    <body>
      <div>SU TURNO</div>
      <div class="numero">${numeroTexto}</div>
      <div>Espere a ser llamado</div>
      <script>
        window.onload = () => window.print();
        window.onafterprint = () => window.close();
      <\/script>
    </body>
    </html>
  `;

  const ventana = window.open('', '_blank');
  if (!ventana) {
    throw new Error('El navegador bloqueó la ventana de impresión (popup). Permite ventanas emergentes para este sitio e intenta de nuevo.');
  }
  ventana.document.write(html);
  ventana.document.close();
}

// Comandos ESC/POS para negritas y tamaño de letra. Se usan para envolver
// líneas específicas (ej. el nombre del negocio, o el TOTAL) sin afectar el
// resto del ticket.
const ESCPOS_NEGRITA_ON = new Uint8Array([0x1B, 0x45, 0x01]);
const ESCPOS_NEGRITA_OFF = new Uint8Array([0x1B, 0x45, 0x00]);
const ESCPOS_TAMANO_GRANDE = new Uint8Array([0x1D, 0x21, 0x11]); // doble alto y ancho
const ESCPOS_TAMANO_NORMAL = new Uint8Array([0x1D, 0x21, 0x00]);

function bytesConEstilo(texto, { negrita = false, grande = false } = {}) {
  const encoder = new TextEncoder();
  const partes = [];
  if (negrita) partes.push(ESCPOS_NEGRITA_ON);
  if (grande) partes.push(ESCPOS_TAMANO_GRANDE);
  partes.push(encoder.encode(texto + '\n'));
  if (grande) partes.push(ESCPOS_TAMANO_NORMAL);
  if (negrita) partes.push(ESCPOS_NEGRITA_OFF);
  return bytesJuntos(partes);
}

// Convierte una imagen ya cargada (base64/URL) a un canvas listo para
// imprimir como logotipo, redimensionada a un ancho razonable para el papel.
function generarCanvasLogo(imagenSrc, anchoMaximoPx) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const escala = Math.min(1, anchoMaximoPx / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * escala);
      canvas.height = Math.round(img.height * escala);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error('No se pudo cargar el logotipo'));
    img.src = imagenSrc;
  });
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

// Genera un código de barras lineal (Code128) con el folio, usando la
// librería JsBarcode (cargada por separado en la página) — para lectores
// físicos básicos que solo leen códigos de barras, no QR.
function generarCanvasBarras(texto, anchoTotalPx) {
  const canvas = document.createElement('canvas');
  JsBarcode(canvas, texto, {
    format: 'CODE128',
    width: Math.max(1, Math.floor(anchoTotalPx / (texto.length * 11))),
    height: 60,
    displayValue: true,
    fontSize: 14,
    margin: 4
  });
  return canvas;
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

function formatearCuerpoTicket({ ancho_ticket, items, total, piePagina, incluirPrecioUnitario = true, descripcionCompleta = true, cliente = null, montoRecibido = null, cambio = null }) {
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
  // Corta un texto largo en varios renglones de máximo "columnas" caracteres,
  // sin partir palabras a la mitad cuando es posible.
  const envolverTexto = (texto) => {
    if (texto.length <= columnas) return [texto];
    const palabras = texto.split(' ');
    const renglones = [];
    let actual = '';
    palabras.forEach(palabra => {
      if ((actual + ' ' + palabra).trim().length > columnas) {
        if (actual) renglones.push(actual.trim());
        actual = palabra;
      } else {
        actual = (actual + ' ' + palabra).trim();
      }
    });
    if (actual) renglones.push(actual);
    return renglones;
  };

  const lineas = [''];

  if (cliente && cliente.nombre) {
    lineas.push(`Cliente: ${cliente.nombre}`);
    if (cliente.telefono) lineas.push(`Tel: ${cliente.telefono}`);
    lineas.push(separador);
  }

  items.forEach(item => {
    if (descripcionCompleta) {
      envolverTexto(item.nombre_producto).forEach(renglon => lineas.push(renglon));
    } else {
      lineas.push(item.nombre_producto.length > columnas ? item.nombre_producto.slice(0, columnas - 1) + '…' : item.nombre_producto);
    }
    if (incluirPrecioUnitario) {
      lineas.push(filaMonto(`  ${item.detalle}`, item.subtotal));
    } else {
      lineas.push(filaMonto('  ', item.subtotal));
    }
  });

  lineas.push(separador);
  // No se usa filaMonto() aquí a propósito: esa función calcula espacios
  // asumiendo que cada letra mide lo mismo, pero esta línea se imprime en
  // negritas — en varias impresoras térmicas, las negritas usan letras más
  // anchas, y ese cálculo empujaba el monto fuera del ancho físico del
  // papel (por eso "TOTAL" se veía pero el número desaparecía). Un formato
  // simple y corto como este cabe siempre, sin importar el ancho real de
  // la letra en negritas.
  lineas.push(`TOTAL: $${total}`);
  // El efectivo recibido y el cambio solo tienen sentido en pagos en
  // efectivo — si no se mandan (tarjeta, transferencia, etc.), no se
  // imprime nada de más.
  if (montoRecibido !== null) lineas.push(`Pagó con: $${montoRecibido}`);
  if (cambio !== null) lineas.push(`Cambio: $${cambio}`);
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

// Imprime un ticket completo, incluyendo QR y/o código de barras escaneable
// según la configuración. Lanza error si no hay impresora conectada — quien
// llama debe mostrar el banner de "Reconectar" en ese caso.
async function imprimirTicketBLE(datosTicket) {
  if (!impresoraConectada()) {
    await reconectarSiEsPosible();
  }
  if (!impresoraConectada()) {
    throw new Error('No hay impresora conectada. Toca "Conectar impresora" primero.');
  }

  const ESC = 0x1B;
  const inicializar = new Uint8Array([ESC, 0x40]);

  const lineasSuperiores = datosTicket.lineasSuperiores || 0;
  const lineasInferiores = datosTicket.lineasInferiores !== undefined ? datosTicket.lineasInferiores : 3;
  const espacioArriba = bytesDeLineas(new Array(lineasSuperiores).fill(''));

  // Logotipo (si se configuró uno en Configuración) — se imprime antes que todo.
  let comandosLogo = new Uint8Array(0);
  if (datosTicket.logoUrl) {
    try {
      const anchoLogoPx = datosTicket.ancho_ticket === '58mm' ? 200 : 300;
      const canvasLogo = await generarCanvasLogo(datosTicket.logoUrl, anchoLogoPx);
      comandosLogo = bytesJuntos([canvasAComandosRaster(canvasLogo), new Uint8Array([0x0A])]);
    } catch (err) {
      console.error('No se pudo imprimir el logotipo:', err.message);
    }
  }

  // Encabezado: el nombre del negocio se imprime en negritas si está
  // configurado así; el resto (dirección, teléfono, folio, fecha) normal.
  const lineasEncabezado = formatearEncabezadoTicket(datosTicket);
  const nombreEsPrimeraLinea = !!(datosTicket.negocio && datosTicket.negocio.nombre);
  const encabezado = bytesJuntos(lineasEncabezado.map((linea, idx) => {
    if (idx === 0 && nombreEsPrimeraLinea && datosTicket.negocioNegritas !== false) {
      return bytesConEstilo(linea, { negrita: true });
    }
    return bytesConEstilo(linea);
  }));

  // Cuerpo: si "tamaño de letra" es "grande", todo el cuerpo se imprime al
  // doble de tamaño. La línea de TOTAL además se pone en negritas si se
  // configuró así (independiente del tamaño).
  const letraGrande = datosTicket.tamanoLetra === 'grande';
  const lineasCuerpo = formatearCuerpoTicket({
    ...datosTicket,
    incluirPrecioUnitario: datosTicket.incluirPrecioUnitario !== false,
    descripcionCompleta: datosTicket.descripcionCompleta !== false,
    cliente: datosTicket.imprimirDatosCliente ? datosTicket.cliente : null
  });
  const cuerpoPartes = [];
  if (letraGrande) cuerpoPartes.push(ESCPOS_TAMANO_GRANDE);
  lineasCuerpo.forEach(linea => {
    const esLineaTotal = linea.trim().startsWith('TOTAL');
    if (esLineaTotal && datosTicket.totalNegritas !== false) {
      cuerpoPartes.push(ESCPOS_NEGRITA_ON, new TextEncoder().encode(linea + '\n'), ESCPOS_NEGRITA_OFF);
    } else {
      cuerpoPartes.push(new TextEncoder().encode(linea + '\n'));
    }
  });
  if (letraGrande) cuerpoPartes.push(ESCPOS_TAMANO_NORMAL);
  const cuerpo = bytesJuntos(cuerpoPartes);

  const cierre = bytesJuntos([
    bytesDeLineas(new Array(lineasInferiores).fill('')),
    new Uint8Array([0x1D, 0x56, 0x00]) // cortar papel (si la impresora lo soporta)
  ]);

  const tipoCodigo = datosTicket.tipoCodigoEscaneo || 'ninguno';
  let comandosCodigo = new Uint8Array(0);
  try {
    const anchoPx = datosTicket.ancho_ticket === '58mm' ? 240 : 350;
    const partesCodigo = [];

    if ((tipoCodigo === 'qr' || tipoCodigo === 'ambos') && typeof QRCode !== 'undefined') {
      const canvasQR = await generarCanvasQR(datosTicket.folio, anchoPx);
      partesCodigo.push(canvasAComandosRaster(canvasQR), new Uint8Array([0x0A]));
    }
    if ((tipoCodigo === 'barras' || tipoCodigo === 'ambos') && typeof JsBarcode !== 'undefined') {
      const canvasBarras = generarCanvasBarras(datosTicket.folio, anchoPx);
      partesCodigo.push(canvasAComandosRaster(canvasBarras), new Uint8Array([0x0A]));
    }
    comandosCodigo = bytesJuntos(partesCodigo);
  } catch (err) {
    console.error('No se pudo generar el código escaneable, se imprime solo el folio en texto:', err.message);
  }

  const comandosFinales = bytesJuntos([inicializar, comandosLogo, espacioArriba, encabezado, comandosCodigo, cuerpo, cierre]);
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

// Imprime usando el diálogo normal de impresión del navegador — funciona con
// CUALQUIER impresora que Windows/Mac ya tenga instalada (USB, red, la que
// sea), porque el sistema operativo maneja la comunicación, no el navegador.
// No corta el papel automáticamente, pero SÍ incluye el QR/código de barras
// como imagen (a diferencia de la versión anterior, que solo imprimía texto).
async function imprimirConDialogoDelSistema(datosTicket) {
  const anchoMM = datosTicket.ancho_ticket === '58mm' ? '58mm' : '80mm';
  const lineas = formatearTicket(datosTicket);
  const nombreEsPrimeraLinea = !!(datosTicket.negocio && datosTicket.negocio.nombre);
  const tamanoFuente = datosTicket.tamanoLetra === 'grande' ? '18px' : '11px';

  // Cada línea se envuelve individualmente para poder poner en negritas
  // solo el nombre del negocio y el TOTAL, igual que en la impresión directa.
  const lineasHtml = lineas.map((linea, idx) => {
    const esNombre = idx === 0 && nombreEsPrimeraLinea && datosTicket.negocioNegritas !== false;
    const esTotal = linea.trim().startsWith('TOTAL') && datosTicket.totalNegritas !== false;
    const contenido = linea.replace(/ /g, '&nbsp;') || '&nbsp;';
    return (esNombre || esTotal) ? `<b>${contenido}</b>` : contenido;
  }).join('<br>');

  let htmlCodigo = '';
  try {
    const anchoPx = datosTicket.ancho_ticket === '58mm' ? 240 : 350;
    const tipoCodigo = datosTicket.tipoCodigoEscaneo || 'ninguno';
    const imagenes = [];

    if ((tipoCodigo === 'qr' || tipoCodigo === 'ambos') && typeof QRCode !== 'undefined') {
      const canvasQR = await generarCanvasQR(datosTicket.folio, anchoPx);
      imagenes.push(canvasQR.toDataURL());
    }
    if ((tipoCodigo === 'barras' || tipoCodigo === 'ambos') && typeof JsBarcode !== 'undefined') {
      const canvasBarras = generarCanvasBarras(datosTicket.folio, anchoPx);
      imagenes.push(canvasBarras.toDataURL());
    }
    htmlCodigo = imagenes.map(src => `<img src="${src}" style="display:block; margin:6px auto; max-width:100%;">`).join('');
  } catch (err) {
    console.error('No se pudo generar el código escaneable para el diálogo del sistema:', err.message);
  }

  let htmlLogo = '';
  if (datosTicket.logoUrl) {
    htmlLogo = `<img src="${datosTicket.logoUrl}" style="display:block; margin:0 auto 6px; max-width:80%;">`;
  }

  const familiaFuente = datosTicket.tipoFuente === 'sans-serif' ? "'Segoe UI', Arial, sans-serif" : "'Courier New', monospace";

  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
    <meta charset="UTF-8">
    <title>Ticket ${datosTicket.folio}</title>
    <style>
      @page { size: ${anchoMM} auto; margin: 2mm; }
      body { font-family: ${familiaFuente}; font-size: ${tamanoFuente}; margin: 0; }
    </style>
    </head>
    <body>${htmlLogo}${htmlCodigo}${lineasHtml}<script>window.onload = () => window.print(); window.onafterprint = () => window.close();<\/script></body>
    </html>
  `;

  const ventana = window.open('', '_blank');
  if (!ventana) {
    throw new Error('El navegador bloqueó la ventana de impresión (popup). Permite ventanas emergentes para este sitio e intenta de nuevo.');
  }
  ventana.document.write(html);
  ventana.document.close();
}
