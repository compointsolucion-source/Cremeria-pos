// Programa de escritorio: la sesión de la vez anterior NO se conserva. Si el programa se cerró (Salir, apagón, reinicio),
// al abrirlo de nuevo la persona elige quién es y pone su contraseña. Dentro de la misma apertura la sesión no se pierde.
(function () {
  try {
    if (window.compointDesktop && compointDesktop.arranque && localStorage.getItem('arranque_id') !== compointDesktop.arranque) {
      localStorage.setItem('arranque_id', compointDesktop.arranque);
      localStorage.removeItem('token');
      localStorage.removeItem('usuario');
    }
  } catch (e) { /* sin almacenamiento: se sigue normal */ }
})();

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

// Convierte cualquier texto que viene del servidor (nombres, notas, motivos...) en texto "seguro"
// para meterlo dentro de HTML o de un atributo: así un nombre con <script> o comillas se ve tal cual
// y no se ejecuta como código. Usarlo SIEMPRE en innerHTML con datos que escribe la gente.
function escHtml(t) {
  return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

// "Salir" (botón del usuario): termina la sesión y CIERRA el programa, para que la siguiente persona tenga que abrirlo de nuevo.
// - Programa de escritorio: cierra la aplicación completa (hace su respaldo normal al cerrar).
// - Navegador / acceso directo web: intenta cerrar la ventana; si el navegador no lo permite, deja la pantalla de entrada.
// (Una sesión vencida por sí sola NO cierra el programa: eso lo hace cerrarSesion() y solo regresa a la pantalla de entrada.)
async function salirDelSistema() {
  const token = getToken();
  try {
    if (token) {
      const ctl = new AbortController();
      const tope = setTimeout(() => ctl.abort(), 1500);
      await fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal }).catch(() => {});
      clearTimeout(tope);
    }
  } catch (e) { /* si no responde, igual se sale */ }
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  try {
    if (document.body) document.body.innerHTML = '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0f3d2e;color:#fff;font:600 18px system-ui,sans-serif;text-align:center;padding:24px">Cerrando Compoint Punto…<br>Hasta pronto 👋</div>';
  } catch (e) { /* nada */ }
  if (window.compointDesktop && compointDesktop.salir) {
    try { if (await compointDesktop.salir()) return; } catch (e) { /* cae a la pantalla de entrada */ }
  } else {
    try { window.close(); } catch (e) { /* el navegador no lo permite */ }
  }
  setTimeout(() => { window.location.href = '/login.html'; }, 400);
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
// LICENCIA: prueba gratis, aviso de vencimiento, gracia y "solo consulta".
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

// ---------------------------------------------------------------------------
// NUBE DORMIDA (plan gratis de Render: el servidor se duerme tras 15 min sin uso
// y tarda hasta ~1 minuto en despertar). En vez de dejar la pantalla esperando:
//  1) Si hace rato que el servidor no contesta (la nube probablemente se durmió),
//     antes de mandar una solicitud se le pregunta (/health) con máximo 6 segundos.
//  2) Si no contesta: se activa el MODO SIN CONEXIÓN. Las solicitudes fallan al
//     instante con el mismo error de «sin internet» que ya entienden Mostrador y
//     Caja Avanzada (guardan la venta en la computadora), y en segundo plano se
//     despierta al servidor.
//  3) Cuando despierta: se suben solas las ventas guardadas y se avisa.
// ---------------------------------------------------------------------------
const NUBE_FRESCA_MS = 8 * 60 * 1000;     // Render la duerme a los 15 min sin uso; con 8 min de margen se da por despierta
const NUBE_SONDEO_MS = 6000;              // lo máximo que se espera a /health antes de pasar a modo sin conexión
const NUBE_ESPERA_DESPERTAR_MS = 90000;   // espera de cada intento de despertarla (en segundo plano)
const MENSAJE_SIN_CONEXION = 'No se pudo conectar con el servidor. Puede estar iniciando (tarda hasta 50s si estaba inactivo) o no tienes conexión a internet. Intenta de nuevo en unos segundos.';
const MENSAJE_NUBE_DORMIDA = 'No se pudo conectar con el servidor: la nube está dormida y despierta sola en menos de un minuto. Mientras tanto se trabaja sin conexión.';

