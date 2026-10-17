// Alertas de confirmación para SUBIR a la nube / BAJAR de la nube (se prueban sin abrir Electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/servidor/confirmaciones');

const aqui = { productos: 12, ventas: 340, clientes: 5 };
const nube = { productos: 1500, ventas: 20000, clientes: 80 };
const todo = (t) => JSON.stringify(t);

test('hay(): cuenta con separador de miles y avisa cuando no hay nada', () => {
  assert.match(c.hay(nube), /1,500 productos, 20,000 ventas y 80 clientes/);
  assert.equal(c.hay({ productos: 0, ventas: 0, clientes: 0 }), 'nada todavía');
  assert.equal(c.hay(null), '');
});

test('BAJAR: el primer paso dice la dirección, lo que se reemplaza y lo que llega', () => {
  const t = c.textosBajar({ aqui, nube });
  assert.match(t.paso1.mensaje, /BAJAR la información de la nube a esta computadora/);
  assert.match(t.paso1.detalle, /IGUAL que tu sistema en la nube/);
  assert.match(t.paso1.detalle, /hoy aquí hay: 12 productos, 340 ventas y 5 clientes/);
  assert.match(t.paso1.detalle, /Se bajará de la nube: 1,500 productos/);
  assert.match(t.paso1.detalle, /respaldo/);
});

