// Pedidos a domicilio, para recoger y programados + repartidor + liquidación + pedidos fijos,
// con base de datos REAL. Necesita una base VACÍA de pruebas (se borra todo lo que tenga):
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('pedidos con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-pedidos-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const lic = require('../utils/licencia');
const pool = require('../db');

let base, servidor, sucursalId, turnoId, quesoId, cremaId, jamonId;
const T = {}; // tokens por nombre
const U = {}; // ids de usuarios por nombre

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
const existencia = async (id) => parseFloat((await pool.query('SELECT existencia_actual FROM inventario WHERE producto_id = $1', [id])).rows[0].existencia_actual);
// "Ahora + N minutos" en la hora local del negocio, con el formato que manda la pantalla.
const enMinutos = async (min) => (await pool.query(
  `SELECT to_char((NOW() AT TIME ZONE 'America/Mexico_City') + make_interval(mins => $1::int), 'YYYY-MM-DD"T"HH24:MI') AS t`, [min])).rows[0].t;
const fechaLocal = async (dias) => (await pool.query(
  `SELECT to_char((NOW() AT TIME ZONE 'America/Mexico_City')::date + $1::int, 'YYYY-MM-DD') AS f`, [dias])).rows[0].f;

const queso = (cantidad = 1, extra = {}) => ({ tipo: 'producto', producto_id: quesoId, nombre_producto: 'Queso Oaxaca', cantidad, precio_unitario: 190, ...extra });
const crema = (cantidad = 2) => ({ tipo: 'producto', producto_id: cremaId, nombre_producto: 'Crema 200ml', cantidad, precio_unitario: 12.5 });
const direccion = (extra = {}) => ({ alias: 'Casa', calle: 'Av. Patria 1234', colonia: 'Jardines Universidad', cp: '45110', ciudad: 'Zapopan', referencias: 'Portón negro', ...extra });

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema.sql'), 'utf8'));
  const app = require('../server');
  servidor = app.server;
  if (!servidor.listening) await new Promise((ok) => servidor.once('listening', ok));
  base = 'http://127.0.0.1:' + servidor.address().port;
  for (let i = 0; i < 100; i++) {
    const r = await pool.query("SELECT 1 FROM schema_migrations WHERE nombre LIKE '009%'").catch(() => ({ rows: [] }));
    if (r.rows.length) break;
    await esperar(100);
  }
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-01-01', '2037-12-31', 'anual', 'nube')");
  lic.invalidarCache();

  sucursalId = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1)', [sucursalId]);
  const hash = await bcrypt.hash('Clave-Prueba-1', 4);
  const usuario = async (nombre, user, rol) => {
    const id = (await pool.query(
      "INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,$2,$3,$4,$5,true) RETURNING id", [sucursalId, nombre, user, hash, rol])).rows[0].id;
    U[user] = id;
    T[user] = jwt.sign({ id, nombre, usuario: user, rol, sucursal_id: sucursalId, permisos: {} }, process.env.JWT_SECRET, { expiresIn: '1h' });
  };
  await usuario('Dueño', 'dueno', 'dueno');
  await usuario('Cajera', 'cajera', 'cajero');
  await usuario('Mostrador', 'mostrador', 'mostrador');
  await usuario('Luis Ramírez', 'luis', 'repartidor');
  await usuario('Pedro Sánchez', 'pedro', 'repartidor');

  const prod = async (nombre, precio, tipo, mayoreo) => {
    const id = (await pool.query(
      "INSERT INTO productos (sucursal_id, nombre, precio, tipo_venta, usa_inventario, precio_mayoreo) VALUES ($1,$2,$3,$4,true,$5) RETURNING id", [sucursalId, nombre, precio, tipo, mayoreo || null])).rows[0].id;
    await pool.query('INSERT INTO inventario (producto_id, existencia_actual) VALUES ($1, 100)', [id]);
    return id;
  };
  quesoId = await prod('Queso Oaxaca', 190, 'peso', 170);
  cremaId = await prod('Crema 200ml', 12.5, 'unidad', 10);
  jamonId = await prod('Jamón', 139, 'peso');
  turnoId = (await pool.query('INSERT INTO turnos (sucursal_id, usuario_id, fondo_inicial) VALUES ($1,$2,500) RETURNING id', [sucursalId, U.cajera])).rows[0].id;
});

test.after(async () => {
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await pool.end().catch(() => {});
});

// ---------------------------------------------------------------- usuarios y permisos
test('el dueño crea un repartidor con teléfono y puede iniciar sesión; el login sigue funcionando', async () => {
  const c = await api('dueno', 'POST', '/api/usuarios', { nombre: 'Memo', usuario: 'memo', password: 'Clave-Memo-1', rol: 'repartidor', telefono: '33 1111 2222' });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.rol, 'repartidor');
  assert.equal(c.json.telefono, '33 1111 2222');
  const lista = await api('dueno', 'GET', '/api/usuarios');
  assert.ok(lista.json.find((u) => u.usuario === 'memo' && u.telefono === '33 1111 2222'));
  const e = await api('dueno', 'PUT', '/api/usuarios/' + c.json.id, { telefono: '33 9999 0000' });
  assert.equal(e.json.telefono, '33 9999 0000');
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: 'memo', password: 'Clave-Memo-1' }) });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).usuario.rol, 'repartidor');
  const mal = await api('dueno', 'POST', '/api/usuarios', { nombre: 'X', usuario: 'xx', password: 'Clave-X-123', rol: 'cobrador' });
  assert.equal(mal.status, 400);
});

test('el repartidor SOLO entra a su módulo: todo lo demás del sistema le responde 403', async () => {
  for (const [metodo, ruta] of [['GET', '/api/clientes'], ['GET', '/api/tickets/pendientes'], ['GET', '/api/productos'], ['GET', '/api/reportes/ventas'],
    ['GET', '/api/usuarios'], ['GET', '/api/pedidos'], ['GET', '/api/pedidos/zonas'], ['POST', '/api/pedidos'], ['GET', '/api/configuracion'],
    ['GET', '/api/pedidos/repartidor/../clientes'], ['GET', '/api/pedidosx']]) {
    const r = await api('luis', metodo, ruta, metodo === 'POST' ? {} : undefined);
    assert.ok([403, 404].includes(r.status), `${metodo} ${ruta} -> ${r.status}`);
    assert.notEqual(r.status, 200, `${metodo} ${ruta} no debe responder 200`);
  }
  const mio = await api('luis', 'GET', '/api/pedidos/repartidor/mis-pedidos');
  assert.equal(mio.status, 200, JSON.stringify(mio.json));
  assert.deepEqual(mio.json.pendientes, []);
  const cp = await api('luis', 'PUT', '/api/auth/cambiar-password', { password_actual: 'mala', password_nueva: 'Otra-Clave-1' });
  assert.equal(cp.status, 400); // llega a la ruta (la contraseña actual es incorrecta), no se bloquea
});

test('el cajero y el mostrador no pueden crear zonas ni pedidos fijos', async () => {
  assert.equal((await api('cajera', 'POST', '/api/pedidos/zonas', { nombre: 'Z', costo: 10 })).status, 403);
  assert.equal((await api('mostrador', 'POST', '/api/pedidos/fijos', {})).status, 403);
});

// ---------------------------------------------------------------- zonas y configuración
let zona1, zona2;
test('zonas de envío: crear, listar, editar y cotizar con envío gratis', async () => {
  const a = await api('dueno', 'POST', '/api/pedidos/zonas', { nombre: 'Zona 1', descripcion: 'Hasta 3 km', costo: 25 });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  zona1 = a.json.id;
  const b = await api('dueno', 'POST', '/api/pedidos/zonas', { nombre: 'Zona 2', descripcion: '3 a 6 km', costo: 35, envio_gratis_desde: 800 });
  zona2 = b.json.id;
  assert.equal((await api('dueno', 'POST', '/api/pedidos/zonas', { nombre: '', costo: 5 })).status, 400);
  assert.equal((await api('dueno', 'POST', '/api/pedidos/zonas', { nombre: 'X', costo: -5 })).status, 400);
  const cfg = await api('dueno', 'PUT', '/api/configuracion', { pedidos_envio_gratis_desde: 500, pedidos_min_preparacion: 30 });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.json));
  assert.equal((await api('dueno', 'PUT', '/api/configuracion', { pedidos_hora_aviso_fijos: '25:99' })).status, 400);
  const lista = await api('mostrador', 'GET', '/api/pedidos/zonas');
  assert.equal(lista.json.zonas.length, 2);
  assert.equal(lista.json.envio_gratis_desde, 500);
  // Zona 1 usa el monto general ($500); la Zona 2 usa el suyo ($800)
  assert.deepEqual((await api('mostrador', 'GET', `/api/pedidos/cotizar-envio?zona_id=${zona1}&subtotal=300`)).json.costo, 25);
  assert.equal((await api('mostrador', 'GET', `/api/pedidos/cotizar-envio?zona_id=${zona1}&subtotal=500`)).json.gratis, true);
  assert.equal((await api('mostrador', 'GET', `/api/pedidos/cotizar-envio?zona_id=${zona2}&subtotal=500`)).json.costo, 35);
  assert.equal((await api('mostrador', 'GET', `/api/pedidos/cotizar-envio?zona_id=${zona2}&subtotal=800`)).json.costo, 0);
  const ed = await api('dueno', 'PUT', '/api/pedidos/zonas/' + zona2, { nombre: 'Zona 2', descripcion: '3 a 6 km', costo: 40, envio_gratis_desde: 800 });
  assert.equal(ed.json.costo, '40.00');
  await api('dueno', 'PUT', '/api/pedidos/zonas/' + zona2, { nombre: 'Zona 2', descripcion: '3 a 6 km', costo: 35, envio_gratis_desde: 800 });
});

