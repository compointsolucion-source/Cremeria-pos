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
const CATALOGO_REFERENCIA = [
  { codigo: 'telcel', nombre: 'Telcel', tipo: 'recarga', montos: [10, 20, 30, 50, 80, 100, 150, 200, 300, 500] },
  { codigo: 'att', nombre: 'AT&T', tipo: 'recarga', montos: MONTOS_COMUNES },
  { codigo: 'movistar', nombre: 'Movistar', tipo: 'recarga', montos: MONTOS_COMUNES },
  { codigo: 'unefon', nombre: 'Unefon', tipo: 'recarga', montos: MONTOS_COMUNES },
  { codigo: 'bait', nombre: 'Bait', tipo: 'recarga', montos: [30, 50, 100, 150, 200, 300] },
  { codigo: 'virgin', nombre: 'Virgin', tipo: 'recarga', montos: [20, 30, 50, 100, 150, 200] },
  { codigo: 'cfe', nombre: 'CFE (luz)', tipo: 'servicio', etiqueta: 'Número de servicio (12 dígitos del recibo)' },
  { codigo: 'telmex', nombre: 'Telmex', tipo: 'servicio', etiqueta: 'Teléfono a 10 dígitos' },
  { codigo: 'siapa', nombre: 'SIAPA (agua)', tipo: 'servicio', etiqueta: 'Número de cuenta del recibo' },
  { codigo: 'izzi', nombre: 'izzi', tipo: 'servicio', etiqueta: 'Número de cuenta' },
  { codigo: 'totalplay', nombre: 'Totalplay', tipo: 'servicio', etiqueta: 'Número de cuenta' },
  { codigo: 'megacable', nombre: 'Megacable', tipo: 'servicio', etiqueta: 'Número de contrato' },
  { codigo: 'sky', nombre: 'SKY', tipo: 'servicio', etiqueta: 'Número de cuenta' }
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

// Vende. datos = { tipo, compania, referencia, monto, folio_interno }
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
