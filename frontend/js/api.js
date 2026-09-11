const API_URL = 'https://cremeria-pos.onrender.com/api';

function getToken() {
  return localStorage.getItem('token');
}

function getUsuario() {
  const u = localStorage.getItem('usuario');
  return u ? JSON.parse(u) : null;
}

function cerrarSesion() {
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  window.location.href = 'login.html';
}

async function apiFetch(endpoint, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  if (!getToken()) window.location.href = 'login.html';
}
