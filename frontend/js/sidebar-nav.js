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
  escudo: '<path d="M12 3l8 3v6c0 4.5-3.2 8.3-8 9-4.8-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  sucursal: '<path d="M4 21V10l8-6 8 6v11"/><path d="M9 21v-6h6v6"/><path d="M4 21h16"/>',
  ayuda: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7"/><path d="M12 17h.01"/>',
  base_datos: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  salir: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  cerrar: '<path d="M5 5l14 14M19 5L5 19"/>',
  flecha_izquierda: '<path d="M15 5l-7 7 7 7"/>',
  flecha_derecha: '<path d="M9 5l7 7-7 7"/>',
  casa: '<path d="M3 11l9-7 9 7"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>'
};

function svgIcono(nombre, tamano) {
  const t = tamano || 18;
  return `<svg width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONOS_SIDEBAR[nombre] || ''}</svg>`;
}

// Ícono de marca (la red de nodos del logo de Compoint) para el encabezado
// del sidebar — a diferencia de svgIcono(), usa "currentColor" solo en el
// nodo verde de acento por separado, para que se vea igual en modo claro y oscuro.
function svgIconoCompoint(tamano) {
  const t = tamano || 20;
  return `<svg width="${t}" height="${t}" viewBox="0 0 200 200" fill="none">
    <g stroke="currentColor" stroke-width="6" opacity="0.9">
      <path d="M100 15 150 31 181 74 181 126 150 169 100 185 50 169 19 126 19 74 50 31 100 15" fill="none"/>
      <path d="M100 15 90 105 M181 74 90 105 M150 169 90 105 M50 169 90 105 M19 74 90 105"/>
      <path d="M100 15 181 126 M150 31 150 169 M100 185 19 74 M50 169 50 31 M181 74 19 126"/>
    </g>
    <g fill="currentColor">
      <circle cx="100" cy="15" r="9"/><circle cx="150" cy="31" r="9"/><circle cx="181" cy="74" r="9"/>
      <circle cx="181" cy="126" r="9"/><circle cx="150" cy="169" r="9"/><circle cx="100" cy="185" r="9"/>
      <circle cx="50" cy="169" r="9"/><circle cx="19" cy="126" r="9"/><circle cx="19" cy="74" r="9"/><circle cx="50" cy="31" r="9"/>
    </g>
    <circle cx="90" cy="105" r="16" fill="#5FAE46"/>
  </svg>`;
}

// Estructura del menú — un solo lugar para agregar/quitar módulos del
// sistema completo. "activo" se calcula solo comparando con el archivo
// de la página actual, no hay que tocarlo a mano.
//
// Quién ve cada módulo (el servidor SIEMPRE vuelve a revisarlo; esto solo
// evita mostrarle a cada empleado botones que no puede usar):
//  - "permiso": basta con tener UNO de los permisos de la lista (dueño, gerente y
//    jefe general los tienen todos; cajero y mostrador según su rol + lo que el
//    dueño les haya dado o quitado en Equipo).
//  - "roles": solo esos roles.  - "soloJefeGeneral": solo el jefe general.
//  - Sin nada de lo anterior: lo ve todo el mundo.
const ROLES_ADMIN_SIDEBAR = ['jefe_general', 'dueno', 'gerente'];