// ---------------------------------------------------------------- crear pedidos
let ped1, clienteMaria;
test('pedido a domicilio: crea cliente + dirección + ticket con envío, y NO sale en la bandeja de Caja (cobra el repartidor)', async () => {
  const r = await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'domicilio', nombre_contacto: 'María Fernanda López', telefono: '33 1234 5678', direccion: direccion({ latitud: 20.7, longitud: -103.4 }),
    zona_id: zona1, pago_modo: 'al_recibir', paga_con: 500, notas: 'Tocar el timbre',
    items: [queso(1.2, { importe: 228 }), crema(2)]
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ped1 = r.json;
  assert.equal(ped1.estado, 'preparando');
  assert.equal(ped1.etiqueta, 'D-' + String(ped1.id).padStart(4, '0'));
  assert.equal(ped1.costo_envio, 25);
  assert.equal(ped1.total_neto, 228 + 25 + 25);            // queso por importe + crema + envío
  assert.equal(ped1.cambio, 500 - 278);
  assert.equal(ped1.por_cobrar, true);
  assert.equal(ped1.n_items, 2);                            // el envío no cuenta como producto
  assert.equal(ped1.calle, 'Av. Patria 1234');
  assert.equal(ped1.latitud, 20.7);
  assert.ok(ped1.items.find((i) => i.es_envio && i.subtotal === 25));
  assert.ok(ped1.items.find((i) => i.nombre_producto === 'Queso Oaxaca' && i.subtotal === 228));
  clienteMaria = ped1.cliente_id;
  assert.ok(clienteMaria, 'se guardó el cliente');
  const dirs = await api('mostrador', 'GET', `/api/clientes/${clienteMaria}/direcciones`);
  assert.equal(dirs.json.length, 1);
  assert.equal(dirs.json[0].principal, true);
  const tk = (await pool.query('SELECT * FROM tickets WHERE id = $1', [ped1.ticket_id])).rows[0];
  assert.equal(parseFloat(tk.total), 278);
  assert.equal(tk.estado, 'pendiente');
  const bandeja = await api('cajera', 'GET', '/api/tickets/pendientes');
  assert.ok(!bandeja.json.find((t) => t.id === ped1.ticket_id), 'el pedido que cobra el repartidor no sale en Caja');
});

test('segundo pedido del mismo teléfono: reutiliza al cliente y su dirección (no duplica)', async () => {
  const r = await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'domicilio', nombre_contacto: 'Maria F. Lopez', telefono: '+52 (33) 1234-5678', direccion: direccion({ calle: 'av. patria 1234', colonia: 'jardines universidad' }),
    zona_id: zona1, pago_modo: 'pagado', items: [jamonItem(0.35)]
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.cliente_id, clienteMaria);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM clientes WHERE sucursal_id = $1', [sucursalId])).rows[0].n, 1);
  assert.equal((await api('mostrador', 'GET', `/api/clientes/${clienteMaria}/direcciones`)).json.length, 1);
  // pagado: sí sale en la bandeja de Caja (con su etiqueta de pedido)
  const bandeja = await api('cajera', 'GET', '/api/tickets/pendientes');
  const fila = bandeja.json.find((t) => t.id === r.json.ticket_id);
  assert.ok(fila, 'el pedido ya pagado se cobra en Caja');
  assert.equal(fila.pedido_id, r.json.id);
  assert.equal(fila.pedido_tipo, 'domicilio');
});
function jamonItem(c) { return { tipo: 'producto', producto_id: jamonId, nombre_producto: 'Jamón', cantidad: c, precio_unitario: 139 }; }

test('buscar clientes por teléfono o nombre trae sus direcciones; con menos de 3 números no busca por teléfono', async () => {
  const a = await api('mostrador', 'GET', '/api/pedidos/clientes?q=1234');
  assert.equal(a.json.length, 1);
  assert.equal(a.json[0].direcciones.length, 1);
  assert.equal(a.json[0].n_pedidos, 2);
  assert.equal((await api('mostrador', 'GET', '/api/pedidos/clientes?q=mar')).json.length, 1);
  assert.equal((await api('mostrador', 'GET', '/api/pedidos/clientes?q=12')).json.length, 0);
  const caja = await api('cajera', 'GET', '/api/clientes/buscar/33%201234');
  assert.equal(caja.json.length, 1); // el selector de Caja también encuentra por teléfono
});

test('validaciones al crear un pedido', async () => {
  const base = { tipo: 'domicilio', nombre_contacto: 'Ana', telefono: '3300000000', direccion: direccion(), items: [queso()] };
  assert.equal((await api('mostrador', 'POST', '/api/pedidos', { ...base, items: [] })).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/pedidos', { ...base, nombre_contacto: '', telefono: '' })).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/pedidos', { ...base, direccion: undefined })).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/pedidos', { ...base, direccion: direccion({ calle: '' }) })).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/pedidos', { ...base, direccion: direccion({ latitud: 999, longitud: 1 }) })).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/pedidos', { ...base, zona_id: 99999 })).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/pedidos', { ...base, programado_para: 'mañana' })).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/pedidos', { ...base, repartidor_id: U.cajera })).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/pedidos', { ...base, pago_modo: 'credito', guardar_cliente: false })).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/pedidos', { ...base, items: [{ ...queso(), cantidad: -1 }] })).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/pedidos', { ...base, costo_envio: 0, zona_id: zona1 })).status, 403); // mostrador no cambia el envío
  // el dueño sí puede poner un costo de envío distinto
  const dueno = await api('dueno', 'POST', '/api/pedidos', { ...base, zona_id: zona1, costo_envio: 10 });
  assert.equal(dueno.status, 200, JSON.stringify(dueno.json));
  assert.equal(dueno.json.costo_envio, 10);
  assert.equal(dueno.json.total_neto, 200);
  await api('dueno', 'POST', `/api/pedidos/${dueno.json.id}/estado`, { estado: 'cancelado' });
});

test('envío gratis al llegar al monto de la zona', async () => {
  const r = await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'domicilio', nombre_contacto: 'Tienda Gratis', telefono: '3355550000', direccion: direccion({ calle: 'Calle Gratis 1' }), zona_id: zona1,
    pago_modo: 'al_recibir', items: [queso(3)] // $570 >= $500
  });
  assert.equal(r.json.costo_envio, 0);
  assert.equal(r.json.total_neto, 570);
  assert.ok(!r.json.items.find((i) => i.es_envio));
  await api('dueno', 'POST', `/api/pedidos/${r.json.id}/estado`, { estado: 'cancelado' });
});

