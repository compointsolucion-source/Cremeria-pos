// Express 4 no atrapa los errores de las rutas "async": si una promesa falla fuera de su try/catch
// (por ejemplo, la base de datos no contesta al pedir una conexión), la solicitud se queda colgada
// para siempre y la caja no sabe si cobró o no.
//
// Este ajuste, que se carga UNA vez al arrancar el servidor, hace que cualquier ruta que regrese una
// promesa rechazada mande el error al manejador general (que responde con un mensaje claro).
// Es lo mismo que hace Express 5 por sí solo.
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__compointAsync) {
  const original = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return original.call(this, req, res, next); // manejador de errores: igual que antes
    try {
      const r = fn(req, res, next);
      if (r && typeof r.then === 'function') {
        r.then(undefined, (err) => {
          // Si la ruta ya contestó y después falló algo, solo se anota (no se corta la respuesta ya enviada).
          if (res.headersSent) return console.error(`[${new Date().toISOString()}] Error después de responder en ${req.method} ${req.originalUrl}:`, err && err.message);
          next(err || new Error('Error sin detalle'));
        });
      }
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype.__compointAsync = true;
}

// ¿El error es porque la base de datos no está disponible (detenida, reiniciándose, sin red)?
// Solo errores de PostgreSQL / del cliente pg (no de otros servicios como recargas o correo, que también
// pueden dar ECONNREFUSED pero no significan que la base esté caída).
const ES_SIN_BASE = /timeout exceeded when trying to connect|Connection terminated|terminating connection|the database system is (starting up|shutting down)|connect ECONNREFUSED .*:5432/i;
function esErrorDeBase(err) {
  if (!err) return false;
  return ES_SIN_BASE.test(String(err.message || '')) || /^57P0|^08/.test(String(err.code || ''));
}

module.exports = { esErrorDeBase };
