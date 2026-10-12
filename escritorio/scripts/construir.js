// Genera la config del cliente y arma el instalador con electron-builder.
const { spawnSync } = require('child_process');
const path = require('path');
const { archivo } = require('./generar-config');
const bin = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const r = spawnSync(bin, ['--win', 'nsis', '--x64', '--publish', 'never'], {
  stdio: 'inherit', shell: process.platform === 'win32',
  env: { ...process.env, CLIENTE_ARCHIVO: archivo }
});
process.exit(r.status === null ? 1 : r.status);
