// Tienda en línea (clientes piden desde su celular) con base de datos REAL.
// Necesita una base VACÍA de pruebas (se borra todo lo que tenga):
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('tienda en línea con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-tienda-0123456789abcdef0123';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.TIENDA_MAX_PEDIDOS_HORA = '200';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const jwt = require('jsonwebtoken');
const lic = require('../utils/licencia');
const pool = require('../db');
const { _estadoHorario } = require('../routes/tienda');

let base, servidor, sucursalId, zonaId, panalesId, lecheId, ocultoId, agotadoId, quesoId;
const T = {};

async function api(quien, metodo, ruta, cuerpo) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(T[quien] ? { Authorization: 'Bearer ' + T[quien] } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const TODO_EL_DIA = { semana: ['00:00', '23:59'], domingo: ['00:00', '23:59'] };
let telSiguiente = 3310000000;
const pedido = (extra = {}) => ({
  s: sucursalId, nombre: 'Laura Gómez', telefono: String(telSiguiente++), zona_id: zonaId, calle: 'Av. Juárez 250',
  referencias: 'Portón negro', si_falta: 'parecido', pago: 'efectivo', paga_con: 500,
  items: [{ producto_id: panalesId, cantidad: 1, precio_unitario: 1 }, { producto_id: lecheId, cantidad: 2 }], ...extra
});

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  for (let i = 0; i < 150; i++) {
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '024%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2037-12-31', 'anual', 'nube')");
  lic.invalidarCache();

  sucursalId = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Abarrotes Lupita', true) RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO configuracion (sucursal_id, nombre_negocio, telefono) VALUES ($1, 'Abarrotes Lupita', '33 1234 0000')", [sucursalId]);
  const usuario = async (user, rol) => {
    const id = (await pool.query(
      "INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,$2,$2,'x',$3,true) RETURNING id", [sucursalId, user, rol])).rows[0].id;
    T[user] = jwt.sign({ id, nombre: user, usuario: user, rol, sucursal_id: sucursalId, permisos: {} }, process.env.JWT_SECRET, { expiresIn: '1h' });
  };
  await usuario('dueno', 'dueno');
  await usuario('cajera', 'cajero');
  const prod = async (nombre, precio, tipo, existencia, enTienda = true) => {
    const id = (await pool.query(
      'INSERT INTO productos (sucursal_id, nombre, precio, tipo_venta, usa_inventario, en_tienda) VALUES ($1,$2,$3,$4,true,$5) RETURNING id',
      [sucursalId, nombre, precio, tipo, enTienda])).rows[0].id;
    await pool.query('INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, $2)', [id, existencia]);
    return id;
  };
  panalesId = await prod('Pañales Huggies Etapa 3', 289, 'unidad', 50);
  lecheId = await prod('Leche Lala 1 L', 29, 'unidad', 50);
  quesoId = await prod('Queso fresco', 150, 'peso', 20);
  ocultoId = await prod('Cigarros', 80, 'unidad', 50, false);
  agotadoId = await prod('Huevo', 48, 'peso', 0);
  // Oferta: pañales a $260 desde 1
  await pool.query('INSERT INTO promociones (producto_id, cantidad_minima, precio_promocional) VALUES ($1, 1, 260)', [panalesId]);
  zonaId = (await pool.query("INSERT INTO zonas_envio (sucursal_id, nombre, costo, envio_gratis_desde) VALUES ($1, 'Centro', 25, 400) RETURNING id", [sucursalId])).rows[0].id;
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
});

