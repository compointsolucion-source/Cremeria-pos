// Venta a granel por importe con base de datos REAL: crear ticket, agregar renglón, venta sin internet,
// cobro y devolución (el importe exacto tiene que respetarse en todo el camino).
// Necesita una base VACÍA de pruebas (se borra todo lo que tenga):
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('granel con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-granel-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const lic = require('../utils/licencia');
const pool = require('../db');

let base, servidor, token, sucursalId, usuarioId, turnoId, quesoId, jamonId, piezaId;

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const existencia = async (id) => parseFloat((await pool.query('SELECT existencia_actual FROM inventario WHERE producto_id = $1', [id])).rows[0].existencia_actual);
const detalle = async (ticketId) => (await pool.query('SELECT * FROM ticket_detalle WHERE ticket_id = $1 ORDER BY id', [ticketId])).rows;
const queso = (extra = {}) => ({ tipo: 'producto', producto_id: quesoId, nombre_producto: 'Queso Oaxaca', cantidad: 0.526, precio_unitario: 190, ...extra });
const jamon = () => ({ tipo: 'producto', producto_id: jamonId, nombre_producto: 'Jamón', cantidad: 0.35, precio_unitario: 139 });

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  for (let i = 0; i < 100; i++) {
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '008%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2027-12-31', 'anual', 'nube')");
  lic.invalidarCache();

  sucursalId = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1)', [sucursalId]);
  const hash = await bcrypt.hash('Clave-Prueba-1', 4);
  usuarioId = (await pool.query(
    "INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,'Dueño','dueno',$2,'dueno',true) RETURNING id", [sucursalId, hash]
  )).rows[0].id;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: 'dueno', password: 'Clave-Prueba-1' }) });
  assert.equal(login.status, 200);
  token = (await login.json()).token;

  const prod = async (nombre, precio, tipo) => {
    const id = (await pool.query(
      "INSERT INTO productos (sucursal_id, nombre, precio, tipo_venta, usa_inventario) VALUES ($1,$2,$3,$4,true) RETURNING id", [sucursalId, nombre, precio, tipo]
    )).rows[0].id;
    await pool.query('INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, 50)', [id]);
    return id;
  };
  quesoId = await prod('Queso Oaxaca', 190, 'peso');
  jamonId = await prod('Jamón', 139, 'peso');
  piezaId = await prod('Crema 200ml', 12.5, 'unidad');
  turnoId = (await pool.query('INSERT INTO turnos (sucursal_id, usuario_id, fondo_inicial) VALUES ($1,$2,500) RETURNING id', [sucursalId, usuarioId])).rows[0].id;
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
});

