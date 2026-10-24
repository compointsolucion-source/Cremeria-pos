const jwt = require('jsonwebtoken');
const pool = require('../db');

// La sesión ya no se vence por tiempo, así que se comprueba que el usuario siga ACTIVO.
// Si el dueño lo desactiva o lo elimina, su sesión deja de servir de inmediato (máx. 30 s por la memoria rápida).
const _activos = new Map();
const VIGENCIA_CONSULTA_MS = 30 * 1000;
async function usuarioSigueActivo(id) {
  const hoy = Date.now();
  const previo = _activos.get(id);
  if (previo && hoy - previo.t < VIGENCIA_CONSULTA_MS) return previo.activo;
  try {
    const r = await pool.query('SELECT activo FROM usuarios WHERE id = $1', [id]);
    const activo = r.rows.length > 0 && r.rows[0].activo !== false;
    _activos.set(id, { activo, t: hoy });
    if (_activos.size > 500) _activos.clear();
    return activo;
  } catch (e) {
    return true; // si la base no responde un instante, no se saca a nadie de su venta
  }
}

// El repartidor SOLO puede usar su propio módulo (sus entregas y su corte) y lo
// básico de la sesión (cambiar su contraseña, cerrar sesión). Se corta aquí, en un
// solo lugar, para que ninguna ruta del sistema (clientes, ventas, reportes...) le
// responda aunque alguien intente llamarla a mano con su sesión.
const PREFIJOS_REPARTIDOR = ['/api/pedidos/repartidor', '/api/auth'];
function rutaPermitidaParaRepartidor(url) {
  const ruta = String(url || '').split('?')[0];
  if (ruta.includes('..') || ruta.includes('//')) return false;
  return PREFIJOS_REPARTIDOR.some((p) => ruta === p || ruta.startsWith(p + '/'));
}

function verificarToken(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  jwt.verify(token, process.env.JWT_SECRET, (err, usuario) => {
    if (err) return res.status(401).json({ error: 'Token inválido o expirado' });
    if (usuario.rol === 'repartidor' && !rutaPermitidaParaRepartidor(req.originalUrl)) {
      return res.status(403).json({ error: 'Tu usuario de repartidor solo puede usar el módulo de entregas' });
    }
    usuarioSigueActivo(usuario.id).then((activo) => {
      if (!activo) return res.status(401).json({ error: 'Tu usuario ya no está activo' });
      req.usuario = usuario;
      next();
    });
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

// Resuelve CON QUÉ sucursal trabaja esta solicitud y lo deja en req.sucursalId.
// - Para casi todos los usuarios (dueño de una sucursal, gerente, cajero,
//   mostrador), su sucursal viene fija en el token — es la de siempre.
// - Para "jefe_general" (sucursal_id NULL en su usuario: ve/opera TODAS las
//   sucursales), la solicitud debe indicar con cuál quiere trabajar en ese
//   momento, vía ?sucursal_id=N o el header X-Sucursal-Id — así puede cambiar
//   de sucursal sin cerrar sesión. Si no la indica, se corta aquí con un
//   error claro en vez de dejar pasar una consulta sin filtro de sucursal.
function requiereSucursalId(req, res, next) {
  if (req.usuario.sucursal_id) {
    req.sucursalId = req.usuario.sucursal_id;
    return next();
  }

  const idIndicado = parseInt(req.query.sucursal_id || req.headers['x-sucursal-id'], 10);
  if (!idIndicado) {
    return res.status(400).json({ error: 'Selecciona una sucursal para continuar (falta sucursal_id)' });
  }
  req.sucursalId = idIndicado;
  next();
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
  if (usuario.rol === 'jefe_general' || usuario.rol === 'dueno' || usuario.rol === 'gerente') return true;
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

module.exports = {
  _limpiarMemoriaActivos: () => _activos.clear(), verificarToken, requiereRol, requiereSucursalId, requierePermiso, tienePermiso, PERMISOS_BASE_POR_ROL, TODOS_LOS_PERMISOS };
