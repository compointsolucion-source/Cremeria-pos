// Sidebar de navegación compartido — un solo lugar para editar el menú de
// todo el sistema, en vez de repetirlo copiado en cada pantalla.
//
// Los iconos son SVG propios (estilo línea, minimalista, un solo color)
// en vez de un CDN externo — así siguen apareciendo aunque el dispositivo
// esté sin internet (consistente con el modo offline que ya existe).

const ICONOS_SIDEBAR = {
  inicio: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  carrito: '<circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2l2.2 11.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.6L21 8H6"/>',
  billetera: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16" cy="14.5" r="1.2"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  deshacer: '<path d="M4 10h10a5 5 0 0 1 0 10H8"/><path d="M4 10l4-4M4 10l4 4"/>',
  calculadora: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01"/>',
  tv: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 21h8M9 6l3-3 3 3"/>',
  ticket: '<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/>',
  imagen: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5.5-5.5L4 21"/>',
  carpeta: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  paquete: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v9l9 5 9-5V8"/><path d="M12 13v9"/>',
  grafica_barras: '<path d="M4 20V10M12 20V4M20 20v-7"/>',
  portapapeles: '<rect x="6" y="4" width="12" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 11h6M9 15h6"/>',
  camion: '<rect x="2" y="7" width="12" height="9" rx="1"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="6.5" cy="18" r="1.7"/><circle cx="16.5" cy="18" r="1.7"/>',
  usuarios: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14c2.5.3 4.5 2.5 4.5 6"/>',
  tendencia: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  usuario_config: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="18" cy="16" r="2.3"/><path d="M18 12.5v1M18 18.5v1M14.5 16h1M20.5 16h1"/>',
  ajustes: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  candado: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  base_datos: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  salir: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  cerrar: '<path d="M5 5l14 14M19 5L5 19"/>',
  flecha_izquierda: '<path d="M15 5l-7 7 7 7"/>',
  flecha_derecha: '<path d="M9 5l7 7-7 7"/>'
};

function svgIcono(nombre, tamano) {
  const t = tamano || 18;
  return `<svg width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONOS_SIDEBAR[nombre] || ''}</svg>`;
}

// Estructura del menú — un solo lugar para agregar/quitar módulos del
// sistema completo. "activo" se calcula solo comparando con el archivo
// de la página actual, no hay que tocarlo a mano.
const GRUPOS_SIDEBAR = [
  {
    titulo: 'Ventas',
    items: [
      { icono: 'carrito', texto: 'Mostrador', href: 'mostrador.html' },
      { icono: 'billetera', texto: 'Caja', href: 'caja.html' },
      { icono: 'monitor', texto: 'Caja Avanzada', href: 'caja-avanzada.html' },
      { icono: 'deshacer', texto: 'Devoluciones', href: 'devoluciones.html' },
      { icono: 'calculadora', texto: 'Corte de Caja', href: 'caja-turno.html' },
      { icono: 'tv', texto: 'Pantalla de Turnos', href: 'pantalla-turnos.html' },
      { icono: 'ticket', texto: 'Kiosco de Fichas', href: 'kiosco-fichas.html' }
    ]
  },
  {
    titulo: 'Catálogo e Inventario',
    items: [
      { icono: 'imagen', texto: 'Productos', href: 'productos.html' },
      { icono: 'carpeta', texto: 'Departamentos', href: 'departamentos.html' },
      { icono: 'paquete', texto: 'Kits/Combos', href: 'kits.html' },
      { icono: 'grafica_barras', texto: 'Inventario', href: 'inventario.html' },
      { icono: 'portapapeles', texto: 'Reporte Inventario', href: 'reporte-inventario.html' },
      { icono: 'camion', texto: 'Compras/Proveedores', href: 'compras.html' }
    ]
  },
  {
    titulo: 'Clientes',
    items: [
      { icono: 'usuarios', texto: 'Clientes/Créditos', href: 'clientes.html' }
    ]
  },
  {
    titulo: 'Reportes',
    items: [
      { icono: 'tendencia', texto: 'Reportes', href: 'reportes.html' },
      { icono: 'portapapeles', texto: 'Bitácora', href: 'bitacora.html' }
    ]
  },
  {
    titulo: 'Administración',
    items: [
      { icono: 'usuario_config', texto: 'Equipo', href: 'equipo.html' },
      { icono: 'ajustes', texto: 'Configuración', href: 'configuracion.html' },
      { icono: 'candado', texto: 'Cambiar Contraseña', href: 'cambiar-password.html' },
      { icono: 'base_datos', texto: 'Backups', href: 'backups.html' }
    ]
  }
];

