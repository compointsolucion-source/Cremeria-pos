// Intermediario de impresión por red — Compoint Punto / Cremería POS.
//
// QUÉ HACE: recibe una orden de impresión desde el navegador (que no puede
// conectarse directo a una impresora por IP) y la reenvía por TCP a la
// impresora (puerto 9100 normalmente).
//
// EN WINDOWS (.exe): al abrirlo una vez se INSTALA solo — se copia a
// %LOCALAPPDATA%\CompointIntermediario, se registra para arrancar con Windows
// en segundo plano (sin ventana), abre el puerto en el firewall y se inicia.
//
// Opciones por línea de comandos:
//   (sin opción)   instala / repara y arranca en segundo plano
//   --servidor     corre el servidor (lo usa el arranque automático)
//   --detener      detiene el servicio en segundo plano
//   --desinstalar  quita el arranque automático, la regla de firewall y lo detiene

const express = require('express');
const cors = require('cors');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const PUERTO_RELAY = parseInt(process.env.PUERTO_RELAY || '3500', 10);
const NOMBRE_EXE = 'IntermediarioImpresion.exe';
const NOMBRE_REGLA = 'Compoint Intermediario Impresion';
const NOMBRE_RUN = 'CompointIntermediarioImpresion';
const CARPETA = path.join(process.env.LOCALAPPDATA || os.homedir(), 'CompointIntermediario');
const args = process.argv.slice(1).filter(a => a.startsWith('--'));
const esWindows = process.platform === 'win32';

// ---------------------------------------------------------------- servidor
function iniciarServidor() {
  const app = express();
  // Chrome pide este permiso extra cuando una página en internet (https)
  // le habla a un equipo de la red local (preflight de "red privada").
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    next();
  });
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/', (req, res) => {
    res.json({ ok: true, mensaje: 'Intermediario de impresión Compoint — activo', version: '2.0.0' });
  });

  app.post('/imprimir-red', (req, res) => {
    const { ip, puerto, datos } = req.body || {};
    if (!ip || !puerto || !Array.isArray(datos)) {
      return res.status(400).json({ error: 'Faltan datos: se necesita ip, puerto, y datos (arreglo de bytes)' });
    }
    const buffer = Buffer.from(datos);
    const socket = new net.Socket();
    let yaRespondido = false;
    socket.setTimeout(5000);
    socket.connect(puerto, ip, () => { socket.write(buffer, () => socket.end()); });
    socket.on('close', () => { if (!yaRespondido) { yaRespondido = true; res.json({ ok: true }); } });
    socket.on('timeout', () => {
      if (!yaRespondido) {
        yaRespondido = true; socket.destroy();
        res.status(504).json({ error: 'La impresora no respondió a tiempo — revisa que la IP sea correcta y que esté encendida y en la misma red.' });
      }
    });
    socket.on('error', (err) => {
      if (!yaRespondido) { yaRespondido = true; res.status(502).json({ error: 'No se pudo conectar con la impresora: ' + err.message }); }
    });
  });

  const servidor = app.listen(PUERTO_RELAY, '0.0.0.0', () => {
    console.log(`Intermediario de impresión escuchando en http://localhost:${PUERTO_RELAY}`);
  });
  servidor.on('error', (err) => {
    // Si ya hay otro intermediario corriendo en ese puerto, salir en silencio.
    if (err.code === 'EADDRINUSE') process.exit(0);
    registrarLog('Error del servidor: ' + err.message);
    process.exit(1);
  });
}

// ---------------------------------------------------------------- utilidades de Windows
function registrarLog(texto) {
  try {
    fs.mkdirSync(CARPETA, { recursive: true });
    fs.appendFileSync(path.join(CARPETA, 'log.txt'), new Date().toISOString() + ' ' + texto + '\n');
  } catch (e) { /* sin log */ }
}

function ipsLocales() {
  const lista = [];
  Object.values(os.networkInterfaces()).forEach(ifs => (ifs || []).forEach(i => {
    if (i.family === 'IPv4' && !i.internal) lista.push(i.address);
  }));
  return lista;
}

