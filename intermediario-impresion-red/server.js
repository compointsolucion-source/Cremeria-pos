// Intermediario de impresión por red para Cremería POS.
//
// QUÉ HACE: recibe una orden de impresión desde el navegador (que no puede
// conectarse directo a una impresora por IP, por seguridad del navegador) y
// la reenvía por una conexión de red directa (TCP) a la impresora.
//
// CÓMO USARLO:
//   1. Instala Node.js en esta computadora si no lo tienes (nodejs.org)
//   2. Abre una terminal en esta carpeta y corre: npm install
//   3. Luego corre: npm start
//   4. Dejar esta ventana abierta y esta computadora prendida mientras
//      quieras poder imprimir fichas por red.
//
// Esta computadora y la impresora deben estar en la MISMA red local.

const express = require('express');
const cors = require('cors');
const net = require('net');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PUERTO_RELAY = process.env.PUERTO_RELAY || 3500;

// Para confirmar que el intermediario está corriendo (se usa desde
// Configuración con un botón de "Probar conexión").
app.get('/', (req, res) => {
  res.json({ ok: true, mensaje: 'Intermediario de impresión Cremería POS — activo' });
});

// Recibe { ip, puerto, datos } donde "datos" es un arreglo de números
// (bytes ESC/POS, 0-255) y los manda por una conexión TCP directa a la
// impresora — esto es justo lo que un navegador no puede hacer solo.
app.post('/imprimir-red', (req, res) => {
  const { ip, puerto, datos } = req.body || {};

  if (!ip || !puerto || !Array.isArray(datos)) {
    return res.status(400).json({ error: 'Faltan datos: se necesita ip, puerto, y datos (arreglo de bytes)' });
  }

  const buffer = Buffer.from(datos);
  const socket = new net.Socket();
  let yaRespondido = false;

  socket.setTimeout(5000); // 5 segundos — si la impresora no contesta, se avisa en vez de dejar la petición colgada

  socket.connect(puerto, ip, () => {
    socket.write(buffer, () => {
      socket.end();
    });
  });

  socket.on('close', () => {
    if (!yaRespondido) {
      yaRespondido = true;
      res.json({ ok: true });
    }
  });

  socket.on('timeout', () => {
    if (!yaRespondido) {
      yaRespondido = true;
      socket.destroy();
      res.status(504).json({ error: 'La impresora no respondió a tiempo — revisa que la IP sea correcta y que esté encendida y en la misma red.' });
    }
  });

  socket.on('error', (err) => {
    if (!yaRespondido) {
      yaRespondido = true;
      res.status(502).json({ error: 'No se pudo conectar con la impresora: ' + err.message });
    }
  });
});

app.listen(PUERTO_RELAY, () => {
  console.log(`Intermediario de impresión escuchando en http://localhost:${PUERTO_RELAY}`);
  console.log('Deja esta ventana abierta mientras quieras poder imprimir fichas por red.');
});