test('apagada no responde; solo el dueño/gerente la configura (la cajera no)', async () => {
  assert.equal((await api(null, 'GET', '/api/tienda/publico/info')).status, 404);
  assert.equal((await api('cajera', 'GET', '/api/tienda/config')).status, 403);
  assert.equal((await api(null, 'GET', '/api/tienda/config')).status, 401);
  const mal = await api('dueno', 'PUT', '/api/tienda/config', { horario: { semana: ['20:00', '08:00'], domingo: null } });
  assert.equal(mal.status, 400);
  const r = await api('dueno', 'PUT', '/api/tienda/config', { activo: true, giro: 'Pañales y abarrotes', horario: TODO_EL_DIA, pedido_minimo: 100, max_pendientes_por_telefono: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.activo, true);
});

test('info pública: negocio, zonas con envío y abierto; productos ocultos y agotados no se ven', async () => {
  const i = await api(null, 'GET', '/api/tienda/publico/info');
  assert.equal(i.status, 200, JSON.stringify(i.json));
  assert.equal(i.json.negocio, 'Abarrotes Lupita');
  assert.equal(i.json.horario.abierto, true);
  assert.deepEqual(i.json.zonas.map((z) => [z.nombre, z.costo, z.envio_gratis_desde]), [['Centro', 25, 400]]);
  assert.equal(i.json.cuenta, null);
  const p = await api(null, 'GET', '/api/tienda/publico/productos');
  const nombres = p.json.map((x) => x.nombre);
  assert.ok(nombres.includes('Pañales Huggies Etapa 3') && nombres.includes('Queso fresco'));
  assert.ok(!nombres.includes('Cigarros'), 'oculto');
  assert.ok(!nombres.includes('Huevo'), 'agotado');
  assert.deepEqual(p.json.find((x) => x.id === panalesId).promo, { desde: 1, precio: 260 });
  assert.equal(p.json.find((x) => x.id === quesoId).por_peso, true);
});

test('pedido: precios del catálogo (no los del celular), envío por zona, queda «por confirmar» y NO sale en Caja', async () => {
  const r = await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ telefono: '33 1234 5678' }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.total, 260 + 58 + 25);              // promo de pañales + 2 leches + envío
  assert.ok(r.json.seguimiento.length >= 20);
  const p = (await pool.query("SELECT * FROM pedidos WHERE seguimiento = $1", [r.json.seguimiento])).rows[0];
  assert.equal(p.origen, 'en_linea');
  assert.equal(p.estado, 'programado');
  assert.equal(p.confirmado_en, null);
  assert.equal(p.preparar_desde, null);
  assert.equal(p.si_falta, 'parecido');
  assert.equal(Number(p.paga_con), 500);
  assert.equal(p.telefono, '3312345678');
  const enCaja = await api('cajera', 'GET', '/api/tickets/pendientes');
  assert.ok(!JSON.stringify(enCaja.json).includes(String(p.ticket_id) + ',"folio"'), 'no aparece en caja');
  const lista = await api('dueno', 'GET', '/api/pedidos?limit=100');
  const enLista = lista.json.find((x) => x.id === p.id);
  assert.ok(enLista, 'aparece en Pedidos');
  assert.equal(enLista.origen, 'en_linea');
  // Seguimiento: recibido
  const s = await api(null, 'GET', '/api/tienda/publico/seguimiento/' + r.json.seguimiento);
  assert.equal(s.json.paso, 'recibido');
  assert.equal(s.json.cambio, 500 - 343);
  // Confirmar (mandar a preparar) => confirmado y "surtiendo"
  const c = await api('dueno', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'preparando' });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const s2 = await api(null, 'GET', '/api/tienda/publico/seguimiento/' + r.json.seguimiento);
  assert.equal(s2.json.paso, 'surtiendo');
  assert.ok(s2.json.horas.confirmado);
});

test('reglas: mínimo, colonia, nombre y teléfono; producto oculto o agotado se rechaza; cantidades por pieza se redondean', async () => {
  assert.equal((await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ items: [{ producto_id: lecheId, cantidad: 2 }] }))).status, 400); // < $100
  assert.equal((await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ zona_id: null }))).status, 400);
  assert.equal((await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ telefono: '123' }))).status, 400);
  assert.equal((await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ nombre: '' }))).status, 400);
  assert.equal((await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ items: [{ producto_id: ocultoId, cantidad: 5 }] }))).status, 409);
  assert.equal((await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ items: [{ producto_id: agotadoId, cantidad: 5 }] }))).status, 409);
  assert.equal((await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ items: [{ producto_id: panalesId, cantidad: -1 }] }))).status, 400);
  const r = await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ items: [{ producto_id: quesoId, cantidad: 0.75 }, { producto_id: lecheId, cantidad: 1.6 }] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const det = (await pool.query(
    `SELECT d.producto_id, d.cantidad FROM ticket_detalle d JOIN pedidos p ON p.ticket_id = d.ticket_id WHERE p.seguimiento = $1 AND d.producto_id IS NOT NULL ORDER BY d.producto_id`,
    [r.json.seguimiento])).rows.map((x) => [x.producto_id, Number(x.cantidad)]);
  assert.deepEqual(det, [[lecheId, 2], [quesoId, 0.75]].sort((a, b) => a[0] - b[0]));
});

