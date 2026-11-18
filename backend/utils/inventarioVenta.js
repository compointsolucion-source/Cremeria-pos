// Descuenta del inventario lo vendido en un ticket ya pagado. Lo usan el cobro normal
// (routes/tickets.js) y la liquidación de pedidos a domicilio (routes/pedidos.js).
// Devuelve los nombres de los productos que quedaron agotados.

// Descuenta UN producto. La existencia nunca baja de 0; si no alcanzaba, el movimiento lo dice en "motivo"
// (cuánto faltó), para que el historial del producto explique por qué no cuadra con la existencia.
// FOR UPDATE: si dos cajas cobran el mismo producto al mismo tiempo, una espera a la otra (el aviso de
// "agotado" sale bien y no se pisan).
async function descontarProducto(conexion, productoId, cantidad, ticketId, usuarioId) {
  await conexion.query(
    `INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, 0) ON CONFLICT (producto_id) DO NOTHING`,
    [productoId]
  );
  const antes = await conexion.query('SELECT existencia_actual FROM inventario WHERE producto_id = $1 FOR UPDATE', [productoId]);
  const existenciaAntes = parseFloat(antes.rows[0].existencia_actual) || 0;
  const cant = parseFloat(cantidad) || 0;
  const faltante = Math.round(Math.max(cant - Math.max(existenciaAntes, 0), 0) * 1000) / 1000;
  await conexion.query(
    'UPDATE inventario SET existencia_actual = GREATEST(existencia_actual - $1, 0) WHERE producto_id = $2',
    [cant, productoId]
  );
  await conexion.query(
    `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, referencia_id, usuario_id)
     VALUES ($1, 'salida_venta', $2, $3, $4, $5)`,
    [productoId, -cant, faltante > 0 ? `Vendido sin existencia suficiente: faltaron ${faltante}` : null, ticketId, usuarioId]
  );
  return faltante > 0;
}

async function descontarInventarioVenta(conexion, ticketId, usuarioId) {
  // Descontar inventario automáticamente por cada producto vendido (los kits descuentan sus componentes).
  // La existencia NUNCA baja de 0 (GREATEST), pero la venta se permite de
  // todas formas — solo se avisa al final si algún producto quedó agotado.
  const items = await conexion.query('SELECT * FROM ticket_detalle WHERE ticket_id = $1 ORDER BY id', [ticketId]);
  // Primero se junta TODO lo que hay que descontar (productos sueltos y componentes de kits), sumando
  // los repetidos; luego se descuenta en orden de producto. Así dos cobros al mismo tiempo siempre
  // apartan los productos en el mismo orden y nunca se quedan esperándose uno al otro.
  const porProducto = new Map(); // producto_id → { cantidad, nombre }
  const sumar = (id, cantidad, nombre) => {
    const k = Number(id);
    const prev = porProducto.get(k);
    porProducto.set(k, { cantidad: (prev ? prev.cantidad : 0) + (Number(cantidad) || 0), nombre: (prev && prev.nombre) || nombre });
  };
  for (const item of items.rows) {
    if (item.tipo === 'producto' && item.producto_id) {
      sumar(item.producto_id, item.cantidad, item.nombre_producto);
    } else if (item.tipo === 'kit' && item.kit_id) {
      const componentes = await conexion.query(
        `SELECT kp.producto_id, kp.cantidad, p.nombre FROM kit_productos kp
         LEFT JOIN productos p ON p.id = kp.producto_id WHERE kp.kit_id = $1`,
        [item.kit_id]
      );
      for (const comp of componentes.rows) sumar(comp.producto_id, comp.cantidad * item.cantidad, comp.nombre);
    }
  }
  const productosAgotados = [];
  for (const id of [...porProducto.keys()].sort((a, b) => a - b)) {
    const x = porProducto.get(id);
    if (await descontarProducto(conexion, id, x.cantidad, ticketId, usuarioId)) productosAgotados.push(x.nombre);
  }
  return productosAgotados;
}

module.exports = { descontarInventarioVenta };
