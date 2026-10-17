// Venta a granel: por CANTIDAD ("1.5 kilos") o por IMPORTE ("dame $100 de queso").
// Un solo lugar con las cuentas, para que Mostrador, Caja y Caja Avanzada den siempre lo mismo
// (y lo mismo que el servidor: ver backend/utils/importeExacto.js).
//
// La cantidad se guarda en gramos (3 decimales). Por eso 0.526 kg × $190.00 da $99.94 aunque el
// cliente pidió $100: en una venta por importe el renglón lleva "importe" y se cobra EXACTO.
(function (raiz) {
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

  // Diferencia máxima aceptada entre el importe y cantidad × precio: medio gramo y un centavo.
  const tolerancia = (precio) => Number(precio) * 0.0005 + 0.011;

  function importeCoherente(cantidad, precio, importe) {
    const c = Number(cantidad), p = Number(precio), i = Number(importe);
    if (!(c > 0) || !(p >= 0) || !(i > 0) || !isFinite(i)) return false;
    return Math.abs(i - c * p) <= tolerancia(p);
  }

  // Importe (subtotal) de un renglón del carrito o del ticket. Si cambió la cantidad o el precio
  // después de capturar el importe, deja de ser coherente y vuelve a ser cantidad × precio.
  function subtotal(it) {
    const cantidad = parseFloat(it.cantidad) || 0, precio = parseFloat(it.precio_unitario) || 0;
    if (it.importe !== undefined && it.importe !== null && it.importe !== '') {
      const importe = r2(parseFloat(it.importe));
      if (importeCoherente(cantidad, precio, importe)) return importe;
    }
    return r2(cantidad * precio);
  }

  // Escalones de "precio por volumen" del producto (de la cantidad mínima más alta a la más baja).
  function escalones(producto) {
    return ((producto && producto.promociones) || [])
      .map((p) => ({ min: parseFloat(p.cantidad_minima), precio: parseFloat(p.precio_promocional) }))
      .filter((t) => t.min > 0 && t.precio > 0)
      .sort((a, b) => b.min - a.min);
  }

  // Precio que toca cobrar por kilo/pieza según la cantidad (igual que siempre en Mostrador).
  function precioPorVolumen(producto, cantidad) {
    let mejor = parseFloat(producto.precio);
    escalones(producto).slice().reverse().forEach((t) => { if (cantidad >= t.min) mejor = t.precio; });
    return mejor;
  }

  // El cliente dice la CANTIDAD → se calcula el importe.
  function porCantidad(producto, cantidad, opciones) {
    const usarPromos = !opciones || opciones.promos !== false;
    const cant = r3(cantidad);
    if (!(cant > 0)) return null;
    const base = parseFloat(producto.precio);
    const precio = usarPromos ? precioPorVolumen(producto, cant) : base;
    return { cantidad: cant, precio_unitario: precio, importe: r2(cant * precio), promo: precio < base, por_importe: false };
  }

  // El cliente dice el IMPORTE → se calcula la cantidad. Si con el importe se alcanza un precio
  // por volumen, se aplica (el cliente se lleva más por el mismo dinero).
  function porImporte(producto, importe, opciones) {
    const usarPromos = !opciones || opciones.promos !== false;
    const imp = r2(importe);
    if (!(imp > 0)) return null;
    const base = parseFloat(producto.precio);
    if (!(base > 0)) return { error: 'sin_precio' };
    let precio = base, promo = false;
    if (usarPromos) {
      for (const t of escalones(producto)) {
        if (t.precio < base && r3(imp / t.precio) >= t.min) { precio = t.precio; promo = true; break; }
      }
    }
    const cant = r3(imp / precio);
    if (!(cant > 0)) return { error: 'muy_pequeno' };
    return { cantidad: cant, precio_unitario: precio, importe: imp, promo, por_importe: true };
  }

  // Renglón listo para el carrito / para mandar al servidor.
  function renglon(producto, calculo) {
    const r = {
      tipo: 'producto',
      producto_id: producto.id,
      nombre_producto: producto.nombre,
      tipo_venta: producto.tipo_venta || 'peso',
      cantidad: calculo.cantidad,
      precio_unitario: calculo.precio_unitario
    };
    if (calculo.por_importe) r.importe = calculo.importe;
    return r;
  }

  function formatoCantidad(c) {
    const n = parseFloat(c) || 0;
    return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  // Texto de la segunda línea de cada producto en el ticket/carrito.
  // A granel: "0.526 kg x $190.00/kg". Lo demás se queda como siempre.
  function detalle(it, separador) {
    const x = separador || 'x';
    if (it.tipo === 'kit') return 'Kit';
    if (it.tipo_venta === 'peso') return `${formatoCantidad(it.cantidad)} kg ${x} $${(parseFloat(it.precio_unitario) || 0).toFixed(2)}/kg`;
    return `${it.cantidad} ${x} $${it.precio_unitario}`;
  }

  const API = { r2, r3, tolerancia, importeCoherente, subtotal, escalones, precioPorVolumen, porCantidad, porImporte, renglon, formatoCantidad, detalle };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else raiz.GRANEL = API;
})(typeof window !== 'undefined' ? window : this);
