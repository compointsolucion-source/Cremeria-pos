// Una actualización automática no debe quitarle a un cliente la dirección de su sistema.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cambiosAConservar, combinar } = require('../src/config-cliente');

const POR_OMISION = { nombre: 'Compoint Punto', intermediario: true, iniciarConWindows: true };
const DEL_CLIENTE = { url: 'https://cliente1.onrender.com/login.html', nombre: 'Cliente 1', intermediario: true };
const GENERICO = { url: '', nombre: 'Compoint Punto', intermediario: true, iniciarConWindows: true };

test('la primera vez guarda la dirección que trae el instalador del cliente', () => {
  assert.deepEqual(cambiosAConservar(DEL_CLIENTE, {}), { urlCliente: DEL_CLIENTE.url, nombreCliente: 'Cliente 1' });
});

test('si ya está guardada la misma dirección no hay nada que guardar', () => {
  assert.equal(cambiosAConservar(DEL_CLIENTE, { urlCliente: DEL_CLIENTE.url }), null);
});

test('tras una actualización (instalador genérico) la dirección guardada se conserva', () => {
  const usuario = { urlCliente: DEL_CLIENTE.url, nombreCliente: 'Cliente 1' };
  assert.equal(cambiosAConservar(GENERICO, usuario), null); // el genérico no pisa lo guardado
  const c = combinar(POR_OMISION, GENERICO, usuario);
  assert.equal(c.url, DEL_CLIENTE.url);
  assert.equal(c.nombre, 'Cliente 1');
});

test('si se instala a mano el instalador de OTRO negocio, la dirección nueva sí reemplaza a la vieja', () => {
  const nuevo = { url: 'https://otro.onrender.com/login.html', nombre: 'Otro' };
  assert.deepEqual(cambiosAConservar(nuevo, { urlCliente: DEL_CLIENTE.url }), { urlCliente: nuevo.url, nombreCliente: 'Otro' });
});

test('lo que el usuario cambia a mano (Cambiar dirección) manda sobre todo', () => {
  const c = combinar(POR_OMISION, DEL_CLIENTE, { urlCliente: DEL_CLIENTE.url, url: 'https://manual.example/login.html' });
  assert.equal(c.url, 'https://manual.example/login.html');
});

test('un instalador genérico sin nada guardado queda sin dirección (abre la pantalla de configuración)', () => {
  assert.equal(cambiosAConservar(GENERICO, {}), null);
  assert.equal(combinar(POR_OMISION, GENERICO, {}).url, '');
});
