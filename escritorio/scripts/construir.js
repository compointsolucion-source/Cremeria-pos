// Genera la config del cliente y arma el instalador con electron-builder.
// Con PUBLICAR_ACTUALIZACION=1 (lo hace el flujo "Publicar actualización" de GitHub) también sube la versión
// a GitHub Releases, que es de donde los programas instalados bajan sus actualizaciones.
const { spawnSync } = require('child_process');
const path = require('path');
const { archivo } = require('./generar-config');
const prep = spawnSync(process.execPath, [path.join(__dirname, 'preparar-servidor.js')], { stdio: 'inherit' });
if (prep.status !== 0) process.exit(prep.status || 1);
const bin = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const r = spawnSync(bin, ['--win', 'nsis', '--x64', '--publish', process.env.PUBLICAR_ACTUALIZACION === '1' ? 'always' : 'never'], {
  stdio: 'inherit', shell: process.platform === 'win32',
  env: { ...process.env, CLIENTE_ARCHIVO: archivo }
});
process.exit(r.status === null ? 1 : r.status);