const NubeEstado = (function () {
  let dormida = false;
  let despertando = false;
  let sondeoEnCurso = null;

  function urlSalud() {
    const u = String(API_URL);
    return /\/api\/?$/.test(u) ? u.replace(/\/api\/?$/, '/health') : u.replace('/api', '/health');
  }

  // Última vez que el servidor contestó bien (se comparte entre pestañas y pantallas).
  function ultimoOk() { try { return Number(localStorage.getItem('nube_ultimo_ok')) || 0; } catch (e) { return 0; } }
  function anotarOk() { try { localStorage.setItem('nube_ultimo_ok', String(Date.now())); } catch (e) { /* nada */ } }

  // Pregunta a /health y espera máximo limiteMs. true = el servidor y su base de datos contestaron.
  async function sondear(limiteMs) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const reloj = ctl ? setTimeout(() => ctl.abort(), limiteMs) : null;
    try {
      const r = await fetch(urlSalud(), { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      return r.ok; // 502/503 = el servidor sigue despertando
    } catch (e) {
      return false;
    } finally {
      if (reloj) clearTimeout(reloj);
    }
  }

  // Aviso azul en pantalla mientras se trabaja sin conexión (solo en pantallas con sesión iniciada).
  function pintar() {
    const poner = () => {
      let el = document.getElementById('avisoNubeDormida');
      if (!dormida || !getToken()) { if (el) el.remove(); return; }
      if (!el) {
        el = document.createElement('div');
        el.id = 'avisoNubeDormida';
        el.setAttribute('role', 'status');
        el.style.cssText = 'position:fixed; bottom:52px; left:52px; z-index:999; max-width:calc(100vw - 72px); padding:8px 14px; border-radius:20px; font:700 14px/1.25 sans-serif; background:#1565C0; color:#fff; box-shadow:0 2px 8px rgba(0,0,0,.25);';
        el.textContent = '☁️ Nube dormida o sin internet: sigue vendiendo, todo se sube solo al despertar';
        document.body.appendChild(el);
      }
    };
    if (document.body) poner(); else document.addEventListener('DOMContentLoaded', poner);
  }

  function despierta() {
    dormida = false;
    anotarOk();
    pintar();
    try { window.dispatchEvent(new CustomEvent('nube-despierta')); } catch (e) { /* nada */ }
    if (typeof mostrarToast === 'function') mostrarToast('☁️ La nube ya despertó: estás en línea otra vez', 'exito', 4000);
    if (typeof sincronizarVentasOffline === 'function') sincronizarVentasOffline(); // sube lo que se vendió sin conexión
  }

  // Insiste en segundo plano hasta que el servidor conteste (esto además es lo que lo despierta).
  async function despertar() {
    if (despertando) return;
    despertando = true;
    let intentos = 0;
    try {
      while (dormida) {
        if (await sondear(NUBE_ESPERA_DESPERTAR_MS)) { despierta(); break; }
        intentos++;
        await new Promise((r) => setTimeout(r, Math.min(15000, 3000 + intentos * 1000)));
      }
    } finally {
      despertando = false;
    }
  }

  function declararDormida() {
    if (!dormida) { dormida = true; pintar(); }
    despertar();
  }

  // ¿Se puede mandar la solicitud? Si la nube está dormida, no: se pasa a modo sin conexión.
  async function asegurar() {
    if (dormida) { despertar(); return false; }
    if (Date.now() - ultimoOk() < NUBE_FRESCA_MS) return true;
    if (!sondeoEnCurso) sondeoEnCurso = sondear(NUBE_SONDEO_MS).finally(() => { sondeoEnCurso = null; });
    if (await sondeoEnCurso) { anotarOk(); return true; }
    declararDormida();
    return false;
  }

  // Una solicitud no recibió respuesta: se revisa si es la nube (o el internet) y no solo esa solicitud.
  async function alFallar() {
    if (dormida) return;
    if (await sondear(NUBE_SONDEO_MS)) { anotarOk(); return; }
    declararDormida();
  }

  // Para quien ya sabe que el servidor contestó (o no): estado-conexion.js.
  function contesto() { anotarOk(); if (dormida) despierta(); }
  function sinRespuesta() { declararDormida(); }

  window.addEventListener('online', () => { if (dormida) despertar(); });

  return { estaDormida: () => dormida, asegurar, alFallar, contesto, sinRespuesta, anotarOk, sondear };
})();

async function apiFetch(endpoint, options = {}) {
  const token = getToken();
  const usuario = getUsuario();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(usuario && usuario.rol === 'jefe_general' && sucursalSeleccionada() ? { 'X-Sucursal-Id': sucursalSeleccionada() } : {}),
    ...(options.headers || {})
  };

  // Iniciar sesión no se puede hacer sin conexión: ahí sí se espera a que la nube despierte.
  const esLogin = String(endpoint).startsWith('/auth/login');
  if (!esLogin && !(await NubeEstado.asegurar())) throw new Error(MENSAJE_NUBE_DORMIDA);

  let response;
  try {
    response = await fetch(`${API_URL}${endpoint}`, { ...options, headers });
  } catch (err) {
    // Esto captura específicamente "Failed to fetch": la solicitud nunca llegó
    // a recibir respuesta (servidor dormido, sin internet, o CORS). Es distinto
    // de un error que el servidor sí devolvió (ver más abajo).
    if (!esLogin) await NubeEstado.alFallar();
    throw new Error(MENSAJE_SIN_CONEXION);
  }

  // Mientras Render despierta el servidor, su propia página contesta 502/503 (no es JSON de nuestro servidor).
  // Se trata como «sin conexión». Un 504 solo en lecturas: en una venta pudo haberse guardado ya.
  if (!esLogin) {
    const tipo = response.headers.get('content-type') || '';
    const metodo = String(options.method || 'GET').toUpperCase();
    const proxyCaido = response.status === 502 ||
      (response.status === 503 && !tipo.includes('json')) ||
      (response.status === 504 && (metodo === 'GET' || metodo === 'HEAD'));
    if (proxyCaido) { NubeEstado.sinRespuesta(); throw new Error(MENSAJE_NUBE_DORMIDA); }
  }
  if (response.status < 500) NubeEstado.anotarOk();

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
  // (Al iniciar sesión, un 401 es solo «usuario o contraseña incorrectos»: se muestra el aviso del
  // servidor en la pantalla de entrada, sin recargarla.)
  if (response.status === 401 && !esLogin) {
    cerrarSesion();
    throw new Error(mensajesPorCodigo[401]);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || mensajesPorCodigo[response.status] || `Error del servidor (código ${response.status})`);
    // Algunas pantallas (formularios) necesitan saber QUÉ campo falló.
    if (data.campos) error.campos = data.campos;
    if (data.motivo) error.motivo = data.motivo;
    if (data.repetida) error.repetida = true;
    throw error;
  }
  return data;
}

