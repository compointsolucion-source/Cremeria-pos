const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Tope de sucursales de ESTA instalación. No está fijo en el código: se lee
// de una variable de entorno para poder subirlo/bajarlo sin tocar nada (y
// para que, al vender el software a otro negocio, cada instalación pueda
// tener su propio límite según lo que se le haya vendido).
const MAX_SUCURSALES = parseInt(process.env.MAX_SUCURSALES, 10) || 4;

// Listar todas las sucursales — solo jefe_general tiene por qué ver esto
// (el resto del personal ya opera fijo en la suya).
router.get('/', verificarToken, requiereRol('jefe_general'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sucursales ORDER BY id ASC');
    res.json({ sucursales: result.rows, tope: MAX_SUCURSALES });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las sucursales' });
  }
});

// Dar de alta una sucursal nueva, respetando el tope de la instalación.
router.post('/', verificarToken, requiereRol('jefe_general'), async (req, res) => {
  try {
    const { nombre, direccion, telefono } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre de la sucursal es requerido' });
    }

    const conteo = await pool.query('SELECT COUNT(*) FROM sucursales');
    if (parseInt(conteo.rows[0].count, 10) >= MAX_SUCURSALES) {
      return res.status(400).json({ error: `Ya alcanzaste el máximo de ${MAX_SUCURSALES} sucursales para esta instalación` });
    }

    const result = await pool.query(
      `INSERT INTO sucursales (nombre, direccion, telefono, activa)
       VALUES ($1, $2, $3, true) RETURNING *`,
      [nombre.trim(), direccion || null, telefono || null]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'crear_sucursal',
      modulo: 'sucursales',
      referencia_id: result.rows[0].id,
      valor_nuevo: { nombre, direccion, telefono }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear la sucursal' });
  }
});

// Editar nombre/dirección/teléfono/estatus de una sucursal existente.
// Desactivar (activa=false) NO borra nada — solo la saca del selector y de
// los reportes consolidados, para poder "pausar" una sucursal sin perder su
// historial ni liberar su lugar en el tope a propósito.
router.put('/:id', verificarToken, requiereRol('jefe_general'), async (req, res) => {
  try {
    const { nombre, direccion, telefono, activa } = req.body;
    const campos = [];
    const valores = [];
    let i = 1;

    if (nombre !== undefined) { campos.push(`nombre = $${i++}`); valores.push(nombre.trim()); }
    if (direccion !== undefined) { campos.push(`direccion = $${i++}`); valores.push(direccion); }
    if (telefono !== undefined) { campos.push(`telefono = $${i++}`); valores.push(telefono); }
    if (activa !== undefined) { campos.push(`activa = $${i++}`); valores.push(!!activa); }

    if (campos.length === 0) {
      return res.status(400).json({ error: 'No hay nada que actualizar' });
    }

    valores.push(req.params.id);
    const result = await pool.query(
      `UPDATE sucursales SET ${campos.join(', ')} WHERE id = $${i} RETURNING *`,
      valores
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Sucursal no encontrada' });

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'editar_sucursal',
      modulo: 'sucursales',
      referencia_id: req.params.id,
      valor_nuevo: req.body
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al editar la sucursal' });
  }
});

module.exports = router;
