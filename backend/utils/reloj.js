// ¿La hora de la computadora del negocio está bien?
//
// En la computadora que es el servidor del negocio, todas las ventas se guardan con SU reloj. Si se fue la
// luz y la hora quedó mal, las ventas salen con horas equivocadas (y fuera de orden) sin que nadie lo note.
// Aquí se compara, cada 30 minutos y solo si hay internet, contra la hora de un servidor de internet
// (el encabezado "Date" de compoint.com.mx). Si hay más de 5 minutos de diferencia, cada respuesta del
// sistema lleva el aviso X-Reloj-Desfase y la pantalla muestra una barra roja para corregirla.
const URL_HORA = process.env.COMPOINT_URL_HORA || 'https://www.compoint.com.mx/';
const TOLERANCIA_MIN = 5;
const CADA_MS = 30 * 60 * 1000;

let desfaseMin = 0; // minutos: positivo = la computadora va adelantada; negativo = atrasada

async function revisar() {
  try {
    const antes = Date.now();
    const r = await fetch(URL_HORA, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    const despues = Date.now();
    const fechaInternet = Date.parse(r.headers.get('date') || '');
    if (!Number.isFinite(fechaInternet)) return; // sin dato confiable: no se cambia nada
    const nuestra = (antes + despues) / 2;
    const min = Math.round((nuestra - fechaInternet) / 60000);
    if (Math.abs(min) >= TOLERANCIA_MIN) {
      if (min !== desfaseMin) console.error(`[${new Date().toISOString()}] AVISO: la hora de esta computadora está ${min > 0 ? 'adelantada' : 'atrasada'} ${Math.abs(min)} minutos.`);
      desfaseMin = min;
    } else {
      desfaseMin = 0;
    }
  } catch (e) {
    /* sin internet: no se puede saber, se deja lo último que se supo */
  }
}

function iniciar() {
  revisar();
  const t = setInterval(revisar, CADA_MS);
  if (t.unref) t.unref();
}

// Middleware: agrega el aviso a cada respuesta mientras la hora esté mal.
function avisoEnRespuesta(req, res, next) {
  if (desfaseMin) res.set('X-Reloj-Desfase', String(desfaseMin));
  next();
}

module.exports = { iniciar, revisar, avisoEnRespuesta, _desfase: () => desfaseMin, _poner: (m) => { desfaseMin = m; } };