// ---------------------------------------------------------------- programados
test('pedido programado: queda "programado" hasta su hora de preparación y entonces pasa solo a "preparando"', async () => {
  const lejos = await enMinutos(120);
  const r = await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'domicilio', nombre_contacto: 'Restaurante Los Arcos', telefono: '3344445555', direccion: direccion({ calle: 'Calle Arcos 5' }), zona_id: zona2,
    pago_modo: 'pagado', programado_para: lejos, items: [queso(2)]
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.estado, 'programado');
  assert.equal(r.json.programado_para, lejos);
  assert.equal(r.json.fecha_entrega, lejos.slice(0, 10));
  assert.ok(r.json.preparar_desde < lejos);
  // un programado no estorba en la bandeja de Caja todavía
  assert.ok(!(await api('cajera', 'GET', '/api/tickets/pendientes')).json.find((t) => t.id === r.json.ticket_id));
  // no se puede mandar a la calle un programado sin prepararlo... pero sí adelantarlo a preparando
  assert.equal((await api('mostrador', 'POST', `/api/pedidos/${r.json.id}/estado`, { estado: 'entregado' })).status, 409);
  // simulamos que llegó la hora de prepararlo
  await pool.query("UPDATE pedidos SET preparar_desde = (NOW() AT TIME ZONE 'America/Mexico_City') - INTERVAL '1 minute' WHERE id = $1", [r.json.id]);
  const lista = await api('mostrador', 'GET', '/api/pedidos?fecha=' + lejos.slice(0, 10));
  const fila = lista.json.find((p) => p.id === r.json.id);
  assert.equal(fila.estado, 'preparando');
  assert.ok((await api('cajera', 'GET', '/api/tickets/pendientes')).json.find((t) => t.id === r.json.ticket_id), 'ya pagado + ya toca: aparece en Caja');
  progra = r.json.id;
});
let progra;

test('programado para dentro de poco (menos que el tiempo de preparación) empieza ya en "preparando"', async () => {
  const r = await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'recoger', nombre_contacto: 'Cliente Pronto', telefono: '3366667777', pago_modo: 'al_recibir', programado_para: await enMinutos(10), items: [crema(1)]
  });
  assert.equal(r.json.estado, 'preparando');
  await api('dueno', 'POST', `/api/pedidos/${r.json.id}/estado`, { estado: 'cancelado' });
});

test('"guardar sin enviar": queda programado sin hora automática y se envía a preparar a mano', async () => {
  const r = await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'recoger', nombre_contacto: 'Borrador', telefono: '3377778888', pago_modo: 'al_recibir', enviar: false, items: [crema(1)]
  });
  assert.equal(r.json.estado, 'programado');
  assert.equal(r.json.preparar_desde, null);
  const lista = await api('mostrador', 'GET', '/api/pedidos?fecha=' + (await fechaLocal(0)));
  assert.equal(lista.json.find((p) => p.id === r.json.id).estado, 'programado'); // el temporizador no lo toca
  const go = await api('mostrador', 'POST', `/api/pedidos/${r.json.id}/estado`, { estado: 'preparando' });
  assert.equal(go.json.estado, 'preparando');
  await api('dueno', 'POST', `/api/pedidos/${r.json.id}/estado`, { estado: 'cancelado' });
});

// ---------------------------------------------------------------- flujo del repartidor y cobro
test('flujo completo: preparando → listo → asignar → el repartidor sale, llega y entrega cobrando', async () => {
  const id = ped1.id;
  // no puede salir sin repartidor
  assert.equal((await api('mostrador', 'POST', `/api/pedidos/${id}/estado`, { estado: 'en_camino' })).status, 400);
  const listo = await api('mostrador', 'POST', `/api/pedidos/${id}/estado`, { estado: 'listo' });
  assert.equal(listo.json.estado, 'listo');
  assert.ok(listo.json.listo_en);
  // sin asignar: aparece como disponible para los repartidores
  const disp = await api('luis', 'GET', '/api/pedidos/repartidor/mis-pedidos');
  assert.ok(disp.json.disponibles.find((p) => p.id === id));
  assert.equal(disp.json.pendientes.length, 0);
  assert.equal((await api('luis', 'POST', `/api/pedidos/repartidor/${id}/salir`)).status, 403); // aún no es suyo
  // Pedro lo toma primero; Luis ya no puede
  assert.equal((await api('pedro', 'POST', `/api/pedidos/repartidor/${id}/tomar`)).status, 200);
  assert.equal((await api('luis', 'POST', `/api/pedidos/repartidor/${id}/tomar`)).status, 409);
  // el gerente reasigna a Luis
  const asig = await api('mostrador', 'POST', `/api/pedidos/${id}/asignar`, { repartidor_id: U.luis });
  assert.equal(asig.json.repartidor_id, U.luis);
  assert.equal((await api('mostrador', 'POST', `/api/pedidos/${id}/asignar`, { repartidor_id: U.cajera })).status, 400);

  const mis = await api('luis', 'GET', '/api/pedidos/repartidor/mis-pedidos');
  assert.equal(mis.json.pendientes.length, 1);
  const p = mis.json.pendientes[0];
  assert.equal(p.calle, 'Av. Patria 1234');
  assert.equal(p.por_cobrar, true);
  assert.equal(p.total_neto, 278);
  assert.equal(p.cambio, 222);
  assert.equal(p.items.length, 2);
  assert.equal(p.latitud, 20.7);

  assert.equal((await api('pedro', 'POST', `/api/pedidos/repartidor/${id}/salir`)).status, 403); // no es de Pedro
  const sal = await api('luis', 'POST', `/api/pedidos/repartidor/${id}/salir`);
  assert.equal(sal.status, 200, JSON.stringify(sal.json));
  assert.equal(sal.json.estado, 'en_camino');
  assert.ok(sal.json.salio_en);
  assert.equal((await api('luis', 'POST', `/api/pedidos/repartidor/${id}/llegue`)).json.estado, 'en_camino');
  assert.ok((await api('dueno', 'GET', `/api/pedidos/${id}`)).json.llego_en);

  // cobra con una forma inválida → rechazado; en efectivo → entregado
  assert.equal((await api('luis', 'POST', `/api/pedidos/repartidor/${id}/entregar`, { metodo_cobro: 'bitcoin' })).status, 400);
  const ent = await api('luis', 'POST', `/api/pedidos/repartidor/${id}/entregar`, { metodo_cobro: 'efectivo' });
  assert.equal(ent.status, 200, JSON.stringify(ent.json));
  assert.equal(ent.json.estado, 'entregado');
  assert.equal(ent.json.monto_cobrado, 278);
  assert.equal(ent.json.metodo_cobro, 'efectivo');
  // el ticket sigue pendiente hasta la liquidación (no hay dinero en caja todavía)
  assert.equal((await pool.query('SELECT estado FROM tickets WHERE id = $1', [ped1.ticket_id])).rows[0].estado, 'pendiente');
  // ya entregado: no se puede volver a mover ni editar
  assert.equal((await api('mostrador', 'POST', `/api/pedidos/${id}/estado`, { estado: 'listo' })).status, 409);
  assert.equal((await api('mostrador', 'PUT', `/api/pedidos/${id}`, { notas: 'x' })).status, 409);
  assert.equal((await api('luis', 'POST', `/api/pedidos/repartidor/${id}/entregar`, {})).status, 409);
  // en "hechos hoy" del repartidor
  const hoy = await api('luis', 'GET', '/api/pedidos/repartidor/mis-pedidos');
  assert.equal(hoy.json.hechos_hoy.length, 1);
});

let ped3, ped4;
test('no pude entregar: pide motivo, regresa a la tienda y se puede reintentar', async () => {
  const mk = async (tel, calle) => (await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'domicilio', nombre_contacto: 'Cliente ' + tel, telefono: tel, direccion: direccion({ calle }), zona_id: zona1, pago_modo: 'al_recibir', repartidor_id: U.luis, items: [queso(1)]
  })).json;
  ped3 = await mk('3388880001', 'Calle Tres 3');
  ped4 = await mk('3388880002', 'Calle Cuatro 4');
  for (const p of [ped3, ped4]) {
    assert.equal(p.repartidor_id, U.luis);
    await api('mostrador', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'listo' });
    assert.equal((await api('luis', 'POST', `/api/pedidos/repartidor/${p.id}/salir`)).status, 200);
  }
  assert.equal((await api('luis', 'POST', `/api/pedidos/repartidor/${ped3.id}/no-entregado`, {})).status, 400); // falta el motivo
  const no = await api('luis', 'POST', `/api/pedidos/repartidor/${ped3.id}/no-entregado`, { motivo: 'No estaba nadie' });
  assert.equal(no.json.estado, 'no_entregado');
  assert.equal(no.json.motivo_no_entrega, 'No estaba nadie');
  const retry = await api('mostrador', 'POST', `/api/pedidos/${ped3.id}/estado`, { estado: 'listo' });
  assert.equal(retry.json.estado, 'listo');
  assert.equal(retry.json.salio_en, null);
  // el pedido 4 se entrega con transferencia
  const ent = await api('luis', 'POST', `/api/pedidos/repartidor/${ped4.id}/entregar`, { metodo_cobro: 'transferencia' });
  assert.equal(ent.json.metodo_cobro, 'transferencia');
  // y el 3 se vuelve a mandar y se entrega en efectivo
  await api('luis', 'POST', `/api/pedidos/repartidor/${ped3.id}/salir`);
  assert.equal((await api('luis', 'POST', `/api/pedidos/repartidor/${ped3.id}/entregar`, { metodo_cobro: 'efectivo' })).json.estado, 'entregado');
});

