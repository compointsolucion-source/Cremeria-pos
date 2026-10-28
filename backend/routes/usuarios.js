const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { verificarToken, requiereRol, tienePermiso, TODOS_LOS_PERMISOS, requiereSucursalId } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');
const paquete = require('../utils/paquete');

// Toda ruta de este archivo ya filtra por sucursal — se resuelve una sola
// vez aquí (req.sucursalId) en vez de repetirlo en cada endpoint.
router.use(verificarToken, requiereSucursalId);

// Listar el equipo de la sucursal (nunca se devuelve el password_hash).
// Incluye "permisos_efectivos": la lista de qué SÍ puede hacer cada empleado
// ahora mismo, combinando lo que trae su rol por defecto con cualquier
// override que se le haya puesto — para que la pantalla de Equipo sepa
// exactamente qué casillas marcar sin tener que recalcularlo ella misma.
router.get('/', verificarToken, requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nombre, usuario, rol, permisos, activo, creado_en, nombre_mostrador, telefono
       FROM usuarios WHERE sucursal_id = $1 AND eliminado_en IS NULL ORDER BY creado_en ASC`,
      [req.sucursalId]
    );

    const equipo = result.rows.map(u => ({
      ...u,
      permisos_efectivos: TODOS_LOS_PERMISOS.filter(p => tienePermiso(u, p))
    }));

    res.json(equipo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el equipo' });
  }
});

// Crear un nuevo empleado
router.post('/', verificarToken, requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  try {
    const { nombre, usuario, password, rol, telefono } = req.body;
    if (!nombre || !usuario || !password || !rol) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    if (!['gerente', 'cajero', 'mostrador', 'repartidor'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    if (rol === 'gerente' && req.usuario.rol === 'gerente') {
      return res.status(403).json({ error: 'Solo el dueño puede crear gerentes' });
    }
    // Límite del paquete contratado (usuarios y app del repartidor).
    try { await paquete.revisarUsuarioNuevo(rol); } catch (e) { return res.status(e.status || 403).json({ error: e.error }); }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo, telefono)
       VALUES ($1, $2, $3, $4, $5, true, $6)
       RETURNING id, nombre, usuario, rol, activo, creado_en, telefono`,
      [req.sucursalId, nombre, usuario, passwordHash, rol, telefono ? String(telefono).slice(0, 20) : null]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'crear_empleado',
      modulo: 'usuarios',
      referencia_id: result.rows[0].id,
      valor_nuevo: { nombre, usuario, rol }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso' });
    res.status(500).json({ error: 'Error al crear el empleado' });
  }
});

