// Compoint Punto para escritorio (Windows 10/11).
// Abre el sistema web del negocio en su propia ventana, arranca con Windows,
// vive junto al reloj (bandeja) e incluye el intermediario de impresión por red.
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, session, shell, safeStorage, net, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const intermediario = require('./intermediario');

const PUERTO_INTERMEDIARIO = 3500;

// Permitir que la página (https) le hable al intermediario de la red local (http://IP:3500).
app.commandLine.appendSwitch('allow-running-insecure-content');
app.commandLine.appendSwitch('disable-features', 'BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults');
app.commandLine.appendSwitch('enable-web-bluetooth');
app.setAppUserModelId('mx.com.compoint.punto');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let ventana = null, ventanaConfig = null, tray = null;
let saliendo = false, avisoBandejaMostrado = false, autoLoginPendiente = true;

// ------------------------------------------------------------ configuración
const archivoUsuario = () => path.join(app.getPath('userData'), 'config.json');
const archivoCliente = () => app.isPackaged
  ? path.join(process.resourcesPath, 'config-cliente.json')
  : path.join(__dirname, '..', 'config-cliente.json');

function leerJson(ruta) { try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (e) { return {}; } }
function configuracion() { return { nombre: 'Compoint Punto', intermediario: true, iniciarConWindows: true, ...leerJson(archivoCliente()), ...leerJson(archivoUsuario()) }; }
function guardarUsuario(cambios) {
  const actual = leerJson(archivoUsuario());
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(archivoUsuario(), JSON.stringify({ ...actual, ...cambios }, null, 2));
}
function log(texto) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'log.txt'), new Date().toISOString() + ' ' + texto + '\n'); } catch (e) { /* sin log */ }
}
const origenConfigurado = () => { try { return new URL(configuracion().url).origin; } catch (e) { return null; } };
const esLocal = (evento) => { try { return String(evento.senderFrame.url).startsWith('file://'); } catch (e) { return false; } };

// ------------------------------------------------------------ ventanas
function iconoApp() { return path.join(__dirname, 'icono.png'); }

