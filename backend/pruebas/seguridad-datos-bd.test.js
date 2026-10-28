// Seguridad de datos con base de datos REAL: devoluciones al precio pagado, abonos, límites de
// crédito, inventario/compras/kits/promociones de otra sucursal, importaciones, CSV, turnos,
// Inicio (dashboard) y departamentos.
// Necesita una base VACÍA de pruebas (se borra todo lo que tenga):
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/seg_datos" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('seguridad de datos con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-seguridad-datos-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const lic = require('../utils/licencia');
const pool = require('../db');

let base, servidor;
let sucA, sucB;
const U = {}; // id de cada usuario
const T = {}; // token de cada usuario
const P = {}; // productos
const TU = {}; // turnos

async function api(quien, metodo, ruta, cuerpo) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T[quien] },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch (e) { /* no es JSON */ }
  return { status: r.status, json, texto };
}
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const uno = async (sql, v) => (await pool.query(sql, v)).rows[0];

let folioN = 0;
// Ticket ya pagado con sus renglones: [{ producto_id, cantidad, precio, descuento }]
async function ticketPagado(sucursal, renglones, { descuentoTicket = 0, metodo = 'efectivo', cliente = null, cajero = null } = {}) {
  const total = renglones.reduce((s, r) => s + r.cantidad * r.precio, 0);
  const t = await uno(
    `INSERT INTO tickets (folio, sucursal_id, estado, total, metodo_pago, descuento_monto, cliente_id, cajero_usuario_id, fecha_pago)
     VALUES ($1,$2,'pagado',$3,$4,$5,$6,$7,NOW()) RETURNING *`,
    ['SEG-' + (++folioN), sucursal, total, metodo, descuentoTicket, cliente, cajero]
  );
  const lineas = [];
  for (const r of renglones) {
    lineas.push(await uno(
      `INSERT INTO ticket_detalle (ticket_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal, descuento_monto)
       VALUES ($1,$2,'Prod',$3,$4,$5,$6) RETURNING *`,
      [t.id, r.producto_id, r.cantidad, r.precio, r.cantidad * r.precio, r.descuento || 0]
    ));
  }
  return { ticket: t, lineas };
}

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  const totalMigraciones = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).length;
  for (let i = 0; i < 200; i++) { // espera a que terminen TODAS las migraciones automáticas
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations').catch(() => ({ rows: [{ n: 0 }] }));
    if (r.rows[0].n >= totalMigraciones) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2037-12-31', 'anual', 'nube')");
  lic.invalidarCache();

  sucA = (await uno("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id")).id;
  sucB = (await uno("INSERT INTO sucursales (nombre, activo) VALUES ('Otra', true) RETURNING id")).id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1), ($2)', [sucA, sucB]);

  const hash = await bcrypt.hash('Clave-Prueba-1', 4);
  const usuario = async (clave, nombre, rol, permisos = {}, sucursal = sucA) => {
    const id = (await uno(
      'INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo, permisos) VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id',
      [sucursal, nombre, clave, hash, rol, JSON.stringify(permisos)])).id;
    U[clave] = id;
    T[clave] = jwt.sign({ id, nombre, usuario: clave, rol, sucursal_id: sucursal, permisos, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  };
  await usuario('dueno', 'Dueño', 'dueno');
  await usuario('cajera', '=HYPERLINK("http://x")', 'cajero', { INVENTARIO_AJUSTAR: true, PRODUCTOS_CREAR: true, PRODUCTOS_EDITAR: true });
  await usuario('cajera2', 'Cajera Dos', 'cajero');
  await usuario('mostrador', 'Mostrador', 'mostrador');
  await usuario('cajeraSinReportes', 'Cajera Sin Reportes', 'cajero', { REPORTES_VER: false });

  const producto = async (clave, sucursal, precio, existencia) => {
    P[clave] = (await uno("INSERT INTO productos (sucursal_id, nombre, precio, tipo_venta, usa_inventario, codigo_barras) VALUES ($1,$2,$3,'unidad',true,$4) RETURNING id",
      [sucursal, 'Producto ' + clave, precio, 'CB-' + clave])).id;
    await pool.query('INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, $2)', [P[clave], existencia]);
  };
  await producto('a1', sucA, 50, 100);
  await producto('a2', sucA, 100, 100);
  await producto('b1', sucB, 30, 100);

  const turno = async (clave, usuarioId, sucursal, estado = 'abierto') => {
    TU[clave] = (await uno('INSERT INTO turnos (sucursal_id, usuario_id, fondo_inicial, estado) VALUES ($1,$2,500,$3) RETURNING id', [sucursal, usuarioId, estado])).id;
  };
  await turno('cajera', U.cajera, sucA);
  await turno('cajera2', U.cajera2, sucA);
  await turno('cerrado', U.cajera, sucA, 'cerrado');
  await turno('otraSucursal', U.cajera, sucB);
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
});