function requiereLogin() {
  if (!getToken()) window.location.href = '/login.html';
}


// ===== Turno abierto: qué hacer al salir, al entrar y al cerrar el programa =====
// Si la persona tiene un turno de caja abierto, antes de salir o cambiar de usuario se le pregunta si cierra caja
// (hace su corte) o deja el turno abierto. Al volver a entrar con un turno abierto, se le pregunta si lo continúa
// o hace el corte. Todo usa el mismo cierre de turno de la pantalla "Corte de Caja".
(function () {
  const estilo = document.createElement('style');
  estilo.textContent = `
  .tsx-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:5000;padding:12px}
  .tsx{background:var(--surface,#fff);color:var(--text,#1F2023);border-radius:16px;width:min(440px,100%);box-shadow:0 18px 60px rgba(0,0,0,.35);overflow:hidden}
  .tsx-cab{background:var(--primary,#5FAE46);color:#fff;padding:14px 20px;font-weight:800;font-size:17px;letter-spacing:.2px}
  .tsx-cuerpo{padding:18px 20px 20px}
  .tsx-sub{font-size:14.5px;margin:0 0 4px;font-weight:600}
  .tsx-dato{font-size:13px;color:var(--muted,#7A7D83);margin:0 0 16px}
  .tsx-btn{display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:1.5px solid var(--border,#E4E6E9);background:var(--surface,#fff);color:inherit;border-radius:12px;padding:13px 14px;margin-bottom:10px;font:inherit;cursor:pointer}
  .tsx-btn:focus-visible{outline:3px solid color-mix(in srgb,var(--primary,#5FAE46) 45%,transparent);outline-offset:1px}
  .tsx-btn .ic{font-size:24px;line-height:1}
  .tsx-btn b{display:block;font-size:15.5px}
  .tsx-btn small{display:block;font-size:12.5px;color:var(--muted,#7A7D83);margin-top:2px;font-weight:500}
  .tsx-btn.rojo{border-color:#C62828}
  .tsx-btn.rojo b{color:#C62828}
  .tsx-btn.verde{background:var(--primary,#5FAE46);border-color:var(--primary,#5FAE46);color:#fff}
  .tsx-btn.verde small{color:rgba(255,255,255,.9)}
  .tsx-cancel{display:block;width:100%;text-align:center;border:none;background:transparent;color:var(--muted,#7A7D83);font:inherit;font-weight:700;padding:8px;cursor:pointer;margin-top:2px}
  .tsx-nota{background:#FFF6D6;border:1px solid #E6D48A;color:#6B5A12;border-radius:10px;padding:9px 12px;font-size:12.5px;margin-top:6px}
  [data-tema="oscuro"] .tsx-nota{background:#3A3420;border-color:#6B5A12;color:#F0DE9A}
  `;
  document.head.appendChild(estilo);
})();