test('tablero: resumen, repartidores y por cobrar', async () => {
  const resumen = await api('mostrador', 'GET', '/api/pedidos/resumen');
  assert.equal(resumen.status, 200, JSON.stringify(resumen.json));
  assert.ok(resumen.json.pedidos_dia >= 3);
  assert.equal(resumen.json.por_cobrar, 278 + 190 + 25 + 190 + 25); // los 3 entregados al recibir, aún sin liquidar
  assert.ok(resumen.json.entregado_hoy >= 278 + 215 + 215);
  const reps = await api('mostrador', 'GET', '/api/pedidos/repartidores');
  const luis = reps.json.find((r) => r.id === U.luis);
  assert.equal(luis.pedidos_por_liquidar, 3);
  assert.equal(luis.efectivo_por_entregar, 278 + 215); // pedido 1 + pedido 3 en efectivo (el 4 fue por transferencia)
  assert.equal(luis.por_entregar_a_caja, 278 + 215 + 215);
  assert.equal(luis.estado, 'libre');
  assert.equal(luis.entregas_hoy, 3);
});

test('liquidar: el repartidor ve su corte; la caja cobra los tickets en su turno y el inventario baja', async () => {
  const corte = await api('luis', 'GET', '/api/pedidos/repartidor/mi-corte');
  assert.equal(corte.status, 200, JSON.stringify(corte.json));
  assert.equal(corte.json.entregadas, 3);
  assert.equal(corte.json.resumen.efectivo, 278 + 215);
  assert.equal(corte.json.resumen.transferencia, 215);
  assert.equal(corte.json.debe_entregar_efectivo, 493);
  assert.equal(corte.json.pedidos.length, 3);

  const prev = await api('cajera', 'GET', `/api/pedidos/liquidacion/${U.luis}`);
  assert.equal(prev.json.resumen.efectivo, 493);

  // sin permiso de caja / turno inválido / sin efectivo → errores claros
  assert.equal((await api('mostrador', 'POST', '/api/pedidos/liquidar', { repartidor_id: U.luis, turno_id: turnoId, efectivo_entregado: 493 })).status, 403);
  assert.equal((await api('cajera', 'POST', '/api/pedidos/liquidar', { repartidor_id: U.luis, turno_id: 99999, efectivo_entregado: 493 })).status, 400);
  assert.equal((await api('cajera', 'POST', '/api/pedidos/liquidar', { repartidor_id: U.luis, turno_id: turnoId })).status, 400);
  assert.equal((await api('cajera', 'POST', '/api/pedidos/liquidar', { repartidor_id: U.pedro, turno_id: turnoId, efectivo_entregado: 0 })).status, 400); // Pedro no tiene nada

  const quesoAntes = await existencia(quesoId), cremaAntes = await existencia(cremaId);
  const liq = await api('cajera', 'POST', '/api/pedidos/liquidar', { repartidor_id: U.luis, turno_id: turnoId, efectivo_entregado: 490, notas: 'Faltaron $3' });
  assert.equal(liq.status, 200, JSON.stringify(liq.json));
  assert.equal(liq.json.liquidacion.esperado_efectivo, 493);
  assert.equal(liq.json.liquidacion.entregado_efectivo, 490);
  assert.equal(liq.json.liquidacion.diferencia, -3);
  assert.equal(liq.json.liquidacion.total_transferencia, 215);
  assert.equal(liq.json.liquidacion.num_pedidos, 3);

  const tks = (await pool.query('SELECT * FROM tickets WHERE id = ANY($1) ORDER BY id', [[ped1.ticket_id, ped3.ticket_id, ped4.ticket_id]])).rows;
  assert.ok(tks.every((t) => t.estado === 'pagado' && t.turno_id === turnoId && t.cajero_usuario_id === U.cajera));
  assert.equal(tks.find((t) => t.id === ped1.ticket_id).metodo_pago, 'efectivo');
  assert.equal(parseFloat(tks.find((t) => t.id === ped1.ticket_id).monto_efectivo), 278);
  assert.equal(tks.find((t) => t.id === ped4.ticket_id).metodo_pago, 'transferencia');
  assert.equal(parseFloat(tks.find((t) => t.id === ped4.ticket_id).monto_tarjeta), 215);
  assert.equal(parseFloat(tks.find((t) => t.id === ped4.ticket_id).monto_efectivo), 0);
  // inventario: 1.2 + 1 + 1 de queso y 2 cremas
  assert.equal(Math.round((quesoAntes - await existencia(quesoId)) * 1000) / 1000, 3.2);
  assert.equal(cremaAntes - await existencia(cremaId), 2);
  // ya no hay nada pendiente y no se puede liquidar dos veces
  assert.equal((await api('luis', 'GET', '/api/pedidos/repartidor/mi-corte')).json.pedidos.length, 0);
  assert.equal((await api('cajera', 'POST', '/api/pedidos/liquidar', { repartidor_id: U.luis, turno_id: turnoId, efectivo_entregado: 0 })).status, 400);
  const hist = await api('cajera', 'GET', '/api/pedidos/liquidaciones');
  assert.equal(hist.json[0].diferencia, -3);
  assert.equal(hist.json[0].repartidor_nombre, 'Luis Ramírez');
  // el corte de caja del turno ve el efectivo y la transferencia
  const corteTurno = await pool.query(
    `SELECT COALESCE(SUM(monto_efectivo),0) AS ef, COALESCE(SUM(monto_tarjeta),0) AS tj FROM tickets WHERE turno_id = $1 AND estado = 'pagado' AND id = ANY($2)`,
    [turnoId, [ped1.ticket_id, ped3.ticket_id, ped4.ticket_id]]);
  assert.equal(parseFloat(corteTurno.rows[0].ef), 493);
  assert.equal(parseFloat(corteTurno.rows[0].tj), 215);
});

test('si la Caja ya cobró el ticket de un pedido, la liquidación no lo cobra dos veces', async () => {
  const p = (await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'domicilio', nombre_contacto: 'Doble Cobro', telefono: '3399990001', direccion: direccion({ calle: 'Calle Doble 9' }), zona_id: zona1, pago_modo: 'al_recibir', repartidor_id: U.luis, items: [queso(1)]
  })).json;
  await api('mostrador', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'listo' });
  await api('luis', 'POST', `/api/pedidos/repartidor/${p.id}/salir`);
  await api('luis', 'POST', `/api/pedidos/repartidor/${p.id}/entregar`, { metodo_cobro: 'efectivo' });
  // alguien lo cobra directo en Caja (escaneando el folio)
  const pago = await api('cajera', 'POST', `/api/tickets/${p.ticket_id}/pagar`, { metodo_pago: 'efectivo', monto_efectivo: 215, efectivo_recibido: 215, turno_id: turnoId });
  assert.equal(pago.status, 200);
  const antes = await existencia(quesoId);
  const corte = await api('luis', 'GET', '/api/pedidos/repartidor/mi-corte');
  assert.equal(corte.json.resumen.efectivo, 0);
  assert.equal(corte.json.resumen.ya_cobrados_en_caja, 215);
  const liq = await api('cajera', 'POST', '/api/pedidos/liquidar', { repartidor_id: U.luis, turno_id: turnoId, efectivo_entregado: 0 });
  assert.equal(liq.status, 200, JSON.stringify(liq.json));
  assert.equal(liq.json.liquidacion.esperado_efectivo, 0);
  assert.equal(await existencia(quesoId), antes); // no se descontó otra vez
});