function mensaje(titulo, texto) {
  if (!esWindows) { console.log(titulo + '\n' + texto); return; }
  const esc = (s) => String(s).replace(/'/g, "''");
  const script = `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('${esc(texto).replace(/\n/g, "' + [char]13 + [char]10 + '")}','${esc(titulo)}')`;
  spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
}

function ejecutar(cmd, cmdArgs) {
  return spawnSync(cmd, cmdArgs, { windowsHide: true, encoding: 'utf8' });
}

function detenerOtros() {
  ejecutar('taskkill', ['/F', '/IM', NOMBRE_EXE, '/FI', `PID ne ${process.pid}`]);
}

function reglaFirewallExiste() {
  return ejecutar('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${NOMBRE_REGLA}`]).status === 0;
}

// Crea (o borra) la regla de firewall. Pide permiso de administrador UNA vez.
function ajustarFirewall(crear) {
  const argsNetsh = crear
    ? ['advfirewall', 'firewall', 'add', 'rule', `name=${NOMBRE_REGLA}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${PUERTO_RELAY}`, 'profile=any']
    : ['advfirewall', 'firewall', 'delete', 'rule', `name=${NOMBRE_REGLA}`];
  let r = ejecutar('netsh', argsNetsh);
  if (r.status === 0) return true;
  // Sin permisos de administrador: relanzar netsh elevado (aparece el aviso de Windows).
  const lista = argsNetsh.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
  r = ejecutar('powershell.exe', ['-NoProfile', '-Command', `Start-Process netsh -ArgumentList ${lista} -Verb RunAs -Wait -WindowStyle Hidden`]);
  return r.status === 0 && (crear ? reglaFirewallExiste() : true);
}

function escribirLanzador(exe) {
  const vbs = path.join(CARPETA, 'iniciar.vbs');
  const contenido = `Set sh = CreateObject("WScript.Shell")\r\nsh.Run """${exe}"" --servidor", 0, False\r\n`;
  fs.writeFileSync(vbs, contenido);
  return vbs;
}

function arrancarEnSegundoPlano(exe) {
  const hijo = spawn(exe, ['--servidor'], { detached: true, stdio: 'ignore', windowsHide: true });
  hijo.unref();
}

function instalar() {
  fs.mkdirSync(CARPETA, { recursive: true });
  const destino = path.join(CARPETA, NOMBRE_EXE);
  const yaEsInstalado = path.resolve(process.execPath).toLowerCase() === path.resolve(destino).toLowerCase();

  detenerOtros();
  if (!yaEsInstalado) {
    // pequeña espera para que Windows suelte el archivo si estaba corriendo
    spawnSync('ping', ['127.0.0.1', '-n', '2'], { windowsHide: true });
    fs.copyFileSync(process.execPath, destino);
  }
  const vbs = escribirLanzador(destino);
  ejecutar('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', NOMBRE_RUN, '/t', 'REG_SZ', '/d', `wscript.exe //B "${vbs}"`, '/f']);

  let firewallOk = true;
  if (!reglaFirewallExiste()) firewallOk = ajustarFirewall(true);

  arrancarEnSegundoPlano(destino);

  const ips = ipsLocales();
  const direcciones = ['En esta computadora:  http://localhost:' + PUERTO_RELAY]
    .concat(ips.map(ip => 'Desde otros equipos:   http://' + ip + ':' + PUERTO_RELAY));
  mensaje('Intermediario de impresión instalado',
    '✔ Listo. El intermediario ya está corriendo en segundo plano y se iniciará solo cada vez que prendas Windows.\n\n' +
    direcciones.join('\n') + '\n\n' +
    (firewallOk ? '' : '⚠ No se pudo abrir el puerto en el firewall: otros equipos de la red quizá no puedan conectarse. Vuelve a abrir este programa y acepta el permiso de administrador.\n\n') +
    'Esa dirección es la que se escribe en Configuración → Impresora de fichas por red.');
}

function desinstalar() {
  detenerOtros();
  ejecutar('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', NOMBRE_RUN, '/f']);
  if (reglaFirewallExiste()) ajustarFirewall(false);
  // borrar la carpeta instalada un instante después de que este proceso termine
  spawn('cmd.exe', ['/c', `ping 127.0.0.1 -n 3 >nul & rmdir /s /q "${CARPETA}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  mensaje('Intermediario de impresión', 'Se desinstaló: ya no arrancará con Windows y se quitó del firewall.');
}

// ---------------------------------------------------------------- arranque
(function main() {
  if (args.includes('--servidor') || !esWindows) return iniciarServidor();
  if (args.includes('--detener')) { detenerOtros(); return mensaje('Intermediario de impresión', 'Detenido. Volverá a iniciar la próxima vez que prendas Windows.'); }
  if (args.includes('--desinstalar')) return desinstalar();
  try { instalar(); } catch (err) {
    registrarLog('Error al instalar: ' + err.stack);
    mensaje('Intermediario de impresión', 'No se pudo instalar: ' + err.message);
  }
})();