// ------------------------------------------------------------------ devoluciones
test('devolución: se regresa lo que se PAGÓ (descuento del renglón y parte del descuento del ticket)', async () => {
  // Renglón 1: 2 × $50 = $100 con $10 de descuento → $90. Renglón 2: 1 × $100 → $100.
  // Descuento del ticket $19 sobre $190 = 10 %. Pagado: $171.
  const { ticket, lineas } = await ticketPagado(sucA, [
    { producto_id: P.a1, cantidad: 2, precio: 50, descuento: 10 },
    { producto_id: P.a2, cantidad: 1, precio: 100 }
  ], { descuentoTicket: 19 });

  const r1 = await api('cajera', 'POST', '/api/devoluciones', {
    ticket_id: ticket.id, metodo_reembolso: 'efectivo', turno_id: TU.cajera,
    items: [{ ticket_detalle_id: lineas[0].id, cantidad_devuelta: 1 }]
  });
  assert.equal(r1.status, 200, r1.texto);
  assert.equal(Number(r1.json.monto_total), 40.5); // 1 × (90/2) × 0.9
  const caja = await uno("SELECT monto, turno_id FROM movimientos_caja WHERE concepto = $1", [`Devolución ticket ${ticket.folio}`]);
  assert.equal(Number(caja.monto), 40.5);
  assert.equal(caja.turno_id, TU.cajera);

  // Devolver todo lo demás: en total nunca más de $171.
  const r2 = await api('cajera', 'POST', '/api/devoluciones', {
    ticket_id: ticket.id, metodo_reembolso: 'efectivo', turno_id: TU.cajera,
    items: [{ ticket_detalle_id: lineas[0].id, cantidad_devuelta: 1 }, { ticket_detalle_id: lineas[1].id, cantidad_devuelta: 1 }]
  });
  assert.equal(r2.status, 200, r2.texto);
  assert.equal(Number(r2.json.monto_total), 130.5);
  const suma = await uno('SELECT SUM(monto_total) AS s FROM devoluciones WHERE ticket_id = $1', [ticket.id]);
  assert.equal(Number(suma.s), 171);
});

test('devolución: el total devuelto de un ticket nunca pasa de lo cobrado menos lo ya devuelto', async () => {
  const { ticket, lineas } = await ticketPagado(sucA, [{ producto_id: P.a1, cantidad: 2, precio: 50 }]);
  // Una devolución anterior (p. ej. de una versión vieja) ya regresó $95 de los $100.
  await pool.query("INSERT INTO devoluciones (ticket_id, usuario_id, monto_total, metodo_reembolso) VALUES ($1,$2,95,'sin_reembolso')", [ticket.id, U.dueno]);
  const r = await api('dueno', 'POST', '/api/devoluciones', {
    ticket_id: ticket.id, metodo_reembolso: 'sin_reembolso',
    items: [{ ticket_detalle_id: lineas[0].id, cantidad_devuelta: 1 }]
  });
  assert.equal(r.status, 200, r.texto);
  assert.equal(Number(r.json.monto_total), 5);
});

