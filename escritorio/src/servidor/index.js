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
const { Client } = require('pg');
const { crearGestor, restaurarRespaldo } = require('./respaldos');
const { crearSincronizador, resolverApi, vincularConUsuario, iniciarSesionDueno, vincularConToken, leerNube } = require('./sync');
const { traerDeNube: traerInfoDeNube, mensajeAmable } = require('./traer');
const { idDeEquipo, rutasMarcas } = require('./equipo');

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

// Nombre del negocio y cuántas sucursales trae la información que acaba de bajar de la nube.
async function datosDelNegocio(url) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query('SELECT nombre FROM sucursales ORDER BY id');
    return { nombre: (r.rows[0] && r.rows[0].nombre) || 'negocio', sucursales: r.rows.length };
  } catch (e) { return { nombre: 'negocio', sucursales: 1 }; } finally { await c.end().catch(() => {}); }
}

// ¿Hay información capturada en esta computadora? (para no vaciar la nube por error)
async function resumenLocal(url) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const n = async (t) => { try { return Number((await c.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n); } catch (e) { return 0; } };
    return { productos: await n('productos'), ventas: await n('tickets'), clientes: await n('clientes') };
  } finally { await c.end().catch(() => {}); }
}

/**
 * @param {object} o  { app, dirServidor, pedirDatosNegocio: async () => datos, avisar: (texto) => void, secretos: { cifrar, descifrar },
 *                   carpetas: { datos, respaldos, copiaExtra } elegidas en el instalador (opcionales) }
 */