// Cada pantalla puede vivir en la raíz (mostrador.html) o en /admin/ — el
// sidebar necesita saber cuál para armar los links relativos correctos,
// sin importar desde dónde se cargó esta misma página.
function estaEnCarpetaAdmin() {
  return window.location.pathname.includes('/admin/');
}

function rutaSidebar(href) {
  const enRaiz = ['mostrador.html', 'caja.html', 'caja-avanzada.html', 'pantalla-turnos.html', 'kiosco-fichas.html'];
  const destinoEnRaiz = enRaiz.includes(href);
  if (estaEnCarpetaAdmin()) {
    return destinoEnRaiz ? `../${href}` : href;
  }
  return destinoEnRaiz ? href : `admin/${href}`;
}

function paginaActual() {
  const partes = window.location.pathname.split('/');
  return partes[partes.length - 1] || 'dashboard.html';
}

function construirSidebar() {
  const actual = paginaActual();
  const inicioHref = estaEnCarpetaAdmin() ? 'dashboard.html' : 'admin/dashboard.html';

  const gruposHTML = GRUPOS_SIDEBAR.map(grupo => `
    <div class="sidebar-grupo">
      <p class="sidebar-titulo-grupo">${grupo.titulo}</p>
      ${grupo.items.map(item => `
        <a class="sidebar-item ${item.href === actual ? 'activo' : ''}" href="${rutaSidebar(item.href)}">
          <span class="sidebar-icono">${svgIcono(item.icono)}</span>
          <span class="sidebar-texto">${item.texto}</span>
        </a>
      `).join('')}
    </div>
  `).join('');

  return `
    <div class="sidebar-overlay" id="sidebarOverlay" onclick="cerrarSidebarMovil()"></div>
    <button class="sidebar-boton-reabrir" id="botonReabrirSidebar" onclick="expandirSidebarEscritorio()" title="Mostrar menú">${svgIcono('flecha_derecha', 18)}</button>
    <aside class="sidebar" id="sidebarPrincipal">
      <div class="sidebar-encabezado">
        <a class="sidebar-marca" href="${inicioHref}">
          <span class="sidebar-icono">${svgIcono('inicio', 20)}</span>
          <span>Cremería POS</span>
        </a>
        <button class="sidebar-colapsar-escritorio" onclick="colapsarSidebarEscritorio()" title="Ocultar menú">${svgIcono('flecha_izquierda', 18)}</button>
        <button class="sidebar-cerrar-movil" onclick="cerrarSidebarMovil()">${svgIcono('cerrar', 20)}</button>
      </div>
      <nav class="sidebar-nav">${gruposHTML}</nav>
      <div class="sidebar-pie">
        <button class="sidebar-item sidebar-salir" onclick="cerrarSesion()">
          <span class="sidebar-icono">${svgIcono('salir')}</span>
          <span class="sidebar-texto">Salir</span>
        </button>
      </div>
    </aside>
  `;
}

// Colapsar/expandir en escritorio: usa el mismo deslizamiento (transform)
// que ya existe para móvil, pero se activa con un botón propio y recuerda
// la preferencia en este dispositivo — así no hay que volver a ocultarlo
// cada vez que entras.
function colapsarSidebarEscritorio() {
  document.body.classList.add('sidebar-colapsado-escritorio');
  localStorage.setItem('sidebar_colapsado', 'true');
}

function expandirSidebarEscritorio() {
  document.body.classList.remove('sidebar-colapsado-escritorio');
  localStorage.setItem('sidebar_colapsado', 'false');
}

function restaurarEstadoSidebar() {
  if (localStorage.getItem('sidebar_colapsado') === 'true') {
    document.body.classList.add('sidebar-colapsado-escritorio');
  }
}

function abrirSidebarMovil() {
  document.getElementById('sidebarPrincipal').classList.add('abierto');
  document.getElementById('sidebarOverlay').classList.add('visible');
}

function cerrarSidebarMovil() {
  document.getElementById('sidebarPrincipal').classList.remove('abierto');
  document.getElementById('sidebarOverlay').classList.remove('visible');
}

function inicializarSidebar() {
  document.body.insertAdjacentHTML('afterbegin', construirSidebar());
  document.body.classList.add('con-sidebar');
  restaurarEstadoSidebar();
}

inicializarSidebar();
