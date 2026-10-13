const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('compoint', {
  guardarConfig: (datos) => ipcRenderer.invoke('guardar-config', datos),
  leerConfig: () => ipcRenderer.invoke('leer-config'),
  reintentar: () => ipcRenderer.invoke('reintentar'),
  cerrar: () => ipcRenderer.invoke('cerrar-ventana-config'),
  buscarServidores: () => ipcRenderer.invoke('buscar-servidores'),
  probarServidor: (u) => ipcRenderer.invoke('probar-servidor', u)
});

// Funciones del programa de escritorio para el sistema web (solo el sitio configurado puede usarlas).
contextBridge.exposeInMainWorld('compointDesktop', {
  esEscritorio: true,
  listarImpresoras: () => ipcRenderer.invoke('listar-impresoras'),
  imprimirHTML: (html, opciones) => ipcRenderer.invoke('imprimir-html', html, opciones)
});

// Modo servidor del negocio (solo las páginas del programa, no el sistema web).
contextBridge.exposeInMainWorld('compointServidor', {
  altaGuardar: (d) => ipcRenderer.invoke('srv-alta-guardar', d),
  altaCancelar: () => ipcRenderer.invoke('srv-alta-cancelar'),
  estado: () => ipcRenderer.invoke('srv-estado'),
  respaldar: () => ipcRenderer.invoke('srv-respaldar'),
  abrirCarpeta: () => ipcRenderer.invoke('srv-abrir-carpeta'),
  guardarNube: (d) => ipcRenderer.invoke('srv-guardar-nube', d),
  probarNube: () => ipcRenderer.invoke('srv-probar-nube'),
  restaurar: () => ipcRenderer.invoke('srv-restaurar'),
  quitarNube: () => ipcRenderer.invoke('srv-quitar-nube'),
  cambiarACliente: (url) => ipcRenderer.invoke('srv-cambiar-a-cliente', url),
  elegirModoServidor: () => ipcRenderer.invoke('srv-elegir-modo')
});
