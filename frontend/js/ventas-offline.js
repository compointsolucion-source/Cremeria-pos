// Ventas cobradas SIN INTERNET (Caja Avanzada).
//
// Si se va el internet, la caja sigue cobrando: la venta se guarda en esta computadora
// (IndexedDB), se imprime su ticket con su folio, y en cuanto regresa la conexión se
// sube sola al sistema (POST /tickets/venta-offline, que no duplica: el folio es único).
//
// Requiere api.js, ui-components.js y offline-db.js (esErrorDeConexion) ya cargados.

const BD_VENTAS_OFFLINE = 'cremeria-pos-ventas-offline';
const CADA_MS_SINCRONIZAR_VENTAS = 30 * 1000;

function abrirBaseVentasOffline() {
  return new Promise((resolve, reject) => {
    const p = indexedDB.open(BD_VENTAS_OFFLINE, 1);
    p.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('ventas')) db.createObjectStore('ventas', { keyPath: 'folio' });
    };
    p.onsuccess = () => resolve(p.result);
    p.onerror = () => reject(p.error);
  });
}

async function guardarVentaOffline(venta) {
  const db = await abrirBaseVentasOffline();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('ventas', 'readwrite');
    tx.objectStore('ventas').put({ ...venta, guardada_en: new Date().toISOString(), error: '' });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function listarVentasOffline() {
  try {
    const db = await abrirBaseVentasOffline();
    const lista = await new Promise((resolve) => {
      const r = db.transaction('ventas', 'readonly').objectStore('ventas').getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => resolve([]);
    });
    db.close();
    return lista.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  } catch (e) { return []; }
}

async function borrarVentaOffline(folio) {
  const db = await abrirBaseVentasOffline();
  await new Promise((resolve) => {
    const tx = db.transaction('ventas', 'readwrite');
    tx.objectStore('ventas').delete(folio);
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
  db.close();
}

async function marcarErrorVentaOffline(venta, mensaje) {
  try { await guardarVentaOffline({ ...venta, error: String(mensaje).slice(0, 200) }); } catch (e) { /* sin espacio */ }
}

// Folio igual que el del servidor (S + sucursal + 6 de tiempo) más 2 caracteres al azar,
// para que dos cajas sin internet no repitan folio.
function generarFolioOffline() {
  const u = (typeof getUsuario === 'function' && getUsuario()) || {};
  const sucursal = u.sucursal_id || (typeof sucursalSeleccionada === 'function' && sucursalSeleccionada()) || 1;
  const base = Date.now().toString(36).toUpperCase().slice(-6);
  const azar = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(2, 'X').slice(0, 2);
  return `S${sucursal}${base}${azar}`;
}

// ---------- Datos que se guardan mientras hay internet, para poder cobrar cuando no lo haya ----------
function claveCacheOffline(nombre) {
  const u = (typeof getUsuario === 'function' && getUsuario()) || {};
  return `offline_${nombre}_${u.id || 0}`;
}
function guardarCacheOffline(nombre, valor) {
  try { localStorage.setItem(claveCacheOffline(nombre), JSON.stringify(valor)); } catch (e) { /* sin espacio */ }
}
function leerCacheOffline(nombre) {
  try { return JSON.parse(localStorage.getItem(claveCacheOffline(nombre))); } catch (e) { return null; }
}
function borrarCacheOffline(nombre) {
  try { localStorage.removeItem(claveCacheOffline(nombre)); } catch (e) { /* nada */ }
}

// Guarda configuración y turno actual para tenerlos sin internet.
async function precalentarCachesOffline() {
  try {
    guardarCacheOffline('config', await apiFetch('/configuracion'));
    const turno = await apiFetch('/turnos/actual');
    if (turno) guardarCacheOffline('turno', turno); else borrarCacheOffline('turno');
  } catch (e) { /* sin internet: se queda lo último guardado */ }
}

// ---------- Subida al regresar el internet ----------
let _sincronizandoVentas = false;

async function sincronizarVentasOffline() {
  if (_sincronizandoVentas) return { subidas: 0 };
  _sincronizandoVentas = true;
  let subidas = 0;
  try {
    const pendientes = await listarVentasOffline();
    for (const v of pendientes) {
      try {
        const { guardada_en, error, ...cuerpo } = v;
        await apiFetch('/tickets/venta-offline', { method: 'POST', body: JSON.stringify(cuerpo) });
        await borrarVentaOffline(v.folio);
        subidas++;
      } catch (err) {
        if (esErrorDeConexion(err)) break; // sigue sin internet: se reintenta luego
        await marcarErrorVentaOffline(v, err.message); // la rechazó el servidor: queda a la vista
      }
    }
  } finally {
    _sincronizandoVentas = false;
  }
  if (subidas > 0 && typeof mostrarToast === 'function') {
    mostrarToast(`✅ Se subieron ${subidas} venta(s) hechas sin internet`, 'exito', 5000);
  }
  await pintarAvisoVentasOffline();
  return { subidas };
}

// ---------- Aviso en pantalla ----------
async function pintarAvisoVentasOffline() {
  let el = document.getElementById('avisoVentasOffline');
  const lista = await listarVentasOffline();
  if (!lista.length) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'avisoVentasOffline';
    el.style.cssText = 'position:fixed; bottom:12px; left:52px; z-index:999; padding:8px 14px; border-radius:20px; font:700 14px sans-serif; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.25);';
    el.onclick = async () => {
      await sincronizarVentasOffline();
      const con = (await listarVentasOffline()).filter(v => v.error);
      if (con.length && typeof mostrarToast === 'function') mostrarToast(`Venta ${con[0].folio} no se pudo subir: ${con[0].error}`, 'error', 8000);
    };
    document.body.appendChild(el);
  }
  const conError = lista.filter(v => v.error).length;
  if (conError) {
    el.style.background = '#C62828'; el.style.color = '#fff';
    el.textContent = `⚠️ ${conError} venta(s) sin internet con problema — toca para ver`;
  } else {
    el.style.background = '#FFB300'; el.style.color = '#222';
    el.textContent = `🟠 ${lista.length} venta(s) sin subir — se suben solas al regresar el internet`;
  }
}

(function () {
  const iniciar = () => {
    pintarAvisoVentasOffline();
    setTimeout(() => { sincronizarVentasOffline(); precalentarCachesOffline(); }, 2500);
    setInterval(() => { sincronizarVentasOffline(); }, CADA_MS_SINCRONIZAR_VENTAS);
    setInterval(precalentarCachesOffline, 5 * 60 * 1000);
    window.addEventListener('online', () => { sincronizarVentasOffline(); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
