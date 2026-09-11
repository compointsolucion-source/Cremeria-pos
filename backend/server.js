require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const pool = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Render/Cloudflare actúan como proxy delante del servidor: sin esto, Express
// vería siempre la IP interna del proxy en vez de la IP real del navegador,
// lo que rompería el límite de intentos de login (afectaría a todos por igual).
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.set('io', io);

// Logging estructurado: método, ruta y tiempo de respuesta. NUNCA se registra
// el body de la solicitud (evita loguear contraseñas, tokens u otros datos sensibles).
app.use((req, res, next) => {
  const inicio = Date.now();
  res.on('finish', () => {
    const duracion = Date.now() - inicio;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duracion}ms)`);
  });
  next();
});

// Socket.io: cada dispositivo se une a la "sala" de su sucursal
io.on('connection', (socket) => {
  socket.on('unirse_sucursal', (sucursalId) => {
    socket.join(`sucursal_${sucursalId}`);
  });
});

// Rutas
app.use('/api/auth', require('./routes/auth'));
app.use('/api/productos', require('./routes/productos'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/turnos', require('./routes/turnos'));
app.use('/api/movimientos', require('./routes/movimientos'));
app.use('/api/kits', require('./routes/kits'));
app.use('/api/clientes', require('./routes/clientes'));
app.use('/api/proveedores', require('./routes/proveedores'));
app.use('/api/compras', require('./routes/compras'));
app.use('/api/inventario', require('./routes/inventario'));
app.use('/api/configuracion', require('./routes/configuracion'));

app.get('/', (req, res) => res.send('Cremería POS backend funcionando'));

// Endpoint de salud: confirma que el servidor Y la base de datos responden,
// sin exponer ningún dato sensible. Útil para diagnosticar caídas o el
// "efecto dormido" del plan Free de Render.
app.get('/health', async (req, res) => {
  const salud = { servidor: 'ok', base_de_datos: 'desconocido', timestamp: new Date().toISOString() };
  try {
    await pool.query('SELECT 1');
    salud.base_de_datos = 'ok';
    res.json(salud);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] /health falló al conectar con la base de datos`);
    salud.base_de_datos = 'error';
    res.status(503).json(salud);
  }
});

// Manejador de errores no capturados: evita que una excepción inesperada
// tumbe el proceso completo o exponga detalles internos al cliente.
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error no capturado en ${req.method} ${req.originalUrl}:`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Ocurrió un error inesperado en el servidor' });
});

process.on('unhandledRejection', (razon) => {
  console.error(`[${new Date().toISOString()}] Promesa rechazada sin manejar:`, razon);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