const GRUPOS_SIDEBAR = [
  {
    clave: 'ventas', titulo: 'Ventas', icono: 'carrito',
    items: [
      { icono: 'carrito', texto: 'Mostrador', href: 'mostrador.html', permiso: 'VENTAS_CREAR' },
      { icono: 'camion', texto: 'Pedidos a domicilio', href: 'pedidos.html', permiso: 'VENTAS_CREAR' },
      { icono: 'billetera', texto: 'Caja', href: 'caja.html', permiso: ['CAJA_ABRIR', 'CAJA_MOVIMIENTO', 'CAJA_CERRAR'] },
      { icono: 'monitor', texto: 'Caja Avanzada', href: 'caja-avanzada.html', permiso: ['CAJA_ABRIR', 'CAJA_MOVIMIENTO', 'CAJA_CERRAR'] },
      { icono: 'deshacer', texto: 'Devoluciones', href: 'devoluciones.html', permiso: 'VENTAS_DEVOLVER' },
      { icono: 'calculadora', texto: 'Corte de Caja', href: 'caja-turno.html', permiso: ['CAJA_ABRIR', 'CAJA_CERRAR'] },
      { icono: 'tv', texto: 'Pantalla de Turnos', href: 'pantalla-turnos.html', permiso: ['VENTAS_CREAR', 'CAJA_ABRIR'] },
      { icono: 'ticket', texto: 'Kiosco de Fichas', href: 'kiosco-fichas.html', permiso: ['VENTAS_CREAR', 'CAJA_ABRIR'] }
    ]
  },
  {
    clave: 'catalogo', titulo: 'Catálogo e Inventario', tituloCorto: 'Catálogo', icono: 'paquete',
    items: [
      { icono: 'imagen', texto: 'Productos', href: 'productos.html', permiso: ['PRODUCTOS_CREAR', 'PRODUCTOS_EDITAR', 'PRODUCTOS_PRECIO', 'INVENTARIO_VER'] },
      { icono: 'carpeta', texto: 'Departamentos', href: 'departamentos.html', permiso: ['PRODUCTOS_CREAR', 'PRODUCTOS_EDITAR'] },
      { icono: 'paquete', texto: 'Kits/Combos', href: 'kits.html', roles: ROLES_ADMIN_SIDEBAR },
      { icono: 'grafica_barras', texto: 'Inventario', href: 'inventario.html', permiso: 'INVENTARIO_VER' },
      { icono: 'portapapeles', texto: 'Reporte Inventario', href: 'reporte-inventario.html', permiso: 'INVENTARIO_VER' },
      { icono: 'camion', texto: 'Compras/Proveedores', href: 'compras.html', roles: ROLES_ADMIN_SIDEBAR }
    ]
  },
  {
    clave: 'clientes', titulo: 'Clientes', icono: 'usuarios',
    items: [
      { icono: 'usuarios', texto: 'Clientes/Créditos', href: 'clientes.html', permiso: ['CLIENTES_CREAR', 'CREDITO_ABONO'] },
      { icono: 'portapapeles', texto: 'Facturación', href: 'facturacion.html', roles: ROLES_ADMIN_SIDEBAR }
    ]
  },
  {
    clave: 'reportes', titulo: 'Reportes', icono: 'tendencia',
    items: [
      { icono: 'tendencia', texto: 'Reportes', href: 'reportes.html', permiso: 'REPORTES_VER' },
      { icono: 'calculadora', texto: 'Cortes de caja', href: 'cortes.html', permiso: ['CAJA_ABRIR', 'CAJA_CERRAR'] },
      { icono: 'calculadora', texto: 'Cortes por día', href: 'cortes-dia.html', permiso: ['CAJA_ABRIR', 'CAJA_CERRAR'] },
      { icono: 'portapapeles', texto: 'Bitácora', href: 'bitacora.html', roles: ROLES_ADMIN_SIDEBAR }
    ]
  },
  {
    clave: 'admin', titulo: 'Administración', icono: 'ajustes',
    items: [
      { icono: 'sucursal', texto: 'Sucursales', href: 'sucursales.html', soloJefeGeneral: true },
      { icono: 'usuario_config', texto: 'Equipo', href: 'equipo.html', roles: ROLES_ADMIN_SIDEBAR },
      { icono: 'ajustes', texto: 'Configuración', href: 'configuracion.html' },
      { icono: 'escudo', texto: 'Licencia', href: 'licencia.html', roles: ['dueno', 'jefe_general', 'gerente'] },
      { icono: 'candado', texto: 'Cambiar Contraseña', href: 'cambiar-password.html' },
      { icono: 'base_datos', texto: 'Backups', href: 'backups.html', roles: ROLES_ADMIN_SIDEBAR },
      { icono: 'ayuda', texto: 'Ayuda y soporte', href: 'ayuda.html' }
    ]
  }
];

