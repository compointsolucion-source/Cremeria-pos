// Intermediario de impresión por red, integrado en la aplicación.
// Recibe órdenes del navegador y las reenvía por TCP a la impresora (IP:9100).
const express = require('express');
const cors = require('cors');
const net = require('net');

let servidor = null;

function iniciar(puerto = 3500, log = () => {}) {
  const app = express();
  // Chrome pide este permiso cuando una página en internet le habla a la red local.
  app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Private-Network', 'true'); next(); });
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/', (req, res) => res.json({ ok: true, mensaje: 'Intermediario de impresión Compoint — activo', version: '2.0.0' }));

  app.post('/imprimir-red', (req, res) => {
    const { ip, puerto: puertoImp, datos } = req.body || {};
    if (!ip || !puertoImp || !Array.isArray(datos)) {
      return res.status(400).json({ error: 'Faltan datos: se necesita ip, puerto, y datos (arreglo de bytes)' });
    }
    const socket = new net.Socket();
    let respondido = false;
    const responder = (codigo, cuerpo) => { if (!respondido) { respondido = true; res.status(codigo).json(cuerpo); } };
    socket.setTimeout(5000);
    socket.connect(puertoImp, ip, () => socket.write(Buffer.from(datos), () => socket.end()));
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

module.exports = { iniciar, detener };