// Turno abierto de quien está usando el sistema (o null si no tiene, no aplica a su rol o no se pudo consultar).
async function turnoAbiertoDelUsuario() {
  try {
    const u = getUsuario();
    if (!getToken() || !u || u.rol === 'repartidor' || u.rol === 'jefe_general') return null;
    const t = await apiFetch('/turnos/actual');
    return t && t.estado !== 'cerrado' ? t : null;
  } catch (e) { return null; }
}

// "Turno abierto hoy a las 10:47 a.m. · 3 ventas · $52.50"
async function textoResumenTurno(t) {
  const d = new Date(t.fecha_apertura), ayer = new Date(Date.now() - 86400000);
  const hora = d.toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
  let dia;
  if (d.toDateString() === new Date().toDateString()) dia = 'hoy';
  else if (d.toDateString() === ayer.toDateString()) dia = 'ayer';
  else dia = 'el ' + d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }).replace('.', '');
  let texto = `${dia} a las ${hora}`;
  try {
    const r = await apiFetch(`/turnos/${t.id}/resumen`);
    const n = (r.cuentas || {}).normales || 0;
    texto += ` · ${n} venta${n === 1 ? '' : 's'} · $` + Number(r.ventas.venta_neta || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch (e) { /* sin resumen: solo la hora */ }
  return texto;
}

// Aviso con botones grandes. Devuelve la clave del botón elegido ('cancelar' con Esc o con el botón Cancelar).
function avisoTurno({ titulo, sub, dato, botones, nota, cancelar }) {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const previo = document.getElementById('avisoTurnoSalida');
  if (previo) previo.remove();
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.id = 'avisoTurnoSalida';
    ov.className = 'tsx-ov';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.innerHTML = `<div class="tsx"><div class="tsx-cab">${esc(titulo)}</div><div class="tsx-cuerpo">
      <p class="tsx-sub">${esc(sub)}</p><p class="tsx-dato">${esc(dato)}</p>
      ${botones.map((b) => `<button type="button" class="tsx-btn ${b.clase || ''}" data-k="${esc(b.k)}"><span class="ic">${b.icono}</span><span><b>${esc(b.texto)}</b><small>${esc(b.detalle)}</small></span></button>`).join('')}
      ${cancelar ? `<button type="button" class="tsx-cancel" data-k="cancelar">${esc(cancelar)}</button>` : ''}
      ${nota ? `<div class="tsx-nota">${esc(nota)}</div>` : ''}</div></div>`;
    const terminar = (k) => { document.removeEventListener('keydown', teclas, true); ov.remove(); resolve(k); };
    const teclas = (e) => { if (e.key === 'Escape' && cancelar) { e.preventDefault(); e.stopPropagation(); terminar('cancelar'); } };
    ov.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) terminar(b.dataset.k); });
    document.addEventListener('keydown', teclas, true);
    document.body.appendChild(ov);
    const primero = ov.querySelector('.tsx-btn.verde') || ov.querySelector('.tsx-btn');
    if (primero) primero.focus();
  });
}

