// Carpetas del modo servidor. Todo vive en una carpeta fácil de encontrar en el
// disco local donde está instalado Windows:  C:\CompointPunto
//   datos\      base de datos del negocio (NO tocar)
//   Respaldos\  copias de seguridad automáticas
//   servidor.json  claves internas y datos del negocio
const path = require('path');
const fs = require('fs');
const os = require('os');

function carpetaBase(app) {
  const candidatos = [];
  if (process.env.COMPOINT_DATA_DIR) candidatos.push(process.env.COMPOINT_DATA_DIR);
  candidatos.push(process.platform === 'win32'
    ? path.join(process.env.SystemDrive || 'C:', '\\', 'CompointPunto')
    : path.join(os.homedir(), 'CompointPunto'));
  candidatos.push(path.join(app.getPath('userData'), 'servidor'));
  for (const c of candidatos) {
    try { fs.mkdirSync(c, { recursive: true }); fs.accessSync(c, fs.constants.W_OK); return c; } catch (e) { /* probar la siguiente */ }
  }
  throw new Error('No se pudo crear la carpeta de datos del servidor.');
}

function rutas(app) {
  const base = carpetaBase(app);
  const r = {
    base,
    datos: path.join(base, 'datos'),
    respaldos: path.join(base, 'Respaldos'),
    configuracion: path.join(base, 'servidor.json'),
    estadoRespaldos: path.join(base, 'Respaldos', 'estado.json'),
    log: path.join(base, 'servidor-log.txt')
  };
  fs.mkdirSync(r.respaldos, { recursive: true });
  return r;
}

function leerJson(ruta, porDefecto = {}) { try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (e) { return porDefecto; } }
function guardarJson(ruta, obj) {
  const tmp = ruta + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, ruta);
}

module.exports = { rutas, leerJson, guardarJson };