test('BAJAR: el segundo paso pregunta «¿Está seguro…?» con el sentido claro', () => {
  const t = c.textosBajar({ aqui, nube });
  assert.match(t.paso2.mensaje, /^¿Está seguro de que quiere sincronizar este equipo con la información de la nube\?$/);
  assert.match(t.paso2.detalle, /BAJAR/);
  assert.match(t.paso2.detalle, /\(12 productos.*\) se reemplaza por lo de la nube \(1,500 productos/);
  assert.match(t.paso2.boton, /^Sí, bajar de la nube$/);
});

test('SUBIR: el primer paso dice qué pasa con la nube y con esta computadora', () => {
  const t = c.textosSubir({ aqui, nube, yaConectada: false });
  assert.match(t.paso1.mensaje, /SUBIR a la nube la información de esta computadora/);
  assert.match(t.paso1.detalle, /IGUAL que esta computadora/);
  assert.match(t.paso1.detalle, /hoy en la nube hay: 1,500 productos/);
  assert.match(t.paso1.detalle, /usuarios y contraseñas/);
  assert.match(t.paso1.detalle, /Esta computadora NO cambia/);
  const otra = c.textosSubir({ aqui, nube, yaConectada: true });
  assert.match(otra.paso1.mensaje, /volver a SUBIR/);
});

test('SUBIR: el segundo paso pregunta «¿Está seguro…?» en sentido contrario a BAJAR', () => {
  const t = c.textosSubir({ aqui, nube });
  assert.match(t.paso2.mensaje, /^¿Está seguro de que quiere sincronizar la nube con la información de este equipo\?$/);
  assert.match(t.paso2.detalle, /SUBIR/);
  assert.match(t.paso2.detalle, /\(1,500 productos.*\) se reemplaza por lo de esta computadora \(12 productos/);
  assert.equal(t.paso2.boton, 'Sí, subir a la nube');
});

test('COPIAR TODO DE NUEVO: también es un SUBIR con dos pasos', () => {
  const t = c.textosCompleto({ aqui });
  assert.match(t.paso1.mensaje, /SUBIR TODO/);
  assert.match(t.paso1.detalle, /hoy aquí hay: 12 productos/);
  assert.match(t.paso2.mensaje, /¿Está seguro/);
  assert.equal(c.textosCompleto({ aqui: null }).paso1.detalle.includes('hoy aquí hay'), false);
});

test('sin los números de la nube (clave manual o nube sin actualizar) los textos siguen bien escritos', () => {
  for (const t of [c.textosSubir({ aqui, nube: null }), c.textosBajar({ aqui: null, nube: null }), c.textosCompleto({ aqui: null })]) {
    const s = todo(t);
    assert.doesNotMatch(s, /undefined|NaN|null|\[object/);
    assert.doesNotMatch(s, /\(\s*\)/);
  }
  assert.doesNotMatch(c.textosSubir({ aqui, nube: null }).paso1.detalle, /hoy en la nube hay/);
});

test('los textos de las alertas no llevan emojis (Windows los dibuja como cuadritos)', () => {
  const s = todo([c.textosSubir({ aqui, nube }), c.textosBajar({ aqui, nube }), c.textosCompleto({ aqui })]);
  assert.doesNotMatch(s, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u);
});

test('seguro: no se deja subir una computadora vacía sobre una nube con información', () => {
  const vacia = { productos: 0, ventas: 0, clientes: 0 };
  assert.match(c.bloqueoNubeConDatos(vacia, nube), /nube ya tiene información \(1,500 productos.*\) y esta computadora todavía está vacía.*«Bajar de la nube»/);
  assert.equal(c.bloqueoNubeConDatos(aqui, nube), null);   // las dos con datos: se pregunta normal
  assert.equal(c.bloqueoNubeConDatos(vacia, vacia), null); // las dos vacías: no hay nada que perder
  assert.equal(c.bloqueoNubeConDatos(vacia, null), null);  // sin datos de la nube (clave manual): no se puede saber
});

test('seguro: no se deja bajar una nube vacía sobre una computadora con información', () => {
  const vacia = { productos: 0, ventas: 0, clientes: 0 };
  assert.match(c.bloqueoPcConDatos(aqui, vacia), /nube está vacío.*se quedaría vacía.*«Subir a la nube»/);
  assert.equal(c.bloqueoPcConDatos(aqui, nube), null);
  assert.equal(c.bloqueoPcConDatos(vacia, vacia), null);
  assert.equal(c.bloqueoPcConDatos(aqui, null), null);
});

// Ventana de mensajes falsa: guarda lo que se le pide y contesta con los botones que se le indiquen.
function falso(respuestas) {
  const llamadas = [];
  return { llamadas, showMessageBox: async (ventana, opciones) => { llamadas.push({ ventana, opciones }); return { response: respuestas[llamadas.length - 1] }; } };
}

test('confirmarEnDosPasos: si cancela en el primer paso, ya no pregunta nada más', async () => {
  const d = falso([1]);
  assert.equal(await c.confirmarEnDosPasos(d, 'VENTANA', c.textosBajar({ aqui, nube })), false);
  assert.equal(d.llamadas.length, 1);
});

test('confirmarEnDosPasos: si acepta el primero y cancela el segundo, no se hace nada', async () => {
  const d = falso([0, 1]);
  assert.equal(await c.confirmarEnDosPasos(d, 'VENTANA', c.textosSubir({ aqui, nube })), false);
  assert.equal(d.llamadas.length, 2);
});

test('confirmarEnDosPasos: solo si acepta los dos pasos devuelve true', async () => {
  const d = falso([0, 0]);
  assert.equal(await c.confirmarEnDosPasos(d, 'VENTANA', c.textosBajar({ aqui, nube })), true);
  assert.equal(d.llamadas.length, 2);
});

test('confirmarEnDosPasos: el botón por omisión (Enter) y el de Escape son siempre «Cancelar»', async () => {
  const d = falso([0, 0]);
  await c.confirmarEnDosPasos(d, 'VENTANA', c.textosBajar({ aqui, nube }));
  for (const { ventana, opciones } of d.llamadas) {
    assert.equal(ventana, 'VENTANA');
    assert.equal(opciones.defaultId, 1);
    assert.equal(opciones.cancelId, 1);
    assert.match(opciones.buttons[1], /ancelar/);
    assert.equal(opciones.buttons.length, 2);
  }
  assert.equal(d.llamadas[0].opciones.type, 'warning');
  assert.match(d.llamadas[1].opciones.message, /¿Está seguro/);
});

test('confirmarEnDosPasos: un cierre de la ventana (sin respuesta) cuenta como cancelar', async () => {
  const d = { showMessageBox: async () => ({ response: undefined }) };
  assert.equal(await c.confirmarEnDosPasos(d, undefined, c.textosCompleto({ aqui })), false);
});