function abrirConfig() {
  if (ventanaConfig && !ventanaConfig.isDestroyed()) { ventanaConfig.focus(); return; }
  ventanaConfig = new BrowserWindow({
    width: 520, height: 660, resizable: false, autoHideMenuBar: true, icon: iconoApp(),
    title: 'Configurar Compoint Punto',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  ventanaConfig.setMenu(null);
  ventanaConfig.loadFile(path.join(__dirname, 'setup.html'));
  ventanaConfig.on('closed', () => { ventanaConfig = null; if (!ventana) { saliendo = true; app.quit(); } });
}

function crearVentana() {
  const cfg = configuracion();
  if (!cfg.url) { abrirConfig(); return; }
  if (ventana && !ventana.isDestroyed()) { ventana.show(); ventana.focus(); return; }

  ventana = new BrowserWindow({
    width: 1366, height: 800, minWidth: 800, minHeight: 600, show: false, icon: iconoApp(),
    title: cfg.nombre, backgroundColor: '#f4f6f8', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  Menu.setApplicationMenu(null);
  ventana.maximize();
  ventana.once('ready-to-show', () => ventana.show());
  const wc = ventana.webContents;

  wc.on('page-title-updated', (e) => { e.preventDefault(); });
  wc.on('did-fail-load', (e, codigo, descripcion, urlFallida, esPrincipal) => {
    if (!esPrincipal || codigo === -3) return;
    log(`No cargó ${urlFallida}: ${descripcion} (${codigo})`);
    ventana.loadFile(path.join(__dirname, 'sin-conexion.html'));
  });
  wc.on('did-finish-load', () => intentarAutoLogin());

  // Ventanas nuevas: las de impresión del propio sistema sí; enlaces externos al navegador.
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const destino = new URL(url);
      if (url === 'about:blank' || destino.origin === origenConfigurado()) {
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 520, height: 760, icon: iconoApp() } };
      }
      if (/^https?:$/.test(destino.protocol)) shell.openExternal(url);
    } catch (e) { /* ignorar */ }
    return { action: 'deny' };
  });

  // Selector de impresora Bluetooth (Web Bluetooth)
  let temporizadorBT = null, pendienteBT = null;
  wc.on('select-bluetooth-device', (evento, dispositivos, callback) => {
    evento.preventDefault();
    pendienteBT = { dispositivos, callback };
    if (temporizadorBT) return;
    temporizadorBT = setTimeout(async () => {
      const { dispositivos: lista, callback: cb } = pendienteBT;
      temporizadorBT = null; pendienteBT = null;
      const validos = lista.filter(d => d.deviceName).slice(0, 8);
      if (!validos.length) { cb(''); return; }
      const r = await dialog.showMessageBox(ventana, {
        type: 'question', title: 'Impresora Bluetooth', message: 'Elige la impresora Bluetooth',
        buttons: validos.map(d => d.deviceName).concat('Cancelar'), cancelId: validos.length, defaultId: 0
      });
      cb(r.response < validos.length ? validos[r.response].deviceId : '');
    }, 2500);
  });

  // Atajos (la ventana no tiene menú)
  wc.on('before-input-event', (evento, i) => {
    if (i.type !== 'keyDown') return;
    const ctrl = i.control || i.meta;
    const k = i.key;
    if (k === 'F11') { ventana.setFullScreen(!ventana.isFullScreen()); evento.preventDefault(); }
    else if (k === 'F5' || (ctrl && !i.shift && k.toLowerCase() === 'r')) { wc.reload(); evento.preventDefault(); }
    else if (ctrl && i.shift && k.toLowerCase() === 'r') { wc.reloadIgnoringCache(); evento.preventDefault(); }
    else if (ctrl && (k === '+' || k === '=')) { wc.setZoomLevel(wc.getZoomLevel() + 0.5); evento.preventDefault(); }
    else if (ctrl && (k === '-' || k === '_')) { wc.setZoomLevel(wc.getZoomLevel() - 0.5); evento.preventDefault(); }
    else if (ctrl && k === '0') { wc.setZoomLevel(0); evento.preventDefault(); }
    else if (ctrl && i.alt && k.toLowerCase() === 'c') { abrirConfig(); evento.preventDefault(); }
    else if (k === 'Escape' && ventana.isFullScreen()) { ventana.setFullScreen(false); }
  });

  // Cerrar la ventana = seguir en segundo plano (el intermediario de impresión sigue activo)
  ventana.on('close', (e) => {
    if (saliendo) return;
    e.preventDefault();
    ventana.hide();
    if (!avisoBandejaMostrado && tray) {
      avisoBandejaMostrado = true;
      try { tray.displayBalloon({ title: 'Compoint Punto sigue activo', content: 'Se quedó en segundo plano junto al reloj. Para cerrarlo del todo: clic derecho en el icono → Salir.', iconType: 'info' }); } catch (e2) { /* ignorar */ }
    }
  });
  ventana.on('closed', () => { ventana = null; });

  wc.loadURL(cfg.url);
}

// ------------------------------------------------------------ entrar automático (opcional)
function credenciales() {
  const c = configuracion();
  if (!c.usuario || !c.passwordCifrada || !safeStorage.isEncryptionAvailable()) return null;
  try { return { usuario: c.usuario, password: safeStorage.decryptString(Buffer.from(c.passwordCifrada, 'base64')) }; } catch (e) { return null; }
}

async function intentarAutoLogin() {
  if (!autoLoginPendiente || !ventana) return;
  const cred = credenciales();
  if (!cred) { autoLoginPendiente = false; return; }
  const script = `(function(u,p){var a=document.getElementById('usuario'),b=document.getElementById('password');if(!a||!b||typeof login!=='function')return false;a.value=u;b.value=p;login();return true;})(${JSON.stringify(cred.usuario)},${JSON.stringify(cred.password)})`;
  try {
    const hecho = await ventana.webContents.executeJavaScript(script);
    if (hecho) autoLoginPendiente = false; // una sola vez por arranque: si cierras sesión, entra otra persona
  } catch (e) { log('Auto-login falló: ' + e.message); }
}

