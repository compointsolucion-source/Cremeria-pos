const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');

// Exporta todos los datos de la sucursal en un solo JSON descargable.
// Esto es una EXPORTACIÓN manual, no un sistema de backup automático ni de
// restauración con un clic — restaurar estos datos requeriría reinsertarlos
// manualmente en la base de datos. Se documenta así para no simular una
// función de "restaurar" que no existe.
router.get('/exportar', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    const sucursalId = req.usuario.sucursal_id;
    const tablas = {};

    const consulta = async (nombre, sql, valores) => {
      const result = await pool.query(sql, valores);
      tablas[nombre] = result.rows;
    };

    await consulta('productos', 'SELECT * FROM productos WHERE sucursal_id = $1', [sucursalId]);
    await consulta('categorias', 'SELECT * FROM categorias', []);
    await consulta('kits', 'SELECT * FROM kits WHERE sucursal_id = $1', [sucursalId]);
    await consulta('clientes', 'SELECT id, nombre, telefono, limite_credito, saldo_actual, activo FROM clientes WHERE sucursal_id = $1', [sucursalId]);
    await consulta('proveedores', 'SELECT * FROM proveedores WHERE sucursal_id = $1', [sucursalId]);
    await consulta('tickets', `SELECT t.* FROM tickets t WHERE t.sucursal_id = $1 ORDER BY t.fecha_creacion DESC LIMIT 5000`, [sucursalId]);
    await consulta('turnos', 'SELECT * FROM turnos WHERE sucursal_id = $1 ORDER BY fecha_apertura DESC LIMIT 500', [sucursalId]);
    await consulta('inventario', `SELECT i.* FROM inventario i JOIN productos p ON i.producto_id = p.id WHERE p.sucursal_id = $1`, [sucursalId]);
    await consulta('configuracion', 'SELECT direccion, telefono, rfc, ancho_ticket, terminos FROM configuracion WHERE sucursal_id = $1', [sucursalId]);

    // NUNCA se incluyen: password_hash, tokens, ni ningún dato de usuarios completo
    await consulta('usuarios_resumen', 'SELECT id, nombre, usuario, rol, activo FROM usuarios WHERE sucursal_id = $1', [sucursalId]);

    res.json({
      exportado_en: new Date().toISOString(),
      sucursal_id: sucursalId,
      nota: 'Esta es una exportación de datos para respaldo manual, no un backup restaurable con un clic.',
      datos: tablas
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al exportar los datos' });
  }
});

module.exports = router;
