const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Listar el equipo de la sucursal (nunca se devuelve el password_hash)
router.get('/', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nombre, usuario, rol, permisos, activo, creado_en
       FROM usuarios WHERE sucursal_id = $1 ORDER BY creado_en ASC`,
      [req.usuario.sucursal_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el equipo' });
  }
});

// Crear un nuevo empleado
router.post('/', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    const { nombre, usuario, password, rol } = req.body;
    if (!nombre || !usuario || !password || !rol) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    if (!['gerente', 'cajero', 'mostrador'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, nombre, usuario, rol, activo, creado_en`,
      [req.usuario.sucursal_id, nombre, usuario, passwordHash, rol]
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

// Editar nombre/rol/activo/permisos de un empleado (dueño/gerente)
router.put('/:id', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    const { nombre, rol, activo, permisos } = req.body;
    if (rol && !['gerente', 'cajero', 'mostrador'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    // Nunca permitir que se edite/desactive al usuario dueño desde aquí
    const objetivo = await pool.query('SELECT rol, nombre, activo, permisos FROM usuarios WHERE id = $1 AND sucursal_id = $2', [req.params.id, req.usuario.sucursal_id]);
    if (objetivo.rows.length === 0) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (objetivo.rows[0].rol === 'dueno') return res.status(403).json({ error: 'No se puede modificar al usuario dueño desde aquí' });
    const valorAnterior = objetivo.rows[0];

    const result = await pool.query(
      `UPDATE usuarios SET
        nombre = COALESCE($1, nombre),
        rol = COALESCE($2, rol),
        activo = COALESCE($3, activo),
        permisos = COALESCE($4, permisos)
       WHERE id = $5 AND sucursal_id = $6
       RETURNING id, nombre, usuario, rol, activo, permisos`,
      [nombre, rol, activo, permisos ? JSON.stringify(permisos) : null, req.params.id, req.usuario.sucursal_id]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'editar_empleado',
      modulo: 'usuarios',
      referencia_id: parseInt(req.params.id),
      valor_anterior: valorAnterior,
      valor_nuevo: { nombre: result.rows[0].nombre, rol: result.rows[0].rol, activo: result.rows[0].activo }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el empleado' });
  }
});

// Restablecer la contraseña de un empleado (el dueño/gerente no necesita la anterior)
router.put('/:id/restablecer-password', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    const { password_nueva } = req.body;
    if (!password_nueva || password_nueva.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const objetivo = await pool.query('SELECT rol FROM usuarios WHERE id = $1 AND sucursal_id = $2', [req.params.id, req.usuario.sucursal_id]);
    if (objetivo.rows.length === 0) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (objetivo.rows[0].rol === 'dueno') return res.status(403).json({ error: 'No se puede restablecer la contraseña del dueño desde aquí' });

    const nuevoHash = await bcrypt.hash(password_nueva, 10);
    await pool.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [nuevoHash, req.params.id]);

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
