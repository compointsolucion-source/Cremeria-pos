// Modo oscuro/claro/sistema, aplicado globalmente. Se incluye en todas las
// pantallas e inyecta un botón flotante para alternar sin editar cada página.
// También maneja los 5 temas de color (independientes de claro/oscuro —
// se pueden combinar, ej. "Azul" + oscuro).
(function () {
  function obtenerTemaPreferido() {
    return localStorage.getItem('tema') || 'sistema';
  }

  function obtenerColorTemaPreferido() {
    return localStorage.getItem('color_tema') || 'verde';
  }

  function aplicarColorTema(colorTema) {
    document.documentElement.setAttribute('data-color-tema', colorTema);
  }

  // Tema "Compoint": además de colores y letra (css/tema-compoint.css) cambia los emojis por íconos de línea.
  // Ese código solo se carga con este tema y antes de pintar la página (así no se ven los emojis un instante).
  const DIR_JS = (document.currentScript && document.currentScript.src || '').replace(/tema\.js(\?.*)?$/, '');
  if (obtenerColorTemaPreferido() === 'compoint' && DIR_JS) {
    if (document.readyState === 'loading') {
      document.write('<script src="' + DIR_JS + 'iconos-compoint.js"><\/script>');
    } else {
      const s = document.createElement('script'); s.src = DIR_JS + 'iconos-compoint.js'; document.head.appendChild(s);
    }
  }

  // Se expone para que Configuración pueda cambiarlo y guardarlo.
  window.establecerColorTema = function (colorTema) {
    const antes = obtenerColorTemaPreferido();
    localStorage.setItem('color_tema', colorTema);
    aplicarColorTema(colorTema);
    // Entrar o salir del tema Compoint cambia los íconos de toda la pantalla: se recarga para aplicarlo completo.
    if ((antes === 'compoint') !== (colorTema === 'compoint')) setTimeout(() => location.reload(), 150);
  };

  function sistemaEsOscuro() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function aplicarTema(tema) {
    const esOscuro = tema === 'oscuro' || (tema === 'sistema' && sistemaEsOscuro());
    document.documentElement.setAttribute('data-tema', esOscuro ? 'oscuro' : 'claro');
  }

  const ICONOS_TEMA = { claro: '☀️', oscuro: '🌙', sistema: '🖥️' };

  function actualizarBotonTema() {
    const texto = `Tema: ${obtenerTemaPreferido()} (toca para cambiar)`;
    const boton = document.getElementById('botonTema');
    if (boton) { boton.textContent = ICONOS_TEMA[obtenerTemaPreferido()]; boton.title = texto; }
    // El menú lateral trae su propio botón de tema (en computadora reemplaza al círculo flotante).
    document.querySelectorAll('.sg-tema').forEach((b) => { b.textContent = ICONOS_TEMA[obtenerTemaPreferido()]; b.title = texto; });
  }

  function alternarTema() {
    const actual = obtenerTemaPreferido();
    const siguiente = actual === 'claro' ? 'oscuro' : actual === 'oscuro' ? 'sistema' : 'claro';
    localStorage.setItem('tema', siguiente);
    aplicarTema(siguiente);
    actualizarBotonTema();
  }

  window.alternarTemaGlobal = function () { alternarTema(); };
  window.iconoTemaGlobal = function () { return ICONOS_TEMA[obtenerTemaPreferido()]; };
  window.textoTemaGlobal = function () { return `Tema: ${obtenerTemaPreferido()} (toca para cambiar)`; };

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
  aplicarColorTema(obtenerColorTemaPreferido());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inyectarBotonTema);
  } else {
    inyectarBotonTema();
  }
})();