test('máximo 2 pedidos sin confirmar por teléfono: el tercero se rechaza', async () => {
  const tel = '33 5555 1111';
  assert.equal((await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ telefono: tel }))).status, 200);
  assert.equal((await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ telefono: tel }))).status, 200);
  const r = await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ telefono: tel }));
  assert.equal(r.status, 429);
  assert.match(r.json.error, /esperando que la tienda/);
});

test('fiado: sin enlace personal no se puede; con enlace ve su saldo y pide a su cuenta hasta su límite', async () => {
  assert.equal((await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ pago: 'cuenta' }))).status, 403);
  const cli = (await pool.query("INSERT INTO clientes (sucursal_id, nombre, telefono, limite_credito, saldo_actual) VALUES ($1, 'Doña Rosa', '3399887766', 500, 180) RETURNING id", [sucursalId])).rows[0].id;
  assert.equal((await api('cajera', 'POST', `/api/tienda/fiado/${cli}/enlace`)).status, 403);
  const e = await api('dueno', 'POST', `/api/tienda/fiado/${cli}/enlace`);
  assert.equal(e.status, 200, JSON.stringify(e.json));
  const enlace = e.json.enlace_tienda;
  assert.equal((await api('dueno', 'POST', `/api/tienda/fiado/${cli}/enlace`)).json.enlace_tienda, enlace, 'no cambia si no se pide');
  const info = await api(null, 'GET', '/api/tienda/publico/info?c=' + enlace);
  assert.deepEqual(info.json.cuenta, { nombre: 'Doña Rosa', saldo: 180, limite: 500 });
  const ok = await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ pago: 'cuenta', c: enlace, telefono: '3399887766' }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const p = (await pool.query('SELECT pago_modo, cliente_id, pago_previsto FROM pedidos WHERE seguimiento = $1', [ok.json.seguimiento])).rows[0];
  assert.deepEqual([p.pago_modo, p.cliente_id, p.pago_previsto], ['credito', cli, 'cuenta']);
  // Lo que ya pidió a su cuenta (sin entregar) también cuenta: 180 + 318 ya casi llega a 500
  const segundo = await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ pago: 'cuenta', c: enlace, telefono: '3399887766', items: [{ producto_id: panalesId, cantidad: 1 }] }));
  assert.equal(segundo.status, 400, JSON.stringify(segundo.json));
  assert.match(segundo.json.error, /\$0\.00 disponibles/);
  const caro = await api(null, 'POST', '/api/tienda/publico/pedido', pedido({ pago: 'cuenta', c: enlace, items: [{ producto_id: panalesId, cantidad: 2 }] }));
  assert.equal(caro.status, 400);
  assert.match(caro.json.error, /disponibles/);
  const nuevo = await api('dueno', 'POST', `/api/tienda/fiado/${cli}/enlace`, { nuevo: true });
  assert.notEqual(nuevo.json.enlace_tienda, enlace);
  assert.equal((await api(null, 'GET', '/api/tienda/publico/info?c=' + enlace)).json.cuenta, null, 'el enlace viejo ya no sirve');
});

test('rechazar (cancelar) un pedido en línea: el cliente lo ve cancelado con el motivo', async () => {
  const r = await api(null, 'POST', '/api/tienda/publico/pedido', pedido());
  const id = (await pool.query('SELECT id FROM pedidos WHERE seguimiento = $1', [r.json.seguimiento])).rows[0].id;
  const c = await api('dueno', 'POST', `/api/pedidos/${id}/estado`, { estado: 'cancelado', motivo: 'No tenemos repartidor hoy' });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const s = await api(null, 'GET', '/api/tienda/publico/seguimiento/' + r.json.seguimiento);
  assert.equal(s.json.paso, 'cancelado');
  assert.equal(s.json.motivo_cancelacion, 'No tenemos repartidor hoy');
  assert.equal((await api(null, 'GET', '/api/tienda/publico/seguimiento/clave-que-no-existe-123456')).status, 404);
});

test('ocultar un producto desde la configuración lo quita de la tienda', async () => {
  assert.equal((await api('dueno', 'PUT', `/api/tienda/productos/${lecheId}`, { en_tienda: false })).status, 200);
  const p = await api(null, 'GET', '/api/tienda/publico/productos');
  assert.ok(!p.json.some((x) => x.id === lecheId));
  await api('dueno', 'PUT', `/api/tienda/productos/${lecheId}`, { en_tienda: true });
});

