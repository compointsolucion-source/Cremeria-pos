// ============================================================================
// PROVEEDOR DE RECARGAS Y PAGO DE SERVICIOS — capa de abstracción
// ============================================================================
// Este archivo es el ÚNICO que habla con el proveedor (Taecel u otro). Las rutas
// (routes/recargas.js) solo llaman a estas funciones, así que cambiar de proveedor
// o agregar uno de respaldo no toca el resto del sistema.
//
// MODOS
//  - "prueba": no hay credenciales. Se simula la venta (nunca se envía saldo real).
//    Sirve para enseñar y probar la pantalla. Esas ventas NO cuentan en el corte.
//  - "real": hay credenciales (RECARGAS_API_KEY y RECARGAS_API_SECRET en el servidor).
//    Falta escribir la llamada real cuando el proveedor entregue su documentación.
//
// Respuesta de venderRecarga: { estado: 'exitosa' | 'fallida' | 'pendiente', folio, mensaje }
//  - 'pendiente' = el proveedor no contestó a tiempo; NO se sabe si pasó. No cuenta en el
//    corte hasta confirmarse.

const RECARGAS_API_KEY = process.env.RECARGAS_API_KEY;
const RECARGAS_API_SECRET = process.env.RECARGAS_API_SECRET;
const proveedorConfigurado = !!(RECARGAS_API_KEY && RECARGAS_API_SECRET);

function estaConfigurado() { return proveedorConfigurado; }
function modo() { return proveedorConfigurado ? 'real' : 'prueba'; }

// Catálogo de referencia. Cuando se conecte el proveedor, su propio catálogo (con los
// montos exactos que permite cada compañía) reemplaza esta lista.
const MONTOS_COMUNES = [10, 20, 30, 50, 100, 150, 200, 300, 500];
// Paquetes de EJEMPLO (nombre y precio): se reemplazan por el catálogo real de Taecel al conectarlo.
const paq = (cia, nombre, montos, detalle) => montos.map((m) => ({ codigo: `${cia}-${m}`, nombre, monto: m, detalle }));
const DETALLE_PAQ = 'Llamadas, mensajes, redes e internet';
// color = color de cada compañía en la pantalla (solo para reconocerla rápido).
const CATALOGO_REFERENCIA = [
  { codigo: 'telcel', nombre: 'Telcel', tipo: 'recarga', color: '#0A3D91', montos: [10, 20, 30, 50, 80, 100, 150, 200, 300, 500],
    paquetes: paq('telcel', 'Amigo Sin Límite', [50, 100, 150, 200, 300, 500], DETALLE_PAQ) },
  { codigo: 'att', nombre: 'AT&T', tipo: 'recarga', color: '#0095D9', montos: MONTOS_COMUNES,
    paquetes: paq('att', 'Unidos', [50, 100, 150, 200, 300], DETALLE_PAQ) },
  { codigo: 'movistar', nombre: 'Movistar', tipo: 'recarga', color: '#019DF4', montos: MONTOS_COMUNES,
    paquetes: paq('movistar', 'Internet + redes', [50, 100, 150, 200], DETALLE_PAQ) },
  { codigo: 'unefon', nombre: 'Unefon', tipo: 'recarga', color: '#E5A800', montos: MONTOS_COMUNES,
    paquetes: paq('unefon', 'Paquete', [50, 100, 150, 200], DETALLE_PAQ) },
  { codigo: 'bait', nombre: 'Bait', tipo: 'recarga', color: '#1D4F9C', montos: [30, 50, 100, 150, 200, 300],
    paquetes: paq('bait', 'Paquete', [100, 150, 200], DETALLE_PAQ) },
  { codigo: 'virgin', nombre: 'Virgin', tipo: 'recarga', color: '#D7192D', montos: [20, 30, 50, 100, 150, 200] },
  { codigo: 'cfe', nombre: 'CFE (luz)', tipo: 'servicio', color: '#00843D', etiqueta: 'Número de servicio (12 dígitos del recibo)' },
  { codigo: 'telmex', nombre: 'Telmex', tipo: 'servicio', color: '#0066B3', etiqueta: 'Teléfono a 10 dígitos' },
  { codigo: 'siapa', nombre: 'SIAPA (agua)', tipo: 'servicio', color: '#1C8DD0', etiqueta: 'Número de cuenta del recibo' },
  { codigo: 'izzi', nombre: 'izzi', tipo: 'servicio', color: '#00A19B', etiqueta: 'Número de cuenta' },
  { codigo: 'totalplay', nombre: 'Totalplay', tipo: 'servicio', color: '#7AB929', etiqueta: 'Número de cuenta' },
  { codigo: 'megacable', nombre: 'Megacable', tipo: 'servicio', color: '#E4002B', etiqueta: 'Número de contrato' },
  { codigo: 'sky', nombre: 'SKY', tipo: 'servicio', color: '#0B4EA2', etiqueta: 'Número de cuenta' }
];
const SERVICIO_MAX = 10000;

async function obtenerCatalogo() {
  // Al conectar el proveedor real: pedir su catálogo y devolverlo con esta misma forma.
  return CATALOGO_REFERENCIA;
}

function buscarEnCatalogo(codigo) {
  return CATALOGO_REFERENCIA.find((c) => c.codigo === codigo) || null;
}

async function consultarSaldo() {
  if (!proveedorConfigurado) return { saldo: 5000, prueba: true };
  // PENDIENTE (con la documentación del proveedor): pedir el saldo y devolver { saldo }.
  const err = new Error('Falta conectar la consulta de saldo con el proveedor');
  err.codigo = 'SIN_INTEGRAR';
  throw err;
}

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Vende. datos = { tipo, compania, referencia, monto, paquete (código o null), folio_interno }
async function venderRecarga(datos) {
  if (!proveedorConfigurado) {
    // Simulación: un número que termina en 0000 sale "rechazado" para poder probar ese caso.
    await esperar(process.env.NODE_ENV === 'test' ? 0 : 700);
    if (/0000$/.test(String(datos.referencia))) {
      return { estado: 'fallida', folio: null, mensaje: 'Número rechazado por la compañía (simulado)' };
    }
    return { estado: 'exitosa', folio: 'PRUEBA-' + String(datos.folio_interno).padStart(6, '0'), mensaje: 'Venta de prueba: no se envió saldo real' };
  }
  // PENDIENTE (con la documentación del proveedor): mandar la venta, esperar máx. ~40 s,
  // y traducir su respuesta a { estado, folio, mensaje }. Si no contesta → 'pendiente'.
  const err = new Error('Falta conectar la venta con el proveedor');
  err.codigo = 'SIN_INTEGRAR';
  throw err;
}

module.exports = { estaConfigurado, modo, obtenerCatalogo, buscarEnCatalogo, consultarSaldo, venderRecarga, SERVICIO_MAX };
