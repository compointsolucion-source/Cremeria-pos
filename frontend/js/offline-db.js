// Guarda una copia local del catálogo (productos, kits, categorías) usando
// IndexedDB — la base de datos que trae el propio navegador, con espacio
// de sobra para catálogos grandes (localStorage es demasiado chico para
// esto). Esto permite seguir vendiendo en Mostrador/Caja Avanzada aunque
// se caiga el internet, usando la última copia guardada.
const NOMBRE_BASE_LOCAL = 'cremeria-pos-offline';
const VERSION_BASE_LOCAL = 1;

function abrirBaseLocal() {
  return new Promise((resolve, reject) => {
    const peticion = indexedDB.open(NOMBRE_BASE_LOCAL, VERSION_BASE_LOCAL);
    peticion.onupgradeneeded = (evento) => {
      const db = evento.target.result;
      if (!db.objectStoreNames.contains('catalogo')) {
        db.createObjectStore('catalogo'); // clave simple: 'productos', 'kits', 'categorias', 'fecha_guardado'
      }
    };
    peticion.onsuccess = () => resolve(peticion.result);
    peticion.onerror = () => reject(peticion.error);
  });
}

async function guardarCatalogoLocal(productos, kits, categorias) {
  try {
    const db = await abrirBaseLocal();
    const tx = db.transaction('catalogo', 'readwrite');
    const store = tx.objectStore('catalogo');
    store.put(productos, 'productos');
    store.put(kits, 'kits');
    // Solo se toca 'categorias' si de verdad se mandó algo — así Caja
    // Avanzada (que no usa categorías) no borra lo que Mostrador ya guardó.
    if (categorias !== undefined) store.put(categorias, 'categorias');
    store.put(new Date().toISOString(), 'fecha_guardado');
  } catch (err) {
    // No es crítico: si falla el guardado local, la app sigue funcionando
    // normal mientras haya internet — solo no habrá respaldo offline.
    console.error('No se pudo guardar el catálogo local:', err.message);
  }
}

function leerDeAlmacen(store, clave, valorPorDefecto) {
  return new Promise((resolve) => {
    const peticion = store.get(clave);
    peticion.onsuccess = () => resolve(peticion.result !== undefined ? peticion.result : valorPorDefecto);
    peticion.onerror = () => resolve(valorPorDefecto);
  });
}

async function obtenerCatalogoLocal() {
  try {
    const db = await abrirBaseLocal();
    const tx = db.transaction('catalogo', 'readonly');
    const store = tx.objectStore('catalogo');
    const [productos, kits, categorias, fecha_guardado] = await Promise.all([
      leerDeAlmacen(store, 'productos', []),
      leerDeAlmacen(store, 'kits', []),
      leerDeAlmacen(store, 'categorias', []),
      leerDeAlmacen(store, 'fecha_guardado', null)
    ]);
    return { productos, kits, categorias, fecha_guardado };
  } catch (err) {
    console.error('No se pudo leer el catálogo local:', err.message);
    return { productos: [], kits: [], categorias: [], fecha_guardado: null };
  }
}

// Distingue un error de "no hay internet" (mensaje específico que ya
// arma api.js) de cualquier otro error (sesión expirada, permiso, etc.) —
// solo en el primer caso tiene sentido usar el catálogo guardado.
function esErrorDeConexion(err) {
  return err && err.message && err.message.includes('No se pudo conectar con el servidor');
}
