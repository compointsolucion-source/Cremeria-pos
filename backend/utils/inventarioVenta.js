// Descuenta del inventario lo vendido en un ticket ya pagado. Lo usan el cobro normal
// (routes/tickets.js) y la liquidación de pedidos a domicilio (routes/pedidos.js).
// Devuelve los nombres de los productos que quedaron agotados.
async function descontarInventarioVenta(conexion, ticketId, usuarioId) {
  // Descontar inventario automáticamente por cada producto vendido (no aplica a kits, que descuentan sus componentes).
  // La existencia NUNCA baja de 0 (GREATEST), pero la venta se permite de
  // todas formas — solo se avisa al final si algún producto quedó agotado.
  const productosAgotados = [];
  const items = await conexion.query('SELECT * FROM ticket_detalle WHERE ticket_id = $1', [ticketId]);
  for (const item of items.rows) {
    if (item.tipo === 'producto' && item.producto_id) {
      await conexion.query(
        `INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, 0)
         ON CONFLICT (producto_id) DO NOTHING`,
        [item.producto_id]
      );
      const antesResult = await conexion.query('SELECT existencia_actual FROM inventario WHERE producto_id = $1', [item.producto_id]);
      const existenciaAntes = parseFloat(antesResult.rows[0].existencia_actual);
      if (existenciaAntes - parseFloat(item.cantidad) < 0) {
        productosAgotados.push(item.nombre_producto);
      }
      await conexion.query(
        'UPDATE inventario SET existencia_actual = GREATEST(existencia_actual - $1, 0) WHERE producto_id = $2',
        [item.cantidad, item.producto_id]
      );
      await conexion.query(
        `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, referencia_id, usuario_id)
         VALUES ($1, 'salida_venta', $2, $3, $4)`,
        [item.producto_id, -item.cantidad, ticketId, usuarioId]
      );
    } else if (item.tipo === 'kit' && item.kit_id) {
      const componentes = await conexion.query('SELECT * FROM kit_productos WHERE kit_id = $1', [item.kit_id]);
      for (const comp of componentes.rows) {
        const cantidadTotal = comp.cantidad * item.cantidad; // por si el kit se vendió más de una vez
        await conexion.query(
          `INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, 0) ON CONFLICT (producto_id) DO NOTHING`,
          [comp.producto_id]
        );
        const antesResult = await conexion.query('SELECT existencia_actual FROM inventario WHERE producto_id = $1', [comp.producto_id]);
        const existenciaAntes = parseFloat(antesResult.rows[0].existencia_actual);
        if (existenciaAntes - cantidadTotal < 0) {
          const nombreProdResult = await conexion.query('SELECT nombre FROM productos WHERE id = $1', [comp.producto_id]);
          productosAgotados.push(nombreProdResult.rows[0].nombre);
        }
        await conexion.query(
          'UPDATE inventario SET existencia_actual = GREATEST(existencia_actual - $1, 0) WHERE producto_id = $2',
          [cantidadTotal, comp.producto_id]
        );
        await conexion.query(
          `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, referencia_id, usuario_id)
           VALUES ($1, 'salida_venta', $2, $3, $4)`,
          [comp.producto_id, -cantidadTotal, ticketId, usuarioId]
        );
      }
    }
  }
  return productosAgotados;
}

module.exports = { descontarInventarioVenta };
