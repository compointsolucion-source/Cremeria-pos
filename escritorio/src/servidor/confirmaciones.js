// Alertas de confirmación para pasar información entre esta computadora y la nube.
//
// Siempre en DOS pasos, para que nadie reemplace información por accidente:
//   1) explica qué va a pasar, con números (lo que hay aquí y lo que hay en la nube);
//   2) pregunta «¿Está seguro?» diciendo claramente en qué sentido se copia.
// El botón marcado por omisión (Enter) SIEMPRE es «Cancelar».
//
// Los textos están aquí (y no dentro de main.js) para poder probarlos sin abrir Electron.

const n = (x) => Number(x || 0).toLocaleString('es-MX');
const vacio = (r) => !r || (!r.productos && !r.ventas && !r.clientes);

// «12 productos, 340 ventas y 5 clientes» o «nada todavía».
function hay(r) {
  if (!r) return '';
  if (vacio(r)) return 'nada todavía';
  return `${n(r.productos)} productos, ${n(r.ventas)} ventas y ${n(r.clientes)} clientes`;
}

// Bajar con la computadora llena y la nube vacía la dejaría sin nada: se detiene y se explica.
function bloqueoPcConDatos(aqui, nube) {
  if (!nube || !vacio(nube) || vacio(aqui)) return null;
  return 'Tu sistema en la nube está vacío (no tiene productos, ventas ni clientes) y esta computadora sí tiene información. ' +
    'Si lo bajas, esta computadora se quedaría vacía. Lo que probablemente quieres es «Subir a la nube».';
}

// Subir con la nube llena y la computadora vacía dejaría vacía la nube: se detiene y se explica.
function bloqueoNubeConDatos(aqui, nube) {
  if (!nube || vacio(nube) || !vacio(aqui)) return null;
  return `Tu sistema en la nube ya tiene información (${hay(nube)}) y esta computadora todavía está vacía. ` +
    'Si lo subes así, la nube quedaría vacía. Lo que probablemente quieres es «Bajar de la nube».';
}

// BAJAR: la nube manda, esta computadora se reemplaza.
function textosBajar({ aqui, nube }) {
  const hoyAqui = aqui ? ` (hoy aquí hay: ${hay(aqui)})` : '';
  return {
    titulo: 'Bajar información de la nube',
    paso1: {
      boton: 'Continuar',
      mensaje: 'Vas a BAJAR la información de la nube a esta computadora.',
      detalle: 'Qué va a pasar:\n' +
        '• Esta computadora quedará IGUAL que tu sistema en la nube.\n' +
        `• Se reemplaza TODO lo que hay aquí${hoyAqui}.\n` +
        (nube ? `• Se bajará de la nube: ${hay(nube)}.\n` : '') +
        '• Antes se guarda un respaldo de lo que hay ahora en esta computadora.\n' +
        '• Después esta computadora queda como la principal: lo que registres aquí se sube a la nube. El programa se reiniciará.'
    },
    paso2: {
      boton: 'Sí, bajar de la nube',
      mensaje: '¿Está seguro de que quiere sincronizar este equipo con la información de la nube?',
      detalle: 'Es decir, BAJAR: lo que hay en esta computadora' + (aqui ? ` (${hay(aqui)})` : '') + ' se reemplaza por lo de la nube' + (nube ? ` (${hay(nube)})` : '') + '.\n\nEsta acción reemplaza la información de este equipo.'
    }
  };
}

// SUBIR: esta computadora manda, la nube se reemplaza.
function textosSubir({ aqui, nube, yaConectada }) {
  return {
    titulo: 'Subir información a la nube',
    paso1: {
      boton: 'Continuar',
      mensaje: yaConectada ? 'Vas a volver a SUBIR a la nube TODA la información de esta computadora.' : 'Vas a SUBIR a la nube la información de esta computadora.',
      detalle: 'Qué va a pasar:\n' +
        '• La nube quedará IGUAL que esta computadora.\n' +
        `• Se reemplaza TODO lo que hay en la nube${nube ? ` (hoy en la nube hay: ${hay(nube)})` : ''} con lo de aquí${aqui ? ` (${hay(aqui)})` : ''}.\n` +
        '• Lo que alguien haya capturado directamente en la nube se pierde, incluidos usuarios y contraseñas: en la nube se entrará con los de esta computadora.\n' +
        '• Esta computadora NO cambia.\n' +
        '• A partir de ahora, captura todo aquí (en el servidor del negocio). Si se va el internet, el negocio sigue trabajando y todo se sube solo al regresar.'
    },
    paso2: {
      boton: 'Sí, subir a la nube',
      mensaje: '¿Está seguro de que quiere sincronizar la nube con la información de este equipo?',
      detalle: 'Es decir, SUBIR: lo que hay en la nube' + (nube ? ` (${hay(nube)})` : '') + ' se reemplaza por lo de esta computadora' + (aqui ? ` (${hay(aqui)})` : '') + '.\n\nEsta acción reemplaza la información de la nube.'
    }
  };
}

// «Copiar todo de nuevo»: es un SUBIR completo.
function textosCompleto({ aqui }) {
  return {
    titulo: 'Copia completa a la nube',
    paso1: {
      boton: 'Continuar',
      mensaje: 'Vas a volver a SUBIR TODO de esta computadora a la nube.',
      detalle: 'Qué va a pasar:\n' +
        '• La nube se vacía y se llena otra vez con lo de esta computadora' + (aqui ? ` (hoy aquí hay: ${hay(aqui)})` : '') + '.\n' +
        '• Esta computadora NO cambia.\n' +
        '• Úsalo si notas diferencias entre la nube y esta computadora. Puede tardar unos minutos.'
    },
    paso2: {
      boton: 'Sí, subir todo de nuevo',
      mensaje: '¿Está seguro de que quiere sincronizar la nube con la información de este equipo?',
      detalle: 'Es decir, SUBIR: la información de la nube se reemplaza por la de esta computadora.\n\nEsta acción reemplaza la información de la nube.'
    }
  };
}

// Muestra los dos pasos. Devuelve true solo si la persona acepta los dos.
async function confirmarEnDosPasos(dialog, ventana, t) {
  const p1 = await dialog.showMessageBox(ventana || undefined, {
    type: 'warning', buttons: [t.paso1.boton, 'Cancelar'], defaultId: 1, cancelId: 1,
    title: t.titulo, message: t.paso1.mensaje, detail: t.paso1.detalle
  });
  if (p1.response !== 0) return false;
  const p2 = await dialog.showMessageBox(ventana || undefined, {
    type: 'question', buttons: [t.paso2.boton, 'No, cancelar'], defaultId: 1, cancelId: 1,
    title: t.titulo, message: t.paso2.mensaje, detail: t.paso2.detalle
  });
  return p2.response === 0;
}

module.exports = { hay, vacio, bloqueoPcConDatos, bloqueoNubeConDatos, textosBajar, textosSubir, textosCompleto, confirmarEnDosPasos };
