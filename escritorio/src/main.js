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
// Modo servidor del negocio (base de datos + sistema dentro de esta app)
let servidorLocal = null, ventanaPanel = null, ventanaAlta = null, ventanaEstado = null;
let cierreListo = false, cerrandoServidor = false, resolverAlta = null;

// ------------------------------------------------------------ configuración
const archivoUsuario = () => path.join(app.getPath('userData'), 'config.json');
const archivoCliente = () => app.isPackaged
  ? path.join(process.resourcesPath, 'config-cliente.json')
  : path.join(__dirname, '..', 'config-cliente.json');

function leerJson(ruta) { try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (e) { return {}; } }
function configuracion() {
  const c = { nombre: 'Compoint Punto', intermediario: true, iniciarConWindows: true, ...leerJson(archivoCliente()), ...leerJson(archivoUsuario()) };
  if (c.modo === 'servidor') c.url = servidorLocal ? servidorLocal.urlLocal + '/login.html' : '';
  return c;
}
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
    else if (ctrl && i.alt && k.toLowerCase() === 'c' && configuracion().modo !== 'servidor') { abrirConfig(); evento.preventDefault(); }
    else if (ctrl && i.alt && k.toLowerCase() === 's' && configuracion().modo === 'servidor') { abrirPanel(); evento.preventDefault(); }
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

