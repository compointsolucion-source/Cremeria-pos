// ============================================================================
// PROVEEDOR DE RECARGAS Y PAGO DE SERVICIOS — capa de abstracción
// ============================================================================
// Todavía NO está conectado a ningún proveedor real (Taecel, Sivetel, etc.).
// Este archivo es el ÚNICO lugar que hay que tocar cuando se tengan las
// credenciales: las rutas en routes/recargas.js ya están listas y llaman a
// las funciones de aquí, así que conectar el proveedor real no debería tocar
// las rutas ni el resto del sistema.
//
// Por qué una capa aparte en vez de llamar al proveedor directo desde la
// ruta: si en el futuro se cambia de proveedor (o se agrega uno segundo como
// respaldo si el primero falla), solo se reescribe este archivo.

// Variables de entorno esperadas una vez que se tenga el proveedor elegido
// (Taecel, por ahora es el candidato — ver PROVEEDOR_RECARGAS_CONFIGURADO
// más abajo). Los nombres exactos de las credenciales hay que confirmarlos
// contra la documentación real que entregue el proveedor al dar de alta la
// cuenta de desarrollador — esto es un placeholder razonable, no un dato
// confirmado.
const RECARGAS_API_KEY = process.env.RECARGAS_API_KEY;
const RECARGAS_API_SECRET = process.env.RECARGAS_API_SECRET;

// Mientras no haya credenciales en el entorno, el módulo se reporta como "no
// configurado" — mismo patrón que ya se usa con Cloudinary en imagenes.js.
const proveedorConfigurado = !!(RECARGAS_API_KEY && RECARGAS_API_SECRET);

function estaConfigurado() {
  return proveedorConfigurado;
}

// Catálogo de compañías/servicios disponibles para vender. Se deja un
// catálogo básico "de referencia" (compañías de telefonía más comunes en
// México) para que la futura pantalla de venta tenga algo con qué armar su
// UI desde ya — el proveedor real normalmente tiene su propio endpoint de
// catálogo (con los montos exactos permitidos por compañía), que es lo que
// debe reemplazar esta lista fija cuando se conecte.
const CATALOGO_REFERENCIA = [
  { codigo: 'telcel', nombre: 'Telcel', tipo: 'recarga' },
  { codigo: 'att', nombre: 'AT&T', tipo: 'recarga' },
  { codigo: 'movistar', nombre: 'Movistar', tipo: 'recarga' },
  { codigo: 'unefon', nombre: 'Unefon', tipo: 'recarga' },
  { codigo: 'cfe', nombre: 'CFE', tipo: 'servicio' },
  { codigo: 'telmex', nombre: 'Telmex', tipo: 'servicio' }
];

async function obtenerCatalogo() {
  // TODO (al conectar el proveedor real): sustituir por la llamada al
  // endpoint de catálogo del proveedor, que normalmente también trae los
  // montos/paquetes exactos que se pueden vender por compañía.
  return CATALOGO_REFERENCIA;
}

async function consultarSaldo() {
  if (!proveedorConfigurado) {
    const err = new Error('El proveedor de recargas todavía no está configurado');
    err.codigo = 'NO_CONFIGURADO';
    throw err;
  }
  // TODO: llamar al endpoint de saldo del proveedor real y devolver
  // { saldo_disponible: <número> } (o el shape que use ese proveedor).
  throw new Error('consultarSaldo: pendiente de implementar contra el proveedor real');
}

// Vende una recarga o un pago de servicio. "datos" trae lo que capture la
// pantalla de venta: compañía/servicio, número de celular o referencia, y
// monto. Devuelve { folio, monto, estado } cuando ya esté implementado.
async function venderRecarga(datos) {
  if (!proveedorConfigurado) {
    const err = new Error('El proveedor de recargas todavía no está configurado');
    err.codigo = 'NO_CONFIGURADO';
    throw err;
  }
  // TODO: armar la solicitud según la API real del proveedor (autenticación,
  // formato exacto del body, manejo de su respuesta/folio) y devolver el
  // resultado normalizado. Mientras tanto nunca debería llegar aquí, porque
  // proveedorConfigurado es siempre false sin las variables de entorno.
  throw new Error('venderRecarga: pendiente de implementar contra el proveedor real');
}

module.exports = { estaConfigurado, obtenerCatalogo, consultarSaldo, venderRecarga };