test('pedido ya pagado / a crédito: la entrega no genera cobro y la liquidación solo lo cierra', async () => {
  const mk = async (modo, tel, calle, cliente) => (await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'domicilio', nombre_contacto: 'Cliente ' + modo, telefono: tel, direccion: direccion({ calle }), zona_id: zona1, pago_modo: modo, repartidor_id: U.pedro, items: [queso(1)]
  })).json;
  const a = await mk('pagado', '3300001111', 'Calle Pagada 1');
  const b = await mk('credito', '3300002222', 'Calle Credito 2');
  assert.equal(a.por_cobrar, false);
  for (const p of [a, b]) {
    await api('mostrador', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'listo' });
    await api('pedro', 'POST', `/api/pedidos/repartidor/${p.id}/salir`);
    const e = await api('pedro', 'POST', `/api/pedidos/repartidor/${p.id}/entregar`, {});
    assert.equal(e.json.estado, 'entregado');
    assert.equal(e.json.monto_cobrado, null);
  }
  const corte = await api('pedro', 'GET', '/api/pedidos/repartidor/mi-corte');
  assert.equal(corte.json.resumen.pagados_antes, 215);
  assert.equal(corte.json.resumen.credito, 215);
  assert.equal(corte.json.debe_entregar_efectivo, 0);
  const tkAntes = (await pool.query('SELECT estado FROM tickets WHERE id = ANY($1)', [[a.ticket_id, b.ticket_id]])).rows;
  const liq = await api('cajera', 'POST', '/api/pedidos/liquidar', { repartidor_id: U.pedro, turno_id: turnoId, efectivo_entregado: 0 });
  assert.equal(liq.status, 200);
  const tkDespues = (await pool.query('SELECT estado FROM tickets WHERE id = ANY($1)', [[a.ticket_id, b.ticket_id]])).rows;
  assert.deepEqual(tkDespues, tkAntes); // siguen pendientes: se cobran en Caja
  assert.ok(tkDespues.every((t) => t.estado === 'pendiente'));
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM pedidos WHERE liquidacion_id IS NOT NULL AND id = ANY($1)', [[a.id, b.id]])).rows[0].n, 2);
});

// ---------------------------------------------------------------- foto / firma
test('foto y firma de entrega: obligatorias según la configuración, y se guardan', async () => {
  await api('dueno', 'PUT', '/api/configuracion', { pedidos_foto_obligatoria: true, pedidos_firma_obligatoria: true });
  const p = (await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'domicilio', nombre_contacto: 'Con Foto', telefono: '3300003333', direccion: direccion({ calle: 'Calle Foto 3' }), zona_id: zona1, pago_modo: 'pagado', repartidor_id: U.pedro, items: [crema(1)]
  })).json;
  await api('mostrador', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'listo' });
  await api('pedro', 'POST', `/api/pedidos/repartidor/${p.id}/salir`);
  const mis = await api('pedro', 'GET', '/api/pedidos/repartidor/mis-pedidos');
  assert.equal(mis.json.foto_obligatoria, true);
  assert.equal(mis.json.firma_obligatoria, true);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  assert.equal((await api('pedro', 'POST', `/api/pedidos/repartidor/${p.id}/entregar`, {})).status, 400);
  assert.equal((await api('pedro', 'POST', `/api/pedidos/repartidor/${p.id}/entregar`, { evidencias: { foto: png } })).status, 400);
  assert.equal((await api('pedro', 'POST', `/api/pedidos/repartidor/${p.id}/entregar`, { evidencias: { foto: 'data:text/html;base64,AAAA', firma: png } })).status, 400);
  const ok = await api('pedro', 'POST', `/api/pedidos/repartidor/${p.id}/entregar`, { evidencias: { foto: png, firma: png } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.evidencias.length, 2);
  const ev = await api('dueno', 'GET', `/api/pedidos/${p.id}/evidencias/${ok.json.evidencias[0].id}`);
  assert.ok(ev.json.dato.startsWith('data:image/png'));
  await api('dueno', 'PUT', '/api/configuracion', { pedidos_foto_obligatoria: false, pedidos_firma_obligatoria: false });
});

// ---------------------------------------------------------------- editar y cancelar
test('editar un pedido: cambiar la zona recalcula el envío y el ticket; el repartidor no puede editar', async () => {
  const p = (await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'domicilio', nombre_contacto: 'Editable', telefono: '3300004444', direccion: direccion({ calle: 'Calle Edit 4' }), zona_id: zona1, pago_modo: 'al_recibir', items: [crema(4)] // $50
  })).json;
  assert.equal(p.total_neto, 75);
  const e = await api('mostrador', 'PUT', `/api/pedidos/${p.id}`, { zona_id: zona2, notas: 'Cambió de zona', nombre_contacto: 'Editable Dos', paga_con: 100,
    direccion: direccion({ calle: 'Calle Nueva 77', referencias: 'Casa azul' }) });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  assert.equal(e.json.costo_envio, 35);
  assert.equal(e.json.total_neto, 85);
  assert.equal(e.json.items.filter((i) => i.es_envio).length, 1);
  assert.equal(e.json.nombre_contacto, 'Editable Dos');
  assert.equal(e.json.calle, 'Calle Nueva 77');
  assert.equal(e.json.cambio, 15);
  assert.equal(parseFloat((await pool.query('SELECT total FROM tickets WHERE id = $1', [p.ticket_id])).rows[0].total), 85);
  const hora = await enMinutos(180);
  const e2 = await api('mostrador', 'PUT', `/api/pedidos/${p.id}`, { programado_para: hora });
  assert.equal(e2.json.programado_para, hora);
  assert.equal(e2.json.fecha_entrega, hora.slice(0, 10));
  assert.equal((await api('mostrador', 'PUT', `/api/pedidos/${p.id}`, { programado_para: 'x' })).status, 400);
  assert.equal((await api('luis', 'PUT', `/api/pedidos/${p.id}`, { notas: 'x' })).status, 403);
  // cancelar: el ticket también se cancela y deja de existir como pendiente
  const c = await api('cajera', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'cancelado', motivo: 'El cliente ya no lo quiere' });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.estado, 'cancelado');
  assert.equal((await pool.query('SELECT estado FROM tickets WHERE id = $1', [p.ticket_id])).rows[0].estado, 'cancelado');
  assert.equal((await api('mostrador', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'listo' })).status, 409);
});

test('editar los productos de un pedido: cantidades, quitar, agregar; el envío y el ticket se recalculan', async () => {
  const p = (await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'domicilio', nombre_contacto: 'Cambia Productos', telefono: '3300008888', direccion: direccion({ calle: 'Calle Cambio 8' }), zona_id: zona1, pago_modo: 'al_recibir', items: [crema(4)]
  })).json;
  assert.equal(p.total_neto, 75); // 4 x 12.50 + envío 25
  const lineaCrema = (await api('mostrador', 'GET', `/api/pedidos/${p.id}`)).json.items.find((i) => !i.es_envio);

  // cambiar la cantidad
  const a = await api('mostrador', 'PUT', `/api/pedidos/${p.id}`, { lineas: [{ id: lineaCrema.id, cantidad: 6 }] });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.total_neto, 100); // 75 + 25
  assert.equal(a.json.costo_envio, 25);
  assert.equal(a.json.items.find((i) => !i.es_envio).subtotal, 75);

  // agregar un producto: con $645 de productos el envío ya sale gratis (a partir de $500)
  const b = await api('mostrador', 'PUT', `/api/pedidos/${p.id}`, { agregar: [queso(3)] });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(b.json.costo_envio, 0);
  assert.equal(b.json.total_neto, 645);
  assert.equal(b.json.items.filter((i) => i.es_envio).length, 0);
  assert.equal(b.json.n_items, 2);
  assert.equal(parseFloat((await pool.query('SELECT total FROM tickets WHERE id = $1', [p.ticket_id])).rows[0].total), 645);

  // quitar el queso: vuelve a cobrarse el envío
  const lineaQueso = b.json.items.find((i) => i.nombre_producto === 'Queso Oaxaca');
  const c = await api('mostrador', 'PUT', `/api/pedidos/${p.id}`, { lineas: [{ id: lineaCrema.id, cantidad: 6 }] });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.items.some((i) => i.id === lineaQueso.id), false);
  assert.equal(c.json.costo_envio, 25);
  assert.equal(c.json.total_neto, 100);

  // quitar uno y agregar otro en la misma edición
  const d = await api('mostrador', 'PUT', `/api/pedidos/${p.id}`, { lineas: [], agregar: [queso(1)] });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.items.filter((i) => !i.es_envio).length, 1);
  assert.equal(d.json.total_neto, 215); // 190 + 25

  // validaciones
  const lineaQueso2 = d.json.items.find((i) => !i.es_envio);
  assert.equal((await api('mostrador', 'PUT', `/api/pedidos/${p.id}`, { lineas: [] })).status, 400); // sin productos
  assert.equal((await api('mostrador', 'PUT', `/api/pedidos/${p.id}`, { lineas: [{ id: lineaQueso2.id, cantidad: 0 }] })).status, 400);
  assert.equal((await api('mostrador', 'PUT', `/api/pedidos/${p.id}`, { lineas: [{ id: 99999999, cantidad: 1 }] })).status, 400);
  assert.equal((await api('mostrador', 'PUT', `/api/pedidos/${p.id}`, { agregar: [{ nombre_producto: 'Raro', cantidad: -1, precio_unitario: 5 }] })).status, 400);
  assert.equal((await api('luis', 'PUT', `/api/pedidos/${p.id}`, { lineas: [{ id: lineaQueso2.id, cantidad: 2 }] })).status, 403);
  assert.equal((await api('dueno', 'GET', `/api/pedidos/${p.id}`)).json.total_neto, 215); // nada cambió con los errores

  // un envío puesto a mano (por el dueño) se respeta al cambiar productos
  const m = (await api('dueno', 'POST', '/api/pedidos', {
    tipo: 'domicilio', nombre_contacto: 'Envio Manual', telefono: '3300009999', direccion: direccion({ calle: 'Calle Manual 3' }), zona_id: zona1, costo_envio: 10, pago_modo: 'al_recibir', items: [crema(2)]
  })).json;
  assert.equal(m.costo_envio, 10);
  const lm = (await api('dueno', 'GET', `/api/pedidos/${m.id}`)).json.items.find((i) => !i.es_envio);
  const m2 = await api('mostrador', 'PUT', `/api/pedidos/${m.id}`, { lineas: [{ id: lm.id, cantidad: 3 }] });
  assert.equal(m2.status, 200, JSON.stringify(m2.json));
  assert.equal(m2.json.costo_envio, 10);
  assert.equal(m2.json.total_neto, 47.5); // 37.50 + 10

  // para recoger: el total es solo los productos; y al cobrar en Caja se descuenta lo nuevo
  const r = (await api('mostrador', 'POST', '/api/pedidos', { tipo: 'recoger', nombre_contacto: 'Recoge Cambio', telefono: '3300001010', pago_modo: 'pagado', items: [crema(2)] })).json;
  const lr = (await api('mostrador', 'GET', `/api/pedidos/${r.id}`)).json.items[0];
  const antes = await existencia(cremaId);
  const r2e = await api('mostrador', 'PUT', `/api/pedidos/${r.id}`, { lineas: [{ id: lr.id, cantidad: 5 }] });
  assert.equal(r2e.status, 200, JSON.stringify(r2e.json));
  assert.equal(r2e.json.total_neto, 62.5);
  assert.equal(await existencia(cremaId), antes); // todavía no se cobra: no se mueve el inventario
  assert.equal((await api('cajera', 'POST', `/api/tickets/${r.ticket_id}/pagar`, { metodo_pago: 'efectivo', monto_efectivo: 62.5, efectivo_recibido: 100, turno_id: turnoId })).status, 200);
  assert.equal(await existencia(cremaId), antes - 5);
  // ya cobrado: no se pueden cambiar los productos
  const tarde = await api('mostrador', 'PUT', `/api/pedidos/${r.id}`, { lineas: [{ id: lr.id, cantidad: 1 }] });
  assert.equal(tarde.status, 409);
  assert.match(tarde.json.error, /cobrado/i);
});