// "Inicio" va aparte, arriba de los grupos: lo ve quien puede ver reportes.
const ITEM_INICIO_SIDEBAR = { icono: 'casa', texto: 'Inicio', href: 'dashboard.html', permiso: 'REPORTES_VER' };

const NOMBRES_ROL_SIDEBAR = {
  jefe_general: 'Jefe general', dueno: 'Dueño', gerente: 'Gerente',
  cajero: 'Cajero', mostrador: 'Mostrador', repartidor: 'Repartidor'
};

// Permisos que cada rol trae de fábrica. Debe coincidir con PERMISOS_BASE_POR_ROL
// de backend/middleware/auth.js (el servidor es quien manda; esto solo decide qué se muestra).
const PERMISOS_BASE_SIDEBAR = {
  cajero: [
    'VENTAS_CREAR', 'VENTAS_CANCELAR', 'VENTAS_DEVOLVER',
    'CAJA_ABRIR', 'CAJA_CERRAR', 'CAJA_MOVIMIENTO',
    'INVENTARIO_VER', 'REPORTES_VER',
    'CLIENTES_CREAR', 'CREDITO_ABONO', 'RECARGAS_VENDER'
  ],
  mostrador: ['VENTAS_CREAR']
};

// Los permisos extra o quitados a un empleado (Equipo) viajan dentro del token de sesión.
function permisosExtraDelToken() {
  try {
    const token = localStorage.getItem('token');
    if (!token) return {};
    let parte = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (parte.length % 4) parte += '=';
    const datos = JSON.parse(decodeURIComponent(escape(atob(parte))));
    return (datos && datos.permisos) || {};
  } catch (e) {
    return {};
  }
}

function usuarioTienePermisoSidebar(usuario, permiso, extra) {
  if (!usuario) return false;
  if (ROLES_ADMIN_SIDEBAR.includes(usuario.rol)) return true;
  if (extra[permiso] === true) return true;
  if (extra[permiso] === false) return false;
  return (PERMISOS_BASE_SIDEBAR[usuario.rol] || []).includes(permiso);
}

function itemVisibleSidebar(item, usuario, extra) {
  const rol = usuario ? usuario.rol : null;
  if (item.soloJefeGeneral && rol !== 'jefe_general') return false;
  if (item.roles && !item.roles.includes(rol)) return false;
  if (rol && ROLES_ADMIN_SIDEBAR.includes(rol)) return true;
  if (!item.permiso) return true;
  const lista = Array.isArray(item.permiso) ? item.permiso : [item.permiso];
  return lista.some((p) => usuarioTienePermisoSidebar(usuario, p, extra));
}

// Cada pantalla puede vivir en la raíz (mostrador.html) o en /admin/ — el
// sidebar necesita saber cuál para armar los links relativos correctos,
// sin importar desde dónde se cargó esta misma página.
function estaEnCarpetaAdmin() {
  return window.location.pathname.includes('/admin/');
}

