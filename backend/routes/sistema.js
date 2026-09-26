const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// ============================================================================
// REINICIO DE FÁBRICA
// ============================================================================
// Borra todos los datos de OPERACIÓN de la sucursal del dueño que lo ejecuta
// (ventas/tickets, turnos, movimientos de caja, créditos/abonos, devoluciones,
// movimientos de inventario, fichas/turnos de mostrador) y deja existencias
// y saldos de clientes en 0. NUNCA toca: catálogo (productos, categorías,
// kits, proveedores), clientes (solo su saldo), usuarios, ni configuración.
//
// Protegido en 3 capas: (1) solo rol "dueno", (2) debe volver a escribir su
// propia contraseña, (3) debe escribir la palabra exacta "BORRAR". Además
// exige que no haya un turno de caja abierto, para no dejar la sesión de
// caja actual en un estado inconsistente.
router.post('/reinicio-fabrica', verificarToken, requiereRol('dueno'), async (req, res) => {
  const { password, confirmacion } = req.body;
  const sucursalId = req.usuario.sucursal_id;

  if (!password || !confirmacion) {
    return res.status(400).json({ error: 'Faltan la contraseña o la palabra de confirmación' });
  }
  if (confirmacion.trim() !== 'BORRAR') {
    return res.status(400).json({ error: 'Debes escribir exactamente la palabra BORRAR para confirmar' });
  }

  try {
    const usuarioResult = await pool.query('SELECT * FROM usuarios WHERE id = $1', [req.usuario.id]);
    if (usuarioResult.rows.length === 0) {
      return res.status(401).json({ error: 'No se pudo verificar tu usuario' });
    }
    const passwordValida = await bcrypt.compare(password, usuarioResult.rows[0].password_hash);
    if (!passwordValida) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error al verificar la contraseña' });
  }

  const conexion = await pool.connect();
  try {
    await conexion.query('BEGIN');

    // Bloquea si hay un turno de caja abierto en este momento — evita dejar
    // a la caja que está trabajando ahora mismo en un estado inconsistente.
    const turnoAbierto = await conexion.query(
      `SELECT id FROM turnos WHERE sucursal_id = $1 AND estado = 'abierto'`,
      [sucursalId]
    );
    if (turnoAbierto.rows.length > 0) {
      await conexion.query('ROLLBACK');
      return res.status(409).json({ error: 'Hay un turno de caja abierto. Cierra el corte de caja antes de hacer el reinicio de fábrica.' });
    }

    // Orden de borrado: primero lo que depende de tickets/turnos/clientes,
    // al final lo que ellos mismos dependen de. Todo limitado a esta sucursal.
    await conexion.query(
      `DELETE FROM devolucion_detalle WHERE devolucion_id IN (
         SELECT d.id FROM devoluciones d JOIN tickets t ON d.ticket_id = t.id WHERE t.sucursal_id = $1
       )`,
      [sucursalId]
    );
    await conexion.query(
      `DELETE FROM devoluciones WHERE ticket_id IN (SELECT id FROM tickets WHERE sucursal_id = $1)`,
      [sucursalId]
    );
    await conexion.query(
      `DELETE FROM creditos_abono WHERE cliente_id IN (SELECT id FROM clientes WHERE sucursal_id = $1)`,
      [sucursalId]
    );
    await conexion.query(
      `DELETE FROM creditos_cargo WHERE ticket_id IN (SELECT id FROM tickets WHERE sucursal_id = $1)`,
      [sucursalId]
    );
    await conexion.query(
      `DELETE FROM movimientos_inventario WHERE producto_id IN (SELECT id FROM productos WHERE sucursal_id = $1)`,
      [sucursalId]
    );
    await conexion.query(
      `DELETE FROM ticket_detalle WHERE ticket_id IN (SELECT id FROM tickets WHERE sucursal_id = $1)`,
      [sucursalId]
    );
    await conexion.query(`DELETE FROM tickets WHERE sucursal_id = $1`, [sucursalId]);
    await conexion.query(
      `DELETE FROM movimientos_caja WHERE turno_id IN (SELECT id FROM turnos WHERE sucursal_id = $1)`,
      [sucursalId]
    );
    await conexion.query(`DELETE FROM turnos WHERE sucursal_id = $1`, [sucursalId]);
    await conexion.query(`DELETE FROM fichas WHERE sucursal_id = $1`, [sucursalId]);

    // Existencias en 0 y saldos de clientes en 0 — se conservan las filas
    // (el producto y el cliente siguen existiendo), solo se limpia el
    // resultado numérico de la operación de prueba.
    await conexion.query(
      `UPDATE inventario SET existencia_actual = 0 WHERE producto_id IN (SELECT id FROM productos WHERE sucursal_id = $1)`,
      [sucursalId]
    );
    await conexion.query(`UPDATE clientes SET saldo_actual = 0 WHERE sucursal_id = $1`, [sucursalId]);

    // Limpia la bitácora de esta sucursal (es parte de la operación de
    // prueba) — el registro del reinicio mismo se agrega después, ya con la
    // bitácora vacía, para que quede como el primer evento real del sistema.
    await conexion.query(
      `DELETE FROM bitacora WHERE usuario_id IN (SELECT id FROM usuarios WHERE sucursal_id = $1)`,
      [sucursalId]
    );

    await conexion.query('COMMIT');
  } catch (err) {
    await conexion.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Error al hacer el reinicio de fábrica. No se borró nada.' });
  } finally {
    conexion.release();
  }

  await registrarBitacora(pool, {
    usuario_id: req.usuario.id,
    accion: 'reinicio_fabrica',
    modulo: 'sistema'
  });

  res.json({ mensaje: 'Reinicio de fábrica completado. El catálogo, clientes, usuarios y configuración se conservaron.' });
});

module.exports = router;