test('no se cancela un pedido ya cobrado; cancelar el ticket cancela el pedido', async () => {
  const a = (await api('mostrador', 'POST', '/api/pedidos', { tipo: 'recoger', nombre_contacto: 'Pagó', telefono: '3300005555', pago_modo: 'pagado', items: [crema(1)] })).json;
  assert.equal((await api('cajera', 'POST', `/api/tickets/${a.ticket_id}/pagar`, { metodo_pago: 'efectivo', monto_efectivo: 12.5, efectivo_recibido: 20, turno_id: turnoId })).status, 200);
  const c = await api('cajera', 'POST', `/api/pedidos/${a.id}/estado`, { estado: 'cancelado' });
  assert.equal(c.status, 409);
  assert.match(c.json.error, /devoluci/i);
  const b = (await api('mostrador', 'POST', '/api/pedidos', { tipo: 'recoger', nombre_contacto: 'Canceló', telefono: '3300006666', pago_modo: 'pagado', items: [crema(1)] })).json;
  assert.equal((await api('cajera', 'POST', `/api/tickets/${b.ticket_id}/cancelar`, { motivo: 'prueba' })).status, 200);
  assert.equal((await api('dueno', 'GET', `/api/pedidos/${b.id}`)).json.estado, 'cancelado');
  // el mostrador no tiene permiso de cancelar pedidos
  const d = (await api('mostrador', 'POST', '/api/pedidos', { tipo: 'recoger', nombre_contacto: 'Otro', telefono: '3300007777', pago_modo: 'pagado', items: [crema(1)] })).json;
  assert.equal((await api('mostrador', 'POST', `/api/pedidos/${d.id}/estado`, { estado: 'cancelado' })).status, 403);
  await api('dueno', 'POST', `/api/pedidos/${d.id}/estado`, { estado: 'cancelado' });
});

test('pedido para recoger: sale en Caja, no lleva repartidor y se entrega desde "listo"', async () => {
  const p = (await api('mostrador', 'POST', '/api/pedidos', { tipo: 'recoger', nombre_contacto: 'Recoge', telefono: '3300008888', pago_modo: 'al_recibir', items: [queso(1)] })).json;
  assert.equal(p.costo_envio, 0);
  assert.equal(p.por_cobrar, false); // al recoger no hay repartidor que cobre
  assert.ok((await api('cajera', 'GET', '/api/tickets/pendientes')).json.find((t) => t.id === p.ticket_id), 'al recoger se cobra en Caja');
  assert.equal((await api('mostrador', 'POST', `/api/pedidos/${p.id}/asignar`, { repartidor_id: U.luis })).status, 400);
  assert.equal((await api('mostrador', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'en_camino' })).status, 409);
  await api('mostrador', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'listo' });
  const e = await api('mostrador', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'entregado' });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  assert.equal(e.json.monto_cobrado, null);
});

// ---------------------------------------------------------------- agenda, producción y ruta
test('hoja de producción y ruta del día', async () => {
  const f = await fechaLocal(3);
  const hora = f + 'T09:00';
  const mk = async (tel, calle, items, extra = {}) => (await api('mostrador', 'POST', '/api/pedidos', {
    tipo: 'domicilio', nombre_contacto: 'Prod ' + tel, telefono: tel, direccion: direccion({ calle }), zona_id: zona1, pago_modo: 'pagado', programado_para: hora, items, ...extra })).json;
  const a = await mk('3300010001', 'Calle P1', [queso(2), crema(3)], { repartidor_id: U.luis });
  const b = await mk('3300010002', 'Calle P2', [queso(1.5), jamonItem(0.5)]);
  const hoja = await api('mostrador', 'GET', '/api/pedidos/produccion?fecha=' + f);
  assert.equal(hoja.status, 200, JSON.stringify(hoja.json));
  const queso$ = hoja.json.productos.find((x) => x.nombre === 'Queso Oaxaca');
  assert.equal(queso$.cantidad, 3.5);
  assert.equal(queso$.pedidos, 2);
  assert.equal(hoja.json.productos.find((x) => x.nombre === 'Crema 200ml').cantidad, 3);
  assert.ok(!hoja.json.productos.find((x) => x.nombre === 'Envío a domicilio'), 'el envío no es un producto');
  assert.equal(hoja.json.pedidos.length, 2);
  assert.equal(hoja.json.pedidos[0].hora, '09:00');
  // agenda: filtros por rango de fechas
  const agenda = await api('mostrador', 'GET', `/api/pedidos?desde=${f}&hasta=${f}`);
  assert.deepEqual(agenda.json.map((p) => p.id).sort(), [a.id, b.id].sort());
  assert.equal((await api('mostrador', 'GET', '/api/pedidos?fecha=2020-13-45')).status, 400);
  // ruta: en orden, y se puede reordenar
  const ruta = await api('mostrador', 'GET', `/api/pedidos/ruta?fecha=${f}`);
  assert.equal(ruta.json.length, 2);
  const nueva = [b.id, a.id];
  assert.equal((await api('mostrador', 'PUT', '/api/pedidos/ruta/orden', { ids: nueva })).status, 200);
  assert.deepEqual((await api('mostrador', 'GET', `/api/pedidos/ruta?fecha=${f}`)).json.map((p) => p.id), nueva);
  assert.deepEqual((await api('mostrador', 'GET', `/api/pedidos/ruta?fecha=${f}&repartidor_id=${U.luis}`)).json.map((p) => p.id), [a.id]);
  assert.deepEqual((await api('mostrador', 'GET', `/api/pedidos/ruta?fecha=${f}&repartidor_id=ninguno`)).json.map((p) => p.id), [b.id]);
  for (const p of [a, b]) await api('dueno', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'cancelado' });
  assert.equal((await api('mostrador', 'GET', '/api/pedidos/produccion?fecha=' + f)).json.productos.length, 0);
});

