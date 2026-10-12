// Genera config-cliente.json (la dirección de ESTE cliente) que se mete dentro
// del instalador. Se toma de las variables de entorno:
//   CLIENTE_URL     dirección del sistema del cliente (ej. https://cliente1.onrender.com/login.html)
//   CLIENTE_NOMBRE  nombre del negocio (sale en el título de la ventana)
// También crea CLIENTE_ARCHIVO (para el nombre del instalador) en GITHUB_ENV si existe.
const fs = require('fs');
const path = require('path');

const url = (process.env.CLIENTE_URL || '').trim();
const nombre = (process.env.CLIENTE_NOMBRE || 'Compoint Punto').trim();
if (url && !/^https?:\/\//i.test(url)) {
  console.error('CLIENTE_URL debe empezar con http:// o https://');
  process.exit(1);
}
const config = { url, nombre, intermediario: true, iniciarConWindows: true };
fs.writeFileSync(path.join(__dirname, '..', 'config-cliente.json'), JSON.stringify(config, null, 2));

const archivo = (nombre || 'Compoint').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'Compoint';
process.env.CLIENTE_ARCHIVO = archivo;
if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `CLIENTE_ARCHIVO=${archivo}\n`);
console.log('config-cliente.json:', config, '| archivo:', archivo);
module.exports = { archivo };
