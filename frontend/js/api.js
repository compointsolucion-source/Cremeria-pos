// API_URL ahora vive en js/config.js (que se carga antes que este archivo
// en cada pantalla) — así, replicar el software para un negocio nuevo solo
// requiere editar ese archivo, sin tocar api.js.

function getToken() {
  return localStorage.getItem('token');
}

function getUsuario() {
  const u = localStorage.getItem('usuario');
  return u ? JSON.parse(u) : null;
}

// El ancho del papel es una preferencia de ESTE dispositivo específico
// (cada terminal puede tener conectada una impresora distinta) — se
// guarda en localStorage, no en la configuración compartida de la tienda.
// Si el dispositivo nunca se configuró, se usa el valor general de la
// tienda como sugerencia inicial (config.ancho_ticket), y de ahí en
// adelante lo que se guarde aquí manda, sin importar qué se cambie en
// otro dispositivo.
function obtenerAnchoTicketDispositivo(config) {
  return localStorage.getItem('ancho_ticket_dispositivo') || (config && config.ancho_ticket) || '80mm';
}

function cerrarSesion() {
  const token = getToken();
  if (token) {
    // "Fire and forget": no bloqueamos el cierre de sesión esperando la respuesta.
    fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  window.location.href = '/login.html';
}

// Para jefe_general (sucursal_id NULL: ve/opera TODAS las sucursales), cada
// solicitud debe decir con cuál sucursal está trabajando en este momento —
// se agrega aquí, en un solo lugar, en vez de tener que acordarse de
// mandarlo en cada pantalla. El resto de los roles ya trae su sucursal fija
// en el token y no les afecta en nada.
function sucursalSeleccionada() {
  return localStorage.getItem('sucursal_seleccionada') || '';
}

function fijarSucursalSeleccionada(id, nombre) {
  localStorage.setItem('sucursal_seleccionada', id);
  localStorage.setItem('sucursal_seleccionada_nombre', nombre || '');
}

// ---------------------------------------------------------------------------
// LICENCIA: prueba de 30 días, aviso de vencimiento, gracia y "solo consulta".
// El servidor manda en cada respuesta los encabezados X-Licencia-Estado, -Tipo,
// -Dias y -Vence (solo cuando hay algo que avisar). Aquí se guardan y se
// muestran en una barra arriba de todas las pantallas.
// ---------------------------------------------------------------------------
const LICENCIA_CONTACTO = 'WhatsApp 33 25 90 70 90 · Tel. 33 15 97 04 12 · contacto@compoint.com.mx';

function licenciaInfo() {
  if (window.__licenciaInfo) return window.__licenciaInfo;
  try { window.__licenciaInfo = JSON.parse(localStorage.getItem('licencia_info') || 'null'); } catch (e) { window.__licenciaInfo = null; }
  return window.__licenciaInfo;
}

function guardarInfoLicencia(info) {
  window.__licenciaInfo = info;
  try { localStorage.setItem('licencia_info', JSON.stringify(info)); } catch (e) { /* sin espacio: se queda en memoria */ }
}

// ¿Estamos en la versión de prueba? (los tickets llevan la leyenda «VERSIÓN DE PRUEBA»)
function licenciaEsPrueba() {
  const i = licenciaInfo();
  return !!(i && i.tipo === 'demo' && i.estado === 'demo');
}

function licenciaSoloConsulta() {
  const i = licenciaInfo();
  return !!(i && i.estado === 'solo_consulta');
}

function _fechaLocalISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function _fechaBonitaLic(iso) {
  const [a, m, d] = String(iso).split('-');
  return `${d}/${m}/${a}`;
}

// Días que faltan según la fecha de vencimiento y el reloj de ESTE equipo (así la barra
// sigue bien aunque la caja lleve un día sin hablar con el servidor).
function _diasLicencia(info) {
  if (info.vence) {
    const [a, m, d] = info.vence.split('-').map(Number);
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    return Math.round((new Date(a, m - 1, d) - hoy) / 86400000);
  }
  return info.dias;
}

function _rutaPaginaLicencia() {
  return window.location.pathname.includes('/admin/') ? 'licencia.html' : 'admin/licencia.html';
}

function _textoBarraLicencia(info) {
  const dias = _diasLicencia(info);
  const plural = (n) => `${n} día${n === 1 ? '' : 's'}`;
  // Texto largo en compu y texto corto en celular.
  const dual = (pc, cel) => `<span class="lic-pc">${pc}</span><span class="lic-cel">${cel}</span>`;
  if (info.estado === 'demo') {
    const cuando = dias <= 0 ? `<b>${dual('Hoy es el último día de tu prueba', 'Último día de prueba')}</b>` : `<b>${dual('Versión de prueba: te quedan ' + plural(dias), 'Prueba: quedan ' + plural(dias))}</b>`;
    return { clase: dias <= 7 ? 'lic-naranja' : 'lic-amarilla', icono: '⏳', cerrable: true, boton: 'Quiero contratar', destino: _rutaPaginaLicencia() + '#contratar',
      html: `${cuando}<span class="lic-extra"> · Todo funciona; al terminar pasa a solo consulta.</span>` };
  }
  if (info.estado === 'por_vencer') {
    const cuando = dias <= 0 ? 'vence hoy' : dias === 1 ? 'vence mañana' : `vence en ${dias} días`;
    const cuandoCel = cuando.charAt(0).toUpperCase() + cuando.slice(1);
    return { clase: 'lic-naranja', icono: '⚠', cerrable: true, boton: 'Renovar', destino: _rutaPaginaLicencia(),
      html: `<b>${dual('Tu licencia ' + cuando, cuandoCel)}</b><span class="lic-extra"> (${_fechaBonitaLic(info.vence)}) · Renueva para no interrumpir tu negocio.</span>` };
  }
  if (info.estado === 'gracia') {
    const restan = Math.max(0, 5 + dias);
    return { clase: 'lic-naranja', icono: '⚠', cerrable: false, boton: 'Renovar ahora', destino: _rutaPaginaLicencia(),
      html: `<b>Tu licencia venció.</b> ${restan === 0 ? dual('Hoy es tu último día de gracia', 'Último día de gracia') : dual(`Te quedan <b>${plural(restan)} de gracia</b>`, `<b>${plural(restan)} de gracia</b>`)}<span class="lic-extra"> para renovar; después solo podrás consultar.</span>` };
  }
  if (info.estado === 'solo_consulta') {
    return { clase: 'lic-roja', icono: '🔒', cerrable: false, boton: 'Activar', destino: _rutaPaginaLicencia(),
      html: `<b>Modo solo consulta.</b><span class="lic-extra"> Puedes ver tus datos, exportar y respaldar. Para volver a vender, ${info.tipo === 'demo' ? 'activa tu licencia' : 'renueva tu licencia'}.</span>` };
  }
  return null;
}

function _barraLicenciaCerradaHoy(info) {
  try { return localStorage.getItem('licencia_barra_cerrada') === `${_fechaLocalISO()}|${info.estado}`; } catch (e) { return false; }
}

// Pone, cambia o quita la barra según el estado actual de la licencia.
// Pantallas que ve el público (turnos, kiosco, factura en línea): nunca llevan la barra de licencia.
const PAGINAS_SIN_BARRA_LICENCIA = ['pantalla-turnos.html', 'kiosco-fichas.html', 'facturar.html'];

function pintarBarraLicencia() {
  const poner = () => {
    if (PAGINAS_SIN_BARRA_LICENCIA.some((p) => window.location.pathname.endsWith('/' + p))) return;
    const info = licenciaInfo();
    let barra = document.getElementById('aviso-licencia');
    const t = info ? _textoBarraLicencia(info) : null;
    if (!t || (t.cerrable && _barraLicenciaCerradaHoy(info))) {
      if (barra) barra.remove();
      document.body.classList.remove('con-aviso-licencia');
      return;
    }
    if (!document.getElementById('estilo-aviso-licencia')) {
      const st = document.createElement('style');
      st.id = 'estilo-aviso-licencia';
      st.textContent = `
        #aviso-licencia{position:fixed;top:0;left:0;right:0;height:34px;z-index:99990;display:flex;gap:10px;align-items:center;justify-content:center;padding:0 40px 0 12px;font:13.5px/1.2 'Segoe UI',Roboto,Arial,sans-serif;border-bottom:1px solid rgba(0,0,0,.12);box-sizing:border-box;overflow:hidden;white-space:nowrap}
        #aviso-licencia .lic-texto{overflow:hidden;text-overflow:ellipsis}
        #aviso-licencia .lic-cel{display:none}
        #aviso-licencia a{flex:none;background:#5FAE46;color:#fff;border-radius:8px;padding:4px 12px;font-weight:700;font-size:12.5px;text-decoration:none}
        #aviso-licencia .lic-x{position:absolute;right:6px;top:3px;width:28px;height:28px;border:0;background:transparent;color:inherit;font-size:18px;cursor:pointer;opacity:.7}
        #aviso-licencia.lic-amarilla{background:#FFF3CD;color:#7a5200}
        #aviso-licencia.lic-naranja{background:#ffe0b3;color:#7a3d00}
        #aviso-licencia.lic-roja{background:#fde3e1;color:#8E1B1B}
        #aviso-licencia.lic-roja a{background:#C62828}
        body.con-aviso-licencia{padding-top:34px;box-sizing:border-box}
        body.con-aviso-licencia .sidebar{top:34px}
        body.con-aviso-licencia .sidebar-boton-reabrir{top:50px}
        @media (max-width:700px){#aviso-licencia .lic-extra,#aviso-licencia .lic-pc{display:none}#aviso-licencia .lic-cel{display:inline}#aviso-licencia .lic-texto{font-size:12.5px}#aviso-licencia{padding-right:34px;gap:6px}}
        @media print{#aviso-licencia{display:none}body.con-aviso-licencia{padding-top:0}}`;
      document.head.appendChild(st);
    }
    if (!barra) {
      barra = document.createElement('div');
      barra.id = 'aviso-licencia';
      barra.setAttribute('role', 'status');
      document.body.appendChild(barra);
    }
    barra.className = t.clase;
    barra.innerHTML = `<span>${t.icono}</span><span class="lic-texto">${t.html}</span><a href="${t.destino}">${t.boton}</a>` +
      (t.cerrable ? '<button class="lic-x" title="Ocultar por hoy" aria-label="Ocultar por hoy">×</button>' : '');
    const x = barra.querySelector('.lic-x');
    if (x) x.onclick = () => {
      try { localStorage.setItem('licencia_barra_cerrada', `${_fechaLocalISO()}|${info.estado}`); } catch (e) { /* nada */ }
      barra.remove(); document.body.classList.remove('con-aviso-licencia');
    };
    document.body.classList.add('con-aviso-licencia');
  };
  if (document.body) poner(); else document.addEventListener('DOMContentLoaded', poner);
}

// Lee los encabezados de licencia de una respuesta del servidor y actualiza la barra.
function actualizarLicenciaDesdeRespuesta(response) {
  const estado = response.headers.get('X-Licencia-Estado');
  const previo = licenciaInfo();
  if (!estado) {
    // Sin encabezado: licencia al corriente (o sin control). Si había un aviso, se quita.
    if (previo && previo.estado !== 'activa') { guardarInfoLicencia({ estado: 'activa' }); pintarBarraLicencia(); }
    return;
  }
  const dias = response.headers.get('X-Licencia-Dias');
  const info = { estado, tipo: response.headers.get('X-Licencia-Tipo') || 'anual', dias: dias === null ? null : Number(dias), vence: response.headers.get('X-Licencia-Vence') || null };
  if (!previo || previo.estado !== info.estado || previo.vence !== info.vence || previo.dias !== info.dias) {
    guardarInfoLicencia(info);
    pintarBarraLicencia();
  }
}

// Lo último que se supo de la licencia se muestra desde que carga la pantalla (aunque no haya internet).
(function () {
  const i = licenciaInfo();
  if (i && i.estado && i.estado !== 'activa') pintarBarraLicencia();
})();

function bloquearPorLicencia(mensaje) {
  const poner = () => {
    if (document.getElementById('bloqueo-licencia')) return;
    const d = document.createElement('div');
    d.id = 'bloqueo-licencia';
    d.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#0F2A1A;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;font-family:sans-serif';
    d.innerHTML = '<h1 style="margin:0 0 12px">Licencia vencida</h1><p style="max-width:420px;font-size:17px;line-height:1.5"></p>';
    d.querySelector('p').textContent = mensaje;
    document.body.appendChild(d);
  };
  if (document.body) poner(); else document.addEventListener('DOMContentLoaded', poner);
}

async function apiFetch(endpoint, options = {}) {
  const token = getToken();
  const usuario = getUsuario();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(usuario && usuario.rol === 'jefe_general' && sucursalSeleccionada() ? { 'X-Sucursal-Id': sucursalSeleccionada() } : {}),
    ...(options.headers || {})
  };

  let response;
  try {
    response = await fetch(`${API_URL}${endpoint}`, { ...options, headers });
  } catch (err) {
    // Esto captura específicamente "Failed to fetch": la solicitud nunca llegó
    // a recibir respuesta (servidor dormido, sin internet, o CORS). Es distinto
    // de un error que el servidor sí devolvió (ver más abajo).
    throw new Error('No se pudo conectar con el servidor. Puede estar iniciando (tarda hasta 50s si estaba inactivo) o no tienes conexión a internet. Intenta de nuevo en unos segundos.');
  }

  const mensajesPorCodigo = {
    400: 'La información enviada no es válida.',
    401: 'Tu sesión expiró. Inicia sesión de nuevo.',
    403: 'No tienes permiso para realizar esta acción.',
    404: 'No se encontró lo que buscabas.',
    409: 'Esta acción ya fue procesada o hay un conflicto con otra solicitud.',
    422: 'Algunos datos no son válidos, revísalos e intenta de nuevo.',
    429: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.',
    500: 'Ocurrió un error inesperado en el servidor.',
    503: 'El servicio no está disponible en este momento. Intenta de nuevo en un momento.'
  };

  // Barra de licencia (prueba, por vencer, gracia, solo consulta): se actualiza con cada respuesta.
  actualizarLicenciaDesdeRespuesta(response);

  if (response.status === 402) {
    const d402 = await response.json().catch(() => ({}));
    // Modo "solo consulta": se puede seguir viendo todo; lo que registra o cambia se rechaza con este aviso.
    if (d402.solo_consulta) {
      throw new Error('Modo solo consulta: la licencia venció y no se pueden registrar ventas ni cambios. Actívala en Licencia (menú Administración) o comunícate con Compoint: ' + LICENCIA_CONTACTO);
    }
    // Licencia vencida (servidor sin la versión nueva): se bloquea la pantalla completa.
    const msg402 = d402.error || 'Licencia vencida. Comunícate con Compoint: ' + LICENCIA_CONTACTO;
    if (!document.getElementById('error')) bloquearPorLicencia(msg402); // en login se muestra en el mensaje de error
    throw new Error(msg402);
  }

  // Solo un token inválido/expirado (401) cierra la sesión. Un 403 significa
  // que el usuario SÍ está autenticado pero no tiene permiso para esta acción
  // específica — cerrar su sesión ahí sería un error (lo sacaría de su turno
  // de trabajo sin motivo).
  if (response.status === 401) {
    cerrarSesion();
    throw new Error(mensajesPorCodigo[401]);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || mensajesPorCodigo[response.status] || `Error del servidor (código ${response.status})`);
    // Algunas pantallas (formularios) necesitan saber QUÉ campo falló.
    if (data.campos) error.campos = data.campos;
    if (data.motivo) error.motivo = data.motivo;
    throw error;
  }
  return data;
}

function requiereLogin() {
  if (!getToken()) window.location.href = '/login.html';
}