// Botón "Salir" / cambio de usuario.
async function salirConTurno() {
  const t = await turnoAbiertoDelUsuario();
  if (!t) { salirDelSistema(); return; }
  const r = await avisoTurno({
    titulo: '🔒 Tu turno de caja sigue abierto',
    sub: '¿Qué quieres hacer antes de salir?',
    dato: 'Turno abierto ' + await textoResumenTurno(t),
    botones: [
      { k: 'cerrar', icono: '🔒', clase: 'rojo', texto: 'Cerrar caja y salir', detalle: 'Haces tu corte ahora (declaras el dinero)' },
      { k: 'dejar', icono: '🚪', texto: 'Dejar turno abierto y salir', detalle: 'Al volver a entrar podrás continuar tu turno' }
    ],
    cancelar: 'Cancelar',
    nota: '⚠️ Si dejas el turno abierto, solo tú o un administrador podrán continuarlo.'
  });
  if (r === 'cerrar') window.location.href = '/admin/caja-turno.html?cerrar=salir';
  else if (r === 'dejar') salirDelSistema();
}

// Al entrar con un turno abierto: continuar o hacer el corte. Devuelve 'continuar' o 'cerrar'.
async function elegirTurnoAlEntrar() {
  const t = await turnoAbiertoDelUsuario();
  if (!t) return 'continuar';
  const r = await avisoTurno({
    titulo: '👋 Tienes un turno abierto',
    sub: new Date(t.fecha_apertura).toDateString() === new Date().toDateString() ? 'Sigue abierto desde hoy.' : 'Quedó abierto de un día anterior y no se ha cerrado.',
    dato: 'Turno abierto ' + await textoResumenTurno(t),
    botones: [
      { k: 'continuar', icono: '▶️', clase: 'verde', texto: 'Continuar mi turno', detalle: 'Sigues vendiendo con el mismo turno y la misma caja' },
      { k: 'cerrar', icono: '🔒', clase: 'rojo', texto: 'Cerrar caja (hacer corte)', detalle: 'Declaras el dinero y se cierra este turno; después abres uno nuevo' }
    ],
    nota: '💡 Si ya terminó tu jornada anterior, lo correcto es hacer el corte antes de empezar a vender.'
  });
  return r === 'cerrar' ? 'cerrar' : 'continuar';
}

