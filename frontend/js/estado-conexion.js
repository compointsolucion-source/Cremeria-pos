// Indicador visual global de conexión con el servidor: consulta /health
// periódicamente y muestra 🟢 (todo bien) / 🟡 (lento o reconectando) / 🔴 (sin conexión).
// Se inyecta automáticamente, igual que el botón de tema.
(function () {
  let indicador = null;

  function crearIndicador() {
    if (document.getElementById('indicadorConexion')) return;
    indicador = document.createElement('div');
    indicador.id = 'indicadorConexion';
    indicador.style.cssText = 'position:fixed; bottom:16px; left:16px; z-index:999; font-size:20px; cursor:default;';
    indicador.title = 'Estado de conexión con el servidor';
    document.body.appendChild(indicador);
  }

  function actualizarIndicador(estado) {
    if (!indicador) return;
    const iconos = { ok: '🟢', lento: '🟡', sin_conexion: '🔴', verificando: '🟡' };
    indicador.textContent = iconos[estado] || '🟡';
    // El menú lateral muestra el estado como un puntito en el avatar (en vez de
    // un círculo flotante). Mientras "verifica" se deja el último color para que no parpadee.
    if (estado !== 'verificando') document.documentElement.setAttribute('data-conexion', estado);
  }

  let verificando = false;

  async function verificarSalud() {
    if (!indicador || verificando) return;
    // API_URL viene definida por api.js; si no existe todavía, no hacemos nada.
    if (typeof API_URL === 'undefined') return;
    const nube = typeof NubeEstado !== 'undefined' ? NubeEstado : null;
    // Nube dormida: api.js ya la está despertando en segundo plano; aquí solo se muestra 🟡 «reconectando».
    if (nube && nube.estaDormida()) { actualizarIndicador('lento'); return; }
    verificando = true;
    actualizarIndicador('verificando');
    const inicio = Date.now();
    try {
      const respuesta = await fetch(API_URL.replace('/api', '/health'));
      const duracion = Date.now() - inicio;
      if (!respuesta.ok) { actualizarIndicador('sin_conexion'); if (nube) nube.sinRespuesta(); return; }
      if (nube) nube.contesto();
      actualizarIndicador(duracion > 3000 ? 'lento' : 'ok');
    } catch (err) {
      actualizarIndicador('sin_conexion');
      if (nube) nube.sinRespuesta();
    } finally {
      verificando = false;
    }
  }

  // Cuando la nube despierta (o se duerme), el puntito se actualiza al momento.
  window.addEventListener('nube-despierta', () => actualizarIndicador('ok'));

  function iniciar() {
    crearIndicador();
    verificarSalud();
    setInterval(verificarSalud, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