test('devolución: el turno debe ser válido (abierto, de esta sucursal y propio) y el efectivo lo exige', async () => {
  const { ticket, lineas } = await ticketPagado(sucA, [{ producto_id: P.a1, cantidad: 5, precio: 50 }]);
  const pedir = (quien, extra) => api(quien, 'POST', '/api/devoluciones', {
    ticket_id: ticket.id, metodo_reembolso: 'efectivo',
    items: [{ ticket_detalle_id: lineas[0].id, cantidad_devuelta: 1 }], ...extra
  });
  assert.equal((await pedir('cajera', {})).status, 400);                              // sin turno
  assert.equal((await pedir('cajera', { turno_id: TU.cajera2 })).status, 403);         // turno de otra cajera
  assert.equal((await pedir('cajera', { turno_id: TU.cerrado })).status, 409);         // turno cerrado
  assert.equal((await pedir('cajera', { turno_id: TU.otraSucursal })).status, 400);    // turno de otra sucursal
  // Aunque no sea en efectivo, un turno mandado también se revisa.
  const noEf = await api('cajera', 'POST', '/api/devoluciones', {
    ticket_id: ticket.id, metodo_reembolso: 'sin_reembolso', turno_id: TU.cajera2,
    items: [{ ticket_detalle_id: lineas[0].id, cantidad_devuelta: 1 }]
  });
  assert.equal(noEf.status, 403);
  const det = await uno('SELECT cantidad_devuelta FROM ticket_detalle WHERE id = $1', [lineas[0].id]);
  assert.equal(Number(det.cantidad_devuelta), 0, 'ningún intento rechazado devolvió mercancía');
  // El dueño sí puede usar el turno de una cajera.
  assert.equal((await pedir('dueno', { turno_id: TU.cajera2 })).status, 200);
});

// ------------------------------------------------------------------ abonos
test('abono: cliente de esta sucursal, forma de pago válida, monto > 0 y no mayor a lo que debe', async () => {
  const cA = (await uno('INSERT INTO clientes (sucursal_id, nombre, saldo_actual, limite_credito) VALUES ($1,$2,100,500) RETURNING id', [sucA, 'Cliente A'])).id;
  const cB = (await uno('INSERT INTO clientes (sucursal_id, nombre, saldo_actual, limite_credito) VALUES ($1,$2,100,500) RETURNING id', [sucB, 'Cliente B'])).id;
  const abono = (quien, id, cuerpo) => api(quien, 'POST', `/api/clientes/${id}/abono`, cuerpo);

  assert.equal((await abono('dueno', cB, { monto: 10, metodo_pago: 'tarjeta' })).status, 404);
  assert.equal(Number((await uno('SELECT saldo_actual FROM clientes WHERE id = $1', [cB])).saldo_actual), 100);
  assert.equal((await abono('dueno', cA, { monto: 10, metodo_pago: 'cheque' })).status, 400);
  assert.equal((await abono('dueno', cA, { monto: 0, metodo_pago: 'tarjeta' })).status, 400);
  assert.equal((await abono('dueno', cA, { monto: -5, metodo_pago: 'tarjeta' })).status, 400);
  assert.equal((await abono('dueno', cA, { monto: 'abc', metodo_pago: 'tarjeta' })).status, 400);
  assert.equal((await abono('dueno', cA, { monto: 150, metodo_pago: 'tarjeta' })).status, 400);
  // El dueño puede recibir efectivo aunque no tenga turno de caja (el cajero no: ver abajo).
  assert.equal((await abono('dueno', cA, { monto: 10, metodo_pago: 'efectivo' })).status, 200);
  // Turno de otra cajera → no.
  assert.equal((await abono('cajera', cA, { monto: 10, metodo_pago: 'efectivo', turno_id: TU.cajera2 })).status, 403);

  // Tarjeta sin turno: sí.
  const t = await abono('dueno', cA, { monto: 30, metodo_pago: 'tarjeta' });
  assert.equal(t.status, 200, t.texto);
  assert.equal(Number(t.json.saldo_actual), 60);
  // Efectivo sin mandar turno: se usa el turno abierto de la propia cajera.
  const e = await abono('cajera', cA, { monto: 20 });
  assert.equal(e.status, 200, e.texto);
  const ab = await uno("SELECT turno_id, metodo_pago FROM creditos_abono WHERE cliente_id = $1 AND monto = 20", [cA]);
  assert.equal(ab.turno_id, TU.cajera);
  assert.equal(ab.metodo_pago, 'efectivo');
  // Ya debe $40: abonar $40.01 no se puede; $40 sí y queda en $0.
  assert.equal((await abono('dueno', cA, { monto: 40.01, metodo_pago: 'transferencia' })).status, 400);
  const fin = await abono('dueno', cA, { monto: 40, metodo_pago: 'transferencia' });
  assert.equal(fin.status, 200);
  assert.equal(Number(fin.json.saldo_actual), 0);
});

