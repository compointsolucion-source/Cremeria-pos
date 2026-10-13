// Copia el servidor del sistema (backend) y las páginas (frontend) dentro de escritorio/servidor,
// para incluirlos en el instalador (modo servidor del negocio). Se ejecuta antes de armar el instalador.
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..', '..');
const destino = path.join(__dirname, '..', 'servidor');

function copiar(origen, dest, excluir) {
  fs.cpSync(origen, dest, {
    recursive: true,
    filter: (src) => !excluir.some((e) => src.split(path.sep).includes(e) || path.basename(src) === e)
  });
}

fs.rmSync(destino, { recursive: true, force: true });
copiar(path.join(raiz, 'backend'), path.join(destino, 'backend'), ['node_modules', '.env', 'package-lock.json']);
copiar(path.join(raiz, 'frontend'), path.join(destino, 'frontend'), ['node_modules', '.DS_Store']);
if (!fs.existsSync(path.join(destino, 'backend', 'server.js')) || !fs.existsSync(path.join(destino, 'backend', 'scripts', 'schema.sql'))
  || !fs.existsSync(path.join(destino, 'frontend', 'login.html'))) {
  console.error('Faltan archivos del sistema (backend/server.js, backend/scripts/schema.sql o frontend/login.html).');
  process.exit(1);
}
console.log('Servidor y páginas copiados a escritorio/servidor');