// ---------------------------------------------------------------- pedidos fijos
test('direcciones del cliente: guardar, editar, principal y quitar', async () => {
  const c = (await api('dueno', 'POST', '/api/clientes', { nombre: 'Tienda La Esperanza', telefono: '3312312312', limite_credito: 5000, tipo: 'tienda', usa_mayoreo: true })).json;
  assert.equal(c.tipo, 'tienda');
  assert.equal(c.usa_mayoreo, true);
  assert.equal((await api('dueno', 'POST', '/api/clientes', { nombre: 'X', tipo: 'otro' })).status, 400);
  const ed = await api('dueno', 'PUT', `/api/clientes/${c.id}`, { tipo: 'publico' });
  assert.equal(ed.json.tipo, 'publico');
  await api('dueno', 'PUT', `/api/clientes/${c.id}`, { tipo: 'tienda' });
  const d1 = await api('mostrador', 'POST', `/api/clientes/${c.id}/direcciones`, direccion({ alias: 'Local', calle: 'Av. Miramar 100' }));
  assert.equal(d1.status, 200, JSON.stringify(d1.json));
  assert.equal(d1.json.principal, true);
  const d2 = await api('mostrador', 'POST', `/api/clientes/${c.id}/direcciones`, direccion({ alias: 'Bodega', calle: 'Calle Bodega 5', latitud: 20.6, longitud: -103.3 }));
  assert.equal(d2.json.principal, false);
  const upd = await api('mostrador', 'PUT', `/api/clientes/${c.id}/direcciones/${d2.json.id}`, { ...direccion({ alias: 'Bodega 2', calle: 'Calle Bodega 6' }), principal: true });
  assert.equal(upd.json.principal, true);
  const lista = (await api('mostrador', 'GET', `/api/clientes/${c.id}/direcciones`)).json;
  assert.equal(lista[0].id, d2.json.id);
  assert.equal(lista.filter((d) => d.principal).length, 1);
  assert.equal((await api('mostrador', 'POST', `/api/clientes/${c.id}/direcciones`, { alias: 'sin calle' })).status, 400);
  assert.equal((await api('mostrador', 'POST', `/api/clientes/${c.id}/direcciones`, direccion({ zona_id: 99999 }))).status, 400);
  assert.equal((await api('mostrador', 'POST', '/api/clientes/99999/direcciones', direccion())).status, 404);
  assert.equal((await api('mostrador', 'DELETE', `/api/clientes/${c.id}/direcciones/${d2.json.id}`)).status, 200);
  const despues = (await api('mostrador', 'GET', `/api/clientes/${c.id}/direcciones`)).json;
  assert.equal(despues.length, 1);
  assert.equal(despues[0].principal, true); // la que quedó pasa a ser la principal
  tienda = { id: c.id, dir: d1.json.id };
});
let tienda;

test('pedidos fijos: se crean, se generan una sola vez por día con precio de mayoreo y respetan los días', async () => {
  const f = await fechaLocal(2);
  const dow = (await pool.query('SELECT EXTRACT(DOW FROM $1::date)::int AS d', [f])).rows[0].d;
  const otroDia = (dow + 1) % 7;
  const cuerpo = { cliente_id: tienda.id, direccion_id: tienda.dir, nombre: 'Pedido semanal', dias: [dow], hora: '07:30', tipo: 'domicilio', pago_modo: 'credito', zona_id: zona1,
    repartidor_id: U.luis, items: [{ producto_id: quesoId, cantidad: 10 }, { producto_id: cremaId, cantidad: 12 }] };
  assert.equal((await api('mostrador', 'POST', '/api/pedidos/fijos', cuerpo)).status, 403);
  assert.equal((await api('dueno', 'POST', '/api/pedidos/fijos', { ...cuerpo, dias: [] })).status, 400);
  assert.equal((await api('dueno', 'POST', '/api/pedidos/fijos', { ...cuerpo, hora: '7:30' })).status, 400);
  assert.equal((await api('dueno', 'POST', '/api/pedidos/fijos', { ...cuerpo, items: [] })).status, 400);
  assert.equal((await api('dueno', 'POST', '/api/pedidos/fijos', { ...cuerpo, items: [{ producto_id: 99999, cantidad: 1 }] })).status, 400);
  const fijo = await api('dueno', 'POST', '/api/pedidos/fijos', cuerpo);
  assert.equal(fijo.status, 200, JSON.stringify(fijo.json));
  assert.equal(fijo.json.cliente_nombre, 'Tienda La Esperanza');
  assert.equal(fijo.json.items[0].nombre, 'Queso Oaxaca');
  const otro = await api('dueno', 'POST', '/api/pedidos/fijos', { ...cuerpo, nombre: 'Otro día', dias: [otroDia] });
  assert.equal(otro.status, 200);
  assert.equal((await api('mostrador', 'GET', '/api/pedidos/fijos')).json.length, 2);

  const g = await api('dueno', 'POST', '/api/pedidos/fijos/generar', { fecha: f });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal(g.json.creados, 1);
  assert.deepEqual(g.json.errores, []);
  const ped = (await api('mostrador', 'GET', `/api/pedidos?fecha=${f}`)).json.find((p) => p.pedido_fijo_id === fijo.json.id);
  assert.ok(ped, 'se generó el pedido');
  assert.equal(ped.origen, 'fijo');
  assert.equal(ped.estado, 'programado');
  assert.equal(ped.programado_para, f + 'T07:30');
  assert.equal(ped.repartidor_id, U.luis);
  assert.equal(ped.nombre_contacto, 'Tienda La Esperanza');
  const det = await api('mostrador', 'GET', `/api/pedidos/${ped.id}`);
  // mayoreo: queso $170 x 10 = 1700 y crema $10 x 12 = 120; envío gratis (>= $500)
  assert.equal(det.json.items.find((i) => i.nombre_producto === 'Queso Oaxaca').precio_unitario, 170);
  assert.equal(det.json.items.find((i) => i.nombre_producto === 'Crema 200ml').precio_unitario, 10);
  assert.equal(det.json.total_neto, 1820);
  assert.equal(det.json.costo_envio, 0);
  // segunda vez el mismo día: no duplica
  const g2 = await api('dueno', 'POST', '/api/pedidos/fijos/generar', { fecha: f });
  assert.equal(g2.json.creados, 0);
  assert.equal(g2.json.omitidos, 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM pedidos WHERE pedido_fijo_id = $1', [fijo.json.id])).rows[0].n, 1);
  // fechas absurdas
  assert.equal((await api('dueno', 'POST', '/api/pedidos/fijos/generar', { fecha: await fechaLocal(60) })).status, 400);
  assert.equal((await api('dueno', 'POST', '/api/pedidos/fijos/generar', { fecha: 'hoy' })).status, 400);
  // editar y quitar
  const ed = await api('dueno', 'PUT', `/api/pedidos/fijos/${fijo.json.id}`, { ...cuerpo, hora: '08:00' });
  assert.equal(ed.json.hora, '08:00');
  assert.equal((await api('dueno', 'DELETE', `/api/pedidos/fijos/${otro.json.id}`)).status, 200);
  assert.equal((await api('mostrador', 'GET', '/api/pedidos/fijos')).json.length, 1);
  // pausar: no sale en la lista normal, sí con ?todos=1, y se puede reanudar
  const pausa = await api('dueno', 'PUT', `/api/pedidos/fijos/${fijo.json.id}`, { ...cuerpo, hora: '08:00', activo: false });
  assert.equal(pausa.json.activo, false);
  assert.equal((await api('mostrador', 'GET', '/api/pedidos/fijos')).json.length, 0);
  assert.equal((await api('mostrador', 'GET', '/api/pedidos/fijos?todos=1')).json.length, 1);
  assert.equal((await api('dueno', 'PUT', `/api/pedidos/fijos/${fijo.json.id}`, { ...cuerpo, hora: '08:00', activo: true })).json.activo, true);
  assert.equal((await api('mostrador', 'GET', '/api/pedidos/fijos')).json.length, 1);
  await api('dueno', 'POST', `/api/pedidos/${ped.id}/estado`, { estado: 'cancelado' });
  // cancelado: el generador no lo vuelve a crear ese día
  assert.equal((await api('dueno', 'POST', '/api/pedidos/fijos/generar', { fecha: f })).json.creados, 0);
});

test('generador automático: un fijo nuevo cuya hora de hoy ya pasó empieza mañana, no hoy', async () => {
  const { generarFijosDelDia } = require('../routes/pedidos');
  const hoy = await fechaLocal(0);
  const dow = (await pool.query('SELECT EXTRACT(DOW FROM $1::date)::int AS d', [hoy])).rows[0].d;
  const horas = (await pool.query(`SELECT to_char(NOW() AT TIME ZONE 'America/Mexico_City' - INTERVAL '2 hours', 'HH24:MI') AS pasada, to_char(NOW() AT TIME ZONE 'America/Mexico_City', 'HH24:MI') AS ahora`)).rows[0];
  if (horas.pasada > horas.ahora) return; // son menos de las 2 am: "hace 2 horas" cae ayer, se omite esta prueba por ahora
  const fijo = await api('dueno', 'POST', '/api/pedidos/fijos', { cliente_id: tienda.id, nombre: 'Nuevo hoy', dias: [dow], hora: horas.pasada, tipo: 'recoger', pago_modo: 'credito', items: [{ producto_id: cremaId, cantidad: 5 }] });
  assert.equal(fijo.status, 200, JSON.stringify(fijo.json));
  const auto = await generarFijosDelDia(null, sucursalId, hoy, { omitirNuevosYaPasados: true }); // lo que hace el temporizador
  assert.equal(auto.creados, 0);
  const manual = await generarFijosDelDia(null, sucursalId, hoy); // generar a mano sí lo crea
  assert.equal(manual.creados, 1);
  assert.deepEqual(manual.errores, []);
  const p = (await api('mostrador', 'GET', '/api/pedidos?fecha=' + hoy)).json.find((x) => x.pedido_fijo_id === fijo.json.id);
  assert.equal(p.estado, 'preparando'); // su hora ya pasó: nace listo para preparar
  assert.equal(p.tipo, 'recoger');
  await api('dueno', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'cancelado' });
  await api('dueno', 'DELETE', `/api/pedidos/fijos/${fijo.json.id}`);
});