// Editar nombre/usuario/rol/activo/permisos de un empleado (dueño/gerente)
router.put('/:id', verificarToken, requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  try {
    const { rol, activo, nombre_mostrador, telefono } = req.body;
    if (rol && !['gerente', 'cajero', 'mostrador', 'repartidor'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    // Permisos: solo se aceptan los que existen y con valor sí/no (nada más se guarda).
    let permisos = null;
    if (req.body.permisos && typeof req.body.permisos === 'object' && !Array.isArray(req.body.permisos)) {
      permisos = {};
      for (const [k, v] of Object.entries(req.body.permisos)) {
        if (TODOS_LOS_PERMISOS.includes(k) && typeof v === 'boolean') permisos[k] = v;
      }
    }

    // Nombre y usuario: si vienen, no pueden quedar vacíos. El usuario no lleva espacios.
    let nombre;
    if (req.body.nombre !== undefined) {
      nombre = String(req.body.nombre || '').trim().slice(0, 100);
      if (!nombre) return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
    }
    let usuario;
    if (req.body.usuario !== undefined) {
      usuario = String(req.body.usuario || '').trim();
      if (!usuario) return res.status(400).json({ error: 'El usuario no puede quedar vacío' });
      if (/\s/.test(usuario)) return res.status(400).json({ error: 'El usuario no puede llevar espacios' });
      if (usuario.length > 30) return res.status(400).json({ error: 'El usuario puede tener máximo 30 letras' });
      if (usuario.includes('~')) return res.status(400).json({ error: 'El usuario no puede llevar el símbolo ~' });
    }

    // Nunca permitir que se edite/desactive al usuario dueño desde aquí
    const objetivo = await pool.query('SELECT rol, nombre, usuario, activo, permisos FROM usuarios WHERE id = $1 AND sucursal_id = $2 AND eliminado_en IS NULL', [req.params.id, req.sucursalId]);
    if (objetivo.rows.length === 0) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (objetivo.rows[0].rol === 'dueno') return res.status(403).json({ error: 'No se puede modificar al usuario dueño desde aquí' });
    // Un gerente no puede tocar a otro gerente ni nombrar gerentes: eso solo lo hace el dueño.
    if (req.usuario.rol === 'gerente' && (objetivo.rows[0].rol === 'gerente' || rol === 'gerente')) {
      return res.status(403).json({ error: 'Solo el dueño puede modificar o nombrar a un gerente' });
    }
    const valorAnterior = objetivo.rows[0];
    // Volver a activar a alguien, o cambiarlo a repartidor, cuenta contra el paquete contratado.
    try {
      const reactiva = activo === true && valorAnterior.activo === false;
      const aRepartidor = rol === 'repartidor' && valorAnterior.rol !== 'repartidor';
      if (reactiva) await paquete.revisarUsuarioNuevo(rol || valorAnterior.rol);
      else if (aRepartidor) await paquete.revisarDomicilio();
    } catch (e) { return res.status(e.status || 403).json({ error: e.error }); }

    const result = await pool.query(
      `UPDATE usuarios SET
        nombre = COALESCE($1, nombre),
        rol = COALESCE($2, rol),
        activo = COALESCE($3, activo),
        permisos = COALESCE(permisos, '{}'::jsonb) || COALESCE($4::jsonb, '{}'::jsonb),
        nombre_mostrador = CASE WHEN $7::boolean THEN $8 ELSE nombre_mostrador END,
        telefono = CASE WHEN $9::boolean THEN $10 ELSE telefono END,
        usuario = COALESCE($11, usuario)
       WHERE id = $5 AND sucursal_id = $6
       RETURNING id, nombre, usuario, rol, activo, permisos, nombre_mostrador, telefono`,
      [nombre, rol, activo, permisos ? JSON.stringify(permisos) : null, req.params.id, req.sucursalId, nombre_mostrador !== undefined, nombre_mostrador || null,
       telefono !== undefined, telefono ? String(telefono).slice(0, 20) : null, usuario]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'editar_empleado',
      modulo: 'usuarios',
      referencia_id: parseInt(req.params.id),
      valor_anterior: valorAnterior,
      valor_nuevo: { nombre: result.rows[0].nombre, usuario: result.rows[0].usuario, rol: result.rows[0].rol, activo: result.rows[0].activo }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso' });
    res.status(500).json({ error: 'Error al actualizar el empleado' });
  }
});

// Eliminar un empleado. NO se borra de la base: se archiva (deja de salir en Equipo, ya no puede entrar
// y su usuario queda libre para otra persona), y sus ventas, turnos y movimientos se conservan tal cual.
router.delete('/:id', verificarToken, requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Empleado inválido' });
    if (id === req.usuario.id) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });

    const objetivo = await pool.query('SELECT id, nombre, usuario, rol FROM usuarios WHERE id = $1 AND sucursal_id = $2 AND eliminado_en IS NULL', [id, req.sucursalId]);
    if (objetivo.rows.length === 0) return res.status(404).json({ error: 'Empleado no encontrado' });
    const emp = objetivo.rows[0];
    if (emp.rol === 'dueno' || emp.rol === 'jefe_general') return res.status(403).json({ error: 'No se puede eliminar al usuario dueño' });
    if (emp.rol === 'gerente' && req.usuario.rol === 'gerente') return res.status(403).json({ error: 'Solo el dueño puede eliminar a un gerente' });

    // No dejar cosas a medias: un turno de caja abierto o entregas pendientes.
    const turno = await pool.query("SELECT 1 FROM turnos WHERE usuario_id = $1 AND estado = 'abierto' LIMIT 1", [id]);
    if (turno.rows.length) return res.status(409).json({ error: `${emp.nombre} tiene un turno de caja abierto. Ciérralo primero y luego elimínalo.` });
    const entregas = await pool.query("SELECT 1 FROM pedidos WHERE repartidor_id = $1 AND estado IN ('programado', 'preparando', 'listo', 'en_camino') LIMIT 1", [id]);
    if (entregas.rows.length) return res.status(409).json({ error: `${emp.nombre} tiene pedidos pendientes por entregar. Reasígnalos o termínalos primero.` });

    await pool.query(
      `UPDATE usuarios SET activo = false, eliminado_en = NOW(), nombre_mostrador = NULL,
              usuario = LEFT(usuario, 30) || '~eliminado~' || id
       WHERE id = $1 AND sucursal_id = $2`,
      [id, req.sucursalId]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'eliminar_empleado',
      modulo: 'usuarios',
      referencia_id: id,
      valor_anterior: { nombre: emp.nombre, usuario: emp.usuario, rol: emp.rol }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el empleado' });
  }
});

// Restablecer la contraseña de un empleado (el dueño/gerente no necesita la anterior)
router.put('/:id/restablecer-password', verificarToken, requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  try {
    const { password_nueva } = req.body;
    if (!password_nueva || password_nueva.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const objetivo = await pool.query('SELECT rol FROM usuarios WHERE id = $1 AND sucursal_id = $2 AND eliminado_en IS NULL', [req.params.id, req.sucursalId]);
    if (objetivo.rows.length === 0) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (objetivo.rows[0].rol === 'dueno' || objetivo.rows[0].rol === 'jefe_general') return res.status(403).json({ error: 'No se puede restablecer la contraseña del dueño desde aquí' });
    if (objetivo.rows[0].rol === 'gerente' && req.usuario.rol === 'gerente') return res.status(403).json({ error: 'Solo el dueño puede restablecer la contraseña de un gerente' });
    if (password_nueva.length > 100) return res.status(400).json({ error: 'La contraseña es demasiado larga' });

    const nuevoHash = await bcrypt.hash(password_nueva, 10);
    // Sube la versión de sesión: las sesiones abiertas de ese empleado se cierran.
    await pool.query('UPDATE usuarios SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2 AND sucursal_id = $3', [nuevoHash, req.params.id, req.sucursalId]);
    require('../middleware/auth')._limpiarMemoriaActivos();

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'restablecer_password',
      modulo: 'usuarios',
      referencia_id: parseInt(req.params.id)
      // Sin valor_anterior/valor_nuevo: nunca se registra información de contraseñas
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al restablecer la contraseña' });
  }
});

module.exports = router;