// ------------------------------------------------------------------ límites de crédito
test('crear cliente: solo dueño/gerente/jefe general ponen límite de crédito', async () => {
  const c1 = await api('cajera', 'POST', '/api/clientes', { nombre: 'Fiado Cajera', limite_credito: 5000 });
  assert.equal(c1.status, 200, c1.texto);
  assert.equal(Number(c1.json.limite_credito), 0);
  const c2 = await api('dueno', 'POST', '/api/clientes', { nombre: 'Fiado Dueño', limite_credito: 5000 });
  assert.equal(c2.status, 200);
  assert.equal(Number(c2.json.limite_credito), 5000);
  assert.equal((await api('dueno', 'POST', '/api/clientes', { nombre: 'Malo', limite_credito: -1 })).status, 400);
});

test('importar clientes: un cajero no pone saldo ni límite, ni sube el límite de los que ya existen', async () => {
  await pool.query("INSERT INTO clientes (sucursal_id, nombre, limite_credito) VALUES ($1, 'Existente Import', 100)", [sucA]);
  const r = await api('cajera', 'POST', '/api/clientes/importar', { clientes: [
    { nombre: 'Nuevo Import', limite_credito: 9000, saldo: 800 },
    { nombre: 'Existente Import', limite_credito: 9000, telefono: '3311223344' }
  ] });
  assert.equal(r.status, 200, r.texto);
  const nuevo = await uno("SELECT limite_credito, saldo_actual FROM clientes WHERE nombre = 'Nuevo Import'");
  assert.equal(Number(nuevo.limite_credito), 0);
  assert.equal(Number(nuevo.saldo_actual), 0);
  const ex = await uno("SELECT limite_credito, telefono FROM clientes WHERE nombre = 'Existente Import'");
  assert.equal(Number(ex.limite_credito), 100);
  assert.equal(ex.telefono, '3311223344');

  const d = await api('dueno', 'POST', '/api/clientes/importar', { clientes: [{ nombre: 'Nuevo Dueño Import', limite_credito: 900, saldo: 80 }] });
  assert.equal(d.status, 200);
  const nd = await uno("SELECT limite_credito, saldo_actual FROM clientes WHERE nombre = 'Nuevo Dueño Import'");
  assert.equal(Number(nd.limite_credito), 900);
  assert.equal(Number(nd.saldo_actual), 80);
});

// ------------------------------------------------------------------ inventario
test('inventario: no se ajusta ni se configura un producto de otra sucursal, y su historial no se ve', async () => {
  const aj = await api('dueno', 'POST', '/api/inventario/ajuste', { producto_id: P.b1, cantidad: 5, tipo: 'merma' });
  assert.equal(aj.status, 404);
  assert.equal(Number((await uno('SELECT existencia_actual FROM inventario WHERE producto_id = $1', [P.b1])).existencia_actual), 100);
  const mi = await api('dueno', 'PUT', `/api/inventario/${P.b1}/minimo`, { stock_minimo: 7 });
  assert.equal(mi.status, 404);
  assert.equal(Number((await uno('SELECT stock_minimo FROM inventario WHERE producto_id = $1', [P.b1])).stock_minimo), 0);

  await pool.query("INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, usuario_id) VALUES ($1, 'merma', -1, $2)", [P.b1, U.dueno]);
  const mov = await api('dueno', 'GET', `/api/inventario/${P.b1}/movimientos`);
  assert.equal(mov.status, 200);
  assert.deepEqual(mov.json, []);

  const okMin = await api('dueno', 'PUT', `/api/inventario/${P.a1}/minimo`, { stock_minimo: 7 });
  assert.equal(okMin.status, 200);
  assert.equal((await api('dueno', 'PUT', `/api/inventario/${P.a1}/minimo`, { stock_minimo: -3 })).status, 400);
});