// Lo llama el programa de escritorio al elegir "Salir por completo". Devuelve 'salir' o 'cancelar'.
async function preguntarSalidaPrograma() {
  const t = await turnoAbiertoDelUsuario();
  if (!t) return 'salir';
  const r = await avisoTurno({
    titulo: 'Salir de Compoint Punto',
    sub: 'Tu turno de caja sigue abierto. Elige la opción que deseas.',
    dato: 'Turno abierto ' + await textoResumenTurno(t),
    botones: [
      { k: 'cerrar', icono: '🔒', clase: 'rojo', texto: 'Cerrar caja…', detalle: 'Haces el corte y después se cierra el programa' },
      { k: 'dejar', icono: '🚪', texto: 'Dejar turno abierto y salir…', detalle: 'Al abrir el programa podrás continuar tu turno' }
    ],
    cancelar: 'Cancelar',
    nota: '⚠️ Si dejas el turno abierto, solo tú o un administrador podrán continuarlo.'
  });
  if (r === 'cerrar') { window.location.href = '/admin/caja-turno.html?cerrar=programa'; return 'cancelar'; }
  if (r === 'dejar') {
    // Se cierra la sesión para que, al abrir el programa, vuelva a preguntar si continúa el turno.
    try { await fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` } }); } catch (e) { /* sin red: igual se sale */ }
    localStorage.removeItem('token');
    localStorage.removeItem('usuario');
    return 'salir';
  }
  return 'cancelar';
}

// ===== Términos y condiciones: el dueño los acepta una sola vez por versión =====
// Al entrar, si el negocio todavía no acepta la versión vigente, al dueño (o jefe general) le sale una ventana
// obligatoria con lo más importante en 5 puntos y la casilla "Acepto". Sin aceptar no puede seguir (solo "Salir").
// Los demás usuarios (cajeros, mostrador...) no ven nada. La constancia queda en el servidor (fecha, IP, versión, huella).
const PAGINAS_SIN_TERMINOS = ['login.html', 'index.html', 'pantalla-turnos.html', 'kiosco-fichas.html', 'facturar.html'];

function mostrarVentanaTerminos(e, clave) {
  if (document.getElementById('cp-terminos')) return;
  if (!document.getElementById('estilo-cp-terminos')) {
    const st = document.createElement('style');
    st.id = 'estilo-cp-terminos';
    st.textContent = `
      #cp-terminos{position:fixed;inset:0;z-index:100001;background:rgba(10,14,20,.72);display:flex;align-items:center;justify-content:center;padding:16px}
      #cp-terminos .ct-caja{background:var(--surface,#fff);color:var(--text,#1F2023);border-radius:18px;max-width:640px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.45);overflow:hidden}
      #cp-terminos .ct-cab{padding:18px 22px 10px}
      #cp-terminos .ct-cab small{color:var(--primary,#5FAE46);font-weight:800;letter-spacing:.06em;font-size:12px}
      #cp-terminos .ct-cab h2{font-size:21px;margin:4px 0 2px}
      #cp-terminos .ct-cab p{color:var(--muted,#7A7D83);font-size:13.5px;margin:0}
      #cp-terminos .ct-cuerpo{padding:6px 22px 4px;overflow:auto}
      #cp-terminos .ct-resumen{display:grid;gap:8px;margin:8px 0 12px}
      #cp-terminos .ct-r{display:flex;gap:10px;align-items:flex-start;background:rgba(95,174,70,.09);border:1px solid rgba(95,174,70,.25);border-radius:12px;padding:9px 12px;font-size:14px;line-height:1.35}
      #cp-terminos .ct-r b{display:block}
      #cp-terminos .ct-r .ct-ic{font-size:18px;line-height:1}
      #cp-terminos .ct-ver{font-size:13.5px;font-weight:700;color:#2E7D32;text-decoration:none}
      [data-tema="oscuro"] #cp-terminos .ct-ver{color:#8BD97A}
      #cp-terminos .ct-pie{padding:12px 22px 16px;border-top:1px solid var(--border,#E4E6E9);display:grid;gap:10px}
      #cp-terminos label.ct-chk{display:flex;gap:10px;align-items:flex-start;font-size:14px;font-weight:600;cursor:pointer}
      #cp-terminos label.ct-chk input{width:20px;height:20px;margin-top:1px;flex:none;accent-color:#5FAE46}
      #cp-terminos .ct-ok{border:none;border-radius:12px;padding:14px;font-weight:800;font-size:15.5px;cursor:pointer;background:var(--primary,#5FAE46);color:#fff}
      #cp-terminos .ct-ok:disabled{opacity:.45;cursor:not-allowed}
      #cp-terminos .ct-err{color:#C62828;font-size:13px;font-weight:600;text-align:center;min-height:0}
      #cp-terminos .ct-err:empty{display:none}
      #cp-terminos .ct-nota{font-size:11.5px;color:var(--muted,#7A7D83);text-align:center}
      #cp-terminos .ct-salir{border:none;background:transparent;color:var(--muted,#7A7D83);font:inherit;font-size:13px;font-weight:700;cursor:pointer;text-decoration:underline}`;
    document.head.appendChild(st);
  }
  const ov = document.createElement('div');
  ov.id = 'cp-terminos';
  ov.innerHTML = `
    <div class="ct-caja" role="dialog" aria-modal="true" aria-labelledby="ctTitulo">
      <div class="ct-cab"><small>ANTES DE EMPEZAR · UNA SOLA VEZ</small><h2 id="ctTitulo">Términos y condiciones de Compoint Punto</h2>
        <p>Lo más importante, en 5 puntos. Puedes leer el texto completo cuando quieras.</p></div>
      <div class="ct-cuerpo"><div class="ct-resumen"></div><a class="ct-ver" target="_blank" rel="noopener"></a></div>
      <div class="ct-pie">
        <label class="ct-chk"><input type="checkbox" id="ctAcepto"> <span class="ct-txt"></span></label>
        <button type="button" class="ct-ok" disabled>Aceptar y continuar</button>
        <div class="ct-err" role="alert"></div>
        <div class="ct-nota"></div>
        <div style="text-align:center"><button type="button" class="ct-salir">No acepto · Salir del sistema</button></div>
      </div>
    </div>`;
  const res = ov.querySelector('.ct-resumen');
  (e.resumen || []).forEach((p) => {
    const d = document.createElement('div'); d.className = 'ct-r';
    const ic = document.createElement('span'); ic.className = 'ct-ic'; ic.textContent = p.icono || '•';
    const t = document.createElement('div'); const b = document.createElement('b'); b.textContent = p.titulo;
    t.appendChild(b); t.appendChild(document.createTextNode(p.texto)); d.appendChild(ic); d.appendChild(t); res.appendChild(d);
  });
  const ver = ov.querySelector('.ct-ver');
  ver.href = e.url_completos || 'https://www.compoint.com.mx/terminos.php';
  ver.textContent = '📄 Leer términos completos, política de pagos y aviso de privacidad →';
  ov.querySelector('.ct-txt').textContent = e.texto_acepto || 'Leí y acepto los Términos y condiciones de Compoint.';
  ov.querySelector('.ct-nota').textContent = `Versión ${e.version} · Se guarda la fecha, la hora y quién aceptó.`;
  const chk = ov.querySelector('#ctAcepto');
  const ok = ov.querySelector('.ct-ok');
  const err = ov.querySelector('.ct-err');
  chk.addEventListener('change', () => { ok.disabled = !chk.checked; });
  ok.addEventListener('click', async () => {
    if (!chk.checked) return;
    ok.disabled = true; err.textContent = '';
    try {
      await apiFetch('/terminos/aceptar', { method: 'POST', body: JSON.stringify({ acepto: true, version: e.version }) });
      try { sessionStorage.setItem(clave, '1'); } catch (x) { /* nada */ }
      ov.remove();
    } catch (x) {
      if (/actualizaron/.test(x.message)) { window.location.reload(); return; }
      err.textContent = x.message || 'No se pudo guardar. Intenta de nuevo.';
      ok.disabled = !chk.checked;
    }
  });
  ov.querySelector('.ct-salir').addEventListener('click', () => {
    if (typeof salirDelSistema === 'function') salirDelSistema(); else cerrarSesion();
  });
  // Mientras esté abierta, nada de atrás se puede usar (ni con el teclado).
  ov.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') ev.stopPropagation(); });
  document.body.appendChild(ov);
  setTimeout(() => { try { chk.focus(); } catch (x) { /* nada */ } }, 50);
}

async function revisarTerminos() {
  try {
    if (!getToken()) return;
    const u = getUsuario();
    if (!u || !['dueno', 'jefe_general'].includes(u.rol)) return;
    const ruta = window.location.pathname;
    if (ruta === '/' || PAGINAS_SIN_TERMINOS.some((p) => ruta.endsWith('/' + p))) return;
    const clave = 'terminos_ok_' + (u.id || u.usuario || '');
    try { if (sessionStorage.getItem(clave)) return; } catch (x) { /* sin almacenamiento: se pregunta al servidor */ }
    const e = await apiFetch('/terminos/estado');
    if (!e || e.aceptado || e.sin_dato) { try { sessionStorage.setItem(clave, '1'); } catch (x) { /* nada */ } return; }
    if (!e.puede_aceptar) return;
    mostrarVentanaTerminos(e, clave);
  } catch (err) { /* sin conexión o servidor sin esta función: se vuelve a revisar la próxima vez */ }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { revisarTerminos(); });
else revisarTerminos();
