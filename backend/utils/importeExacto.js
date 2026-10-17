// Venta a granel POR IMPORTE: "dame $100 de queso".
//
// La cantidad se guarda en gramos (3 decimales). Por eso 0.526 kg × $190.00 da $99.94, aunque
// el cliente pidió y pagó $100. Para que el ticket cobre EXACTAMENTE lo que se pidió, el
// renglón puede traer "importe": si ese importe es coherente con cantidad × precio (la
// diferencia no puede ser mayor a medio gramo más un centavo), se respeta tal cual.
// Si no es coherente (o no viene), se usa cantidad × precio de siempre. Así nadie puede
// "inventar" un importe distinto mandando un número cualquiera.
//
// La misma regla vive en frontend/js/granel.js (para que la pantalla muestre lo mismo).

function r2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function tolerancia(precio) {
  return Number(precio) * 0.0005 + 0.011;
}

// ¿El importe es coherente con cantidad × precio?
function importeEsCoherente(cantidad, precio, importe) {
  const c = Number(cantidad), p = Number(precio), i = Number(importe);
  if (!(c > 0) || !(p >= 0) || !(i > 0) || !isFinite(i)) return false;
  return Math.abs(i - c * p) <= tolerancia(p);
}

// Importe (subtotal) de un renglón de ticket, redondeado a centavos.
function subtotalRenglon(item) {
  const cantidad = Number(item.cantidad), precio = Number(item.precio_unitario);
  const normal = r2(cantidad * precio);
  if (item.importe !== undefined && item.importe !== null && item.importe !== '') {
    const importe = r2(Number(item.importe));
    if (importeEsCoherente(cantidad, precio, importe)) return importe;
  }
  return normal;
}

module.exports = { r2, tolerancia, importeEsCoherente, subtotalRenglon };