test('inventario: cambiar precios en una entrada manual pide PRODUCTOS_PRECIO', async () => {
  const conPrecio = await api('cajera', 'POST', '/api/inventario/ajuste', { producto_id: P.a2, cantidad: 3, tipo: 'entrada_manual', precio: 1 });
  assert.equal(conPrecio.status, 403);
  assert.equal(Number((await uno('SELECT precio FROM productos WHERE id = $1', [P.a2])).precio), 100);
  const sinPrecio = await api('cajera', 'POST', '/api/inventario/ajuste', { producto_id: P.a2, cantidad: 3, tipo: 'entrada_manual' });
  assert.equal(sinPrecio.status, 200, sinPrecio.texto);
  const dueno = await api('dueno', 'POST', '/api/inventario/ajuste', { producto_id: P.a2, cantidad: 1, tipo: 'entrada_manual', precio_costo: 60 });
  assert.equal(dueno.status, 200);
  assert.equal(Number((await uno('SELECT precio_costo FROM productos WHERE id = $1', [P.a2])).precio_costo), 60);
});

// ------------------------------------------------------------------ compras
test('compras: proveedor y productos de esta sucursal, cantidades > 0 y costos >= 0', async () => {
  const provA = (await uno("INSERT INTO proveedores (sucursal_id, nombre) VALUES ($1, 'Prov A') RETURNING id", [sucA])).id;
  const provB = (await uno("INSERT INTO proveedores (sucursal_id, nombre) VALUES ($1, 'Prov B') RETURNING id", [sucB])).id;
  const comprar = (cuerpo) => api('dueno', 'POST', '/api/compras', cuerpo);
  const item = (extra) => ({ producto_id: P.a1, cantidad: 2, costo_unitario: 20, ...extra });

  assert.equal((await comprar({ proveedor_id: provB, items: [item()] })).status, 404);
  assert.equal((await comprar({ proveedor_id: provA, items: [item({ producto_id: P.b1 })] })).status, 404);
  assert.equal((await comprar({ proveedor_id: provA, items: [item({ cantidad: 0 })] })).status, 400);
  assert.equal((await comprar({ proveedor_id: provA, items: [item({ cantidad: -3 })] })).status, 400);
  assert.equal((await comprar({ proveedor_id: provA, items: [item({ costo_unitario: -1 })] })).status, 400);
  assert.equal(Number((await uno('SELECT existencia_actual FROM inventario WHERE producto_id = $1', [P.b1])).existencia_actual), 100);
  assert.equal(Number((await uno('SELECT COUNT(*)::int AS n FROM compras')).n), 0);

  const ok = await comprar({ proveedor_id: provA, items: [item()] });
  assert.equal(ok.status, 200, ok.texto);
  assert.equal(Number(ok.json.total), 40);
});

// ------------------------------------------------------------------ kits
test('kits: los productos del kit deben ser de esta sucursal y con cantidad > 0', async () => {
  const kit = (productos) => api('dueno', 'POST', '/api/kits', { nombre: 'Kit prueba', precio_kit: 99, productos });
  assert.equal((await kit([{ producto_id: P.b1, cantidad: 1 }])).status, 400);
  assert.equal((await kit([{ producto_id: P.a1, cantidad: 0 }])).status, 400);
  assert.equal((await kit([{ producto_id: P.a1, cantidad: -2 }])).status, 400);
  const ok = await kit([{ producto_id: P.a1, cantidad: 1 }, { producto_id: P.a2, cantidad: 2 }]);
  assert.equal(ok.status, 200, ok.texto);
  const editar = await api('dueno', 'PUT', `/api/kits/${ok.json.id}`, { nombre: 'Kit prueba', precio_kit: 99, productos: [{ producto_id: P.b1, cantidad: 1 }] });
  assert.equal(editar.status, 400);
  assert.equal(Number((await uno('SELECT COUNT(*)::int AS n FROM kit_productos WHERE kit_id = $1', [ok.json.id])).n), 2);
});