// ------------------------------------------------------------ bandeja
function aplicarInicioConWindows() {
  const activo = configuracion().iniciarConWindows !== false;
  try { app.setLoginItemSettings({ openAtLogin: activo, path: process.execPath }); } catch (e) { log('Inicio con Windows: ' + e.message); }
}

function crearBandeja() {
  tray = new Tray(nativeImage.createFromPath(iconoApp()).resize({ width: 16, height: 16 }));
  tray.setToolTip(configuracion().nombre);
  const armar = () => Menu.buildFromTemplate([
    { label: 'Abrir ' + configuracion().nombre, click: () => crearVentana() },
    { label: 'Pantalla completa (F11)', click: () => { crearVentana(); if (ventana) ventana.setFullScreen(!ventana.isFullScreen()); } },
    { label: 'Recargar', click: () => ventana && ventana.webContents.reloadIgnoringCache() },
    { type: 'separator' },
    { label: 'Iniciar con Windows', type: 'checkbox', checked: configuracion().iniciarConWindows !== false,
      click: (item) => { guardarUsuario({ iniciarConWindows: item.checked }); aplicarInicioConWindows(); } },
    { label: 'Cambiar dirección o usuario…', click: () => abrirConfig() },
    { type: 'separator' },
    { label: 'Salir por completo', click: () => { saliendo = true; app.quit(); } }
  ]);
  tray.setContextMenu(armar());
  tray.on('click', () => crearVentana());
}

// ------------------------------------------------------------ permisos y dispositivos
function configurarPermisos() {
  const ses = session.defaultSession;
  const permitidos = new Set(['media', 'fullscreen', 'clipboard-sanitized-write', 'usb', 'bluetooth', 'serial', 'notifications']);
  const origenOk = (url) => { try { return new URL(url).origin === origenConfigurado(); } catch (e) { return false; } };
  ses.setPermissionRequestHandler((wc, permiso, cb) => cb(permitidos.has(permiso) && origenOk(wc.getURL())));
  ses.setPermissionCheckHandler((wc, permiso, origen) => permitidos.has(permiso) && origenOk(origen));
  // Una vez que se elige una impresora USB, se recuerda: reconecta sola sin volver a preguntar.
  ses.setDevicePermissionHandler((detalles) => origenOk(detalles.origin) && ['usb', 'bluetooth', 'serial'].includes(detalles.deviceType));
  ses.on('select-usb-device', async (evento, detalles, callback) => {
    evento.preventDefault();
    const lista = detalles.deviceList;
    if (!lista.length) { callback(''); return; }
    const nombre = (d) => (d.productName || 'Dispositivo USB') + ` (${d.vendorId.toString(16)}:${d.productId.toString(16)})`;
    const r = await dialog.showMessageBox(ventana || undefined, {
      type: 'question', title: 'Impresora USB', message: 'Elige la impresora USB',
      buttons: lista.slice(0, 8).map(nombre).concat('Cancelar'), cancelId: Math.min(lista.length, 8), defaultId: 0
    });
    callback(r.response < Math.min(lista.length, 8) ? lista[r.response].deviceId : '');
  });
  ses.on('select-serial-port', (evento, puertos, wc, callback) => {
    evento.preventDefault();
    callback(puertos.length ? puertos[0].portId : '');
  });
}

// ------------------------------------------------------------ comunicación con setup.html / sin-conexion.html
ipcMain.handle('leer-config', (e) => {
  if (!esLocal(e)) return {};
  const c = configuracion();
  return { url: c.url || '', nombre: c.nombre, usuario: c.usuario || '', configurado: !!c.url };
});

