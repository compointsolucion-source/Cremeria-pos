const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('compoint', {
  guardarConfig: (datos) => ipcRenderer.invoke('guardar-config', datos),
  leerConfig: () => ipcRenderer.invoke('leer-config'),
  reintentar: () => ipcRenderer.invoke('reintentar'),
  cerrar: () => ipcRenderer.invoke('cerrar-ventana-config')
});