function rutaSidebar(href) {
  const enRaiz = ['mostrador.html', 'pedidos.html', 'repartidor.html', 'caja.html', 'caja-avanzada.html', 'pantalla-turnos.html', 'kiosco-fichas.html'];
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

function escaparSidebar(texto) {
  return String(texto == null ? '' : texto).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inicialesSidebar(nombre) {
  const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  return (partes[0][0] + (partes.length > 1 ? partes[1][0] : '')).toUpperCase();
}

// Preferencias de ESTE dispositivo (menú compacto y qué grupos dejó abiertos).
function leerLocalSidebar(clave) { try { return localStorage.getItem(clave); } catch (e) { return null; } }
function guardarLocalSidebar(clave, valor) { try { localStorage.setItem(clave, valor); } catch (e) { /* sin almacenamiento: no pasa nada */ } }

function gruposAbiertosGuardados() {
  try { const l = JSON.parse(leerLocalSidebar('sidebar_grupos') || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; }
}

function itemSidebarHTML(item, actual, conTitle) {
  return `<a class="sidebar-item ${item.href === actual ? 'activo' : ''}" href="${rutaSidebar(item.href)}" title="${escaparSidebar(item.texto)}">
      <span class="sidebar-icono">${svgIcono(item.icono, conTitle ? 19 : 17)}</span>
      <span class="sidebar-texto">${item.texto}</span>
    </a>`;
}

function construirSidebar() {
  const actual = paginaActual();
  const usuario = typeof getUsuario === 'function' ? getUsuario() : null;
  const extra = permisosExtraDelToken();
  const esJefeGeneral = !!(usuario && usuario.rol === 'jefe_general');
  const abiertosGuardados = gruposAbiertosGuardados();

  // Lo que SÍ ve esta persona, ya filtrado por su rol y permisos.
  const gruposVisibles = GRUPOS_SIDEBAR
    .map((g) => ({ ...g, items: g.items.filter((it) => itemVisibleSidebar(it, usuario, extra)) }))
    .filter((g) => g.items.length > 0);
  const verInicio = itemVisibleSidebar(ITEM_INICIO_SIDEBAR, usuario, extra);

  // A dónde lleva el logo: a Inicio, o (si no ve Inicio) a su primera pantalla.
  let inicioHref = rutaSidebar(ITEM_INICIO_SIDEBAR.href);
  if (!verInicio && gruposVisibles.length) inicioHref = rutaSidebar(gruposVisibles[0].items[0].href);

  const inicioHTML = verInicio ? itemSidebarHTML(ITEM_INICIO_SIDEBAR, actual, true) : '';

  const gruposHTML = gruposVisibles.map((grupo) => {
    // Un grupo con un solo módulo no necesita desplegarse: va directo, como un botón normal.
    if (grupo.items.length === 1) return `<div class="sidebar-grupo sidebar-grupo-simple">${itemSidebarHTML(grupo.items[0], actual, true)}</div>`;
    const conActivo = grupo.items.some((it) => it.href === actual);
    const abierto = conActivo || abiertosGuardados.includes(grupo.clave);
    return `
    <div class="sidebar-grupo ${abierto ? 'abierto' : ''} ${conActivo ? 'con-activo' : ''}" data-grupo="${grupo.clave}">
      <button type="button" class="sg-cab" onclick="alternarGrupoSidebar(this)" aria-expanded="${abierto}" title="${escaparSidebar(grupo.titulo)}">
        <span class="sidebar-icono">${svgIcono(grupo.icono, 19)}</span>
        <span class="sidebar-texto sg-titulo">${grupo.tituloCorto || grupo.titulo}</span>
        <span class="sg-n">${grupo.items.length}</span>
        <span class="sg-fl">${svgIcono('chevron', 14)}</span>
      </button>
      <div class="sg-cuerpo">
        <p class="sg-cuerpo-titulo">${grupo.titulo}</p>
        ${grupo.items.map((it) => itemSidebarHTML(it, actual, false)).join('')}
      </div>
    </div>`;
  }).join('');

  // Solo jefe_general trabaja "parado" en una sucursal a la vez (el resto
  // de los roles ya la trae fija y no necesita ver esto). El link "Cambiar"
  // manda directo a Sucursales, donde también se elige con cuál operar.
  const badgeSucursal = esJefeGeneral ? `
    <a class="sidebar-badge-sucursal" href="${rutaSidebar('sucursales.html')}" title="Cambiar de sucursal">
      <span class="sidebar-icono">${svgIcono('sucursal', 15)}</span>
      <span class="sidebar-texto">${escaparSidebar(localStorage.getItem('sucursal_seleccionada_nombre') || 'Elegir sucursal')}</span>
    </a>
  ` : '';

  const nombreUsuario = usuario ? (usuario.nombre || usuario.usuario || '') : '';
  const rolUsuario = usuario ? (NOMBRES_ROL_SIDEBAR[usuario.rol] || '') : '';

  return `
    <div class="sidebar-overlay" id="sidebarOverlay" onclick="cerrarSidebarMovil()"></div>
    <aside class="sidebar" id="sidebarPrincipal">
      <div class="sidebar-encabezado">
        <a class="sidebar-marca" href="${inicioHref}" title="Compoint Punto">
          <span class="sidebar-icono">${svgIconoCompoint(22)}</span>
          <span class="sidebar-texto">Compoint Punto</span>
        </a>
        <button type="button" class="sidebar-colapsar-escritorio" id="botonCompactarSidebar" onclick="alternarSidebarCompacto()" title="Menú compacto (solo iconos)" aria-label="Menú compacto">${svgIcono('flecha_izquierda', 15)}</button>
        <button type="button" class="sidebar-cerrar-movil" onclick="cerrarSidebarMovil()" aria-label="Cerrar menú">${svgIcono('cerrar', 20)}</button>
      </div>
      ${badgeSucursal}
      <nav class="sidebar-nav">${inicioHTML}${gruposHTML}</nav>
      <div class="sidebar-pie">
        <div class="sg-usuario">
          <div class="sg-avatar" title="${escaparSidebar(nombreUsuario)}">${escaparSidebar(inicialesSidebar(nombreUsuario))}<span class="sg-punto" title="Conexión con el servidor"></span></div>
          <div class="sg-datos" title="${escaparSidebar(nombreUsuario)}">
            <div class="sg-nombre">${escaparSidebar(String(nombreUsuario).trim().split(/\s+/)[0] || '')}</div>
            <div class="sg-rol">${escaparSidebar(rolUsuario)}</div>
          </div>
          <button type="button" class="sg-tema" onclick="alternarTemaGlobal()" title="${escaparSidebar(typeof textoTemaGlobal === 'function' ? textoTemaGlobal() : 'Cambiar entre claro y oscuro')}" aria-label="Cambiar entre claro y oscuro">${typeof iconoTemaGlobal === 'function' ? iconoTemaGlobal() : '☀️'}</button>
          <button type="button" class="sg-salir" onclick="salirConTurno()" title="Cerrar sesión" aria-label="Cerrar sesión">${svgIcono('salir', 18)}</button>
        </div>
      </div>
    </aside>
  `;
}

// ¿Está el menú en modo compacto (solo iconos)? Solo existe en pantallas grandes;
// en celular/tablet angosta el menú siempre se abre como panel con el botón ☰.
function sidebarEsCompacto() {
  return document.body.classList.contains('sidebar-compacto') && window.matchMedia('(min-width: 901px)').matches;
}

function cerrarEmergentesSidebar() {
  document.querySelectorAll('.sidebar-grupo.emergente').forEach((g) => g.classList.remove('emergente'));
}

// Abrir/cerrar un grupo. En modo normal se despliega hacia abajo (y se recuerda);
// en modo compacto se abre como una lista flotante al lado del icono.
function alternarGrupoSidebar(boton) {
  const grupo = boton.closest('.sidebar-grupo');
  if (sidebarEsCompacto()) {
    const yaAbierto = grupo.classList.contains('emergente');
    cerrarEmergentesSidebar();
    if (!yaAbierto) {
      grupo.classList.add('emergente');
      const cuerpo = grupo.querySelector('.sg-cuerpo');
      const r = boton.getBoundingClientRect();
      const alto = cuerpo.offsetHeight;
      cuerpo.style.top = Math.max(8, Math.min(r.top, window.innerHeight - alto - 8)) + 'px';
    }
    return;
  }
  const abierto = grupo.classList.toggle('abierto');
  boton.setAttribute('aria-expanded', String(abierto));
  guardarLocalSidebar('sidebar_grupos', JSON.stringify([...document.querySelectorAll('.sidebar-grupo.abierto[data-grupo]')].map((g) => g.dataset.grupo)));
}

// Menú compacto: se recuerda en este dispositivo para no tener que cambiarlo en cada pantalla.
function aplicarModoCompactoSidebar(compacto) {
  document.body.classList.toggle('sidebar-compacto', compacto);
  const boton = document.getElementById('botonCompactarSidebar');
  if (boton) boton.title = compacto ? 'Menú completo' : 'Menú compacto (solo iconos)';
}

function alternarSidebarCompacto() {
  const compacto = !document.body.classList.contains('sidebar-compacto');
  cerrarEmergentesSidebar();
  aplicarModoCompactoSidebar(compacto);
  guardarLocalSidebar('sidebar_modo', compacto ? 'compacto' : 'normal');
}

function restaurarEstadoSidebar() {
  let modo = leerLocalSidebar('sidebar_modo');
  // Quien antes tenía el menú "oculto" pasa a verlo compacto (así no pierde el espacio que ganó).
  if (modo === null && leerLocalSidebar('sidebar_colapsado') === 'true') modo = 'compacto';
  aplicarModoCompactoSidebar(modo === 'compacto');
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
  // Un clic fuera de la lista flotante (menú compacto) la cierra.
  // (fase de captura: así también cierra aunque el botón que se tocó detenga el evento)
  document.addEventListener('click', (e) => { if (!e.target.closest('.sidebar-grupo.emergente')) cerrarEmergentesSidebar(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarEmergentesSidebar(); });
  window.addEventListener('resize', cerrarEmergentesSidebar);
}

// ---------- Pantallas que no le corresponden a esta persona ----------
// El menú ya oculta lo que no puede usar. Si aun así alguien escribe a mano la dirección de una pantalla
// restringida (o la tenía guardada en favoritos), no se queda ahí: se le regresa a su pantalla de inicio y
// se le avisa. (El servidor además rechaza siempre los datos de esas pantallas: esto es solo para que no las vea.)
function todosLosModulosSidebar() {
  return [ITEM_INICIO_SIDEBAR, ...GRUPOS_SIDEBAR.flatMap((g) => g.items)];
}

function pantallaPermitidaSidebar() {
  const usuario = typeof getUsuario === 'function' ? getUsuario() : null;
  if (!usuario) return true; // sin sesión: cada pantalla ya manda al inicio de sesión
  const item = todosLosModulosSidebar().find((it) => it.href === paginaActual());
  if (!item) return true;    // pantallas fuera del menú (ej. la del repartidor): no se tocan
  return itemVisibleSidebar(item, usuario, permisosExtraDelToken());
}

function pantallaDeInicioSidebar(usuario) {
  // Mismo destino que al iniciar sesión (login.html), siempre que esa pantalla sí le corresponda.
  const porRol = { mostrador: 'mostrador.html', cajero: 'caja.html', repartidor: 'repartidor.html', jefe_general: 'sucursales.html' };
  const extra = permisosExtraDelToken();
  const modulos = todosLosModulosSidebar();
  const propia = porRol[usuario.rol] || 'dashboard.html';
  const enMenu = modulos.find((it) => it.href === propia);
  if (!enMenu || itemVisibleSidebar(enMenu, usuario, extra)) return propia;
  const primero = modulos.find((it) => itemVisibleSidebar(it, usuario, extra));
  return primero ? primero.href : 'cambiar-password.html';
}

const redirigiendoSinPermisoSidebar = (function resguardarPantallaSidebar() {
  if (pantallaPermitidaSidebar()) return false;
  const usuario = getUsuario();
  try { sessionStorage.setItem('aviso_sin_permiso', 'No tienes permiso para entrar a esa pantalla. Te regresamos a tu pantalla de inicio.'); } catch (e) { /* sin almacenamiento */ }
  window.location.replace(rutaSidebar(pantallaDeInicioSidebar(usuario)));
  return true;
})();

function mostrarAvisoSinPermisoSidebar() {
  let aviso = null;
  try { aviso = sessionStorage.getItem('aviso_sin_permiso'); sessionStorage.removeItem('aviso_sin_permiso'); } catch (e) { /* sin almacenamiento */ }
  if (aviso && typeof mostrarToast === 'function') mostrarToast(aviso, 'error', 6000);
}

if (!redirigiendoSinPermisoSidebar) {
  inicializarSidebar();
  mostrarAvisoSinPermisoSidebar(); // el aviso sale en la pantalla a la que se le regresó, no en la que se está cerrando
}