// ------------------------------------------------------------------ promociones
test('promociones: no se ven ni se borran las de un producto de otra sucursal', async () => {
  const promo = (await uno('INSERT INTO promociones (producto_id, cantidad_minima, precio_promocional) VALUES ($1, 3, 25) RETURNING id', [P.b1])).id;
  const ver = await api('dueno', 'GET', `/api/promociones/${P.b1}`);
  assert.equal(ver.status, 200);
  assert.deepEqual(ver.json, []);
  const borrar = await api('dueno', 'DELETE', `/api/promociones/escalon/${promo}`);
  assert.equal(borrar.status, 404);
  assert.equal((await uno('SELECT activo FROM promociones WHERE id = $1', [promo])).activo, true);

  const propia = (await uno('INSERT INTO promociones (producto_id, cantidad_minima, precio_promocional) VALUES ($1, 3, 40) RETURNING id', [P.a1])).id;
  assert.equal((await api('dueno', 'GET', `/api/promociones/${P.a1}`)).json.length, 1);
  assert.equal((await api('dueno', 'DELETE', `/api/promociones/escalon/${propia}`)).status, 200);
});

// ------------------------------------------------------------------ productos
test('importar productos: sin permisos no cambia precios ni existencia de los que ya existen', async () => {
  const antes = await uno('SELECT p.precio, i.existencia_actual FROM productos p JOIN inventario i ON i.producto_id = p.id WHERE p.id = $1', [P.a1]);
  const r = await api('cajera2', 'POST', '/api/productos/importar', { productos: [{ nombre: 'X', codigo_barras: 'CB-a1', precio: 1, existencia: 0 }] });
  assert.equal(r.status, 403); // cajera2 ni siquiera puede crear productos
  // cajera tiene PRODUCTOS_CREAR e INVENTARIO_AJUSTAR, pero NO PRODUCTOS_PRECIO.
  const c = await api('cajera', 'POST', '/api/productos/importar', { productos: [
    { nombre: 'Producto a1', codigo_barras: 'CB-a1', precio: 1, precio_costo: 1 },
    { nombre: 'Nuevo de Excel', codigo_barras: 'CB-nuevo', precio: 15, existencia: 4 }
  ] });
  assert.equal(c.status, 200, c.texto);
  const despues = await uno('SELECT p.precio, i.existencia_actual FROM productos p JOIN inventario i ON i.producto_id = p.id WHERE p.id = $1', [P.a1]);
  assert.equal(Number(despues.precio), Number(antes.precio));
  assert.equal(Number(despues.existencia_actual), Number(antes.existencia_actual), 'sin columna Existencia no se toca');
  const nuevo = await uno("SELECT p.precio, i.existencia_actual FROM productos p JOIN inventario i ON i.producto_id = p.id WHERE p.codigo_barras = 'CB-nuevo'");
  assert.equal(Number(nuevo.precio), 15);
  assert.equal(Number(nuevo.existencia_actual), 4);
});

test('importar productos: con INVENTARIO_AJUSTAR la existencia cambia y queda en el historial', async () => {
  const antes = Number((await uno('SELECT existencia_actual FROM inventario WHERE producto_id = $1', [P.a2])).existencia_actual);
  const r = await api('dueno', 'POST', '/api/productos/importar', { productos: [{ nombre: 'Producto a2', codigo_barras: 'CB-a2', existencia: antes + 15, precio: 120 }] });
  assert.equal(r.status, 200, r.texto);
  const inv = await uno('SELECT existencia_actual FROM inventario WHERE producto_id = $1', [P.a2]);
  assert.equal(Number(inv.existencia_actual), antes + 15);
  const mov = await uno("SELECT tipo, cantidad, motivo FROM movimientos_inventario WHERE producto_id = $1 AND motivo = 'Importación de Excel'", [P.a2]);
  assert.equal(mov.tipo, 'entrada_manual');
  assert.equal(Number(mov.cantidad), 15);
  assert.equal(Number((await uno('SELECT precio FROM productos WHERE id = $1', [P.a2])).precio), 120);
  assert.deepEqual(r.json.errores, []);
});

