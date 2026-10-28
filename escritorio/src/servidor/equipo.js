// Identificador de ESTA computadora y marcas de la licencia (prueba de 15 días).
//
// - El identificador sale del "MachineGuid" de Windows: no cambia aunque se desinstale
//   y se vuelva a instalar el sistema, así el mismo código de activación sigue valiendo.
// - Las marcas son 2 o 3 archivitos (fuera de la carpeta de datos del negocio) donde el
//   sistema anota cuándo empezó la prueba. Si se desinstala y se reinstala, la prueba
//   NO empieza de cero. Las firma el propio sistema (ver backend/utils/licencia.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function parsearMachineGuid(salida) {
  const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{16,})/.exec(String(salida || ''));
  return m ? m[1].toLowerCase() : null;
}

function leerMachineGuidWindows() {
  try {
    const salida = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return parsearMachineGuid(salida);
  } catch (e) { return null; }
}

// obtenerPropio / guardarPropio: respaldo (un identificador al azar que se guarda en la configuración)
// por si Windows no deja leer el MachineGuid.
function idDeEquipo({ plataforma = process.platform, leerWindows = leerMachineGuidWindows, obtenerPropio, guardarPropio } = {}) {
  if (plataforma === 'win32') {
    const g = leerWindows();
    if (g) return g;
  } else {
    try { const t = fs.readFileSync('/etc/machine-id', 'utf8').trim(); if (t.length >= 16) return t; } catch (e) { /* no hay */ }
  }
  let propio = obtenerPropio && obtenerPropio();
  if (!propio) { propio = crypto.randomUUID(); if (guardarPropio) guardarPropio(propio); }
  return propio;
}

// Dónde se dejan las marcas de la licencia (varias, para que borrar una sola no las quite todas).
function rutasMarcas({ env = process.env, plataforma = process.platform, casa = os.homedir() } = {}) {
  if (plataforma === 'win32') {
    const lista = [];
    if (env.LOCALAPPDATA) lista.push(path.win32.join(env.LOCALAPPDATA, 'CompointPunto', 'lic.dat'));
    if (env.APPDATA) lista.push(path.win32.join(env.APPDATA, 'Compoint', 'lic.dat'));
    if (env.ProgramData) lista.push(path.win32.join(env.ProgramData, 'Compoint', 'lic.dat'));
    return lista;
  }
  return [path.join(casa, '.local', 'share', 'CompointPunto', 'lic.dat'), path.join(casa, '.config', 'Compoint', 'lic.dat')];
}

module.exports = { parsearMachineGuid, idDeEquipo, rutasMarcas };
