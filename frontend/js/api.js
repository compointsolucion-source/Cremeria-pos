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

  if (response.status === 401 || response.status === 403) {
    cerrarSesion();
    throw new Error('Sesión expirada');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Error del servidor (código ${response.status})`);
  }
  return data;
}

function requiereLogin() {
  if (!getToken()) window.location.href = 'login.html';
}
