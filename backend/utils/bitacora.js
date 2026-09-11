// Helper compartido para registrar acciones críticas en la bitácora de auditoría.
// NUNCA pasar contraseñas, tokens u otra información sensible en valor_anterior/valor_nuevo.
async function registrarBitacora(conexionOPool, { usuario_id, accion, modulo, referencia_id, valor_anterior, valor_nuevo }) {
  try {
    await conexionOPool.query(
      `INSERT INTO bitacora (usuario_id, accion, modulo, referencia_id, valor_anterior, valor_nuevo)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        usuario_id,
        accion,
        modulo,
        referencia_id || null,
        valor_anterior ? JSON.stringify(valor_anterior) : null,
        valor_nuevo ? JSON.stringify(valor_nuevo) : null
      ]
    );
  } catch (err) {
    // La bitácora nunca debe tumbar la operación principal si falla al registrar.
    console.error('Error al registrar en bitácora (no crítico):', err.message);
  }
}

module.exports = { registrarBitacora };