test('POST /tickets: el renglón por importe cobra $100.00 exactos (no $99.94)', async () => {
  const r = await api('POST', '/api/tickets', { items: [queso({ importe: 100 }), jamon()] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(parseFloat(r.json.total), 148.65); // 100.00 + 48.65
  const filas = await detalle(r.json.id);
  assert.equal(parseFloat(filas[0].subtotal), 100);
  assert.equal(parseFloat(filas[0].cantidad), 0.526);
  assert.equal(parseFloat(filas[1].subtotal), 48.65);
  assert.equal(parseFloat(r.json.items[0].subtotal), 100); // y la respuesta lo trae igual
});

test('POST /tickets: un importe que no cuadra se ignora; sin importe todo igual que antes', async () => {
  const r = await api('POST', '/api/tickets', { items: [queso({ importe: 150 }), { tipo: 'producto', producto_id: piezaId, nombre_producto: 'Crema', cantidad: 3, precio_unitario: 12.5 }] });
  assert.equal(r.status, 200);
  assert.equal(parseFloat(r.json.total), 99.94 + 37.5);
  const sin = await api('POST', '/api/tickets', { items: [queso()] });
  assert.equal(parseFloat(sin.json.total), 99.94);
});

test('agregar-item: el importe exacto también se respeta al agregar a un ticket guardado', async () => {
  const t = await api('POST', '/api/tickets', { items: [jamon()] });
  assert.equal(parseFloat(t.json.total), 48.65);
  const a = await api('POST', `/api/tickets/${t.json.id}/agregar-item`, queso({ importe: 100 }));
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(parseFloat(a.json.item.subtotal), 100);
  assert.equal(parseFloat(a.json.ticket.total), 148.65);
  const mala = await api('POST', `/api/tickets/${t.json.id}/agregar-item`, queso({ importe: 500 }));
  assert.equal(parseFloat(mala.json.item.subtotal), 99.94);
});

test('pendiente-offline: el ticket hecho en Mostrador sin internet conserva el importe exacto', async () => {
  const r = await api('POST', '/api/tickets/pendiente-offline', { folio: 'OFF-GRAN1', fecha: new Date().toISOString(), items: [queso({ importe: 100 })] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(parseFloat(r.json.total), 100);
  assert.equal(parseFloat((await detalle(r.json.id))[0].subtotal), 100);
});

test('venta-offline: la venta cobrada sin internet conserva el importe exacto y descuenta el inventario', async () => {
  const antes = await existencia(quesoId);
  const r = await api('POST', '/api/tickets/venta-offline', {
    folio: 'OFF-GRAN2', fecha: new Date().toISOString(), metodo_pago: 'efectivo', monto_efectivo: 100, efectivo_recibido: 100, turno_id: turnoId,
    items: [queso({ importe: 100 })]
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.estado, 'pagado');
  assert.equal(parseFloat(r.json.total), 100);
  assert.equal(parseFloat((await detalle(r.json.id))[0].subtotal), 100);
  assert.equal(Math.round((antes - await existencia(quesoId)) * 1000) / 1000, 0.526);
});

test('cobro y devolución: devolver todo regresa exactamente los $100.00 cobrados', async () => {
  const t = await api('POST', '/api/tickets', { items: [queso({ importe: 100 })] });
  const pago = await api('POST', `/api/tickets/${t.json.id}/pagar`, { metodo_pago: 'efectivo', monto_efectivo: 100, efectivo_recibido: 100, turno_id: turnoId });
  assert.equal(pago.status, 200, JSON.stringify(pago.json));
  assert.equal(pago.json.total_neto, 100);

  const porFolio = await api('GET', `/api/tickets/folio/${t.json.folio}`);
  assert.equal(porFolio.json.items[0].tipo_venta, 'peso'); // para que el ticket diga "0.526 kg x $190.00/kg"
  const fila = porFolio.json.items[0];

  const dev = await api('POST', '/api/devoluciones', {
    ticket_id: t.json.id, metodo_reembolso: 'efectivo', turno_id: turnoId, motivo: 'prueba',
    items: [{ ticket_detalle_id: fila.id, cantidad_devuelta: 0.526, regresa_inventario: true }]
  });
  assert.equal(dev.status, 200, JSON.stringify(dev.json));
  assert.equal(parseFloat(dev.json.monto_total), 100);
});

test('devolución parcial por partes suma exactamente lo cobrado', async () => {
  const t = await api('POST', '/api/tickets', { items: [queso({ importe: 100 })] });
  await api('POST', `/api/tickets/${t.json.id}/pagar`, { metodo_pago: 'efectivo', monto_efectivo: 100, efectivo_recibido: 100, turno_id: turnoId });
  const fila = (await detalle(t.json.id))[0];
  const dev = (cantidad) => api('POST', '/api/devoluciones', {
    ticket_id: t.json.id, metodo_reembolso: 'efectivo', turno_id: turnoId, items: [{ ticket_detalle_id: fila.id, cantidad_devuelta: cantidad }]
  });
  const a = await dev(0.263);
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(parseFloat(a.json.monto_total), 50);
  const b = await dev(0.263);
  assert.equal(parseFloat(b.json.monto_total), 50);
  assert.equal((await dev(0.001)).status, 400); // ya no queda nada por devolver
});

test('devolución de un renglón normal (sin importe) sigue siendo cantidad × precio', async () => {
  const t = await api('POST', '/api/tickets', { items: [{ tipo: 'producto', producto_id: piezaId, nombre_producto: 'Crema', cantidad: 3, precio_unitario: 12.5 }] });
  await api('POST', `/api/tickets/${t.json.id}/pagar`, { metodo_pago: 'efectivo', monto_efectivo: 37.5, efectivo_recibido: 50, turno_id: turnoId });
  const fila = (await detalle(t.json.id))[0];
  const dev = await api('POST', '/api/devoluciones', {
    ticket_id: t.json.id, metodo_reembolso: 'efectivo', turno_id: turnoId, items: [{ ticket_detalle_id: fila.id, cantidad_devuelta: 1 }]
  });
  assert.equal(dev.status, 200);
  assert.equal(parseFloat(dev.json.monto_total), 12.5);
});

test('último ticket cobrado también trae si cada renglón es a granel', async () => {
  const r = await api('GET', '/api/tickets/ultimo-pagado');
  assert.equal(r.status, 200);
  assert.ok(r.json.items.length > 0);
  assert.ok(r.json.items.every((i) => i.tipo_venta === 'peso' || i.tipo_venta === 'unidad'));
});
