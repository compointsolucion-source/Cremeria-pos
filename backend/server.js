require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const pool = require('./db');
const { verificarLicencia } = require('./middleware/licencia');
const { migrar } = require('./utils/migrar');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e6 });
const jwt = require('jsonwebtoken');
const { datosActuales } = require('./middleware/auth');

app.disable('x-powered-by');

// En la nube (Coolify/Render) hay un proxy delante del servidor: sin esto, Express vería siempre
// la IP interna del proxy en vez de la del navegador y el límite de intentos de login afectaría a todos.
// En la computadora del negocio NO hay proxy: ahí no se confía en el encabezado X-Forwarded-For
// (si se confiara, cualquiera en la red podría inventarse una IP nueva en cada intento).
const ES_LOCAL = !!process.env.COMPOINT_ID_EQUIPO;
app.set('trust proxy', ES_LOCAL ? false : 1);

// Encabezados de seguridad para todas las respuestas.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Content-Security-Policy', "frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.use(cors({ exposedHeaders: ['X-Licencia-Estado', 'X-Licencia-Tipo', 'X-Licencia-Dias', 'X-Licencia-Vence'] }));
// Tamaño máximo de lo que se manda: 2 MB en general; 15 MB solo donde se suben fotos, archivos
// o listas grandes (así nadie puede saturar el servidor mandando datos enormes al login, por ejemplo).
const jsonNormal = express.json({ limit: '2mb' });
const jsonGrande = express.json({ limit: '15mb' });
const RUTAS_GRANDES = /^\/api\/(imagenes|sync|backups|facturacion|productos|clientes|configuracion|kits)(\/|$)/;
app.use((req, res, next) => (RUTAS_GRANDES.test(req.path) ? jsonGrande : jsonNormal)(req, res, next));
app.set('io', io);

// Modo servidor del negocio (instalación local): el mismo servidor entrega las
// páginas del sistema, para que las cajas entren por red local
// (http://IP-DE-ESTA-PC:3000). En la nube esto no se usa (FRONTEND_DIR vacío).
const FRONTEND_DIR = process.env.FRONTEND_DIR;
if (FRONTEND_DIR) {
  app.get('/js/config.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-store')
      .send("const API_URL = location.origin + '/api';\n");
  });
  app.get('/', (req, res) => res.redirect('/login.html'));
  app.use(express.static(FRONTEND_DIR));
}

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

// Socket.io (avisos en tiempo real): SOLO con sesión válida. Cada dispositivo se une a la
// "sala" de SU sucursal (el jefe general puede elegir cualquiera). Sin sesión no recibe nada.
io.use((socket, next) => {
  const token = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
  if (!token || typeof token !== 'string') return next(new Error('Sesión requerida'));
  jwt.verify(token, process.env.JWT_SECRET, (err, usuario) => {
    if (err) return next(new Error('Sesión no válida'));
    datosActuales(usuario.id).then((d) => {
      if (d && (!d.activo || (Number(usuario.tv) || 0) !== d.tv)) return next(new Error('Sesión no válida'));
      socket.data.usuario = d ? { ...usuario, rol: d.rol, sucursal_id: d.sucursal_id } : usuario;
      next();
    });
  });
});
io.on('connection', (socket) => {
  socket.on('unirse_sucursal', (sucursalId) => {
    const u = socket.data.usuario || {};
    const pedida = parseInt(sucursalId, 10);
    const sala = u.sucursal_id ? Number(u.sucursal_id) : (u.rol === 'jefe_general' && pedida > 0 ? pedida : null);
    if (!sala) return;
    for (const r of socket.rooms) if (r.startsWith('sucursal_')) socket.leave(r);
    socket.join(`sucursal_${sala}`);
  });
});

// Licencia (prueba de 15 días / renta anual / permanente): avisa antes de vencer y, ya vencida
// (y pasada la gracia), deja el sistema en "solo consulta". Sin fila en la tabla "licencia" y en la nube no hay control.
app.use('/api', verificarLicencia);

