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
  ficha: estadoInicialCanalImpresora(),
  etiqueta: estadoInicialCanalImpresora()
};

function nombreCanal(canal) {
  if (canal === 'ficha') return 'de fichas';
  if (canal === 'etiqueta') return 'de etiquetas';
  return 'de tickets';
}
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
intentarReconexionAutomatica('etiqueta');

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

// Misma idea que configuracionRedFicha(), pero para el canal de etiquetas
// (ej. una impresora de etiquetas tipo Torrey en red en vez de Bluetooth/USB).
function configuracionRedEtiqueta() {
  return {
    urlIntermediario: localStorage.getItem('intermediario_url_etiqueta') || '',
    ipImpresora: localStorage.getItem('intermediario_ip_impresora_etiqueta') || '',
    puertoImpresora: parseInt(localStorage.getItem('intermediario_puerto_impresora_etiqueta') || '9100')
  };
}

function guardarConfiguracionRedEtiqueta(urlIntermediario, ipImpresora, puertoImpresora) {
  localStorage.setItem('intermediario_url_etiqueta', urlIntermediario);
  localStorage.setItem('intermediario_ip_impresora_etiqueta', ipImpresora);
  localStorage.setItem('intermediario_puerto_impresora_etiqueta', puertoImpresora || 9100);
}

// ¿Este cobro lleva dinero en efectivo? Fiado, tarjeta y transferencia NO abren el cajón.
// Pago mixto lo abre solo si una parte se paga en efectivo. Efectivo, dólares, cheque y vale sí.
function cobroAbreCajon(metodo, montoEfectivo) {
  if (metodo === 'credito' || metodo === 'tarjeta' || metodo === 'transferencia') return false;
  if (metodo === 'mixto') return (parseFloat(montoEfectivo) || 0) > 0;
  return true;
}

