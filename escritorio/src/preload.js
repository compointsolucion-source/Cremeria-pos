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
  imprimirHTML: (html, opciones) => ipcRenderer.invoke('imprimir-html', html, opciones),
  abrirCajon: (opciones) => ipcRenderer.invoke('abrir-cajon', opciones),
  salir: () => ipcRenderer.invoke('salir-programa')
});

// Modo servidor del negocio (solo las páginas del programa, no el sistema web).
contextBridge.exposeInMainWorld('compointServidor', {
  altaGuardar: (d) => ipcRenderer.invoke('srv-alta-guardar', d),
  nubeRevisar: (d) => ipcRenderer.invoke('srv-nube-revisar', d),
  traerNube: (d) => ipcRenderer.invoke('srv-traer-nube', d),
  licenciaRevisar: () => ipcRenderer.invoke('srv-licencia-revisar'),
  altaCancelar: () => ipcRenderer.invoke('srv-alta-cancelar'),
  estado: () => ipcRenderer.invoke('srv-estado'),
  respaldar: () => ipcRenderer.invoke('srv-respaldar'),
  abrirCarpeta: () => ipcRenderer.invoke('srv-abrir-carpeta'),
  guardarNube: (d) => ipcRenderer.invoke('srv-guardar-nube', d),
  probarNube: () => ipcRenderer.invoke('srv-probar-nube'),
  restaurar: () => ipcRenderer.invoke('srv-restaurar'),
  quitarNube: () => ipcRenderer.invoke('srv-quitar-nube'),
  cambiarACliente: (url) => ipcRenderer.invoke('srv-cambiar-a-cliente', url),
  syncGuardar: (d) => ipcRenderer.invoke('srv-sync-guardar', d),
  syncAhora: () => ipcRenderer.invoke('srv-sync-ahora'),
  syncCompleto: () => ipcRenderer.invoke('srv-sync-completo'),
  syncQuitar: () => ipcRenderer.invoke('srv-sync-quitar'),
  elegirModoServidor: () => ipcRenderer.invoke('srv-elegir-modo'),
  rutasPrevistas: () => ipcRenderer.invoke('srv-rutas-previstas'),
  elegirCopiaExtra: () => ipcRenderer.invoke('srv-copia-extra-elegir'),
  quitarCopiaExtra: () => ipcRenderer.invoke('srv-copia-extra-quitar')
});