test('Open Food Facts: solo códigos de 8 a 14 números', async () => {
  for (const malo of ['abc', '1234567', '123456789012345', '1234abcd', '12345678%3F']) {
    const r = await api('dueno', 'GET', `/api/productos/buscar-externo/${malo}`);
    assert.equal(r.status, 400, malo);
  }
});

// ------------------------------------------------------------------ reportes
test('CSV de ventas: una celda que empieza con = no se vuelve fórmula', async () => {
  await ticketPagado(sucA, [{ producto_id: P.a1, cantidad: 1, precio: 50 }], { cajero: U.cajera });
  const r = await api('dueno', 'GET', '/api/reportes/ventas/exportar-csv');
  assert.equal(r.status, 200);
  assert.match(r.texto, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.doesNotMatch(r.texto, /,=HYPERLINK/);
});

// ------------------------------------------------------------------ turnos
test('abrir turno: el fondo inicial no puede ser negativo', async () => {
  assert.equal((await api('dueno', 'POST', '/api/turnos/abrir', { fondo_inicial: -100 })).status, 400);
  assert.equal((await api('dueno', 'POST', '/api/turnos/abrir', { fondo_inicial: 'abc' })).status, 400);
  assert.equal(Number((await uno('SELECT COUNT(*)::int AS n FROM turnos WHERE usuario_id = $1', [U.dueno])).n), 0);
});

// ------------------------------------------------------------------ dashboard
test('Inicio: utilidad, fiado y clientes que deben solo con permiso de reportes', async () => {
  await pool.query("INSERT INTO clientes (sucursal_id, nombre, saldo_actual, limite_credito) VALUES ($1, 'Debe mucho', 95, 100)", [sucA]);
  for (const quien of ['mostrador', 'cajeraSinReportes']) {
    const r = await api(quien, 'GET', '/api/dashboard/resumen');
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.datos_restringidos, true);
    assert.deepEqual(r.json.utilidad_hoy, { ventas_productos: null, costo_estimado: null, ganancia: null });
    assert.equal(r.json.fiado_total, null);
    assert.deepEqual(r.json.creditos_cerca_limite, []);
    assert.ok(Array.isArray(r.json.stock_bajo) && Array.isArray(r.json.agotados) && Array.isArray(r.json.ventas_por_hora));
    assert.ok(!r.json.actividad_reciente.some((a) => a.tipo === 'compra' || a.tipo === 'abono'));
  }
  for (const quien of ['dueno', 'cajera']) { // la cajera tiene REPORTES_VER por defecto
    const r = await api(quien, 'GET', '/api/dashboard/resumen');
    assert.equal(r.status, 200);
    assert.equal(r.json.datos_restringidos, false);
    assert.equal(typeof r.json.utilidad_hoy.ganancia, 'number');
    assert.ok(r.json.fiado_total > 0);
    assert.ok(r.json.creditos_cerca_limite.length >= 1);
  }
});

// ------------------------------------------------------------------ departamentos
test('departamentos: renombrar y borrar solo dueño/gerente/jefe general', async () => {
  const dep = (await uno("INSERT INTO categorias (nombre) VALUES ('Lácteos') RETURNING id")).id;
  assert.equal((await api('cajera', 'PUT', `/api/departamentos/${dep}`, { nombre: 'Hackeado' })).status, 403);
  assert.equal((await api('cajera', 'DELETE', `/api/departamentos/${dep}`)).status, 403);
  assert.equal((await uno('SELECT nombre FROM categorias WHERE id = $1', [dep])).nombre, 'Lácteos');
  assert.equal((await api('dueno', 'PUT', `/api/departamentos/${dep}`, { nombre: 'Lácteos y quesos' })).status, 200);
  assert.equal((await api('dueno', 'DELETE', `/api/departamentos/${dep}`)).status, 200);
});
