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
  }

  async function verificarSalud() {
    if (!indicador) return;
    actualizarIndicador('verificando');
    const inicio = Date.now();
    try {
      // API_URL viene definida por api.js; si no existe todavía, no hacemos nada.
      if (typeof API_URL === 'undefined') return;
      const respuesta = await fetch(API_URL.replace('/api', '/health'));
      const duracion = Date.now() - inicio;
      if (!respuesta.ok) { actualizarIndicador('sin_conexion'); return; }
      actualizarIndicador(duracion > 3000 ? 'lento' : 'ok');
    } catch (err) {
      actualizarIndicador('sin_conexion');
    }
  }

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
