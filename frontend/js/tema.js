// Modo oscuro/claro/sistema, aplicado globalmente. Se incluye en todas las
// pantallas e inyecta un botón flotante para alternar sin editar cada página.
(function () {
  function obtenerTemaPreferido() {
    return localStorage.getItem('tema') || 'sistema';
  }

  function sistemaEsOscuro() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function aplicarTema(tema) {
    const esOscuro = tema === 'oscuro' || (tema === 'sistema' && sistemaEsOscuro());
    document.documentElement.setAttribute('data-tema', esOscuro ? 'oscuro' : 'claro');
  }

  function actualizarBotonTema() {
    const boton = document.getElementById('botonTema');
    if (!boton) return;
    const iconos = { claro: '☀️', oscuro: '🌙', sistema: '🖥️' };
    boton.textContent = iconos[obtenerTemaPreferido()];
    boton.title = `Tema: ${obtenerTemaPreferido()} (toca para cambiar)`;
  }

  function alternarTema() {
    const actual = obtenerTemaPreferido();
    const siguiente = actual === 'claro' ? 'oscuro' : actual === 'oscuro' ? 'sistema' : 'claro';
    localStorage.setItem('tema', siguiente);
    aplicarTema(siguiente);
    actualizarBotonTema();
  }

  function inyectarBotonTema() {
    if (document.getElementById('botonTema')) return;
    const boton = document.createElement('button');
    boton.id = 'botonTema';
    boton.className = 'boton-tema-flotante';
    boton.onclick = alternarTema;
    document.body.appendChild(boton);
    actualizarBotonTema();
  }

  // Aplicar el tema lo antes posible (antes de pintar) para evitar parpadeo
  aplicarTema(obtenerTemaPreferido());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inyectarBotonTema);
  } else {
    inyectarBotonTema();
  }
})();
