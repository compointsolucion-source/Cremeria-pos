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

// ---------- Etiquetas de báscula (código de barras con peso/precio embebido) ----------
// Formato estándar de 13 dígitos que usan las básculas etiquetadoras (Torrey,
// Rhino, CAS, etc.) cuando imprimen su propia etiqueta adhesiva, tal como lo
// documentan sistemas como eleventa:
//   Dígitos 1-2:   "bandera" — prefijo que indica que es un código de báscula,
//                  no un código de producto normal. El rango 20-29 está
//                  reservado internacionalmente para uso interno de comercios
//                  (no corresponde a ningún producto registrado globalmente),
//                  así que cualquier código en ese rango se trata como
//                  etiqueta de báscula.
//   Dígitos 3-7:   PLU — el código del producto, tal como está dado de alta
//                  en la báscula. Debe coincidir exactamente con el "Código
//                  de barras" registrado para ese producto en Compoint.
//   Dígitos 8-12:  el dato numérico (peso o precio, según cómo esté
//                  configurada la báscula) con los últimos decimales
//                  implícitos (sin punto impreso).
//   Dígito 13:     dígito verificador, calculado con el algoritmo estándar
//                  de EAN-13 — se valida antes de aceptar el código, para no
//                  confundir un código de barras cualquiera de 13 dígitos
//                  con una etiqueta de báscula.
function validarChecksumEAN13(codigo13) {
  if (!/^\d{13}$/.test(codigo13)) return false;
  let suma = 0;
  for (let i = 0; i < 12; i++) {
    const digito = parseInt(codigo13[i], 10);
    suma += (i % 2 === 0) ? digito : digito * 3;
  }
  const verificadorEsperado = (10 - (suma % 10)) % 10;
  return verificadorEsperado === parseInt(codigo13[12], 10);
}

// Intenta interpretar un código escaneado como etiqueta de báscula. Devuelve
// null si no cumple el formato (longitud, bandera o dígito verificador) —
// en ese caso, quien llama debe tratarlo como un código normal (producto,
// kit o folio de ticket, según la pantalla).
// "tipoDato" viene de Configuración → Báscula: 'peso' (kg, 3 decimales
// implícitos, ej. 01250 = 1.250 kg) o 'precio' (importe ya calculado en
// pesos, 2 decimales implícitos, ej. 01250 = $12.50).
function decodificarCodigoBascula(codigo, tipoDato = 'peso') {
  if (typeof codigo !== 'string' || !/^\d{13}$/.test(codigo)) return null;
  const bandera = parseInt(codigo.slice(0, 2), 10);
  if (bandera < 20 || bandera > 29) return null;
  if (!validarChecksumEAN13(codigo)) return null;

  const plu = codigo.slice(2, 7);
  const datoCrudo = parseInt(codigo.slice(7, 12), 10);
  const valor = tipoDato === 'precio' ? datoCrudo / 100 : datoCrudo / 1000;

  return { plu, valor, tipoDato };
}
