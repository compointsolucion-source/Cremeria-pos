// Lista oficial de precios de Compoint Punto.
//
// La ÚNICA lista vive en la página de Compoint (php/precios_punto.php) y se publica en
//   https://www.compoint.com.mx/punto/precios.php
// El sistema la lee de ahí (guarda una copia 6 horas). Si no hay internet, usa la COPIA de
// abajo, que es la lista del día en que salió esta versión del programa.
const URL_PRECIOS = process.env.COMPOINT_PRECIOS_URL || 'https://www.compoint.com.mx/punto/precios.php';
const CACHE_MS = 6 * 60 * 60 * 1000;
const TIEMPO_MAX_MS = 5000;

const COPIA = Object.freeze({
  version: '2026-10-28',
  moneda: 'MXN',
  paquetes: {
    basico: { nombre: 'Básico', sucursales: 1, usuarios: 3, usuarios_texto: '3 usuarios', incluye: ['1 sucursal', '3 usuarios', 'Nube incluida'], mensual: 349, semestral: 1745, anual: 3490 },
    negocio: { nombre: 'Negocio', sucursales: 2, usuarios: 8, usuarios_texto: '8 usuarios', incluye: ['2 sucursales', '8 usuarios', 'Servicio a domicilio y app del repartidor', 'Nube incluida'], mensual: 499, semestral: 2495, anual: 4990 },
    pro: { nombre: 'Pro', sucursales: 4, usuarios: null, usuarios_texto: 'Usuarios ilimitados', incluye: ['4 sucursales', 'Usuarios ilimitados', 'Servicio a domicilio y app del repartidor', 'Nube incluida'], mensual: 799, semestral: 3995, anual: 7990 }
  },
  periodos: {
    mensual: { nombre: 'Mensual', meses: 1, ahorro: '' },
    semestral: { nombre: '6 meses', meses: 6, ahorro: 'Ahorras 1 mes' },
    anual: { nombre: 'Anual', meses: 12, ahorro: 'Ahorras 2 meses' }
  },
  extras: { sucursal_anual: 1500, usuario_anual: 300 },
  sin_nube: {
    nombre: 'Sin nube (pago único)', pago_unico: 2990, sucursales: 1,
    incluye: 'Es para siempre e incluye 1 año de actualizaciones y soporte.',
    renovacion_anual: 990, renovacion_texto: 'Después, la renovación de actualizaciones y soporte es opcional.'
  },
  instalacion: { presencial: 600, distancia: 400 },
  prueba: { dias: 15, url: 'https://www.compoint.com.mx/demos/punto' },
  nota: 'Precios en pesos mexicanos. Antes de pagar te confirmamos por escrito el total, el periodo y la fecha de vencimiento. No hay cobros automáticos.'
});

const PERIODOS = ['mensual', 'semestral', 'anual'];

let cache = { t: 0, lista: null };

/** ¿La lista tiene la forma esperada? (no se confía en lo que llegue de internet) */
function listaValida(l) {
  if (!l || typeof l !== 'object' || !l.paquetes || !l.sin_nube) return false;
  const pq = Object.values(l.paquetes);
  if (!pq.length) return false;
  return pq.every((p) => p && typeof p.nombre === 'string' && PERIODOS.every((k) => Number.isFinite(p[k]) && p[k] > 0)) &&
    Number.isFinite(l.sin_nube.pago_unico);
}

/** Lista vigente: la de la página (si se pudo leer) o la copia. Nunca falla. */
async function obtener({ forzar = false } = {}) {
  if (!forzar && cache.lista && Date.now() - cache.t < CACHE_MS) return cache.lista;
  try {
    const r = await fetch(URL_PRECIOS, { headers: { 'User-Agent': 'CompointPunto/precios' }, signal: AbortSignal.timeout(TIEMPO_MAX_MS) });
    if (r.ok) {
      const l = await r.json();
      if (listaValida(l)) {
        cache = { t: Date.now(), lista: { ...l, origen: 'pagina' } };
        return cache.lista;
      }
    }
  } catch (e) { /* sin internet: se usa la copia */ }
  return cache.lista || { ...COPIA, origen: 'copia' };
}

/** Texto corto del plan: "Negocio · Anual" o "Sin nube (pago único)". */
function textoPlan(lista, plan, paquete, periodo) {
  const l = lista || COPIA;
  if (plan === 'local') return l.sin_nube.nombre;
  const pq = l.paquetes[paquete] ? l.paquetes[paquete].nombre : '';
  const pe = l.periodos && l.periodos[periodo] ? l.periodos[periodo].nombre : '';
  return [pq, pe].filter(Boolean).join(' · ');
}

/** Precio de lista o null. */
function precio(lista, plan, paquete, periodo) {
  const l = lista || COPIA;
  if (plan === 'local') return l.sin_nube.pago_unico;
  const p = l.paquetes[paquete];
  return p && Number.isFinite(p[periodo]) ? p[periodo] : null;
}

function _reiniciar() { cache = { t: 0, lista: null }; }

module.exports = { COPIA, PERIODOS, URL_PRECIOS, obtener, listaValida, textoPlan, precio, _reiniciar };