// Abre el cajón de dinero conectado a la impresora (puerto RJ11/RJ12) con el comando
// ESC/POS estándar. Hay dos caminos, según cómo imprime ESTE equipo:
//  1) Impresora directa (Bluetooth/USB): se manda el comando por la conexión.
//  2) Programa de escritorio con impresora de Windows: se manda por el spooler de Windows
//     (compointDesktop.abrirCajon), a la misma impresora del ticket.
// Un navegador normal con impresora de Windows no puede mandar comandos crudos: ahí el cajón
// solo se abre si el driver de la impresora lo hace al imprimir (opción de Windows).
async function abrirCajonDinero() {
  const modo = localStorage.getItem('modo_impresion') || 'directo';

  if (modo !== 'sistema') {
    if (!impresoraConectada()) {
      await reconectarSiEsPosible();
    }
    if (impresoraConectada()) {
      // ESC p m t1 t2 — comando estándar "kick out drawer" que reconocen casi
      // todas las impresoras térmicas con conector de cajón.
      await enviarBytes(new Uint8Array([0x1B, 0x70, 0x00, 0x19, 0xFA]));
      return;
    }
  }

  if (escritorioDisponible()) {
    const escritorio = window.compointDesktop;
    if (typeof escritorio.abrirCajon !== 'function') {
      throw new Error('Esta versión del programa de escritorio todavía no abre la caja. Instala la versión nueva de Compoint Punto.');
    }
    const eleccion = eleccionImpresoraWindows('ticket');
    await escritorio.abrirCajon({
      impresora: (eleccion === '__predeterminada__' || eleccion === '__preguntar__') ? '' : eleccion
    });
    return;
  }

  if (modo === 'sistema') {
    throw new Error('Desde el navegador no se puede mandar la orden de abrir la caja a una impresora de Windows. Usa el programa de escritorio de Compoint Punto, o activa en las propiedades de la impresora (Windows) la opción de abrir el cajón al imprimir.');
  }
  throw new Error('No hay impresora conectada — el cajón se abre a través de ella. Conéctala primero (Configuración → Impresión de este dispositivo).');
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

// Imprime la etiqueta final de un producto pesado: nombre, peso, precio
// unitario, total y (si se pudo generar) un código de barras con el folio o
// el id del producto — pensada para pegarse en la bolsa como entrega final,
// al estilo de las etiquetas que imprimen básculas Torrey/Rhino con
// impresora de etiquetas integrada, pero generada aquí por el sistema para
// que el precio y el nombre salgan exactamente como están en Compoint.
// "ancho_etiqueta" acepta '40mm' | '50mm' | '58mm' (más angosto que un
// ticket normal, porque una etiqueta de bolsa no necesita tanto ancho).
async function imprimirEtiquetaPeso({ nombreProducto, peso, precioUnitario, subtotal, codigo, ancho_etiqueta = '50mm' }) {
  const configRed = configuracionRedEtiqueta();
  const usaRed = !!(configRed.urlIntermediario && configRed.ipImpresora);

  if (!usaRed) {
    if (!impresoraConectada('etiqueta')) {
      await reconectarSiEsPosible('etiqueta');
    }
    if (!impresoraConectada('etiqueta')) {
      throw new Error('No hay impresora de etiquetas conectada. Configúrala en Configuración → Báscula → Etiqueta final.');
    }
  }

  const columnas = ancho_etiqueta === '40mm' ? 24 : (ancho_etiqueta === '58mm' ? 32 : 28);
  const centrar = (texto) => {
    const espacios = Math.max(0, Math.floor((columnas - texto.length) / 2));
    return ' '.repeat(espacios) + texto;
  };
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

  const ESC = 0x1B, GS = 0x1D;
  const inicializar = new Uint8Array([ESC, 0x40]);

  const partes = [inicializar];
  envolverTexto(nombreProducto).forEach(renglon => {
    partes.push(bytesConEstilo(renglon, { negrita: true }));
  });
  partes.push(bytesDeLineas([
    `Peso: ${peso.toFixed(3)} kg`,
    `P/U: $${precioUnitario.toFixed(2)}`
  ]));
  partes.push(bytesConEstilo(`TOTAL: $${subtotal.toFixed(2)}`, { negrita: true }));

  // Código de barras con el id/código del producto, si se proporcionó — útil
  // para volver a escanear la bolsa en caja en vez de buscar el producto a mano.
  if (codigo && typeof JsBarcode !== 'undefined') {
    try {
      const anchoPx = ancho_etiqueta === '58mm' ? 220 : (ancho_etiqueta === '40mm' ? 160 : 190);
      const canvasBarras = generarCanvasBarras(String(codigo), anchoPx);
      partes.push(canvasAComandosRaster(canvasBarras));
    } catch (err) {
      console.error('No se pudo generar el código de barras de la etiqueta:', err.message);
    }
  }

  partes.push(new Uint8Array([0x0A, 0x0A]));
  partes.push(new Uint8Array([GS, 0x56, 0x00])); // cortar papel (si la impresora lo soporta)

  const comandos = bytesJuntos(partes);

  if (usaRed) {
    await enviarBytesPorRed(comandos, configRed);
  } else {
    await enviarBytes(comandos, 'etiqueta');
  }
}

// ---------- Impresoras instaladas en Windows (programa de escritorio) ----------
// Dentro del programa de escritorio de Compoint Punto se puede imprimir DIRECTO
// (sin diálogo) en cualquier impresora instalada en Windows. La elección se
// guarda por equipo: 'impresora_windows_ticket' / 'impresora_windows_ficha'
// = nombre exacto de la impresora, '__predeterminada__' (la predeterminada de
// Windows) o '__preguntar__' (abrir el diálogo de impresión cada vez).
// Sin elección guardada = '__predeterminada__': en el programa de escritorio
// YA NO pregunta por defecto, imprime directo en la predeterminada de Windows.
// (Un navegador normal no puede imprimir sin diálogo: ver Configuración →
// Impresión → "Imprimir sin que pregunte" para Chrome/Edge.)
function escritorioDisponible() {
  return typeof window !== 'undefined' && !!(window.compointDesktop && window.compointDesktop.esEscritorio);
}
function eleccionImpresoraWindows(canal) {
  let v = null;
  try { v = localStorage.getItem('impresora_windows_' + canal); } catch (e) { /* sin almacenamiento */ }
  return (v === null || v === '') ? '__predeterminada__' : v;
}
function usaImpresionSilenciosa(canal) {
  return escritorioDisponible() && eleccionImpresoraWindows(canal) !== '__preguntar__';
}
async function imprimirHtmlSilencioso(html, canal, anchoMM) {
  const nombre = eleccionImpresoraWindows(canal);
  await window.compointDesktop.imprimirHTML(html, {
    impresora: nombre === '__predeterminada__' ? '' : nombre,
    anchoMM: parseInt(anchoMM, 10) === 58 ? 58 : 80
  });
}
// Programa de escritorio sin nada configurado todavía (nadie eligió cómo imprimir ni
// conectó Bluetooth/USB): imprime por Windows, directo y sin preguntar.
(function modoInicialEscritorio() {
  try {
    if (escritorioDisponible() && localStorage.getItem('modo_impresion') === null
        && localStorage.getItem('impresora_transporte_ticket') === null) {
      localStorage.setItem('modo_impresion', 'sistema');
    }
  } catch (e) { /* sin almacenamiento */ }
})();
// Abre el diálogo de impresión del navegador con el HTML (método de siempre).
function abrirVentanaImpresion(html) {
  const ventana = window.open('', '_blank');
  if (!ventana) {
    throw new Error('El navegador bloqueó la ventana de impresión (popup). Permite ventanas emergentes para este sitio e intenta de nuevo.');
  }
  ventana.document.write(html);
  ventana.document.close();
}
// Intenta imprimir sin diálogo; si no se puede (o no está configurado), devuelve false.
async function intentarImpresionSilenciosa(html, canal, anchoMM) {
  if (!usaImpresionSilenciosa(canal)) return false;
  try {
    await imprimirHtmlSilencioso(html, canal, anchoMM);
    return true;
  } catch (err) {
    console.error('Impresión directa en Windows falló:', err);
    if (typeof mostrarToast === 'function') mostrarToast('No se pudo imprimir directo (' + (err.message || err) + '). Se abre el diálogo de impresión.', 'error', 6000);
    return false;
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
      <div class="numero">${escaparHtmlTicket(numeroTexto)}</div>
      <div>Espere a ser llamado</div>
      <script>
        window.onload = () => window.print();
        window.onafterprint = () => window.close();
      <\/script>
    </body>
    </html>
  `;

  // En el programa de escritorio con impresora de Windows elegida: imprime directo.
  if (usaImpresionSilenciosa('ficha')) {
    return intentarImpresionSilenciosa(html, 'ficha', anchoMM).then((ok) => { if (!ok) abrirVentanaImpresion(html); });
  }
  abrirVentanaImpresion(html);
}

// Comandos ESC/POS para negritas y tamaño de letra. Se usan para envolver
// líneas específicas (ej. el nombre del negocio, o el TOTAL) sin afectar el
// resto del ticket.
const ESCPOS_NEGRITA_ON = new Uint8Array([0x1B, 0x45, 0x01]);
const ESCPOS_NEGRITA_OFF = new Uint8Array([0x1B, 0x45, 0x00]);
const ESCPOS_TAMANO_GRANDE = new Uint8Array([0x1D, 0x21, 0x11]); // doble alto y ancho
const ESCPOS_TAMANO_NORMAL = new Uint8Array([0x1D, 0x21, 0x00]);

// ============ Diseño del ticket (todo configurable desde Configuración) ============

// Tabla de acentos para impresoras térmicas. Las impresoras NO entienden
// UTF-8 (por eso salían "jeroglíficos"): hay que mandarles cada letra con
// el número que ellas conocen (página de códigos CP858/CP850).
const TICKET_CP858 = {
  'á': 0xA0, 'í': 0xA1, 'ó': 0xA2, 'ú': 0xA3, 'ñ': 0xA4, 'Ñ': 0xA5,
  'ª': 0xA6, 'º': 0xA7, '¿': 0xA8, '¡': 0xAD, 'é': 0x82, 'ü': 0x81,
  'É': 0x90, 'Á': 0xB5, 'Í': 0xD6, 'Ó': 0xE0, 'Ú': 0xE9, 'Ü': 0x9A,
  'ç': 0x87, '°': 0xF8, '€': 0xD5, '«': 0xAE, '»': 0xAF
};

// Modo vigente para los textos de ESTA impresión: 'quitar' | 'cp858' | 'cp850'.
let ticketModoAcentos = 'quitar';

// Deja solo letras que TODA impresora imprime bien (sin acentos ni símbolos raros).
function ticketTextoSeguro(texto) {
  return String(texto)
    .replace(/¿/g, '?').replace(/¡/g, '!').replace(/…/g, '...')
    .replace(/[–—]/g, '-').replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'")
    .replace(/€/g, 'EUR')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E\n]/g, '?');
}

// Convierte texto a los bytes que la impresora entiende según el modo elegido.
function codificarTextoTicket(texto, modo) {
  modo = modo || ticketModoAcentos;
  if (modo !== 'cp858' && modo !== 'cp850') {
    return new TextEncoder().encode(ticketTextoSeguro(texto));
  }
  let s = String(texto).replace(/…/g, '...').replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/•/g, '*');
  if (modo === 'cp850') s = s.replace(/€/g, 'EUR');
  const salida = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) { salida.push(c); continue; }
    if (TICKET_CP858[ch] !== undefined) { salida.push(TICKET_CP858[ch]); continue; }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    salida.push(base && base.charCodeAt(0) < 0x80 ? base.charCodeAt(0) : 0x3F);
  }
  return new Uint8Array(salida);
}

function escposComando(arr) { return new Uint8Array(arr); }
// Tamaño de letra ESC/POS: ancho 1-8 veces, alto 1-8 veces.
function escposTamano(ancho, alto) { return escposComando([0x1D, 0x21, ((ancho - 1) << 4) | (alto - 1)]); }
const ESCPOS_CENTRAR = escposComando([0x1B, 0x61, 1]);
const ESCPOS_IZQUIERDA = escposComando([0x1B, 0x61, 0]);
const ESCPOS_FUENTE_A = escposComando([0x1B, 0x4D, 0]);
const ESCPOS_FUENTE_B = escposComando([0x1B, 0x4D, 1]);
const ESCPOS_INVERSO_ON = escposComando([0x1D, 0x42, 1]);  // letras blancas sobre fondo negro
const ESCPOS_INVERSO_OFF = escposComando([0x1D, 0x42, 0]);

// Cuántos caracteres caben por renglón según papel y tamaño de letra.
function columnasTicket(ancho, letra, paraDialogo) {
  const e58 = ancho === '58mm';
  if (letra === 'pequena') return e58 ? 42 : 64;
  if (letra === 'grande') return paraDialogo ? (e58 ? 24 : 32) : (e58 ? 32 : 48);
  return e58 ? 32 : 48;
}

// Valores por defecto de todo lo que se puede configurar en el ticket.
const TICKET_DEFECTOS = {
  mensajeSuperior: '', logoTamano: 'mediano', tamanoLetra: 'normal',
  nombreTamano: 'grande', totalTamano: 'grande', acentos: 'quitar',
  negocioNegritas: true, totalNegritas: true, productosNegritas: false, tipoFuente: 'monospace',
  qrPromo: null, textoLegal: '', facturaUrl: null, lineasSuperiores: 0, lineasInferiores: 3,
  incluirPrecioUnitario: true, descripcionCompleta: true
};

function completarDatosTicket(d) {
  const r = { ...TICKET_DEFECTOS };
  Object.keys(d).forEach(k => { if (d[k] !== undefined) r[k] = d[k]; });
  r.negocio = r.negocio || {};
  return r;
}

// Convierte la configuración guardada del negocio (tabla "configuracion") en
// las opciones de estilo que usan las funciones de impresión. Lo usan Mostrador,
// Caja y la pantalla de Configuración — así TODOS los tickets salen igual.
//   esFinal = true  → comprobante ya pagado (lleva logo y QR de promoción)
//   esFinal = false → ticket de mostrador (solo si se activó en la configuración)
// Ajustes del ticket que son SOLO de este dispositivo (se guardan en el propio
// navegador/equipo, nunca se comparten): así el celular con impresora de 58 mm
// y la computadora con impresora de 80 mm no se pisan entre sí.
function leerDisenoDispositivo() {
  try { return JSON.parse(localStorage.getItem('ticket_diseno_dispositivo') || '{}') || {}; } catch (e) { return {}; }
}

function estiloTicketDesdeConfig(config, esFinal, sinDispositivo) {
  config = config || {};
  const nombre = (config.nombre_negocio === null || config.nombre_negocio === undefined)
    ? 'Compoint Punto de Soluciones' : config.nombre_negocio;
  const mostrarQr = config.qr_promo_activo && config.qr_promo_contenido &&
    (esFinal || config.qr_promo_en_mostrador);
  const estilo = {
    negocio: { nombre, direccion: config.direccion, telefono: config.telefono, rfc: config.rfc },
    mensajeSuperior: config.mensaje_superior || '',
    logoUrl: (esFinal || config.ticket_logo_en_mostrador) ? (config.logo_url || null) : null,
    logoTamano: config.ticket_logo_tamano || 'mediano',
    tamanoLetra: config.ticket_letra || (config.tamano_letra === 'grande' ? 'grande' : 'normal'),
    nombreTamano: config.ticket_nombre_tamano || 'grande',
    totalTamano: config.ticket_total_tamano || 'grande',
    acentos: config.ticket_acentos || 'quitar',
    negocioNegritas: config.negocio_negritas !== false,
    totalNegritas: config.total_negritas !== false,
    tipoFuente: config.tipo_fuente || 'monospace',
    qrPromo: mostrarQr ? {
      contenido: config.qr_promo_contenido,
      texto: config.qr_promo_texto || '',
      tamano: config.qr_promo_tamano || 'mediano'
    } : null,
    textoLegal: esFinal ? (config.terminos || '') : '',
    // Leyenda + QR para pedir factura en línea (solo en el ticket final)
    facturaUrl: (esFinal && config.facturacion_activa !== false && config.facturacion_leyenda_ticket && typeof location !== 'undefined' && location.origin)
      ? location.origin + '/facturar.html' : null
  };

  // Lo que se haya guardado en ESTE dispositivo manda sobre el valor general del negocio.
  if (!sinDispositivo) {
    const dv = leerDisenoDispositivo();
    ['tamanoLetra', 'nombreTamano', 'totalTamano', 'acentos', 'logoTamano', 'tipoFuente'].forEach(k => { if (dv[k]) estilo[k] = dv[k]; });
    if (typeof dv.incluirPrecioUnitario === 'boolean') estilo.incluirPrecioUnitario = dv.incluirPrecioUnitario;
    if (typeof dv.descripcionCompleta === 'boolean') estilo.descripcionCompleta = dv.descripcionCompleta;
    if (typeof dv.productosNegritas === 'boolean') estilo.productosNegritas = dv.productosNegritas;
    if (estilo.qrPromo && dv.qrTamano) estilo.qrPromo.tamano = dv.qrTamano;
    const lin = esFinal ? dv.lineasFinal : dv.lineasMostrador;
    if (lin && Number.isFinite(lin.sup) && Number.isFinite(lin.inf)) { estilo.lineasSuperiores = lin.sup; estilo.lineasInferiores = lin.inf; }
  }
  return estilo;
}

// Pasa un canvas a blanco y negro puro con "tramado" (puntitos) para que un
// logotipo a color o en grises se vea bien en papel térmico.
function tramarCanvasBlancoNegro(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const viejo = g[i];
      const nuevo = viejo < 128 ? 0 : 255;
      const err = viejo - nuevo;
      g[i] = nuevo;
      if (x + 1 < w) g[i + 1] += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) g[i + w - 1] += err * 3 / 16;
        g[i + w] += err * 5 / 16;
        if (x + 1 < w) g[i + w + 1] += err * 1 / 16;
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    const v = g[i] < 128 ? 0 : 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function anchoLogoTicketPx(ancho, tamano) {
  const total = ancho === '58mm' ? 384 : 576;
  const pct = tamano === 'chico' ? 0.25 : (tamano === 'grande' ? 0.7 : 0.45);
  return Math.max(8, Math.round(total * pct / 8) * 8);
}

function anchoQrPromoPx(ancho, tamano) {
  const tabla = ancho === '58mm' ? { chico: 160, mediano: 224, grande: 288 } : { chico: 200, mediano: 280, grande: 360 };
  return tabla[tamano] || tabla.mediano;
}

// También escapa comillas: así sirve igual para texto y para atributos (src="...").
function escaparHtmlTicket(t) {
  return String(t === null || t === undefined ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function bytesConEstilo(texto, { negrita = false, grande = false } = {}) {
  const partes = [];
  if (negrita) partes.push(ESCPOS_NEGRITA_ON);
  if (grande) partes.push(ESCPOS_TAMANO_GRANDE);
  partes.push(codificarTextoTicket(texto + '\n'));
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
      resolve(tramarCanvasBlancoNegro(canvas));
    };
    img.onerror = () => reject(new Error('No se pudo cargar el logotipo'));
    img.src = imagenSrc;
  });
}

// Convierte texto a bytes ESC/POS básicos: inicializa, imprime texto, corta el papel.
function construirComandosTexto(lineas) {
  const ESC = 0x1B, GS = 0x1D;
  const partes = [new Uint8Array([ESC, 0x40])]; // inicializar impresora

  lineas.forEach(linea => {
    partes.push(codificarTextoTicket(linea + '\n'));
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
// "chico" (ticket de domicilio con ahorro de papel): barras más bajas y sin el número debajo
// (el folio ya sale escrito en el ticket), para gastar menos papel.
// "zonaBlanca" (solo tickets): deja 10 módulos en blanco a cada lado, que el lector necesita para
// encontrar dónde empieza el código. Se recorta si no cabría en el papel (58 mm = 384 puntos, 80 mm = 576).
function generarCanvasBarras(texto, anchoTotalPx, chico, zonaBlanca) {
  const canvas = document.createElement('canvas');
  const moduloPx = Math.max(1, Math.floor(anchoTotalPx / (texto.length * 11)));
  const opciones = {
    format: 'CODE128',
    width: moduloPx,
    height: chico ? 36 : 60,
    displayValue: !chico,
    fontSize: 14,
    margin: chico ? 2 : 4
  };
  if (zonaBlanca) {
    const papelPuntos = anchoTotalPx <= 240 ? 384 : 576;
    const nucleoPx = ((texto.length + 2) * 11 + 13) * moduloPx;
    const lateralPx = Math.max(4, Math.min(10 * moduloPx, Math.floor((papelPuntos - nucleoPx) / 2) - 2));
    opciones.marginLeft = lateralPx;
    opciones.marginRight = lateralPx;
  }
  JsBarcode(canvas, texto, opciones);
  return canvas;
}

// Código de barras para el ticket en HTML (impresora de Windows / navegador).
// Antes era una imagen que el navegador encogía a un tamaño "quebrado": las barras salían de grosor
// desigual y pegadas a las orillas del papel, y el lector no las leía. Ahora se dibuja como imagen
// vectorial donde cada módulo mide un número ENTERO de puntos de la impresora (3 en 80 mm), con
// 10 módulos de zona blanca a cada lado. Se mide con las mismas cuentas que usa la app de escritorio
// al convertir el ticket a puntos (576 puntos en 80 mm, 384 en 58 mm).
// El atributo data-barras lleva el patrón (1 = barra, 0 = espacio) para que la app de escritorio
// lo vuelva a dibujar exacto sobre la imagen final.
function htmlBarrasTicket(texto, opciones) {
  const { chico = false, e58 = false } = opciones || {};
  const puntos = e58 ? 384 : 576;
  const anchoPx = Math.round((e58 ? 58 : 80) * 96 / 25.4);
  const canvas = document.createElement('canvas');
  JsBarcode(canvas, String(texto), {
    format: 'CODE128', width: 1, height: 1, displayValue: false,
    margin: 0, marginLeft: 10, marginRight: 10
  });
  const M = canvas.width;
  const px = canvas.getContext('2d').getImageData(0, 0, M, 1).data;
  let patron = '', trazo = '';
  for (let x = 0; x < M; x++) patron += px[x * 4] < 128 ? '1' : '0';
  for (let x = 0; x < M; ) {
    if (patron[x] !== '1') { x++; continue; }
    let f = x;
    while (f < M && patron[f] === '1') f++;
    trazo += `M${x} 0h${f - x}v1h-${f - x}z`;
    x = f;
  }
  const k = Math.max(1, Math.min(3, Math.floor((puntos - 16) / M))); // puntos de impresora por módulo
  const anchoCss = (M * k * anchoPx / puntos).toFixed(4);
  const altoCss = chico ? 26 : 44;
  let html = `<svg class="barras" data-barras="${patron}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${M} 1" preserveAspectRatio="none" shape-rendering="crispEdges" style="display:block;margin:4px auto;width:${anchoCss}px;height:${altoCss}px;max-width:none;"><path d="${trazo}" fill="#000"/></svg>`;
  if (!chico) html += `<div class="c" style="letter-spacing:.08em;">${escaparHtmlTicket(texto)}</div>`;
  return html;
}

function bytesJuntos(listaDeArrays) {
  const total = listaDeArrays.reduce((sum, a) => sum + a.length, 0);
  const resultado = new Uint8Array(total);
  let offset = 0;
  listaDeArrays.forEach(a => { resultado.set(a, offset); offset += a.length; });
  return resultado;
}

function bytesDeLineas(lineas) {
  return bytesJuntos(lineas.map(l => codificarTextoTicket(l + '\n')));
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
  if (ticketEsPrueba()) lineas.push(centrar(TEXTO_VERSION_PRUEBA));
  lineas.push(separador);
  lineas.push(`Folio: ${folio}`);
  lineas.push(`Fecha: ${fecha}`);
  lineas.push(separador);
  return lineas;
}

// Leyenda fija de Compoint al pie de TODOS los tickets (venta, reimpresión, devolución…).
// Está escrita aquí a propósito: no se configura ni se puede quitar desde el sistema.
const LEYENDA_COMPOINT_BASE = [
  'COMPOINT PUNTO - Venta y soporte del sistema',
  'WhatsApp 33 25 90 70 90',
  'www.compoint.com.mx'
];
// Durante la prueba gratis TODOS los tickets llevan la leyenda «VERSIÓN DE PRUEBA»
// (arriba, al pie y como marca de agua en la impresión del sistema). Se quita sola al activar la licencia.
const TEXTO_VERSION_PRUEBA = '*** VERSIÓN DE PRUEBA ***';
function ticketEsPrueba() { return typeof licenciaEsPrueba === 'function' && licenciaEsPrueba(); }
function leyendaCompoint() { return ticketEsPrueba() ? [TEXTO_VERSION_PRUEBA, ...LEYENDA_COMPOINT_BASE] : LEYENDA_COMPOINT_BASE; }

// Opciones del ticket de domicilio (ver js/mostrador-pedidos.js):
//   productoUnaLinea → "1.500 kg Queso Oaxaca ........ $270.00" en un solo renglón
//   ticketCompacto   → sin los renglones en blanco de arriba y de abajo
//   (sin precio unitario, los pedidos siguen mostrando la cantidad: item.cantidad_texto)
function formatearCuerpoTicket({ ancho_ticket, columnas: columnasForzadas, items, total, piePagina, textoLegal = '', incluirPrecioUnitario = true, descripcionCompleta = true, cliente = null, montoRecibido = null, cambio = null, productoUnaLinea = false, ticketCompacto = false }) {
  const columnas = columnasForzadas || (ancho_ticket === '58mm' ? 32 : 48);
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
  // sin partir palabras a la mitad cuando es posible. Respeta los saltos de
  // línea que el usuario escribió.
  const envolverTexto = (texto) => String(texto).split('\n').flatMap(parte => {
    if (parte.length <= columnas) return [parte];
    const renglones = [];
    let actual = '';
    parte.split(' ').forEach(palabra => {
      while (palabra.length > columnas) {
        if (actual) { renglones.push(actual); actual = ''; }
        renglones.push(palabra.slice(0, columnas));
        palabra = palabra.slice(columnas);
      }
      if ((actual + ' ' + palabra).trim().length > columnas) {
        if (actual) renglones.push(actual.trim());
        actual = palabra;
      } else {
        actual = (actual + ' ' + palabra).trim();
      }
    });
    if (actual) renglones.push(actual);
    return renglones;
  });

  const lineas = ticketCompacto ? [] : [''];

  if (cliente && cliente.nombre) {
    lineas.push(`Cliente: ${cliente.nombre}`);
    if (cliente.telefono) lineas.push(`Tel: ${cliente.telefono}`);
    lineas.push(separador);
  }

  items.forEach(item => {
    const cant = item.cantidad_texto || '';
    if (productoUnaLinea) {
      // Cantidad + nombre a la izquierda e importe a la derecha, en un solo renglón (si cabe).
      const izq = (cant ? cant + ' ' : '') + item.nombre_producto;
      const monto = `$${item.subtotal}`;
      const partes = descripcionCompleta ? envolverTexto(izq) : [izq.length > columnas ? izq.slice(0, columnas - 1) + '.' : izq];
      const ultimo = partes[partes.length - 1];
      partes.slice(0, -1).forEach(renglon => lineas.push(renglon));
      if (ultimo.length + 1 + monto.length <= columnas) lineas.push(ultimo + ' '.repeat(columnas - ultimo.length - monto.length) + monto);
      else { lineas.push(ultimo); lineas.push(filaMonto('  ', item.subtotal)); }
      return;
    }
    if (descripcionCompleta) {
      envolverTexto(item.nombre_producto).forEach(renglon => lineas.push(renglon));
    } else {
      lineas.push(item.nombre_producto.length > columnas ? item.nombre_producto.slice(0, columnas - 1) + '.' : item.nombre_producto);
    }
    if (incluirPrecioUnitario && item.detalle) {
      lineas.push(filaMonto(`  ${item.detalle}`, item.subtotal));
    } else if (cant) {
      lineas.push(filaMonto(`  ${cant}`, item.subtotal)); // sin precio unitario, pero sin perder cuánto lleva
    } else {
      lineas.push(filaMonto('  ', item.subtotal));
    }
  });

  lineas.push(separador);
  // Esta línea la reconocen las funciones de impresión (empieza con "TOTAL")
  // para imprimirla con el tamaño y negritas que se eligieron.
  lineas.push(`TOTAL: $${total}`);
  // El efectivo recibido y el cambio solo tienen sentido en pagos en
  // efectivo — si no se mandan (tarjeta, transferencia, etc.), no se
  // imprime nada de más.
  if (montoRecibido !== null) lineas.push(`Pagó con: $${montoRecibido}`);
  if (cambio !== null) lineas.push(`Cambio: $${cambio}`);
  lineas.push(separador);

  if (piePagina) envolverTexto(piePagina).forEach(r => lineas.push(centrar(r)));
  if (textoLegal) {
    lineas.push('');
    envolverTexto(textoLegal).forEach(r => lineas.push(centrar(r)));
  }
  if (!ticketCompacto) lineas.push('');
  return lineas;
}

// Mantiene compatibilidad con quien todavía use formatearTicket() completo
// (ej. el respaldo de texto compartido, que no imprime imagen QR).
function formatearTicket(datosTicket) {
  const cols = datosTicket.ancho_ticket === '58mm' ? 32 : 48;
  const centrarL = (t) => ' '.repeat(Math.max(0, Math.floor((cols - t.length) / 2))) + t;
  return [...formatearEncabezadoTicket(datosTicket), ...formatearCuerpoTicket(datosTicket), '='.repeat(cols), ...leyendaCompoint().map(centrarL), ''];
}

// ---------------------------------------------------------------------------
// Ticket de un PEDIDO que ya quedó listo en Mostrador. Además de lo normal lleva los datos del
// cliente en letra grande (los arma js/mostrador-pedidos.js en "datosTicket.pedido"):
//   { titulo, subtitulo, entrega:{etiqueta,valor}, datos:[{etiqueta,lineas,grande}],
//     cobro:{titulo,monto,detalle}, notas, pie:[...] }
// "arriba" va después del folio y la fecha; "abajo" después del total. Solo texto sencillo
// (sin emojis ni símbolos raros, la impresora no los dibuja).
// ---------------------------------------------------------------------------
function bloquePedidoEscPos(d, parte, { linea, envolver }) {
  const p = d.pedido, out = [];
  if (!p) return out;
  const cn = columnasTicket(d.ancho_ticket, 'normal', false);
  const w2 = Math.floor(cn / 2);
  const negrita = ESCPOS_NEGRITA_ON, sinNegrita = ESCPOS_NEGRITA_OFF;
  const grande = (t) => { out.push(escposTamano(2, 2), negrita); envolver(t, w2).forEach(r => out.push(linea(r))); out.push(sinNegrita, escposTamano(1, 1)); };
  const alto = (t) => { out.push(escposTamano(1, 2), negrita); envolver(t, cn).forEach(r => out.push(linea(r))); out.push(sinNegrita, escposTamano(1, 1)); };
  const etiqueta = (t) => out.push(negrita, linea(t), sinNegrita);
  const raya = (c) => out.push(linea(c.repeat(cn)));
  const centrarEn = (t, w) => { const f = Math.max(0, w - t.length); const i = Math.floor(f / 2); return ' '.repeat(i) + t + ' '.repeat(f - i); };
  const normal = (t) => { out.push(negrita); envolver(t, cn).forEach(r => out.push(linea(r))); out.push(sinNegrita); };
  // Cómo se dibuja (Configuración → Ticket de domicilio). Sin "formato" sale como siempre.
  const f = p.formato || {};
  const adornos = f.adornos !== false;

  out.push(ESCPOS_FUENTE_A);
  if (parte === 'arriba') {
    out.push(ESCPOS_CENTRAR);
    if (f.tituloUna) { const t = [p.titulo, p.subtitulo].filter(Boolean).join(' - '); if (t) alto(t); }
    else { if (p.titulo) grande(p.titulo); if (p.subtitulo) grande(p.subtitulo); }
    if (p.entrega) {
      if (!f.entrega || f.entrega === 'recuadro') { raya('='); envolver(p.entrega.etiqueta, cn).forEach(r => out.push(negrita, linea(r), sinNegrita)); grande(p.entrega.valor); raya('='); }
      else { const t = `${p.entrega.etiqueta} ${p.entrega.valor}`.trim(); if (f.entrega === 'grande') grande(t); else normal(t); }
    }
    out.push(ESCPOS_IZQUIERDA);
    (p.datos || []).forEach(dt => {
      if (dt.etiqueta) etiqueta(dt.etiqueta);
      const tam = dt.tam || (dt.grande ? 'grande' : 'alto');
      (dt.lineas || []).forEach(l => (tam === 'grande' ? grande(l) : tam === 'alto' ? alto(l) : normal(l)));
    });
    raya('-');
    if (adornos) etiqueta('PRODUCTOS');
  } else {
    out.push(ESCPOS_IZQUIERDA);
    if (p.cobro) {
      // Recuadro negro de lado a lado: se rellena cada renglón con espacios porque lo invertido solo pinta donde hay letras.
      out.push(ESCPOS_INVERSO_ON, negrita);
      if (f.cobro === 'linea') {
        // Ahorro de papel: "COBRAR AL RECIBIR $496.00" en un renglón (y abajo con cuánto paga, si lo hay)
        out.push(escposTamano(1, 2));
        envolver(p.cobro.titulo + (p.cobro.monto ? ' $' + p.cobro.monto : ''), cn).forEach(r => out.push(linea(centrarEn(r, cn))));
        out.push(escposTamano(1, 1));
      } else {
        envolver(p.cobro.titulo, cn).forEach(r => out.push(linea(centrarEn(r, cn))));
        if (p.cobro.monto) { out.push(escposTamano(2, 2)); envolver('$' + p.cobro.monto, w2).forEach(r => out.push(linea(centrarEn(r, w2)))); out.push(escposTamano(1, 1)); }
      }
      if (p.cobro.detalle) envolver(p.cobro.detalle, cn).forEach(r => out.push(linea(centrarEn(r, cn))));
      out.push(sinNegrita, ESCPOS_INVERSO_OFF);
    }
    if (p.notas) { if (adornos) { etiqueta('NOTAS DEL PEDIDO'); alto(p.notas); } else normal('NOTA: ' + p.notas); }
    if (adornos) raya('-');
    (p.pie || []).forEach(t => { out.push(ESCPOS_CENTRAR); envolver(t, cn).forEach(r => out.push(linea(r))); });
    out.push(ESCPOS_IZQUIERDA);
  }
  return out;
}

// Lo mismo, para el ticket que se imprime con el diálogo del sistema (HTML).
function bloquePedidoHtml(d, parte, esc) {
  const p = d.pedido;
  if (!p) return '';
  const lineasHtml = (ls, clase) => (ls || []).map(l => `<div class="${clase}">${esc(l)}</div>`).join('');
  const f = p.formato || {};
  const adornos = f.adornos !== false;
  if (parte === 'arriba') {
    let h = '';
    if (f.tituloUna) { const t = [p.titulo, p.subtitulo].filter(Boolean).join(' - '); if (t) h += `<div class="pd-t una">${esc(t)}</div>`; }
    else {
      if (p.titulo) h += `<div class="pd-t">${esc(p.titulo)}</div>`;
      if (p.subtitulo) h += `<div class="pd-t">${esc(p.subtitulo)}</div>`;
    }
    if (p.entrega) {
      if (!f.entrega || f.entrega === 'recuadro') h += `<div class="pd-caja"><div class="e">${esc(p.entrega.etiqueta)}</div><div class="v">${esc(p.entrega.valor)}</div></div>`;
      else h += `<div class="${f.entrega === 'grande' ? 'pd-t' : 'pd-n c'}">${esc(`${p.entrega.etiqueta} ${p.entrega.valor}`.trim())}</div>`;
    }
    (p.datos || []).forEach(dt => {
      const clase = { grande: 'pd-g', alto: 'pd-m', normal: 'pd-n' }[dt.tam || (dt.grande ? 'grande' : 'alto')] || 'pd-m';
      if (dt.etiqueta) h += `<div class="pd-et">${esc(dt.etiqueta)}</div>`;
      h += lineasHtml(dt.lineas, clase);
    });
    h += `<div class="pd-raya"></div>${adornos ? '<div class="pd-et" style="margin-top:0">PRODUCTOS</div>' : ''}`;
    return h;
  }
  let h = '';
  if (p.cobro) {
    if (f.cobro === 'linea') {
      h += `<div class="pd-linea">${esc(p.cobro.titulo + (p.cobro.monto ? ' $' + p.cobro.monto : ''))}${p.cobro.detalle ? `<div class="d">${esc(p.cobro.detalle)}</div>` : ''}</div>`;
    } else {
      h += `<div class="pd-caja pd-cobro"><div class="e">${esc(p.cobro.titulo)}</div>${p.cobro.monto ? `<div class="v">$${esc(p.cobro.monto)}</div>` : ''}${p.cobro.detalle ? `<div class="e">${esc(p.cobro.detalle)}</div>` : ''}</div>`;
    }
  }
  if (p.notas) h += adornos ? `<div class="pd-et">NOTAS DEL PEDIDO</div><div class="pd-m">${esc(p.notas)}</div>` : `<div class="pd-n">${esc('NOTA: ' + p.notas)}</div>`;
  if (adornos) h += '<div class="pd-raya"></div>';
  h += (p.pie || []).map(t => `<div class="c">${esc(t)}</div>`).join('');
  return h;
}

// Imprime un ticket completo (logo, nombre, datos, código del folio, productos,
// total, QR de promoción) con todo el diseño elegido en Configuración. Lanza
// error si no hay impresora conectada — quien llama debe mostrar el banner de
// "Reconectar" en ese caso.
async function imprimirTicketBLE(datosTicket) {
  if (!impresoraConectada()) {
    await reconectarSiEsPosible();
  }
  if (!impresoraConectada()) {
    throw new Error('No hay impresora conectada. Toca "Conectar impresora" primero.');
  }
  await enviarBytes(await construirBytesTicketBLE(datosTicket));
}

// Largo aproximado (en cm) de lo que imprime un ticket ya armado en bytes ESC/POS: cada renglón
// avanza 30 puntos (más 24 por cada vez que la letra es más alta) y las imágenes avanzan su alto.
// La impresora térmica trae 203 puntos por pulgada.
function estimarLargoTicketCm(bytes) {
  let puntos = 0, altoLetra = 1;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x1B && bytes[i + 1] === 0x40) { altoLetra = 1; i += 1; continue; }                          // reiniciar
    if (b === 0x1D && bytes[i + 1] === 0x21) { altoLetra = (bytes[i + 2] & 0x0F) + 1; i += 2; continue; }  // tamaño de letra
    if (b === 0x1D && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {                                   // imagen: m xL xH yL yH + datos
      const ancho = bytes[i + 4] + bytes[i + 5] * 256, alto = bytes[i + 6] + bytes[i + 7] * 256;
      puntos += alto; i += 7 + ancho * alto; continue;
    }
    if (b === 0x1D && bytes[i + 1] === 0x56) { i += 2; continue; }                                         // corte
    if (b === 0x1D && bytes[i + 1] === 0x42) { i += 2; continue; }                                         // inverso
    if (b === 0x1B && (bytes[i + 1] === 0x45 || bytes[i + 1] === 0x61 || bytes[i + 1] === 0x4D || bytes[i + 1] === 0x74)) { i += 2; continue; }
    if (b === 0x0A) puntos += 30 + 24 * (altoLetra - 1);
  }
  return Math.round((puntos / 203) * 2.54 * 10) / 10;
}

// Arma TODO lo que se manda a la impresora (sin mandarlo). Lo usa imprimirTicketBLE y la vista previa
// de Configuración (para decir cuánto papel gasta un ticket).
async function construirBytesTicketBLE(datosTicket) {
  const d = completarDatosTicket(datosTicket);
  ticketModoAcentos = d.acentos;
  const ESC = 0x1B;
  const columnas = columnasTicket(d.ancho_ticket, d.tamanoLetra, false);
  const linea = (t) => codificarTextoTicket(t + '\n', d.acentos);
  const salto = escposComando([0x0A]);
  const negritaOn = ESCPOS_NEGRITA_ON, negritaOff = ESCPOS_NEGRITA_OFF;

  // Parte un texto largo en renglones de máximo "ancho" caracteres.
  const envolver = (texto, ancho) => String(texto).split('\n').flatMap(parte => {
    if (parte.length <= ancho) return [parte];
    const r = []; let actual = '';
    parte.split(' ').forEach(p => {
      while (p.length > ancho) { if (actual) { r.push(actual); actual = ''; } r.push(p.slice(0, ancho)); p = p.slice(ancho); }
      if ((actual + ' ' + p).trim().length > ancho) { if (actual) r.push(actual.trim()); actual = p; }
      else actual = (actual + ' ' + p).trim();
    });
    if (actual) r.push(actual);
    return r;
  });

  const partes = [escposComando([ESC, 0x40])]; // inicializar
  if (d.acentos === 'cp858') partes.push(escposComando([ESC, 0x74, 19]));
  else if (d.acentos === 'cp850') partes.push(escposComando([ESC, 0x74, 2]));

  partes.push(bytesDeLineas(new Array(d.lineasSuperiores || 0).fill('')));

  // ---- Encabezado centrado: logo, nombre, mensaje, dirección, teléfono, RFC ----
  partes.push(ESCPOS_CENTRAR, ESCPOS_FUENTE_A);

  if (d.logoUrl) {
    try {
      const canvasLogo = await generarCanvasLogo(d.logoUrl, anchoLogoTicketPx(d.ancho_ticket, d.logoTamano));
      partes.push(canvasAComandosRaster(canvasLogo), salto);
    } catch (err) {
      console.error('No se pudo imprimir el logotipo:', err.message);
    }
  }

  const nombre = d.negocio.nombre;
  if (nombre) {
    const grande = d.nombreTamano === 'grande';
    if (d.negocioNegritas) partes.push(negritaOn);
    if (grande) partes.push(escposTamano(2, 2));
    envolver(nombre, grande ? Math.floor(columnasTicket(d.ancho_ticket, 'normal', false) / 2) : columnasTicket(d.ancho_ticket, 'normal', false))
      .forEach(r => partes.push(linea(r)));
    if (grande) partes.push(escposTamano(1, 1));
    if (d.negocioNegritas) partes.push(negritaOff);
  }

  partes.push(d.tamanoLetra === 'pequena' ? ESCPOS_FUENTE_B : ESCPOS_FUENTE_A);
  const datosNegocio = [];
  if (d.mensajeSuperior) datosNegocio.push(d.mensajeSuperior);
  if (d.negocio.direccion) datosNegocio.push(d.negocio.direccion);
  if (d.negocio.telefono) datosNegocio.push(`Tel: ${d.negocio.telefono}`);
  if (d.negocio.rfc) datosNegocio.push(`RFC: ${d.negocio.rfc}`);
  datosNegocio.forEach(t => envolver(t, columnas).forEach(r => partes.push(linea(r))));
  if (ticketEsPrueba()) partes.push(negritaOn, linea(TEXTO_VERSION_PRUEBA), negritaOff);

  // ---- Folio y fecha (alineados a la izquierda) ----
  const separador = '-'.repeat(columnas);
  partes.push(ESCPOS_IZQUIERDA, linea(separador));
  if (d.folioUnaLinea) envolver(`Folio: ${d.folio}   ${d.fecha}`, columnas).forEach(r => partes.push(linea(r)));   // ahorro de papel: un renglón
  else partes.push(linea(`Folio: ${d.folio}`), linea(`Fecha: ${d.fecha}`));
  partes.push(linea(separador));

  // ---- Pedido listo: título, hora de entrega y datos del cliente en letra grande ----
  if (d.pedido) {
    partes.push(...bloquePedidoEscPos(d, 'arriba', { linea, envolver }));
    partes.push(d.tamanoLetra === 'pequena' ? ESCPOS_FUENTE_B : ESCPOS_FUENTE_A);
  }

  // ---- Código del folio (QR y/o barras) para que Caja lo escanee ----
  // (en el ticket de un pedido el código de barras va al final, ver más abajo)
  try {
    const tipoCodigo = d.codigoAlFinal ? 'ninguno' : (d.tipoCodigoEscaneo || 'ninguno');
    const anchoPx = d.ancho_ticket === '58mm' ? 240 : 350;
    const partesCodigo = [];
    if ((tipoCodigo === 'qr' || tipoCodigo === 'ambos') && typeof QRCode !== 'undefined') {
      partesCodigo.push(canvasAComandosRaster(await generarCanvasQR(d.folio, anchoPx)), salto);
    }
    if ((tipoCodigo === 'barras' || tipoCodigo === 'ambos') && typeof JsBarcode !== 'undefined') {
      partesCodigo.push(canvasAComandosRaster(generarCanvasBarras(d.folio, anchoPx, false, true)), salto);
    }
    if (partesCodigo.length) partes.push(ESCPOS_CENTRAR, ...partesCodigo, ESCPOS_IZQUIERDA);
  } catch (err) {
    console.error('No se pudo generar el código escaneable, se imprime solo el folio en texto:', err.message);
  }

  // ---- Productos, total, pie ----
  const lineasCuerpo = formatearCuerpoTicket({
    ...d, columnas,
    cliente: d.imprimirDatosCliente ? d.cliente : null
  });
  const bodyGrande = d.tamanoLetra === 'grande';
  const tamanoCuerpo = bodyGrande ? escposTamano(1, 2) : escposTamano(1, 1);
  partes.push(tamanoCuerpo);
  lineasCuerpo.forEach(l => {
    if (l.trim().startsWith('TOTAL')) {
      const etiqueta = 'TOTAL', monto = `$${d.total}`;
      const grande = d.totalTamano === 'grande';
      // Letra doble (ancho y alto) si cabe; si no, solo doble alto.
      const dobleAncho = grande && (etiqueta.length + monto.length + 1) <= Math.floor(columnas / 2);
      const anchoReal = dobleAncho ? Math.floor(columnas / 2) : columnas;
      const texto = etiqueta + ' '.repeat(Math.max(1, anchoReal - etiqueta.length - monto.length)) + monto;
      if (d.totalNegritas) partes.push(negritaOn);
      partes.push(grande ? escposTamano(dobleAncho ? 2 : 1, 2) : escposTamano(1, 1), linea(texto), tamanoCuerpo);
      if (d.totalNegritas) partes.push(negritaOff);
    } else if (d.productosNegritas) {
      partes.push(negritaOn, linea(l), negritaOff);
    } else {
      partes.push(linea(l));
    }
  });
  partes.push(escposTamano(1, 1), ESCPOS_FUENTE_A);

  // ---- Pedido listo: cobro, notas y, al final, el código de barras del folio (Caja lo escanea) ----
  if (d.pedido) partes.push(...bloquePedidoEscPos(d, 'abajo', { linea, envolver }));
  if (d.codigoAlFinal && d.folio && typeof JsBarcode !== 'undefined') {
    try {
      const anchoBarrasPx = d.ancho_ticket === '58mm' ? 240 : 350;
      const chico = !!(d.pedido && d.pedido.formato && d.pedido.formato.barras === 'chico');
      partes.push(ESCPOS_CENTRAR, canvasAComandosRaster(generarCanvasBarras(d.folio, anchoBarrasPx, chico, true)), salto, ESCPOS_IZQUIERDA);
    } catch (err) {
      console.error('No se pudo generar el código de barras, se imprime solo el folio en texto:', err.message);
    }
  }

  // ---- QR de promoción (ej. descuentos, redes sociales, catálogo) ----
  if (d.qrPromo && d.qrPromo.contenido && typeof QRCode !== 'undefined') {
    try {
      const canvasPromo = await generarCanvasQR(d.qrPromo.contenido, anchoQrPromoPx(d.ancho_ticket, d.qrPromo.tamano));
      partes.push(ESCPOS_CENTRAR);
      if (d.qrPromo.texto) {
        partes.push(negritaOn);
        envolver(d.qrPromo.texto, columnasTicket(d.ancho_ticket, 'normal', false)).forEach(r => partes.push(linea(r)));
        partes.push(negritaOff);
      }
      partes.push(canvasAComandosRaster(canvasPromo), salto, ESCPOS_IZQUIERDA);
    } catch (err) {
      console.error('No se pudo imprimir el QR de promoción:', err.message);
    }
  }

  // ---- Facturación en línea: leyenda + QR con el folio ya escrito ----
  if (d.facturaUrl && typeof QRCode !== 'undefined') {
    try {
      const enlaceCorto = d.facturaUrl.replace(/^https?:\/\//, '');
      const canvasFactura = await generarCanvasQR(`${d.facturaUrl}?folio=${encodeURIComponent(d.folio)}`, anchoQrPromoPx(d.ancho_ticket, 'mediano'));
      const colsN = columnasTicket(d.ancho_ticket, 'normal', false);
      partes.push(ESCPOS_CENTRAR, negritaOn, linea('SOLICITA TU FACTURA'), negritaOff);
      envolver(`Escanea el codigo o entra a ${enlaceCorto}`, colsN).forEach(r => partes.push(linea(r)));
      envolver(`Folio: ${d.folio}   Total: $${d.total}`, colsN).forEach(r => partes.push(linea(r)));
      partes.push(canvasAComandosRaster(canvasFactura), salto, ESCPOS_IZQUIERDA);
    } catch (err) {
      console.error('No se pudo imprimir el QR de facturación:', err.message);
    }
  }

  // ---- Leyenda fija de Compoint (negritas, centrada) ----
  partes.push(ESCPOS_CENTRAR, linea('='.repeat(columnas)), negritaOn);
  leyendaCompoint().forEach(t => envolver(t, columnas).forEach(r => partes.push(linea(r))));
  partes.push(negritaOff, ESCPOS_IZQUIERDA);

  // ---- Cierre: espacio y corte ----
  partes.push(
    bytesDeLineas(new Array(d.lineasInferiores !== undefined ? d.lineasInferiores : 3).fill('')),
    escposComando([0x1D, 0x56, 0x00]) // cortar papel (si la impresora lo soporta)
  );

  return bytesJuntos(partes);
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

// Arma el HTML del ticket (el mismo para el diálogo de impresión del sistema
// y para la vista previa de Configuración). Devuelve { css, html } — el CSS
// va con la clase ".tk" para no chocar con el resto de la página.
async function construirHtmlTicket(datosTicket) {
  const d = completarDatosTicket(datosTicket);
  const e58 = d.ancho_ticket === '58mm';
  const columnas = columnasTicket(d.ancho_ticket, d.tamanoLetra, true);
  const utilPx = e58 ? 204 : 287; // ancho útil del papel en pixeles
  const fuentePx = Math.floor((utilPx / (columnas * 0.6)) * 10) / 10;
  const familia = d.tipoFuente === 'sans-serif' ? "'Segoe UI', Arial, sans-serif" : "'Courier New', monospace";
  const esc = escaparHtmlTicket;

  const css = `
    .tk { font-family: ${familia}; font-size: ${fuentePx}px; line-height: 1.25; color: #000; background: #fff; }
    .tk .c { text-align: center; }
    .tk .l { white-space: pre; }
    .tk .l.p { font-weight: ${d.productosNegritas ? 700 : 400}; }
    .tk .nombre { font-weight: ${d.negocioNegritas ? 700 : 400}; font-size: ${(fuentePx * (d.nombreTamano === 'grande' ? 1.9 : 1)).toFixed(1)}px; line-height: 1.15; margin: 2px 0; }
    .tk .total { display: flex; justify-content: space-between; font-weight: ${d.totalNegritas ? 700 : 400}; font-size: ${(fuentePx * (d.totalTamano === 'grande' ? 1.6 : 1)).toFixed(1)}px; margin: 2px 0; }
    .tk img { display: block; margin: 4px auto; max-width: 100%; }
    /* Ticket de un pedido listo: datos del cliente grandes y en negritas */
    .tk .pd-t { text-align: center; font-weight: 900; font-size: ${(fuentePx * 1.9).toFixed(1)}px; line-height: 1.1; margin: 2px 0; word-break: break-word; }
    .tk .pd-caja { border: 3px solid #000; text-align: center; padding: 4px 5px; margin: 6px 0; }
    .tk .pd-caja .e { font-weight: 800; word-break: break-word; }
    .tk .pd-caja .v { font-weight: 900; font-size: ${(fuentePx * 1.9).toFixed(1)}px; line-height: 1.1; word-break: break-word; }
    .tk .pd-cobro { border-width: 5px; border-style: double; }
    .tk .pd-et { font-weight: 800; font-size: ${(fuentePx * 0.85).toFixed(1)}px; letter-spacing: .06em; margin-top: 6px; }
    .tk .pd-g { font-weight: 900; font-size: ${(fuentePx * 1.45).toFixed(1)}px; line-height: 1.15; word-break: break-word; }
    .tk .pd-m { font-weight: 800; font-size: ${(fuentePx * 1.15).toFixed(1)}px; line-height: 1.2; word-break: break-word; }
    .tk .pd-raya { border-top: 2px dashed #000; margin: 6px 0; }
    .tk .pd-t.una { font-size: ${(fuentePx * 1.3).toFixed(1)}px; }
    .tk .pd-n { font-weight: 800; word-break: break-word; }
    .tk .pd-linea { border: 2px solid #000; text-align: center; font-weight: 900; font-size: ${(fuentePx * 1.2).toFixed(1)}px; padding: 1px 3px; margin: 3px 0; word-break: break-word; }
    .tk .pd-linea .d { font-size: ${fuentePx.toFixed(1)}px; font-weight: 800; }
    .tk .l.w { white-space: pre-wrap; }
    .tk { position: relative; overflow: hidden; }
    .tk .marca-prueba { position: absolute; left: -20%; right: -20%; top: 38%; text-align: center; transform: rotate(-20deg); font-family: Arial, sans-serif; font-weight: 900; font-size: ${(fuentePx * 2.1).toFixed(1)}px; letter-spacing: 2px; color: rgba(0,0,0,.14); pointer-events: none; white-space: nowrap; }
  `;

  const partes = [];

  if (d.logoUrl) {
    const pct = d.logoTamano === 'chico' ? 28 : (d.logoTamano === 'grande' ? 75 : 50);
    // La dirección del logo se escapa: si trajera comillas podría meter código en la ventana de impresión.
    partes.push(`<img src="${esc(d.logoUrl)}" style="width:${pct}%;">`);
  }
  if (d.negocio.nombre) partes.push(`<div class="c nombre">${esc(d.negocio.nombre)}</div>`);
  const datosNegocio = [];
  if (d.mensajeSuperior) datosNegocio.push(d.mensajeSuperior);
  if (d.negocio.direccion) datosNegocio.push(d.negocio.direccion);
  if (d.negocio.telefono) datosNegocio.push(`Tel: ${d.negocio.telefono}`);
  if (d.negocio.rfc) datosNegocio.push(`RFC: ${d.negocio.rfc}`);
  datosNegocio.forEach(t => partes.push(`<div class="c">${esc(t)}</div>`));
  if (ticketEsPrueba()) partes.push(`<div class="c" style="font-weight:800;">${esc(TEXTO_VERSION_PRUEBA)}</div>`);

  const sep = '-'.repeat(columnas);
  partes.push(d.folioUnaLinea
    ? `<div class="l w">${sep}\nFolio: ${esc(d.folio)}   ${esc(d.fecha)}\n${sep}</div>`
    : `<div class="l">${sep}\nFolio: ${esc(d.folio)}\nFecha: ${esc(d.fecha)}\n${sep}</div>`);

  // Pedido listo: título, hora de entrega y datos del cliente en letra grande
  if (d.pedido) partes.push(bloquePedidoHtml(d, 'arriba', esc));

  // Código del folio (QR y/o barras). En el ticket de un pedido el de barras va al final.
  try {
    const tipoCodigo = d.codigoAlFinal ? 'ninguno' : (d.tipoCodigoEscaneo || 'ninguno');
    if ((tipoCodigo === 'qr' || tipoCodigo === 'ambos') && typeof QRCode !== 'undefined') {
      partes.push(`<img src="${(await generarCanvasQR(d.folio, 240)).toDataURL()}" style="width:55%;">`);
    }
    if ((tipoCodigo === 'barras' || tipoCodigo === 'ambos') && typeof JsBarcode !== 'undefined') {
      partes.push(htmlBarrasTicket(d.folio, { e58 }));
    }
  } catch (err) {
    console.error('No se pudo generar el código escaneable:', err.message);
  }

  // Productos, total y pie
  const lineasCuerpo = formatearCuerpoTicket({ ...d, columnas, cliente: d.imprimirDatosCliente ? d.cliente : null });
  let buffer = [];
  const vaciar = () => { if (buffer.length) { partes.push(`<div class="l p">${esc(buffer.join('\n'))}</div>`); buffer = []; } };
  lineasCuerpo.forEach(l => {
    if (l.trim().startsWith('TOTAL')) {
      vaciar();
      partes.push(`<div class="total"><span>TOTAL</span><span>$${esc(d.total)}</span></div>`);
    } else {
      buffer.push(l);
    }
  });
  vaciar();

  // Pedido listo: cobro, notas y, al final, el código de barras del folio
  if (d.pedido) partes.push(bloquePedidoHtml(d, 'abajo', esc));
  if (d.codigoAlFinal && d.folio && typeof JsBarcode !== 'undefined') {
    try {
      const chico = !!(d.pedido && d.pedido.formato && d.pedido.formato.barras === 'chico');
      partes.push(htmlBarrasTicket(d.folio, { chico, e58 }));
    } catch (err) {
      console.error('No se pudo generar el código de barras:', err.message);
    }
  }

  // QR de promoción
  if (d.qrPromo && d.qrPromo.contenido && typeof QRCode !== 'undefined') {
    try {
      const pct = d.qrPromo.tamano === 'chico' ? 40 : (d.qrPromo.tamano === 'grande' ? 80 : 60);
      if (d.qrPromo.texto) partes.push(`<div class="c" style="font-weight:700; margin-top:6px;">${esc(d.qrPromo.texto).replace(/\n/g, '<br>')}</div>`);
      partes.push(`<img src="${(await generarCanvasQR(d.qrPromo.contenido, 360)).toDataURL()}" style="width:${pct}%;">`);
    } catch (err) {
      console.error('No se pudo generar el QR de promoción:', err.message);
    }
  }

  // Facturación en línea: leyenda + QR con el folio ya escrito
  if (d.facturaUrl && typeof QRCode !== 'undefined') {
    try {
      const enlaceCorto = d.facturaUrl.replace(/^https?:\/\//, '');
      partes.push(`<div class="c" style="font-weight:700; margin-top:8px;">SOLICITA TU FACTURA</div>`);
      partes.push(`<div class="c" style="word-break:break-all;">Escanea el código o entra a ${esc(enlaceCorto)}<br>Folio: ${esc(d.folio)} &nbsp; Total: $${esc(d.total)}</div>`);
      partes.push(`<img src="${(await generarCanvasQR(`${d.facturaUrl}?folio=${encodeURIComponent(d.folio)}`, 360)).toDataURL()}" style="width:55%;">`);
    } catch (err) {
      console.error('No se pudo generar el QR de facturación:', err.message);
    }
  }

  // Leyenda fija de Compoint (negritas, centrada)
  partes.push(`<div class="c" style="font-weight:800; border-top:2px solid #000; margin-top:10px; padding-top:5px; line-height:1.35;">${leyendaCompoint().map(esc).join('<br>')}</div>`);

  if (ticketEsPrueba()) partes.push('<div class="marca-prueba">VERSIÓN DE PRUEBA</div>');

  return { css, html: `<div class="tk">${partes.join('')}</div>` };
}

// Imprime usando el diálogo normal de impresión del navegador — funciona con
// CUALQUIER impresora que Windows/Mac ya tenga instalada (USB, red, la que
// sea), porque el sistema operativo maneja la comunicación, no el navegador.
// No corta el papel automáticamente. Aquí los acentos siempre salen bien
// (los maneja Windows, no la impresora).
async function imprimirConDialogoDelSistema(datosTicket) {
  const anchoMM = datosTicket.ancho_ticket === '58mm' ? '58mm' : '80mm';
  const { css, html } = await construirHtmlTicket(datosTicket);
  const pagina = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
    <meta charset="UTF-8">
    <title>Ticket ${escaparHtmlTicket(datosTicket.folio)}</title>
    <style>
      @page { size: ${anchoMM} auto; margin: 2mm; }
      body { margin: 0; }
      ${css}
    </style>
    </head>
    <body>${html}<script>window.onload = () => window.print(); window.onafterprint = () => window.close();<\/script></body>
    </html>
  `;

  if (await intentarImpresionSilenciosa(pagina, 'ticket', anchoMM)) return;
  abrirVentanaImpresion(pagina);
}

// Imprime líneas de texto plano (cortes de caja, reportes) respetando el método
// de impresión de ESTE dispositivo: directo (Bluetooth/USB, con corte de papel)
// o el diálogo de la impresora instalada en Windows/Mac. Todo sale en negritas
// y en letra grande para que se lea bien. Cada línea es un texto, o
// { t: 'TEXTO', big: true } para un título en letra doble.
async function imprimirTextoPlanoTicket(lineas, { titulo = 'Documento', ancho_ticket } = {}) {
  const modo = localStorage.getItem('modo_impresion') || 'directo';
  const ancho = ancho_ticket || localStorage.getItem('ancho_ticket_dispositivo') || '80mm';
  const acentos = (leerDisenoDispositivo().acentos) || 'quitar';
  const texto = (l) => (typeof l === 'string' ? l : l.t);
  const esGrande = (l) => typeof l !== 'string' && l.big;

  if (modo === 'sistema') {
    const columnas = ancho === '58mm' ? 26 : 34;
    const utilPx = ancho === '58mm' ? 204 : 287;
    const fuentePx = Math.floor((utilPx / (columnas * 0.6)) * 10) / 10;
    const cuerpo = lineas.map(l => esGrande(l)
      ? `<div class="g">${escaparHtmlTicket(texto(l).trim())}</div>`
      : `<div class="l">${escaparHtmlTicket(texto(l)) || '&nbsp;'}</div>`).join('');
    const pagina = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${escaparHtmlTicket(titulo)}</title>
      <style>@page { size: ${ancho} auto; margin: 2mm; } body { margin: 0; font-family: 'Courier New', monospace; font-size: ${fuentePx}px; font-weight: 700; line-height: 1.3; color: #000; }
      .l { white-space: pre; } .g { text-align: center; font-size: 1.4em; font-weight: 800; margin: 2px 0; }</style>
      </head><body>${cuerpo}
      <script>window.onload = () => window.print(); window.onafterprint = () => window.close();<\/script></body></html>`;
    if (await intentarImpresionSilenciosa(pagina, 'ticket', ancho)) return;
    abrirVentanaImpresion(pagina);
    return;
  }

  if (!impresoraConectada()) await reconectarSiEsPosible();
  if (!impresoraConectada()) throw new Error('No hay impresora conectada. Conéctala en Configuración → Impresión de este dispositivo.');

  ticketModoAcentos = acentos;
  const columnas = columnasTicket(ancho, 'normal', false);
  const partes = [escposComando([0x1B, 0x40])];
  if (acentos === 'cp858') partes.push(escposComando([0x1B, 0x74, 19]));
  else if (acentos === 'cp850') partes.push(escposComando([0x1B, 0x74, 2]));
  partes.push(ESCPOS_FUENTE_A, ESCPOS_IZQUIERDA, ESCPOS_NEGRITA_ON);
  lineas.forEach(l => {
    if (esGrande(l)) {
      const t = texto(l).trim();
      const doble = t.length * 2 <= columnas;
      partes.push(ESCPOS_CENTRAR, escposTamano(doble ? 2 : 1, 2), codificarTextoTicket(t + '\n', acentos), escposTamano(1, 1), ESCPOS_IZQUIERDA);
    } else {
      // Letra de doble alto (mismo ancho de columnas) para que se lea mejor.
      partes.push(escposTamano(1, 2), codificarTextoTicket(texto(l) + '\n', acentos), escposTamano(1, 1));
    }
  });
  partes.push(ESCPOS_NEGRITA_OFF, bytesDeLineas(['', '', '']), escposComando([0x1D, 0x56, 0x00]));
  await enviarBytes(bytesJuntos(partes));
}
