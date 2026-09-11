const jwt = require('jsonwebtoken');

function verificarToken(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  jwt.verify(token, process.env.JWT_SECRET, (err, usuario) => {
    if (err) return res.status(401).json({ error: 'Token inválido o expirado' });
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

// Permisos base que cada rol ya tiene SIN que el dueño configure nada — así
// no se le quita a nadie una capacidad que ya usaba. El dueño/gerente puede
// después REVOCAR alguno explícitamente (permisos[clave] = false) o AGREGAR
// uno extra que no venga por defecto (permisos[clave] = true).
const PERMISOS_BASE_POR_ROL = {
  cajero: [
    'VENTAS_CREAR', 'VENTAS_CANCELAR', 'VENTAS_DEVOLVER',
    'CAJA_ABRIR', 'CAJA_CERRAR', 'CAJA_MOVIMIENTO',
    'INVENTARIO_VER', 'REPORTES_VER',
    'CLIENTES_CREAR', 'CREDITO_ABONO'
  ],
  mostrador: ['VENTAS_CREAR']
};

const TODOS_LOS_PERMISOS = [
  'VENTAS_CREAR', 'VENTAS_CANCELAR', 'VENTAS_DEVOLVER', 'DESCUENTO_APLICAR',
  'INVENTARIO_VER', 'INVENTARIO_AJUSTAR', 'INVENTARIO_MERMA',
  'CAJA_ABRIR', 'CAJA_CERRAR', 'CAJA_MOVIMIENTO',
  'REPORTES_VER',
  'PRODUCTOS_CREAR', 'PRODUCTOS_EDITAR', 'PRODUCTOS_PRECIO',
  'CLIENTES_CREAR', 'CREDITO_ABONO'
  // USUARIOS_ADMIN queda fuera a propósito: gestión de equipo sigue siendo
  // exclusiva de dueño/gerente, nunca delegable a cajero/mostrador.
];

// Revisa si un usuario tiene un permiso: dueño/gerente siempre lo tienen;
// para los demás, se respeta primero cualquier override explícito
// (true=otorgado, false=revocado) y si no hay override, el permiso base de su rol.
function tienePermiso(usuario, permiso) {
  if (usuario.rol === 'dueno' || usuario.rol === 'gerente') return true;
  const permisos = usuario.permisos || {};
  if (permisos[permiso] === true) return true;
  if (permisos[permiso] === false) return false;
  return (PERMISOS_BASE_POR_ROL[usuario.rol] || []).includes(permiso);
}

function requierePermiso(permiso) {
  return (req, res, next) => {
    if (tienePermiso(req.usuario, permiso)) return next();
    return res.status(403).json({ error: `No tienes el permiso "${permiso}" para esta acción. Pide a tu gerente que te lo asigne en Equipo.` });
  };
}

module.exports = { verificarToken, requiereRol, requierePermiso, tienePermiso, PERMISOS_BASE_POR_ROL, TODOS_LOS_PERMISOS };
