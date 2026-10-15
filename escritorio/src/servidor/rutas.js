// Carpetas del modo servidor. Por defecto todo vive en una carpeta fácil de encontrar en el
// disco local donde está instalado Windows:  C:\CompointPunto
//   datos\      base de datos del negocio (NO tocar)
//   Respaldos\  copias de seguridad automáticas
//   servidor.json  claves internas y datos del negocio
// El instalador (modo Avanzado) permite elegir otras carpetas para datos, respaldos y una
// copia extra de los respaldos (por ejemplo una USB). Esas elecciones llegan en `extra`.
const path = require('path');
const fs = require('fs');
const os = require('os');

function candidatosBase() {
  const candidatos = [];
  if (process.env.COMPOINT_DATA_DIR) candidatos.push(process.env.COMPOINT_DATA_DIR);
  candidatos.push(process.platform === 'win32'
    ? path.join(process.env.SystemDrive || 'C:', '\\', 'CompointPunto')
    : path.join(os.homedir(), 'CompointPunto'));
  return candidatos;
}

function carpetaBase(app) {
  const candidatos = candidatosBase();
  candidatos.push(path.join(app.getPath('userData'), 'servidor'));
  for (const c of candidatos) {
    try { fs.mkdirSync(c, { recursive: true }); fs.accessSync(c, fs.constants.W_OK); return c; } catch (e) { /* probar la siguiente */ }
  }
  throw new Error('No se pudo crear la carpeta de datos del servidor.');
}

// Ruta absoluta y limpia, o '' si no sirve.
function limpiaRuta(t) {
  const s = String(t == null ? '' : t).trim();
  if (!s || s.length > 240) return '';
  return path.isAbsolute(s) ? path.normalize(s) : '';
}

// ¿Se puede escribir en la carpeta? (la crea si falta)
function usable(c) {
  try {
    fs.mkdirSync(c, { recursive: true });
    const prueba = path.join(c, '.compoint-prueba-' + process.pid);
    fs.writeFileSync(prueba, 'x');
    fs.unlinkSync(prueba);
    return true;
  } catch (e) { return false; }
}

/** Dónde quedarían las carpetas, sin crear nada (para mostrarlas en pantalla). */
function rutasPrevistas(extra = {}) {
  const base = candidatosBase()[0];
  return {
    base,
    datos: limpiaRuta(extra.datos) || path.join(base, 'datos'),
    respaldos: limpiaRuta(extra.respaldos) || path.join(base, 'Respaldos'),
    copiaExtra: limpiaRuta(extra.copiaExtra)
  };
}

/**
 * Prepara las carpetas del servidor.
 * extra: { datos, respaldos, copiaExtra } elegidas en el instalador (todas opcionales).
 * - datos: si la carpeta elegida no se puede usar, se detiene con un mensaje claro (nunca se cambia sola
 *   a otra, porque arrancaría un negocio vacío).
 * - respaldos: si no se puede usar (p. ej. USB desconectada), se usa la carpeta estándar y se avisa.
 * - copiaExtra: no se crea al arrancar (la unidad puede no estar conectada); se intenta en cada respaldo.
 */
function rutas(app, extra = {}) {
  const base = carpetaBase(app);
  const avisos = [];
  const pedidoDatos = limpiaRuta(extra.datos);
  const pedidoResp = limpiaRuta(extra.respaldos);

  let datos = path.join(base, 'datos');
  if (pedidoDatos) {
    if (!usable(pedidoDatos)) {
      throw new Error('No se pudo usar la carpeta elegida para la información del negocio:\n' + pedidoDatos +
        '\n\nRevisa que la unidad esté conectada. Si cambió de letra, vuelve a ejecutar el instalador y elige otra carpeta.');
    }
    datos = pedidoDatos;
  }

  const respaldosPorDefecto = path.join(base, 'Respaldos');
  let respaldos = respaldosPorDefecto;
  if (pedidoResp) {
    if (usable(pedidoResp)) respaldos = pedidoResp;
    else avisos.push('No se pudo usar la carpeta de respaldos elegida (' + pedidoResp + '). Mientras tanto se guardan en ' + respaldosPorDefecto + '.');
  }
  fs.mkdirSync(respaldosPorDefecto, { recursive: true });
  fs.mkdirSync(respaldos, { recursive: true });

  return {
    base,
    datos,
    respaldos,
    respaldosPorDefecto,
    copiaExtra: limpiaRuta(extra.copiaExtra),
    configuracion: path.join(base, 'servidor.json'),
    // Con la carpeta estándar el estado sigue donde siempre; con una carpeta propia se guarda en la base
    // (así no depende de que una USB esté conectada).
    estadoRespaldos: respaldos === respaldosPorDefecto && !pedidoResp
      ? path.join(respaldos, 'estado.json')
      : path.join(base, 'estado-respaldos.json'),
    log: path.join(base, 'servidor-log.txt'),
    avisos
  };
}

function leerJson(ruta, porDefecto = {}) { try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (e) { return porDefecto; } }
function guardarJson(ruta, obj) {
  const tmp = ruta + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, ruta);
}

module.exports = { rutas, rutasPrevistas, limpiaRuta, usable, leerJson, guardarJson };