let menuBandeja = null;
function crearBandeja() {
  tray = new Tray(nativeImage.createFromPath(iconoApp()).resize({ width: 16, height: 16 }));
  tray.setToolTip(configuracion().nombre);
  menuBandeja = () => Menu.buildFromTemplate([
    { label: 'Abrir ' + configuracion().nombre, click: () => crearVentana() },
    { label: 'Pantalla completa (F11)', click: () => { crearVentana(); if (ventana) ventana.setFullScreen(!ventana.isFullScreen()); } },
    { label: 'Recargar', click: () => ventana && ventana.webContents.reloadIgnoringCache() },
    { type: 'separator' },
    { label: 'Iniciar con Windows', type: 'checkbox', checked: configuracion().iniciarConWindows !== false,
      click: (item) => { guardarUsuario({ iniciarConWindows: item.checked }); aplicarInicioConWindows(); } },
    ...(configuracion().modo === 'servidor' ? [
      { label: 'Panel del servidor y respaldos…', click: () => abrirPanel() },
      { label: 'Respaldar ahora', click: () => respaldarAhora() }
    ] : [{ label: 'Cambiar dirección o usuario…', click: () => abrirConfig() }]),
    { label: 'Ayuda y soporte', click: () => { crearVentana(); try { const u = new URL('/admin/ayuda.html', configuracion().url); if (ventana) ventana.loadURL(u.href); } catch (e) {} } },
    { type: 'separator' },
    { label: 'Salir por completo (guarda un respaldo)', click: () => { saliendo = true; app.quit(); } }
  ]);
  tray.setContextMenu(menuBandeja());
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

// Busca servidores del negocio en la red local (puerto 3000) y prueba una dirección escrita a mano.
function consultarServidor(host, puerto, ms) {
  return new Promise((ok) => {
    const req = require('http').get({ host, port: puerto, path: '/health', timeout: ms }, (res) => {
      let t = ''; res.on('data', (d) => { if (t.length < 2000) t += d; });
      res.on('end', () => { try { const j = JSON.parse(t); ok(j && j.servidor === 'ok' ? { host, puerto, equipo: j.equipo || '' } : null); } catch (er) { ok(null); } });
    });
    req.on('timeout', () => { req.destroy(); ok(null); });
    req.on('error', () => ok(null));
  });
}
ipcMain.handle('buscar-servidores', async (e) => {
  if (!esLocal(e)) return [];
  const os = require('os'); const ips = [];
  for (const lista of Object.values(os.networkInterfaces())) for (const i of lista || []) {
    if (i.family === 'IPv4' && !i.internal) { const p = i.address.split('.'); for (let n = 1; n < 255; n++) ips.push(`${p[0]}.${p[1]}.${p[2]}.${n}`); }
  }
  const unicas = [...new Set(ips)]; const hallados = [];
  for (let k = 0; k < unicas.length; k += 64) {
    const r = await Promise.all(unicas.slice(k, k + 64).map((ip) => consultarServidor(ip, 3000, 700)));
    r.forEach((x) => { if (x) hallados.push(x); });
  }
  return hallados.map((h) => ({ url: `http://${h.host}:${h.puerto}`, equipo: h.equipo }));
});
ipcMain.handle('probar-servidor', async (e, u) => {
  if (!esLocal(e)) return { ok: false };
  try {
    const url = new URL(String(u));
    const r = await consultarServidor(url.hostname, Number(url.port) || 80, 3000);
    return { ok: !!r, equipo: r ? r.equipo : '' };
  } catch (er) { return { ok: false }; }
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

// ------------------------------------------------------------ MODO SERVIDOR DEL NEGOCIO
// Esta computadora guarda la información (base de datos propia) y entrega el sistema a las demás
// cajas por red local. Funciona sin internet y respalda automáticamente.
function dirServidor() {
  const empaquetado = path.join(__dirname, '..', 'servidor');
  if (fs.existsSync(path.join(empaquetado, 'backend', 'server.js'))) return empaquetado;
  return path.join(__dirname, '..', '..'); // desarrollo: carpeta del proyecto (backend/ y frontend/)
}
const secretos = {
  cifrar: (t) => (safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(String(t)).toString('base64') : 'raw:' + t),
  descifrar: (t) => (String(t).startsWith('enc:') ? safeStorage.decryptString(Buffer.from(String(t).slice(4), 'base64')) : String(t).replace(/^raw:/, ''))
};

function mostrarEstado(texto) {
  const html = '<meta charset="utf-8"><body style="font-family:Segoe UI,Arial;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f4f6f8;color:#333"><div style="text-align:center;padding:20px"><div style="font-size:34px;margin-bottom:10px">⏳</div><div style="font-size:15px">' + String(texto).replace(/[<&]/g, '') + '</div></div>';
  if (!ventanaEstado || ventanaEstado.isDestroyed()) {
    ventanaEstado = new BrowserWindow({ width: 380, height: 180, resizable: false, frame: true, minimizable: false, closable: false, autoHideMenuBar: true, icon: iconoApp(), title: 'Compoint Punto',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    ventanaEstado.setMenu(null);
  }
  ventanaEstado.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}
function cerrarEstado() { if (ventanaEstado && !ventanaEstado.isDestroyed()) { ventanaEstado.setClosable(true); ventanaEstado.destroy(); } ventanaEstado = null; }

function pedirDatosNegocio() {
  return new Promise((resolver) => {
    cerrarEstado();
    resolverAlta = resolver;
    ventanaAlta = new BrowserWindow({
      width: 520, height: 720, autoHideMenuBar: true, icon: iconoApp(), title: 'Preparar el servidor del negocio',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    ventanaAlta.setMenu(null);
    ventanaAlta.loadFile(path.join(__dirname, 'servidor-alta.html'));
    ventanaAlta.on('closed', () => { ventanaAlta = null; if (resolverAlta) { const r = resolverAlta; resolverAlta = null; r(null); } });
  });
}

async function iniciarModoServidor() {
  mostrarEstado('Encendiendo el servidor del negocio… (la primera vez tarda un poco más)');
  try {
    const { crearServidor } = require('./servidor');
    servidorLocal = await crearServidor({ app, dirServidor: dirServidor(), avisar: mostrarEstado, pedirDatosNegocio, secretos });
  } catch (err) {
    cerrarEstado();
    log('No se pudo iniciar el servidor: ' + (err && err.stack || err));
    if (String(err && err.message) === 'CANCELADO') { guardarUsuario({ modo: '' }); saliendo = true; app.quit(); return; }
    dialog.showErrorBox('No se pudo iniciar el servidor del negocio', String(err && err.message || err) + '\n\nSi el problema continúa, avisa a Compoint. Detalle guardado en ' + path.join(app.getPath('userData'), 'log.txt'));
    saliendo = true; app.quit(); return;
  }
  cerrarEstado();
  log('Servidor del negocio listo: ' + servidorLocal.urlLocal + ' | red: ' + servidorLocal.direcciones().join(', '));
  if (tray) tray.setContextMenu(menuBandeja());
  programarRespaldos();
  crearVentana();
}

function abrirPanel() {
  if (!servidorLocal) return;
  if (ventanaPanel && !ventanaPanel.isDestroyed()) { ventanaPanel.focus(); return; }
  ventanaPanel = new BrowserWindow({
    width: 700, height: 800, autoHideMenuBar: true, icon: iconoApp(), title: 'Panel del servidor',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  ventanaPanel.setMenu(null);
  ventanaPanel.loadFile(path.join(__dirname, 'servidor-panel.html'));
  ventanaPanel.on('closed', () => { ventanaPanel = null; });
}

async function respaldarAhora() {
  if (!servidorLocal) return { ok: false, error: 'El servidor no está encendido.' };
  const r = await servidorLocal.respaldos.hacerRespaldo('manual');
  try { if (tray) tray.displayBalloon({ title: r.ok ? 'Respaldo listo' : 'No se pudo respaldar', content: r.ok ? 'Guardado en ' + servidorLocal.rutas.respaldos : String(r.error), iconType: r.ok ? 'info' : 'error' }); } catch (e) { /* ignorar */ }
  return r;
}

// Respaldo automático: al salir del sistema y, por si la PC se apaga sin cerrarlo, cada 12 h.
function programarRespaldos() {
  const revisar = async () => {
    if (!servidorLocal || cerrandoServidor) return;
    try {
      if (servidorLocal.respaldos.tocaRespaldo(12)) await servidorLocal.respaldos.hacerRespaldo('automatico');
      else await servidorLocal.respaldos.reintentarNube();
    } catch (e) { log('Revisión de respaldos: ' + e.message); }
  };
  setTimeout(revisar, 2 * 60 * 1000);
  setInterval(revisar, 30 * 60 * 1000);
}

async function cerrarServidorConRespaldo() {
  const sv = servidorLocal;
  try {
    mostrarEstado('Guardando el respaldo del negocio… no apagues la computadora');
    const r = await Promise.race([sv.respaldos.hacerRespaldo('cierre'), new Promise((ok) => setTimeout(() => ok({ ok: false, error: 'tiempo agotado' }), 90000))]);
    if (!r.ok) log('Respaldo al cerrar: ' + r.error);
    mostrarEstado('Cerrando…');
    await Promise.race([sv.detener(), new Promise((ok) => setTimeout(ok, 40000))]);
  } catch (e) { log('Cierre del servidor: ' + e.message); }
  cerrarEstado();
}

ipcMain.handle('srv-elegir-modo', (e) => {
  if (!esLocal(e)) return;
  guardarUsuario({ modo: 'servidor' });
  if (ventanaConfig) { const v = ventanaConfig; ventanaConfig = null; v.destroy(); }
  iniciarModoServidor();
});

ipcMain.handle('srv-alta-guardar', async (e, datos) => {
  if (!esLocal(e) || !resolverAlta) return { error: 'No permitido' };
  const { validar } = require('./servidor/negocio');
  const errores = validar(datos);
  if (errores.length) return { error: errores.join(' ') };
  const r = resolverAlta; resolverAlta = null;
  r(datos);
  if (ventanaAlta) { const v = ventanaAlta; ventanaAlta = null; v.destroy(); }
  mostrarEstado('Creando el negocio…');
  return { ok: true };
});
ipcMain.handle('srv-alta-cancelar', (e) => { if (esLocal(e) && ventanaAlta) ventanaAlta.close(); });

ipcMain.handle('srv-estado', (e) => {
  if (!esLocal(e) || !servidorLocal) return null;
  const c = servidorLocal.configuracion();
  const n = servidorLocal.nube();
  return {
    negocio: c.negocio || '', urlLocal: servidorLocal.urlLocal, direcciones: servidorLocal.direcciones(),
    carpeta: servidorLocal.rutas.respaldos, estado: servidorLocal.respaldos.estado(), locales: servidorLocal.respaldos.listarLocales(),
    nube: { cloud_name: n.cloud_name, api_key: n.api_key, tieneSecreto: !!n.api_secret }
  };
});
ipcMain.handle('srv-respaldar', async (e) => { if (!esLocal(e)) return { ok: false, error: 'No permitido' }; return respaldarAhora(); });
ipcMain.handle('srv-abrir-carpeta', (e) => { if (esLocal(e) && servidorLocal) shell.openPath(servidorLocal.rutas.respaldos); });
ipcMain.handle('srv-guardar-nube', (e, d) => {
  if (!esLocal(e) || !servidorLocal) return { error: 'No permitido' };
  if (!String(d.cloud_name || '').trim() || !String(d.api_key || '').trim()) return { error: 'Escribe el Cloud name y la API key.' };
  if (!String(d.api_secret || '').trim() && !servidorLocal.nube().api_secret) return { error: 'Escribe el API secret.' };
  servidorLocal.guardarNube(d);
  return { ok: true };
});
ipcMain.handle('srv-probar-nube', async (e) => {
  if (!esLocal(e) || !servidorLocal) return { ok: false, error: 'No permitido' };
  try { await require('./servidor/respaldos').probarNube(servidorLocal.nube()); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err && (err.message || (err.error && err.error.message)) || err).slice(0, 200) }; }
});
ipcMain.handle('srv-restaurar', async (e) => {
  if (!esLocal(e) || !servidorLocal) return { error: 'No permitido' };
  const sel = await dialog.showOpenDialog(ventanaPanel || undefined, {
    title: 'Elige el respaldo a restaurar', defaultPath: servidorLocal.rutas.respaldos,
    filters: [{ name: 'Respaldo de Compoint Punto', extensions: ['gz'] }], properties: ['openFile']
  });
  if (sel.canceled || !sel.filePaths.length) return { ok: false };
  const archivo = sel.filePaths[0];
  const conf = await dialog.showMessageBox(ventanaPanel || undefined, {
    type: 'warning', buttons: ['Restaurar', 'Cancelar'], defaultId: 1, cancelId: 1, title: 'Restaurar respaldo',
    message: 'Se reemplazará TODA la información actual por la de este respaldo.',
    detail: path.basename(archivo) + '\n\nAntes de restaurar se guarda un respaldo de seguridad de lo que hay ahora. El programa se reiniciará.'
  });
  if (conf.response !== 0) return { ok: false };
  try {
    mostrarEstado('Restaurando el respaldo… no apagues la computadora');
    const previo = await servidorLocal.respaldos.hacerRespaldo('antes-de-restaurar');
    if (!previo.ok) throw new Error('No se pudo guardar el respaldo de seguridad previo: ' + previo.error);
    await servidorLocal.restaurar(archivo);
    log('Respaldo restaurado: ' + archivo);
    cierreListo = true; servidorLocal = null;
    intermediario.detener();
    app.relaunch(); app.exit(0);
  } catch (err) {
    cerrarEstado();
    log('Restauración falló: ' + (err && err.stack || err));
    dialog.showErrorBox('No se pudo restaurar', String(err && err.message || err) + '\n\nReinicia el programa; tu información anterior no se perdió si el error ocurrió antes de restaurar.');
    app.relaunch(); app.exit(1);
  }
  return { ok: true };
});

// ------------------------------------------------------------ arranque
app.on('second-instance', () => { if (ventana) { if (ventana.isMinimized()) ventana.restore(); ventana.show(); ventana.focus(); } else crearVentana(); });
app.on('before-quit', (e) => {
  saliendo = true;
  if (servidorLocal && !cierreListo) {
    e.preventDefault();
    if (cerrandoServidor) return;
    cerrandoServidor = true;
    cerrarServidorConRespaldo().finally(() => { cierreListo = true; intermediario.detener(); app.quit(); });
    return;
  }
  intermediario.detener();
});
app.on('window-all-closed', () => { /* se queda en la bandeja */ });

app.whenReady().then(async () => {
  configurarPermisos();
  crearBandeja();
  aplicarInicioConWindows();
  if (configuracion().intermediario !== false) intermediario.iniciar(PUERTO_INTERMEDIARIO, log);
  if (configuracion().modo === 'servidor') { await iniciarModoServidor(); return; }
  crearVentana();
});
