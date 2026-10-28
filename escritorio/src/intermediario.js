// Intermediario de impresión por red, integrado en la aplicación.
// Recibe órdenes del navegador y las reenvía por TCP a la impresora (IP:9100).
//
// Lo usan esta computadora (http://localhost:3500) y las demás cajas/tabletas del negocio
// (http://IP-DE-ESTA-PC:3500), por eso escucha en la red local. Para que nadie lo use de "puente":
//   - solo atiende a páginas del sistema del negocio (las decide main.js con `origenPermitido`);
//   - solo manda a impresoras de la red local (IP 10.x, 172.16-31.x, 192.168.x o 127.x);
//   - solo a los puertos de impresora (9100, 9101, 9102).
const express = require('express');
const net = require('net');

// Puertos de impresión directa (RAW / JetDirect). 9101 y 9102 son el 2.º y 3.er puerto de algunos print servers.
const PUERTOS_IMPRESORA = new Set([9100, 9101, 9102]);

// ¿Es una IP (v4, escrita con números) de la red local?
function ipPrivada(ip) {
  const t = String(ip || '').trim();
  if (!net.isIPv4(t)) return false; // nada de nombres: así no se puede "disfrazar" una dirección de internet
  const [a, b] = t.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function puertoPermitido(p) {
  const n = Number(p);
  return Number.isInteger(n) && PUERTOS_IMPRESORA.has(n);
}

// La propia computadora (localhost) y las ventanas internas del programa (file://) siempre pueden.
function origenDeEstaPc(origen) {
  if (origen === 'file://') return true;
  try {
    const u = new URL(origen);
    return /^https?:$/.test(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch (e) { return false; }
}

let servidor = null;

// opciones.origenPermitido(origen) → true si la página que pide imprimir es del sistema del negocio.
function iniciar(puerto = 3500, log = () => {}, opciones = {}) {
  const extra = typeof opciones.origenPermitido === 'function' ? opciones.origenPermitido : () => false;
  const permitido = (origen) => {
    if (origenDeEstaPc(origen)) return true;
    try { return !!extra(origen); } catch (e) { return false; }
  };

  const app = express();
  // Permisos del navegador (CORS): solo para las páginas del sistema. Una página de internet cualquiera
  // no recibe estos permisos y el navegador no le deja usar el intermediario.
  app.use((req, res, next) => {
    const origen = req.headers.origin;
    if (origen === undefined) return next(); // no viene de una página web (ej. prueba con el navegador escribiendo la dirección)
    if (!permitido(origen)) {
      log('Intermediario: pedido rechazado desde ' + String(origen).slice(0, 200));
      return res.status(403).json({ error: 'Esta página no puede usar el intermediario de impresión.' });
    }
    res.setHeader('Access-Control-Allow-Origin', origen);
    res.setHeader('Vary', 'Origin');
    // Chrome pide este permiso cuando una página en internet le habla a la red local.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  app.get('/', (req, res) => res.json({ ok: true, mensaje: 'Intermediario de impresión Compoint — activo', version: '2.1.0' }));

  app.post('/imprimir-red', (req, res) => {
    const { ip, puerto: puertoImp, datos } = req.body || {};
    if (!ip || !puertoImp || !Array.isArray(datos) || !datos.length) {
      return res.status(400).json({ error: 'Faltan datos: se necesita ip, puerto, y datos (arreglo de bytes)' });
    }
    if (!ipPrivada(ip)) {
      return res.status(400).json({ error: 'La IP de la impresora debe ser de tu red local (ej. 192.168.1.100).' });
    }
    if (!puertoPermitido(puertoImp)) {
      return res.status(400).json({ error: 'El puerto de la impresora debe ser 9100 (o 9101 / 9102).' });
    }
    const socket = new net.Socket();
    let respondido = false;
    const responder = (codigo, cuerpo) => { if (!respondido) { respondido = true; res.status(codigo).json(cuerpo); } };
    socket.setTimeout(5000);
    socket.connect(Number(puertoImp), String(ip).trim(), () => socket.write(Buffer.from(datos), () => socket.end()));
    socket.on('close', () => responder(200, { ok: true }));
    socket.on('timeout', () => { socket.destroy(); responder(504, { error: 'La impresora no respondió a tiempo — revisa que la IP sea correcta y que esté encendida y en la misma red.' }); });
    socket.on('error', (err) => responder(502, { error: 'No se pudo conectar con la impresora: ' + err.message }));
  });

  servidor = app.listen(puerto, '0.0.0.0', () => log(`Intermediario escuchando en el puerto ${puerto}`));
  servidor.on('error', (err) => {
    // Puerto ocupado = ya hay otro intermediario corriendo (ej. el .exe suelto): no pasa nada.
    log('Intermediario no iniciado: ' + (err.code || err.message));
    servidor = null;
  });
  return servidor;
}

function detener() { if (servidor) { servidor.close(); servidor = null; } }

module.exports = { iniciar, detener, ipPrivada, puertoPermitido, origenDeEstaPc, PUERTOS_IMPRESORA };
