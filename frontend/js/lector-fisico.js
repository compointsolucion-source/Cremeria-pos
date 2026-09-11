// Soporte para lectores de código de barras físicos (USB o Bluetooth con
// "emulación de teclado" — la inmensa mayoría del mercado funciona así).
// No requieren ninguna app, driver ni permiso especial del navegador: el
// lector simplemente "teclea" el código a gran velocidad y termina con Enter.
// Lo distinguimos de una persona escribiendo por la velocidad entre teclas
// (ningún humano teclea tan rápido de forma sostenida).
function activarLectorFisico(callback, opcionesDeConfiguracion) {
  const opciones = opcionesDeConfiguracion || {};
  const longitudMinima = opciones.longitudMinima || 4;
  const umbralVelocidadMs = opciones.umbralVelocidadMs || 40;

  let buffer = '';
  let ultimaTecla = 0;

  document.addEventListener('keydown', (e) => {
    const ahora = Date.now();
    const tiempoDesdeUltima = ahora - ultimaTecla;
    ultimaTecla = ahora;

    if (e.key === 'Enter') {
      if (buffer.length >= longitudMinima) {
        callback(buffer);
      }
      buffer = '';
      return;
    }

    if (e.key.length === 1) {
      // Si pasó mucho tiempo desde la última tecla, es tecleo humano normal — se reinicia.
      if (tiempoDesdeUltima > umbralVelocidadMs) buffer = '';
      buffer += e.key;
    } else {
      buffer = ''; // Shift, Tab, flechas, etc. rompen la secuencia de escaneo
    }
  });
}