async function crearServidor({ app, dirServidor, pedirDatosNegocio, avisar = () => {}, secretos = {}, carpetas = {} }) {
  const cifrar = secretos.cifrar || ((t) => t);
  const descifrar = secretos.descifrar || ((t) => t);
  const r = rutas(app, carpetas);
  const log = (t) => { try { fs.appendFileSync(r.log, new Date().toISOString() + ' ' + t + '\n'); } catch (e) { /* sin log */ } };
  for (const aviso of r.avisos || []) log(aviso);

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

  let traidoDeNube = false;
  avisar('Encendiendo la base de datos…');
  const bd = await iniciarPostgres({ dirDatos: r.datos, puerto: cfg.puerto_pg || PUERTO_PG, password: cfg.db_password, log });

  if (await baseVacia(bd.url)) {
    avisar('Primera vez: preparando el negocio…');
    const datos = await pedirDatosNegocio();
    if (!datos) { await bd.detener(); throw new Error('CANCELADO'); }
    if (datos.modo === 'nube' && datos.sesion) {
      // El negocio ya existe en la nube: se baja toda su información a esta computadora.
      avisar('Bajando tu información de la nube… (puede tardar unos minutos)');
      try {
        await traerInfoDeNube({ url: bd.url, dirServidor, sesion: datos.sesion, avisar, log, prepararAntes: true, limpiarSiFalla: true });
      } catch (e) { await bd.detener(); throw e; }
      traidoDeNube = true;
      const dn = await datosDelNegocio(bd.url);
      // Si la nube ya tenía varias sucursales, aquí también caben (el tope lo fija además la licencia).
      guardarCfg({ negocio: dn.nombre, max_sucursales: Math.max(cfg.max_sucursales || 1, dn.sucursales), traido_de_nube: new Date().toISOString() });
      log('Negocio traído de la nube: ' + (cfg.negocio || ''));
      // Desde aquí esta computadora es la principal: lo que se registre se sube a la nube (sin volver a copiar todo).
      try {
        const { clave } = await vincularConToken(datos.sesion.api, datos.sesion.token);
        guardarCfg({ sync: { api: datos.sesion.api, texto: datos.sesion.texto, clave_cifrada: cifrar(clave) } });
      } catch (e) { log('Traído de la nube, pero no se pudo conectar la sincronización: ' + mensajeAmable(e)); }
      // La licencia del cliente se toma en cuanto arranque el sistema (más abajo).
      guardarCfg({ licencia_nube_pendiente: datos.sesion.licencia || null });
    } else {
      await crearNegocio(bd.url, datos, dirServidor);
      guardarCfg({ negocio: datos.negocio.trim() });
      log('Negocio creado: ' + datos.negocio);
    }
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
  // Licencia: identificador de ESTA computadora (liga el código de activación) y marcas de la prueba de 30 días.
  process.env.COMPOINT_ID_EQUIPO = idDeEquipo({ obtenerPropio: () => cfg.id_equipo, guardarPropio: (id) => guardarCfg({ id_equipo: id }) });
  process.env.COMPOINT_MARCAS = JSON.stringify(rutasMarcas());
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

  // Sincronización con la nube (local → nube). Se arranca ya con las migraciones aplicadas.
  const sync = crearSincronizador({ url: bd.url, rutas: r, log, obtenerConfig: () => cfg.sync, descifrar });
  if (traidoDeNube) sync.marcarAlDia(); // la nube y esta computadora ya tienen lo mismo: no hace falta copiar todo
  sync.iniciar().catch((e) => log('Sincronización no pudo iniciar: ' + e.message));

  // Licencia del cliente: si esta computadora está conectada con la nube del cliente, toma la licencia de ahí
  // (se quita la prueba de 30 días) y se mantiene al día cuando Compoint la renueva.
  const modLicencia = require(path.join(dirServidor, 'backend', 'utils', 'licencia.js'));
  async function tomarLicencia(info, origen) {
    if (!info) return null;
    try {
      const res = await modLicencia.adoptarDeNube(info);
      log(`Licencia de la nube (${origen}): ` + (res.adoptada ? 'tomada (' + res.origen + ')' : 'sin cambios (' + res.motivo + ')'));
      return res;
    } catch (e) { log('Licencia de la nube: ' + e.message); return null; }
  }
  async function refrescarLicencia() {
    if (!(cfg.sync && cfg.sync.api)) return null;
    const info = await sync.licenciaDeNube();
    if (!info) return null;
    guardarCfg({ licencia_nube_revisada: new Date().toISOString() });
    return tomarLicencia(info, 'revisión');
  }
  if (cfg.licencia_nube_pendiente) {
    await tomarLicencia(cfg.licencia_nube_pendiente, 'al traer la información');
    guardarCfg({ licencia_nube_pendiente: null });
  }
  const t1 = setTimeout(() => { refrescarLicencia().catch(() => {}); }, 45 * 1000);
  const t2 = setInterval(() => { refrescarLicencia().catch(() => {}); }, 6 * 3600 * 1000);
  [t1, t2].forEach((t) => { if (t.unref) t.unref(); });

  // Seguro contra vaciar la nube: conectar la sincronización copia esta computadora HACIA la nube.
  // Si la nube ya tiene información y esta computadora está vacía, se detiene y se explica qué hacer.
  async function protegerNube(api, credencial) {
    let est;
    try { est = await leerNube(api, '/sync/exportar/estructura', { ...credencial, timeout: 60000 }); }
    catch (e) { if (e.http === 404) return; throw e; } // una nube sin la actualización no tiene cómo bajarse: se sigue como antes
    const t = (est && est.tablas) || {};
    const enNube = { productos: (t.productos || {}).filas || 0, ventas: (t.tickets || {}).filas || 0 };
    if (!enNube.productos && !enNube.ventas) return;
    const aqui = await resumenLocal(bd.url);
    if (aqui.productos || aqui.ventas || aqui.clientes) return;
    const err = new Error(`Tu sistema en la nube ya tiene información (${enNube.productos} productos y ${enNube.ventas} ventas) y esta computadora todavía está vacía. ` +
      'Si se conecta así, la nube quedaría vacía. Primero usa el botón «Bajar de la nube» para traer esa información a esta computadora.');
    err.http = 409;
    throw err;
  }

  async function apagarWeb() {
    await new Promise((ok) => { try { backend.io.close(() => ok()); } catch (e) { ok(); } setTimeout(ok, 3000); });
    await new Promise((ok) => { try { backend.server.close(() => ok()); } catch (e) { ok(); } setTimeout(ok, 3000); });
    try { await backend.pool.end(); } catch (e) { /* ya cerrada */ }
  }

  return {
    rutas: r, respaldos, puertoWeb, sync,
    urlLocal: `http://localhost:${puertoWeb}`,
    direcciones: () => direccionesRed(puertoWeb),
    configuracion: () => ({ ...cfg, db_password: undefined, jwt_secret: undefined }),
    guardarNube: (n) => {
      const previa = nubeActual();
      const secreto = n.api_secret ? n.api_secret : previa.api_secret; // vacío = conservar el actual
      guardarCfg({ nube: { cloud_name: String(n.cloud_name || '').trim(), api_key: String(n.api_key || '').trim(), api_secret_cifrado: secreto ? cifrar(secreto) : '' } });
      process.env.CLOUDINARY_CLOUD_NAME = cfg.nube.cloud_name; process.env.CLOUDINARY_API_KEY = cfg.nube.api_key; process.env.CLOUDINARY_API_SECRET = secreto || '';
    },
    quitarNube: () => {
      guardarCfg({ nube: {} });
      delete process.env.CLOUDINARY_CLOUD_NAME; delete process.env.CLOUDINARY_API_KEY; delete process.env.CLOUDINARY_API_SECRET;
    },
    nube: nubeActual,
    // Cuánta información hay en esta computadora (para mostrarla en las confirmaciones).
    resumenLocal: () => resumenLocal(bd.url),
    // Guarda la conexión con la nube y arranca la copia completa inicial.
    // Lo normal: dirección + usuario y contraseña del dueño de la nube (la nube crea la clave sola).
    // También acepta una clave escrita a mano (la variable SYNC_KEY de Render) o conserva la guardada.
    // Si ya se abrió sesión con la nube (para mostrar los números en la confirmación), se reutiliza: no se vuelve a pedir la contraseña.
    async guardarSync({ texto, clave, usuario, password, sesion }) {
      const api = sesion ? sesion.api : await resolverApi(texto);
      const previa = cfg.sync || {};
      let claveFinal = String(clave || '').trim();
      let reemplazo = false;
      let token = null;
      if (!claveFinal && (sesion || String(usuario || '').trim() || password)) {
        token = sesion ? sesion.token : (await iniciarSesionDueno(api, usuario, password)).token;
        // Seguro: si la nube ya tiene información y esta computadora está vacía, conectar vaciaría la nube.
        await protegerNube(api, { token });
        ({ clave: claveFinal, reemplazo } = await vincularConToken(api, token));
      } else if (!claveFinal && previa.clave_cifrada) {
        try { claveFinal = descifrar(previa.clave_cifrada); } catch (e) { claveFinal = ''; }
      } else if (claveFinal && !previa.clave_cifrada) {
        await protegerNube(api, { clave: claveFinal });
      }
      if (!claveFinal) { const e = new Error('Escribe el usuario y la contraseña del dueño de tu sistema en la nube.'); e.http = 400; throw e; }
      if (claveFinal.length < 16) throw new Error('La clave debe tener al menos 16 caracteres.');
      await sync.probar(api, claveFinal); // lanza error si no hay conexión o la clave no coincide
      guardarCfg({ sync: { api, texto: String(texto).trim(), clave_cifrada: cifrar(claveFinal) } });
      await sync.activar();
      refrescarLicencia().catch(() => {}); // y de una vez toma la licencia del cliente
      return { api, reemplazo };
    },
    // Revisa la licencia de la nube ahora mismo (para el botón del panel). Devuelve el estado de la licencia.
    async revisarLicencia() {
      const res = await refrescarLicencia();
      return { conectada: !!(cfg.sync && cfg.sync.api), resultado: res ? { adoptada: !!res.adoptada, motivo: res.motivo || null } : null };
    },
    // Reemplaza TODO lo de esta computadora con la información de la nube. Lo llama el panel con la sesión ya abierta;
    // quien lo llama hace antes un respaldo y después reinicia el programa. Si algo falla, lo de aquí queda como estaba.
    async reemplazarConNube(sesion) {
      await sync.detener();
      await apagarWeb();
      await traerInfoDeNube({ url: bd.url, dirServidor, sesion, avisar, log, prepararAntes: false, limpiarSiFalla: false });
      let enlazada = false;
      try {
        const { clave } = await vincularConToken(sesion.api, sesion.token);
        guardarCfg({ sync: { api: sesion.api, texto: sesion.texto, clave_cifrada: cifrar(clave) } });
        enlazada = true;
      } catch (e) { log('Traído de la nube, pero no se pudo conectar la sincronización: ' + mensajeAmable(e)); }
      const dn = await datosDelNegocio(bd.url);
      guardarCfg({ negocio: dn.nombre, max_sucursales: Math.max(cfg.max_sucursales || 1, dn.sucursales), traido_de_nube: new Date().toISOString(), licencia_nube_pendiente: sesion.licencia || null });
      try { // lo que se anotó en la cola antes ya no sirve: todo viene de la nube
        const c = new Client({ connectionString: bd.url }); await c.connect();
        try { await c.query('DELETE FROM compoint_sync.cola'); } catch (e) { /* sin cola */ } finally { await c.end().catch(() => {}); }
      } catch (e) { /* ignorar */ }
      sync.marcarAlDia();
      await bd.detener();
      return { enlazada };
    },
    async quitarSync() { await sync.desvincular(); await sync.desactivar(); guardarCfg({ sync: {} }); },
    async detener() { clearTimeout(t1); clearInterval(t2); await sync.detener(); await apagarWeb(); await bd.detener(); },
    async restaurar(archivo) {
      // Se apaga el servidor web, se restaura, y la app debe reiniciarse.
      await sync.detener();
      await apagarWeb();
      const res = await restaurarRespaldo({ url: bd.url, archivo, dirServidor, log });
      if (cfg.sync && cfg.sync.api) sync.marcarCompleto(); // la base cambió por completo: se vuelve a copiar todo
      await bd.detener();
      return res;
    }
  };
}

module.exports = { crearServidor, direccionesRed };