test('horario: abierto/cerrado con la hora del negocio', () => {
  const h = { semana: ['08:00', '20:00'], domingo: null };
  assert.deepEqual(_estadoHorario(h, new Date(2026, 10, 18, 10, 0)), { abierto: true, texto: 'Abierto hasta las 8 pm' });
  assert.equal(_estadoHorario(h, new Date(2026, 10, 18, 7, 30)).texto, 'Cerrado. Recibimos pedidos a partir de las 8 am');
  assert.equal(_estadoHorario(h, new Date(2026, 10, 21, 21, 0)).texto, 'Cerrado. Recibimos pedidos el lunes a partir de las 8 am');   // sábado de noche
  assert.equal(_estadoHorario(h, new Date(2026, 10, 18, 20, 0)).abierto, false);
});

test('fuera de horario no se reciben pedidos', async () => {
  await api('dueno', 'PUT', '/api/tienda/config', { horario: { semana: null, domingo: null } });
  const r = await api(null, 'POST', '/api/tienda/publico/pedido', pedido());
  assert.equal(r.status, 409);
  await api('dueno', 'PUT', '/api/tienda/config', { horario: TODO_EL_DIA });
});

test('administración: lista por departamento y prender/apagar varios de un jalón (solo de su sucursal)', async () => {
  const l = await api('dueno', 'GET', '/api/tienda/productos');
  assert.equal(l.status, 200);
  assert.ok(l.json.every((p) => typeof p.departamento === 'string'));
  const ids = [panalesId, lecheId];
  assert.equal((await api('cajera', 'PUT', '/api/tienda/productos', { ids, en_tienda: false })).status, 403);
  assert.equal((await api('dueno', 'PUT', '/api/tienda/productos', { ids: [], en_tienda: false })).status, 400);
  assert.equal((await api('dueno', 'PUT', '/api/tienda/productos', { ids: ['x'], en_tienda: false })).status, 400);
  const otra = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Otra', true) RETURNING id")).rows[0].id;
  const ajeno = (await pool.query("INSERT INTO productos (sucursal_id, nombre, precio, tipo_venta, en_tienda) VALUES ($1, 'Ajeno', 10, 'unidad', true) RETURNING id", [otra])).rows[0].id;
  const r = await api('dueno', 'PUT', '/api/tienda/productos', { ids: [...ids, ajeno], en_tienda: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.cambiados, 2, 'el producto de otra sucursal no se toca');
  assert.equal((await pool.query('SELECT en_tienda FROM productos WHERE id = $1', [ajeno])).rows[0].en_tienda, true);
  const p = await api(null, 'GET', '/api/tienda/publico/productos');
  assert.ok(!p.json.some((x) => ids.includes(x.id)));
  await api('dueno', 'PUT', '/api/tienda/productos', { ids, en_tienda: true });
});

test('tema y colores: se guardan, se validan y la tienda los recibe', async () => {
  assert.equal((await api('dueno', 'PUT', '/api/tienda/config', { tema: 'disco' })).status, 400);
  assert.equal((await api('dueno', 'PUT', '/api/tienda/config', { tema: 'color', color_principal: 'rojo' })).status, 400);
  const r = await api('dueno', 'PUT', '/api/tienda/config', { tema: 'color', color_principal: '#7a2e8e', color_oferta: '#FF9B4A' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const i = await api(null, 'GET', '/api/tienda/publico/info');
  assert.deepEqual([i.json.tema, i.json.color_principal, i.json.color_oferta], ['color', '#7A2E8E', '#FF9B4A']);
  await api('dueno', 'PUT', '/api/tienda/config', { tema: 'pizarron' });
  assert.equal((await api(null, 'GET', '/api/tienda/publico/info')).json.tema, 'pizarron');
  const p = await api(null, 'POST', '/api/tienda/publico/pedido', pedido());
  assert.equal((await api(null, 'GET', '/api/tienda/publico/seguimiento/' + p.json.seguimiento)).json.tema, 'pizarron');
  await api('dueno', 'PUT', '/api/tienda/config', { tema: 'letrero', color_principal: null, color_oferta: null });
});
