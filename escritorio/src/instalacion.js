// Opciones elegidas en el instalador de Compoint Punto.
// El instalador deja un archivo `instalacion.json` en  %LOCALAPPDATA%\CompointPunto\ ;
// la primera vez que abre la app se leen, se guardan en su configuración y el archivo se marca como aplicado.
//
// Formato (version 1). Todo es opcional; lo que no viene, no se cambia:
//   { "version": 1,
//     "modo": "servidor" | "cliente",
//     "carpetaDatos": "D:\\Negocio\\datos",
//     "carpetaRespaldos": "D:\\Negocio\\Respaldos",     ("" = volver a la carpeta estándar)
//     "copiaExtra": "E:\\Respaldos Compoint",           ("" = sin copia extra)
//     "iniciarConWindows": true, "intermediario": true }
const fs = require('fs');
const path = require('path');

// Ruta de Windows o de Linux/Mac, absoluta, sin caracteres raros.
function carpetaValida(t) {
  const s = String(t == null ? '' : t).trim();
  if (!s || s.length > 240) return '';
  if (!(path.win32.isAbsolute(s) || path.posix.isAbsolute(s))) return '';
  if (/[<>"|?*\u0000-\u001f]/.test(s.replace(/^[A-Za-z]:/, ''))) return '';
  if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return '';
  return s;
}

const mismaRuta = (a, b) => String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase();

/**
 * Convierte el contenido del archivo en cambios de configuración.
 * @param {object} datos          contenido ya leído del JSON
 * @param {object} ctx            { datosActuales: [rutas donde puede haber información del negocio], existeDatos: (ruta)=>bool, modoActual }
 * @returns {{ cambios: object, avisos: string[] }}
 */
function interpretar(datos, ctx = {}) {
  const cambios = {};
  const avisos = [];
  if (!datos || typeof datos !== 'object' || datos.version !== 1) {
    avisos.push('El archivo del instalador no tiene un formato conocido; se ignora.');
    return { cambios, avisos };
  }
  const existeDatos = ctx.existeDatos || (() => false);

  if (datos.modo === 'servidor') cambios.modo = 'servidor';

  if (typeof datos.carpetaDatos === 'string' && datos.carpetaDatos.trim()) {
    const nueva = carpetaValida(datos.carpetaDatos);
    if (!nueva) avisos.push('La carpeta de datos elegida no es válida; se deja la actual.');
    else {
      // Si ya hay información del negocio en otro lugar, NO se cambia: el sistema arrancaría con un negocio vacío.
      const previa = (ctx.datosActuales || []).filter(Boolean).find((r) => existeDatos(r) && !mismaRuta(r, nueva));
      if (previa) avisos.push('Ya hay información del negocio en ' + previa + '; se conserva ahí (no se cambia a ' + nueva + ').');
      else cambios.carpetaDatos = nueva;
    }
  }
  if (typeof datos.carpetaRespaldos === 'string') {
    const t = datos.carpetaRespaldos.trim();
    if (!t) cambios.carpetaRespaldos = '';
    else { const v = carpetaValida(t); if (v) cambios.carpetaRespaldos = v; else avisos.push('La carpeta de respaldos elegida no es válida; se deja la actual.'); }
  }
  if (typeof datos.copiaExtra === 'string') {
    const t = datos.copiaExtra.trim();
    if (!t) cambios.copiaExtra = '';
    else { const v = carpetaValida(t); if (v) cambios.copiaExtra = v; else avisos.push('La carpeta de la copia extra no es válida; se ignora.'); }
  }
  if (typeof datos.iniciarConWindows === 'boolean') cambios.iniciarConWindows = datos.iniciarConWindows;
  if (typeof datos.intermediario === 'boolean') cambios.intermediario = datos.intermediario;
  return { cambios, avisos };
}

/**
 * Lee el archivo del instalador (si existe), guarda los cambios y lo marca como aplicado.
 * @param {object} o { archivo, guardar: (cambios)=>void, datosActuales, log }
 * @returns {{ aplicado: boolean, cambios?: object }}
 */
function aplicar({ archivo, guardar, datosActuales = [], log = () => {} }) {
  let texto;
  try { texto = fs.readFileSync(archivo, 'utf8'); } catch (e) { return { aplicado: false }; }
  const marcar = (sufijo) => { try { fs.renameSync(archivo, archivo.replace(/\.json$/i, '') + '.' + sufijo + '.json'); } catch (e) { try { fs.unlinkSync(archivo); } catch (e2) { /* ignorar */ } } };
  let datos;
  try { datos = JSON.parse(texto.replace(/^\uFEFF/, '')); } catch (e) { log('Opciones del instalador: archivo ilegible (' + e.message + ')'); marcar('invalida'); return { aplicado: false }; }
  const { cambios, avisos } = interpretar(datos, {
    datosActuales,
    existeDatos: (r) => { try { return fs.existsSync(path.join(r, 'PG_VERSION')); } catch (e) { return false; } }
  });
  avisos.forEach((a) => log('Opciones del instalador: ' + a));
  if (Object.keys(cambios).length) { guardar(cambios); log('Opciones del instalador aplicadas: ' + JSON.stringify(cambios)); }
  marcar('aplicada');
  return { aplicado: true, cambios };
}

module.exports = { aplicar, interpretar, carpetaValida };
