// Modo servidor del negocio: base de datos + servidor web dentro de la app de escritorio.
// Las demás cajas entran por red local a  http://IP-DE-ESTA-PC:3000
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { rutas, leerJson, guardarJson } = require('./rutas');
const { iniciarPostgres } = require('./postgres');
const { baseVacia, crearNegocio } = require('./negocio');
const { crearGestor, restaurarRespaldo } = require('./respaldos');

const PUERTO_WEB = 3000;
const PUERTO_PG = 54329;

function direccionesRed(puerto) {
  const out = [];
  const nombre = os.hostname();
  if (nombre) out.push(`http://${nombre}:${puerto}`);
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const i of lista || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${puerto}`);
  }
  return out;
}

function puertoLibre(puerto) {
  return new Promise((ok) => {
    const t = require('net').createServer();
    t.once('error', () => ok(false));
    t.once('listening', () => t.close(() => ok(true)));
    t.listen(puerto, '0.0.0.0');
  });
}

function esperarSalud(puerto, intentos = 60) {
  return new Promise((resolver, rechazar) => {
    const probar = (n) => {
      const req = http.get({ host: '127.0.0.1', port: puerto, path: '/health', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolver(); else reintentar(n);
      });
      req.on('error', () => reintentar(n));
      req.on('timeout', () => { req.destroy(); reintentar(n); });
    };
    const reintentar = (n) => (n <= 0 ? rechazar(new Error('El servidor no respondió a tiempo.')) : setTimeout(() => probar(n - 1), 1000));
    probar(intentos);
  });
}

/**
 * @param {object} o  { app, dirServidor, pedirDatosNegocio: async () => datos, avisar: (texto) => void, secretos: { cifrar, descifrar } }
 */
async function crearServidor({ app, dirServidor, pedirDatosNegocio, avisar = () => {}, secretos = {} }) {
  const cifrar = secretos.cifrar || ((t) => t);
  const descifrar = secretos.descifrar || ((t) => t);
  const r = rutas(app);
  const log = (t) => { try { fs.appendFileSync(r.log, new Date().toISOString() + ' ' + t + '\n'); } catch (e) { /* sin log */ } };

  // Claves internas (se generan una sola vez y se conservan)
  let cfg = leerJson(r.configuracion, {});
  if (!cfg.jwt_secret || !cfg.db_password) {
    cfg = { puerto_web: PUERTO_WEB, puerto_pg: PUERTO_PG, ...cfg,
      jwt_secret: cfg.jwt_secret || crypto.randomBytes(32).toString('hex'),
      db_password: cfg.db_password || crypto.randomBytes(18).toString('hex') };
    guardarJson(r.configuracion, cfg);
  }
  const guardarCfg = (cambios) => { cfg = { ...cfg, ...cambios }; guardarJson(r.configuracion, cfg); };
  const puertoWeb = cfg.puerto_web || PUERTO_WEB;

  avisar('Encendiendo la base de datos…');
  const bd = await iniciarPostgres({ dirDatos: r.datos, puerto: cfg.puerto_pg || PUERTO_PG, password: cfg.db_password, log });

  if (await baseVacia(bd.url)) {
    avisar('Primera vez: preparando el negocio…');
    const datos = await pedirDatosNegocio();
    if (!datos) { await bd.detener(); throw new Error('CANCELADO'); }
    await crearNegocio(bd.url, datos, dirServidor);
    guardarCfg({ negocio: datos.negocio.trim() });
    log('Negocio creado: ' + datos.negocio);
  }

  // Variables que usa el servidor del sistema
  process.env.DATABASE_URL = bd.url;
  process.env.DB_SSL = 'false';
  process.env.JWT_SECRET = cfg.jwt_secret;
  process.env.PORT = String(puertoWeb);
  process.env.HOST = '0.0.0.0';
  process.env.COMPOINT_EQUIPO = os.hostname();
  process.env.FRONTEND_DIR = path.join(dirServidor, 'frontend');
  process.env.MAX_SUCURSALES = String(cfg.max_sucursales || 1);
  const nubeActual = () => { const n = cfg.nube || {}; let secreto = ''; try { secreto = n.api_secret_cifrado ? descifrar(n.api_secret_cifrado) : (n.api_secret || ''); } catch (e) { secreto = ''; } return { cloud_name: n.cloud_name || '', api_key: n.api_key || '', api_secret: secreto }; };
  const nube = nubeActual();
  if (nube.cloud_name) { process.env.CLOUDINARY_CLOUD_NAME = nube.cloud_name; process.env.CLOUDINARY_API_KEY = nube.api_key || ''; process.env.CLOUDINARY_API_SECRET = nube.api_secret || ''; }

  if (!(await puertoLibre(puertoWeb))) {
    await bd.detener();
    throw new Error(`El puerto ${puertoWeb} está ocupado por otro programa (o ya hay otro Compoint Punto abierto). Ciérralo e intenta de nuevo.`);
  }
  avisar('Iniciando el sistema…');
  const backend = require(path.join(dirServidor, 'backend', 'server.js'));
  await esperarSalud(puertoWeb);
  log('Servidor web listo en el puerto ' + puertoWeb);

  const respaldos = crearGestor({
    rutas: r, urlBase: bd.url, log,
    obtenerNegocio: () => cfg.negocio || 'negocio',
    obtenerNube: nubeActual
  });

  async function apagarWeb() {
    await new Promise((ok) => { try { backend.io.close(() => ok()); } catch (e) { ok(); } setTimeout(ok, 3000); });
    await new Promise((ok) => { try { backend.server.close(() => ok()); } catch (e) { ok(); } setTimeout(ok, 3000); });
    try { await backend.pool.end(); } catch (e) { /* ya cerrada */ }
  }

  return {
    rutas: r, respaldos, puertoWeb,
    urlLocal: `http://localhost:${puertoWeb}`,
    direcciones: () => direccionesRed(puertoWeb),
    configuracion: () => ({ ...cfg, db_password: undefined, jwt_secret: undefined }),
    guardarNube: (n) => {
      const previa = nubeActual();
      const secreto = n.api_secret ? n.api_secret : previa.api_secret; // vacío = conservar el actual
      guardarCfg({ nube: { cloud_name: String(n.cloud_name || '').trim(), api_key: String(n.api_key || '').trim(), api_secret_cifrado: secreto ? cifrar(secreto) : '' } });
      process.env.CLOUDINARY_CLOUD_NAME = cfg.nube.cloud_name; process.env.CLOUDINARY_API_KEY = cfg.nube.api_key; process.env.CLOUDINARY_API_SECRET = secreto || '';
    },
    nube: nubeActual,
    async detener() { await apagarWeb(); await bd.detener(); },
    async restaurar(archivo) {
      // Se apaga el servidor web, se restaura, y la app debe reiniciarse.
      await apagarWeb();
      const res = await restaurarRespaldo({ url: bd.url, archivo, dirServidor, log });
      await bd.detener();
      return res;
    }
  };
}

module.exports = { crearServidor, direccionesRed };
