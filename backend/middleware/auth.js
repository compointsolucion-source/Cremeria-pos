const jwt = require('jsonwebtoken');

function verificarToken(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  jwt.verify(token, process.env.JWT_SECRET, (err, usuario) => {
    if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
    req.usuario = usuario;
    next();
  });
}

function requiereRol(...rolesPermitidos) {
  return (req, res, next) => {
    if (!rolesPermitidos.includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'No tienes permiso para esta acción' });
    }
    next();
  };
}

// Permisos granulares (además del rol): el dueño siempre tiene todos los
// permisos. Para el resto, se revisa el objeto `permisos` guardado en su
// cuenta (ej. { DESCUENTO_APLICAR: true }). Esto permite que un gerente le dé
// una capacidad puntual a un cajero sin subirlo de rol por completo.
function requierePermiso(permiso) {
  return (req, res, next) => {
    if (req.usuario.rol === 'dueno' || req.usuario.rol === 'gerente') return next();
    const permisos = req.usuario.permisos || {};
    if (permisos[permiso]) return next();
    return res.status(403).json({ error: `No tienes el permiso "${permiso}" para esta acción. Pide a tu gerente que te lo asigne en Equipo.` });
  };
}

module.exports = { verificarToken, requiereRol, requierePermiso };
