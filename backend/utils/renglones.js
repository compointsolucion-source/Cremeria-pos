// Revisión de los renglones (productos) que manda una pantalla ANTES de guardarlos en un ticket o pedido.
//  - cantidad > 0 y precio >= 0 (sin negativos que funcionen como descuento escondido);
//  - si el renglón es de un producto o kit, debe ser de ESTA sucursal y el nombre se toma del catálogo;
//  - el precio no puede ser MENOR que el del catálogo (precio normal, de mayoreo o de promoción por
//    volumen), salvo que el usuario tenga permiso de cambiar precios. Para cobrar menos está el descuento;
//  - el nombre libre se limpia de caracteres que podrían esconder código (<, >, comillas).
const { tienePermiso } = require('../middleware/auth');

function nombreLimpio(t) {
  return String(t == null ? '' : t).replace(/[<>"'`\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
}

class ErrorRenglon extends Error {
  constructor(error) { super(error); this.status = 400; this.error = error; }
}

async function precioMinimo(db, tipo, id, sucursalId) {
  if (tipo === 'kit') {
    const r = await db.query('SELECT nombre, precio_kit AS precio FROM kits WHERE id = $1 AND sucursal_id = $2', [id, sucursalId]);
    if (!r.rows.length) return null;
    return { nombre: r.rows[0].nombre, minimo: Number(r.rows[0].precio) };
  }
  const r = await db.query(
    `SELECT p.nombre, p.precio, p.precio_mayoreo,
            (SELECT MIN(pr.precio_promocional) FROM promociones pr WHERE pr.producto_id = p.id AND pr.activo = true) AS promo
       FROM productos p WHERE p.id = $1 AND p.sucursal_id = $2`, [id, sucursalId]);
  if (!r.rows.length) return null;
  const f = r.rows[0];
  const opciones = [Number(f.precio), Number(f.precio_mayoreo), Number(f.promo)].filter((n) => Number.isFinite(n) && n > 0);
  return { nombre: f.nombre, minimo: opciones.length ? Math.min(...opciones) : 0 };
}

/** Devuelve los renglones limpios o lanza {status:400, error}. */
async function revisarRenglones(db, items, sucursalId, usuario, { max = 500 } = {}) {
  if (!Array.isArray(items) || !items.length) throw new ErrorRenglon('El ticket necesita al menos un producto');
  if (items.length > max) throw new ErrorRenglon('Demasiados renglones en un solo ticket');
  const puedeCambiarPrecio = usuario ? tienePermiso(usuario, 'PRODUCTOS_PRECIO') : false;
  const salida = [];
  for (const it of items) {
    const cantidad = Number(it && it.cantidad);
    const precio = Number(it && it.precio_unitario);
    if (!(Number.isFinite(cantidad) && cantidad > 0 && cantidad < 1e6)) throw new ErrorRenglon('Cantidad inválida en un renglón');
    if (!(Number.isFinite(precio) && precio >= 0 && precio < 1e7)) throw new ErrorRenglon('Precio inválido en un renglón');
    const tipo = it.tipo === 'kit' ? 'kit' : 'producto';
    let nombre = nombreLimpio(it.nombre_producto);
    const id = tipo === 'kit' ? it.kit_id : it.producto_id;
    if (id) {
      const cat = await precioMinimo(db, tipo, id, sucursalId);
      if (!cat) throw new ErrorRenglon('Uno de los productos no es de esta sucursal');
      nombre = nombreLimpio(cat.nombre) || nombre;
      if (!puedeCambiarPrecio && precio + 0.005 < cat.minimo) {
        throw new ErrorRenglon(`El precio de «${nombre}» es menor al del catálogo. Para cobrar menos, usa un descuento.`);
      }
    }
    if (!nombre) throw new ErrorRenglon('Falta el nombre de un producto');
    salida.push({ ...it, tipo, cantidad, precio_unitario: precio, nombre_producto: nombre,
      producto_id: tipo === 'producto' ? (it.producto_id || null) : null, kit_id: tipo === 'kit' ? (it.kit_id || null) : null });
  }
  return salida;
}

module.exports = { revisarRenglones, nombreLimpio };