// ---------------------------------------------------------------- reporte
test('reporte de repartidores: entregas, envíos, tiempos y diferencias de liquidación', async () => {
  const hoy = await fechaLocal(0);
  assert.equal((await api('cajera', 'GET', `/api/pedidos/reporte-repartidores?desde=${hoy}&hasta=${hoy}`)).status, 403);
  assert.equal((await api('dueno', 'GET', '/api/pedidos/reporte-repartidores')).status, 400);
  const r = await api('dueno', 'GET', `/api/pedidos/reporte-repartidores?desde=${hoy}&hasta=${hoy}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const luis = r.json.find((x) => x.repartidor_id === U.luis);
  assert.ok(luis.entregas >= 4);
  assert.equal(luis.no_entregadas, 0);
  assert.ok(luis.envios >= 50);
  assert.equal(luis.diferencia, -3);
  assert.ok(luis.liquidaciones >= 1);
});

test('aviso al cliente: se marca que ya se avisó por WhatsApp', async () => {
  const p = (await api('mostrador', 'POST', '/api/pedidos', { tipo: 'recoger', nombre_contacto: 'Aviso', telefono: '3300009999', pago_modo: 'pagado', items: [crema(1)] })).json;
  assert.equal(p.aviso_camino_en, null);
  const a = await api('mostrador', 'POST', `/api/pedidos/${p.id}/avisado`);
  assert.ok(a.json.aviso_camino_en);
  assert.equal((await api('mostrador', 'POST', '/api/pedidos/99999/avisado')).status, 404);
  await api('dueno', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'cancelado' });
});

test('los pedidos de otra sucursal no se ven ni se tocan', async () => {
  const s2 = (await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Otra', true) RETURNING id")).rows[0].id;
  const id = (await pool.query("INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,'Gerente 2','g2','x','gerente',true) RETURNING id", [s2])).rows[0].id;
  T.g2 = jwt.sign({ id, nombre: 'Gerente 2', usuario: 'g2', rol: 'gerente', sucursal_id: s2, permisos: {} }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await api('g2', 'GET', `/api/pedidos/${ped1.id}`)).status, 404);
  assert.equal((await api('g2', 'POST', `/api/pedidos/${ped1.id}/estado`, { estado: 'cancelado' })).status, 404);
  assert.equal((await api('g2', 'GET', '/api/pedidos')).json.length, 0);
  assert.equal((await api('g2', 'PUT', `/api/pedidos/zonas/${zona1}`, { nombre: 'Hack', costo: 1 })).status, 404);
  assert.equal((await api('g2', 'POST', '/api/pedidos', { tipo: 'domicilio', nombre_contacto: 'Z', direccion: direccion(), zona_id: zona1, items: [queso()] })).status, 400); // la zona es de otra sucursal
});

// ---------------------------------------------------------------- Mostrador: aceptar el pedido que se envió a preparar
test('Mostrador: un pedido nuevo sale sin aceptar; al aceptarlo queda quién lo tomó y no se pisa', async () => {
  const p = (await api('cajera', 'POST', '/api/pedidos', { tipo: 'recoger', nombre_contacto: 'Acepta Uno', telefono: '3311110000', pago_modo: 'pagado', items: [queso(0.5), crema(2)] })).json;
  assert.equal(p.estado, 'preparando');
  assert.equal(p.aceptado_en, null);
  assert.equal(p.aceptado_por_nombre, null);
  // la lista que usa Mostrador (preparando + listos) lo trae, sin aceptar
  const lista = await api('mostrador', 'GET', '/api/pedidos?estado=preparando,listo&limit=200');
  const enLista = lista.json.find((x) => x.id === p.id);
  assert.ok(enLista && !enLista.aceptado_en);

  const a = await api('mostrador', 'POST', `/api/pedidos/${p.id}/aceptar`, {});
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.estado, 'preparando');
  assert.ok(a.json.aceptado_en);
  assert.equal(a.json.aceptado_por_nombre, 'Mostrador');
  assert.equal(a.json.items.filter((i) => !i.es_envio).length, 2); // trae los productos para la ventana de preparar

  // otra persona lo acepta después: se conserva quién lo tomó primero
  const b = await api('cajera', 'POST', `/api/pedidos/${p.id}/aceptar`, {});
  assert.equal(b.status, 200);
  assert.equal(b.json.aceptado_por_nombre, 'Mostrador');
  assert.equal(b.json.aceptado_en, a.json.aceptado_en);

  const bit = await pool.query("SELECT 1 FROM bitacora WHERE accion = 'pedido_aceptado' AND referencia_id = $1", [p.id]);
  assert.ok(bit.rows.length >= 1);

  // listo desde Mostrador; ya no se puede "aceptar"
  assert.equal((await api('mostrador', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'listo' })).json.estado, 'listo');
  const tarde = await api('mostrador', 'POST', `/api/pedidos/${p.id}/aceptar`, {});
  assert.equal(tarde.status, 409);
  assert.match(tarde.json.error, /listo/);

  // si se reabre la preparación, vuelve a salir como NUEVO (hay que volver a aceptarlo)
  const re = await api('dueno', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'preparando' });
  assert.equal(re.json.estado, 'preparando');
  assert.equal(re.json.aceptado_en, null);
  assert.equal(re.json.aceptado_por_nombre, null);
  await api('dueno', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'cancelado' });
});

test('Mostrador: aceptar pide permiso, no existe en otra sucursal y no sirve para un pedido cancelado', async () => {
  const p = (await api('mostrador', 'POST', '/api/pedidos', { tipo: 'recoger', nombre_contacto: 'Acepta Dos', telefono: '3322220000', pago_modo: 'pagado', items: [crema(1)] })).json;
  assert.equal((await api('luis', 'POST', `/api/pedidos/${p.id}/aceptar`, {})).status, 403);          // el repartidor no
  assert.equal((await api('mostrador', 'POST', '/api/pedidos/99999/aceptar', {})).status, 404);
  if (T.g2) assert.equal((await api('g2', 'POST', `/api/pedidos/${p.id}/aceptar`, {})).status, 404);   // otra sucursal
  await api('dueno', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'cancelado' });
  assert.equal((await api('mostrador', 'POST', `/api/pedidos/${p.id}/aceptar`, {})).status, 409);
});

test('Mostrador: un pedido programado entra a la lista de preparar cuando llega su hora', async () => {
  const dentroDe = await enMinutos(5); // se prepara 30 min antes: ya toca prepararlo
  const p = (await api('mostrador', 'POST', '/api/pedidos', { tipo: 'recoger', nombre_contacto: 'Programado Hoy', telefono: '3344440000', pago_modo: 'pagado', programado_para: dentroDe, items: [crema(1)] })).json;
  assert.equal(p.estado, 'preparando');
  const lista = await api('mostrador', 'GET', '/api/pedidos?estado=preparando,listo&limit=200');
  const x = lista.json.find((q) => q.id === p.id);
  assert.ok(x && !x.aceptado_en && x.programado_para === dentroDe);
  await api('dueno', 'POST', `/api/pedidos/${p.id}/estado`, { estado: 'cancelado' });
});
