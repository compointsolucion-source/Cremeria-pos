const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('compoint', {
  guardarConfig: (datos) => ipcRenderer.invoke('guardar-config', datos),
  leerConfig: () => ipcRenderer.invoke('leer-config'),
  reintentar: () => ipcRenderer.invoke('reintentar'),
  cerrar: () => ipcRenderer.invoke('cerrar-ventana-config')
});

// Funciones del programa de escritorio para el sistema web (solo el sitio configurado puede usarlas).
contextBridge.exposeInMainWorld('compointDesktop', {
  esEscritorio: true,
  listarImpresoras: () => ipcRenderer.invoke('listar-impresoras'),
  imprimirHTML: (html, opciones) => ipcRenderer.invoke('imprimir-html', html, opciones)
});
