// Actualizaciones automáticas de Compoint Punto para escritorio.
// - Cada vez que Compoint publica una versión nueva (GitHub, rama "estable"), el programa la encuentra solo,
//   la baja en segundo plano y le avisa a quien lo usa: "Hay una actualización… ¿Reiniciar ahora?".
// - Si dice "Después", se instala sola la próxima vez que se cierre el programa.
// - Sin internet o con cualquier error, no molesta: solo lo anota en el log y vuelve a intentar más tarde.
// Todo se recibe por parámetro (autoUpdater, dialog…) para poder probarlo sin abrir Electron.

const HORAS = 3600 * 1000;

function crear(op) {
  const {
    autoUpdater, dialog, app, log,
    ventana = () => null,          // () => ventana principal (para que el aviso salga encima de ella)
    prepararSalida = async () => {}, // se llama antes de reiniciar (por ejemplo, cerrar la base de datos con respaldo)
    cadaHoras = 4,
    primerRevisionMs = 45 * 1000,
    programar = { esperar: setTimeout, repetir: setInterval }
  } = op;

  let manual = false, avisada = '', reiniciando = false, descargada = null, revisando = false;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = { info: (m) => log('Actualizador: ' + m), warn: (m) => log('Actualizador (aviso): ' + m), error: (m) => log('Actualizador (error): ' + m), debug() {} };

  const cuadro = (opciones) => {
    const v = ventana();
    return v && !v.isDestroyed() ? dialog.showMessageBox(v, opciones) : dialog.showMessageBox(opciones);
  };

  async function reiniciar() {
    if (reiniciando) return;
    reiniciando = true;
    try { await prepararSalida(); } catch (e) { log('Actualizador: no se pudo preparar la salida: ' + (e && e.message)); }
    autoUpdater.quitAndInstall(true, true); // instala sin preguntar nada y vuelve a abrir el programa
  }

  async function avisarDescargada(version) {
    if (avisada === version && !manual) return;
    avisada = version;
    manual = false;
    const r = await cuadro({
      type: 'info',
      title: 'Actualización de Compoint Punto',
      message: 'Hay una actualización nueva (versión ' + version + ')',
      detail: 'Ya se descargó. Trae mejoras y correcciones de seguridad.\n\n¿Quieres reiniciar ahora para usarla? Tarda unos segundos. Si eliges «Después», se instala sola la próxima vez que cierres el programa.',
      buttons: ['Reiniciar ahora', 'Después'], defaultId: 0, cancelId: 1, noLink: true
    });
    if (r.response === 0) await reiniciar();
  }

  autoUpdater.on('checking-for-update', () => { revisando = true; });
  autoUpdater.on('update-available', (info) => { log('Actualizador: versión nueva ' + (info && info.version) + ', descargando'); });
  autoUpdater.on('update-not-available', async () => {
    revisando = false;
    if (manual) {
      manual = false;
      await cuadro({ type: 'info', title: 'Actualización de Compoint Punto', message: 'Ya tienes la última versión (' + app.getVersion() + ')', buttons: ['Aceptar'], noLink: true });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    revisando = false;
    descargada = info && info.version;
    avisarDescargada(descargada).catch((e) => log('Actualizador: ' + (e && e.message)));
  });
  autoUpdater.on('error', async (err) => {
    revisando = false;
    log('Actualizador (error): ' + (err && err.message || err));
    if (manual) {
      manual = false;
      await cuadro({ type: 'warning', title: 'Actualización de Compoint Punto', message: 'No se pudo buscar actualizaciones', detail: 'Revisa que esta computadora tenga internet e intenta de nuevo en unos minutos.', buttons: ['Aceptar'], noLink: true }).catch(() => {});
    }
  });

  function buscar() {
    if (revisando || reiniciando) return Promise.resolve();
    return Promise.resolve(autoUpdater.checkForUpdates()).catch((e) => log('Actualizador: ' + (e && e.message)));
  }

  return {
    iniciar() {
      programar.esperar(buscar, primerRevisionMs);
      programar.repetir(buscar, cadaHoras * HORAS);
    },
    // Desde el menú junto al reloj: "Buscar actualizaciones".
    buscarAhora() {
      manual = true;
      if (descargada) { avisarDescargada(descargada).catch(() => {}); return Promise.resolve(); }
      return buscar();
    },
    reiniciar,
    versionDescargada: () => descargada
  };
}

module.exports = { crear };
