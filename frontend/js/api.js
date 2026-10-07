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

// Licencia: aviso 7 días antes de vencer (barra arriba) y bloqueo total al vencer.
function mostrarAvisoLicencia(dias, vence) {
  if (document.getElementById('aviso-licencia')) return;
  const poner = () => {
    const d = document.createElement('div');
    d.id = 'aviso-licencia';
    d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#F9A825;color:#1A1A1A;text-align:center;padding:8px 12px;font:600 14px sans-serif';
    const txt = dias === 0 ? 'hoy' : dias === 1 ? 'mañana' : `en ${dias} días`;
    d.textContent = `Tu licencia vence ${txt} (${vence}). Para renovar comunícate con Compoint: WhatsApp 33 25 90 70 90 · Tel. 33 15 97 04 12 · contacto@compoint.com.mx`;
    d.onclick = () => d.remove();
    document.body.appendChild(d);
  };
  if (document.body) poner(); else document.addEventListener('DOMContentLoaded', poner);
}

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

  // Licencia vencida: se bloquea la pantalla completa.
  if (response.status === 402) {
    const d402 = await response.json().catch(() => ({}));
    const msg402 = d402.error || 'Licencia vencida. Comunícate con Compoint: WhatsApp 33 25 90 70 90 · Tel. 33 15 97 04 12 · contacto@compoint.com.mx';
    if (!document.getElementById('error')) bloquearPorLicencia(msg402); // en login se muestra en el mensaje de error
    throw new Error(msg402);
  }

  // Aviso previo al vencimiento (el servidor manda el encabezado desde 7 días antes)
  const diasLic = response.headers.get('X-Licencia-Dias');
  if (diasLic !== null) mostrarAvisoLicencia(Number(diasLic), response.headers.get('X-Licencia-Vence'));

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
    throw new Error(data.error || mensajesPorCodigo[response.status] || `Error del servidor (código ${response.status})`);
  }
  return data;
}

function requiereLogin() {
  if (!getToken()) window.location.href = '/login.html';
}