ipcMain.handle('guardar-config', (e, datos) => {
  if (!esLocal(e)) return { error: 'No permitido' };
  try {
    const url = new URL(String(datos.url || '').trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error('x');
  } catch (err) { return { error: 'La dirección no es válida. Ejemplo: https://minegocio.onrender.com' }; }

  const cambios = { url: String(datos.url).trim() };
  if (datos.nombre) cambios.nombre = String(datos.nombre).trim();
  const usuario = String(datos.usuario || '').trim();
  if (usuario) {
    cambios.usuario = usuario;
    if (datos.password) {
      if (!safeStorage.isEncryptionAvailable()) return { error: 'Este equipo no permite guardar la contraseña de forma segura.' };
      cambios.passwordCifrada = safeStorage.encryptString(String(datos.password)).toString('base64');
    }
  } else { cambios.usuario = ''; cambios.passwordCifrada = ''; }
  guardarUsuario(cambios);
  autoLoginPendiente = true;
  if (tray) tray.setToolTip(configuracion().nombre);
  if (ventana && !ventana.isDestroyed()) { ventana.webContents.loadURL(cambios.url); ventana.show(); } else crearVentana();
  if (ventanaConfig) { const v = ventanaConfig; ventanaConfig = null; v.destroy(); }
  return { ok: true };
});

ipcMain.handle('cerrar-ventana-config', (e) => { if (esLocal(e) && ventanaConfig) ventanaConfig.close(); });

ipcMain.handle('reintentar', async (e) => {
  if (!esLocal(e) || !ventana) return;
  try {
    const r = await net.fetch(configuracion().url, { method: 'HEAD' });
    if (r) ventana.webContents.loadURL(configuracion().url);
  } catch (err) { /* sigue sin conexión */ }
});

// ------------------------------------------------------------ impresoras instaladas en Windows
// Solo las páginas del sistema configurado pueden listar impresoras e imprimir.
const esDelSistema = (evento) => { try { return new URL(evento.senderFrame.url).origin === origenConfigurado(); } catch (e) { return false; } };

ipcMain.handle('listar-impresoras', async (e) => {
  if (!esDelSistema(e)) return [];
  const lista = await e.sender.getPrintersAsync();
  return lista.map(p => ({ nombre: p.name, predeterminada: !!p.isDefault, descripcion: p.description || '' }));
});

// Imprime un HTML directo en una impresora instalada, sin diálogo.
// opciones: { impresora: 'nombre exacto' | '' (predeterminada), anchoMM: 58 | 80 }
// ---- Impresión RAW (ESC/POS) por el spooler de Windows: no pasa por el "dibujo" del driver,
// que es lo que hacía salir todo en negro en algunas térmicas de 80 mm.
const PS_RAW = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class RawPrn {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA { [MarshalAs(UnmanagedType.LPStr)] public string pDocName; [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPStr)] public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool StartDocPrinter(IntPtr h, int l, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA d);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, IntPtr b, int c, out int w);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("No se pudo abrir la impresora (" + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFOA di = new DOCINFOA(); di.pDocName = "Compoint Punto"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDoc fallo (" + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h);
        IntPtr p = Marshal.AllocCoTaskMem(data.Length);
        try { Marshal.Copy(data, 0, p, data.Length); int w; if (!WritePrinter(h, p, data.Length, out w) || w != data.Length) throw new Exception("WritePrinter fallo (" + Marshal.GetLastWin32Error() + ")"); }
        finally { Marshal.FreeCoTaskMem(p); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
[RawPrn]::Send($env:COMPOINT_PRN, [System.IO.File]::ReadAllBytes($env:COMPOINT_FILE))
`;

function enviarRaw(nombreImpresora, bytes) {
  return new Promise((resolver, rechazar) => {
    if (process.platform !== 'win32') return rechazar(new Error('La impresión RAW solo existe en Windows'));
    const base = path.join(app.getPath('temp'), 'compoint-raw-' + Date.now());
    const archivoBin = base + '.bin', archivoPs = base + '.ps1';
    fs.writeFileSync(archivoBin, bytes);
    fs.writeFileSync(archivoPs, '﻿' + PS_RAW, 'utf8');
    const { execFile } = require('child_process');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', archivoPs],
      { env: { ...process.env, COMPOINT_PRN: nombreImpresora, COMPOINT_FILE: archivoBin }, windowsHide: true, timeout: 30000 },
      (err, _out, errOut) => {
        try { fs.unlinkSync(archivoBin); fs.unlinkSync(archivoPs); } catch (_) {}
        if (err) rechazar(new Error((String(errOut || '').trim() || err.message).split('\n')[0])); else resolver();
      });
  });
}

// Convierte el bitmap BGRA (ya en blanco/negro) a comandos ESC/POS de imagen + avance + corte.
function bitmapAEscPos(buf, ancho, alto) {
  const bytesFila = Math.ceil(ancho / 8);
  const partes = [Buffer.from([0x1B, 0x40])]; // ESC @ (reiniciar)
  const BANDA = 128;
  for (let y0 = 0; y0 < alto; y0 += BANDA) {
    const filas = Math.min(BANDA, alto - y0);
    const datos = Buffer.alloc(bytesFila * filas);
    for (let y = 0; y < filas; y++) {
      for (let x = 0; x < ancho; x++) {
        if (buf[((y0 + y) * ancho + x) * 4] === 0) datos[y * bytesFila + (x >> 3)] |= (0x80 >> (x & 7));
      }
    }
    partes.push(Buffer.from([0x1D, 0x76, 0x30, 0x00, bytesFila & 0xFF, bytesFila >> 8, filas & 0xFF, filas >> 8]), datos);
  }
  partes.push(Buffer.from([0x1B, 0x64, 0x04]));       // avanzar 4 líneas
  partes.push(Buffer.from([0x1D, 0x56, 0x42, 0x00])); // corte parcial (si la impresora lo tiene)
  return Buffer.concat(partes);
}

ipcMain.handle('imprimir-html', async (e, html, opciones = {}) => {
  if (!esDelSistema(e)) throw new Error('No permitido');
  const anchoMM = parseInt(opciones.anchoMM, 10) === 58 ? 58 : 80;
  const nombre = String(opciones.impresora || '');
  if (nombre) {
    const instaladas = await e.sender.getPrintersAsync();
    if (!instaladas.some(p => p.name === nombre)) throw new Error(`La impresora "${nombre}" no está instalada en esta computadora.`);
  }
  // Se quitan los scripts: el que trae el HTML llamaría al diálogo de impresión.
  let limpio = String(html).replace(/<script[\s\S]*?<\/script>/gi, '');
  // Fondo blanco explícito: algunas impresoras térmicas (sobre todo en 80 mm) imprimen
  // en negro todo lo que es "transparente".
  const cssBlanco = '<style>html,body{background:#fff !important;color:#000 !important;-webkit-print-color-adjust:economy;}</style>';
  limpio = /<\/head>/i.test(limpio) ? limpio.replace(/<\/head>/i, cssBlanco + '</head>') : cssBlanco + limpio;
  const anchoPx = Math.round(anchoMM * 96 / 25.4);
  const puntos = anchoMM === 58 ? 384 : 576; // puntos reales de la cabeza térmica (203 dpi)
  const zoom = puntos / anchoPx;
  const oculta = new BrowserWindow({
    show: false, width: anchoPx, height: 50, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  let ventanaImg = null;
  const imprimir = (win, altoPx) => new Promise((resolver, rechazar) => {
    const alturaMicrones = Math.max(30000, Math.ceil(altoPx * 264.583) + 4000); // rollo: alto = contenido
    win.webContents.print({
      silent: true, deviceName: nombre, printBackground: true, color: false,
      margins: { marginType: 'none' },
      pageSize: { width: anchoMM * 1000, height: alturaMicrones }
    }, (exito, motivo) => exito ? resolver() : rechazar(new Error(motivo || 'No se pudo imprimir')));
  });
  try {
    await oculta.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(limpio));
    const altoPx = await oculta.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)');

    // Método principal: se convierte el ticket en una imagen en blanco y negro puro y se imprime
    // esa imagen. Así el driver de la impresora no puede "interpretar" el color y sacarlo en negro.
    let png = null, bitmapBN = null;
    try {
      oculta.webContents.setZoomFactor(zoom);
      oculta.setContentSize(puntos, Math.ceil(altoPx * zoom) + 2);
      await new Promise(r => setTimeout(r, 250));
      const cap = await oculta.webContents.capturePage();
      const tam = cap.getSize();
      if (tam.width > 0 && tam.height > 0) {
        const img = tam.width === puntos ? cap : cap.resize({ width: puntos, quality: 'best' });
        const t = img.getSize();
        const buf = Buffer.from(img.toBitmap()); // BGRA
        for (let p = 0; p < buf.length; p += 4) {
          const a = buf[p + 3] / 255;
          // se compone sobre blanco y se pasa a blanco/negro
          const lum = 0.114 * buf[p] + 0.587 * buf[p + 1] + 0.299 * buf[p + 2];
          const v = (lum * a + 255 * (1 - a)) < 160 ? 0 : 255;
          buf[p] = buf[p + 1] = buf[p + 2] = v; buf[p + 3] = 255;
        }
        bitmapBN = { buf, ancho: t.width, alto: t.height };
        png = nativeImage.createFromBitmap(buf, { width: t.width, height: t.height }).toPNG();
        var altoImgPx = Math.ceil(t.height / zoom);
      }
    } catch (err) { log('No se pudo convertir a imagen, se imprime directo: ' + err.message); png = null; }

    // 1.º intento: RAW ESC/POS (lo más compatible con térmicas). Si falla, se imprime la imagen por el driver.
    let hechoRaw = false;
    if (bitmapBN && opciones.raw !== false && process.platform === 'win32') {
      try {
        let destino = nombre;
        if (!destino) { const lista = await e.sender.getPrintersAsync(); const d = lista.find(p => p.isDefault); destino = d ? d.name : ''; }
        if (!destino) throw new Error('No hay impresora predeterminada');
        await enviarRaw(destino, bitmapAEscPos(bitmapBN.buf, bitmapBN.ancho, bitmapBN.alto));
        hechoRaw = true;
      } catch (err) { log('Impresión RAW falló, se usa el driver: ' + err.message); }
    }
    if (hechoRaw) {
      // listo
    } else if (png) {
      ventanaImg = new BrowserWindow({ show: false, width: anchoPx, height: 400, useContentSize: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      const pagina = '<!doctype html><html><head><meta charset="utf-8"><style>@page{margin:0}html,body{margin:0;padding:0;background:#fff}img{display:block;width:' + anchoMM + 'mm;height:auto}</style></head><body><img src="data:image/png;base64,' + png.toString('base64') + '"></body></html>';
      await ventanaImg.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pagina));
      await imprimir(ventanaImg, altoImgPx);
    } else {
      await imprimir(oculta, altoPx);
    }
  } finally {
    if (ventanaImg && !ventanaImg.isDestroyed()) ventanaImg.destroy();
    if (!oculta.isDestroyed()) oculta.destroy();
  }
  return { ok: true };
});

// ------------------------------------------------------------ arranque
app.on('second-instance', () => { if (ventana) { if (ventana.isMinimized()) ventana.restore(); ventana.show(); ventana.focus(); } else crearVentana(); });
app.on('before-quit', () => { saliendo = true; intermediario.detener(); });
app.on('window-all-closed', () => { /* se queda en la bandeja */ });

app.whenReady().then(() => {
  configurarPermisos();
  crearBandeja();
  aplicarInicioConWindows();
  if (configuracion().intermediario !== false) intermediario.iniciar(PUERTO_INTERMEDIARIO, log);
  crearVentana();
});
