// Pruebas del identificador de equipo y de las marcas de la licencia (no necesitan Windows).
// Se corren con:  cd escritorio && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { parsearMachineGuid, idDeEquipo, rutasMarcas } = require('../src/servidor/equipo');

const SALIDA_REG = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography
    MachineGuid    REG_SZ    4F2A9C1E-7B3D-4E8A-9C55-0123456789AB

`;

test('MachineGuid: se saca de la salida de «reg query»', () => {
  assert.equal(parsearMachineGuid(SALIDA_REG), '4f2a9c1e-7b3d-4e8a-9c55-0123456789ab');
  assert.equal(parsearMachineGuid('ERROR: no se encuentra el valor'), null);
  assert.equal(parsearMachineGuid(''), null);
  assert.equal(parsearMachineGuid(null), null);
});

test('idDeEquipo: en Windows usa el MachineGuid', () => {
  const id = idDeEquipo({ plataforma: 'win32', leerWindows: () => 'abc-123-guid-de-prueba' });
  assert.equal(id, 'abc-123-guid-de-prueba');
});

test('idDeEquipo: si Windows no lo da, crea uno propio, lo guarda y siempre devuelve el mismo', () => {
  let guardado = null;
  const opciones = { plataforma: 'win32', leerWindows: () => null, obtenerPropio: () => guardado, guardarPropio: (x) => { guardado = x; } };
  const a = idDeEquipo(opciones);
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.equal(guardado, a);
  assert.equal(idDeEquipo(opciones), a);
});

test('rutasMarcas: varias carpetas de Windows, fuera de la carpeta de datos del negocio', () => {
  const r = rutasMarcas({ plataforma: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local', APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming', ProgramData: 'C:\\ProgramData' } });
  assert.deepEqual(r, [
    'C:\\Users\\Ana\\AppData\\Local\\CompointPunto\\lic.dat',
    'C:\\Users\\Ana\\AppData\\Roaming\\Compoint\\lic.dat',
    'C:\\ProgramData\\Compoint\\lic.dat'
  ]);
  assert.ok(r.every((x) => !/CompointPunto\\datos/i.test(x)));
});

test('rutasMarcas: si faltan variables de Windows, solo usa las que existen', () => {
  assert.deepEqual(rutasMarcas({ plataforma: 'win32', env: { APPDATA: 'C:\\A' } }), ['C:\\A\\Compoint\\lic.dat']);
  assert.deepEqual(rutasMarcas({ plataforma: 'win32', env: {} }), []);
});

test('rutasMarcas: fuera de Windows (desarrollo) usa la carpeta personal', () => {
  const r = rutasMarcas({ plataforma: 'linux', casa: '/home/ana' });
  assert.equal(r.length, 2);
  assert.ok(r.every((x) => x.startsWith(path.join('/home/ana', '.'))));
});
