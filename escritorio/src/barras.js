'use strict';
// Códigos de barras del ticket con barras EXACTAS.
//
// El ticket se convierte a una imagen en blanco y negro (576 puntos en 80 mm) antes de mandarse a
// la impresora. En ese paso Windows puede achicar o estirar la imagen (por ejemplo, con la escala de
// pantalla al 125 %), y las barras del código quedan de grosor desigual: el lector no las lee.
// Aquí se vuelve a dibujar cada código sobre la imagen final con un número ENTERO de puntos por
// módulo (barra más delgada), centrado en el mismo lugar que ocupaba. No toca nada más del ticket.
//
// buf    : bitmap BGRA (4 bytes por punto), ya en blanco y negro puro.
// ancho  : puntos de ancho del bitmap;  alto : puntos de alto.
// lista  : [{ x, y, w, h, patron }]  recuadro de cada código en pixeles CSS de la página y su patrón
//          (cadena de 1 = barra y 0 = espacio, un carácter por módulo, con la zona blanca incluida).
// escala : puntos de impresora por pixel CSS de la página.
// Devuelve cuántos códigos se redibujaron.
function dibujarBarras(buf, ancho, alto, lista, escala) {
  let hechos = 0;
  if (!buf || !(escala > 0)) return 0;
  for (const b of lista || []) {
    const patron = String((b && b.patron) || '');
    const M = patron.length;
    if (M < 20 || M > ancho || !/^[01]+$/.test(patron)) continue;
    const x0 = Math.round(b.x * escala), x1 = Math.round((b.x + b.w) * escala);
    const y0 = Math.max(0, Math.round(b.y * escala)), y1 = Math.min(alto, Math.round((b.y + b.h) * escala));
    if (!(x1 > x0) || !(y1 > y0)) continue;

    const k = Math.max(1, Math.min(4, Math.round((x1 - x0) / M))); // puntos por módulo
    if (k * M > ancho) continue;
    let izq = x0 + Math.floor(((x1 - x0) - k * M) / 2);
    izq = Math.max(0, Math.min(ancho - k * M, izq));

    // 1) se borra el recuadro que ocupaba el código (y lo que se vaya a dibujar encima)
    const desde = Math.max(0, Math.min(x0, izq)), hasta = Math.min(ancho, Math.max(x1, izq + k * M));
    for (let y = y0; y < y1; y++) {
      for (let x = desde; x < hasta; x++) {
        const i = (y * ancho + x) * 4;
        buf[i] = buf[i + 1] = buf[i + 2] = 255; buf[i + 3] = 255;
      }
    }
    // 2) se dibujan las barras, k puntos por módulo
    for (let m = 0; m < M; m++) {
      if (patron[m] !== '1') continue;
      for (let y = y0; y < y1; y++) {
        for (let d = 0; d < k; d++) {
          const i = (y * ancho + izq + m * k + d) * 4;
          buf[i] = buf[i + 1] = buf[i + 2] = 0; buf[i + 3] = 255;
        }
      }
    }
    hechos++;
  }
  return hechos;
}

// Script que se corre dentro de la página del ticket para medir dónde quedó cada código de barras
// (los marca la pantalla con el atributo data-barras).
const MEDIR_BARRAS = `(function () {
  var lista = [];
  document.querySelectorAll('[data-barras]').forEach(function (el) {
    var r = el.getBoundingClientRect();
    lista.push({ x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height,
                 patron: String(el.getAttribute('data-barras') || '').slice(0, 2000) });
  });
  return { barras: lista.slice(0, 6), anchoPagina: document.documentElement.clientWidth };
})()`;

module.exports = { dibujarBarras, MEDIR_BARRAS };