// Rutas
app.use('/api/auth', require('./routes/auth'));
app.use('/api/productos', require('./routes/productos'));
app.use('/api/tickets', require('./routes/tickets'));
// Pedidos a domicilio / para recoger / programados + módulo del repartidor.
const rutaPedidos = require('./routes/pedidos');
app.use('/api/pedidos', rutaPedidos);
app.use('/api/turnos', require('./routes/turnos'));
app.use('/api/movimientos', require('./routes/movimientos'));
app.use('/api/kits', require('./routes/kits'));
app.use('/api/clientes', require('./routes/clientes'));
app.use('/api/proveedores', require('./routes/proveedores'));
app.use('/api/compras', require('./routes/compras'));
app.use('/api/inventario', require('./routes/inventario'));
app.use('/api/configuracion', require('./routes/configuracion'));
app.use('/api/reportes', require('./routes/reportes'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/devoluciones', require('./routes/devoluciones'));
app.use('/api/bitacora', require('./routes/bitacora'));
app.use('/api/backups', require('./routes/backups'));
app.use('/api/departamentos', require('./routes/departamentos'));
app.use('/api/promociones', require('./routes/promociones'));
app.use('/api/imagenes', require('./routes/imagenes'));
app.use('/api/fichas', require('./routes/fichas'));
app.use('/api/sistema', require('./routes/sistema'));
app.use('/api/sucursales', require('./routes/sucursales'));
app.use('/api/licencia', require('./routes/licencia'));
app.use('/api/terminos', require('./routes/terminos'));
// Copia espejo del servidor local del negocio (apagada hasta que el dueño la vincule desde el panel del servidor, o exista SYNC_KEY).
app.use('/api/sync', require('./routes/sync'));
// Facturación: página pública para que el cliente pida su factura (+ administración de solicitudes).
app.use('/api/facturacion', require('./routes/facturacion'));
// Recargas y pago de servicios: estructura lista, pendiente de conectar a un
// proveedor real (ver backend/utils/proveedorRecargas.js).
app.use('/api/recargas', require('./routes/recargas'));

if (!FRONTEND_DIR) app.get('/', (req, res) => res.send('Cremería POS backend funcionando'));

// Endpoint de salud: confirma que el servidor Y la base de datos responden,
// sin exponer ningún dato sensible. Útil para diagnosticar caídas o el
// "efecto dormido" del plan Free de Render.
app.get('/health', async (req, res) => {
  const salud = { servidor: 'ok', base_de_datos: 'desconocido', timestamp: new Date().toISOString() };
  if (process.env.COMPOINT_EQUIPO) salud.equipo = process.env.COMPOINT_EQUIPO; // solo en modo servidor local
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
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Lo que se mandó es demasiado grande' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos mal formados' });
  res.status(500).json({ error: 'Ocurrió un error inesperado en el servidor' });
});

process.on('unhandledRejection', (razon) => {
  console.error(`[${new Date().toISOString()}] Promesa rechazada sin manejar:`, razon);
});

const PORT = process.env.PORT || 3000;
// Primero se ponen al día las migraciones de la base de datos de ESTA
// instalación; si fallan, el servidor arranca igual (queda el aviso en los Logs).
migrar()
  .catch((e) => console.error(`[${new Date().toISOString()}] Arranque sin completar migraciones:`, e.message))
  .finally(() => server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
    // Solicitudes de licencia que no se pudieron mandar por falta de internet: se reintentan solas.
    require('./utils/licenciaEnvio').iniciarReintentos(process.env.COMPOINT_ID_EQUIPO ? 'local' : 'nube');
    // Licencia central (solo en la nube y solo si Compoint puso COMPOINT_LICENCIA_TOKEN): consulta cada hora a compoint.com.mx.
    require('./utils/licenciaCentral').iniciar();
    // Pedidos programados que ya toca preparar y pedidos fijos de tiendas (cada minuto).
    rutaPedidos.iniciarTemporizador(io);
  }));

// Para el modo servidor local (la app de escritorio lo arranca y lo detiene).
module.exports = { app, server, io, pool };
