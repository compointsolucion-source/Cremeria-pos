// Pruebas con base de datos REAL: datos del negocio, bienvenida del demo y solicitud de licencia
// (con un "solicitud.php" falso que se puede apagar, para probar el reintento sin internet).
// Necesitan una base VACÍA de pruebas (se borra todo lo que tenga):
//   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/prueba" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('solicitud de licencia con base de datos: omitidas (falta TEST_DATABASE_URL)', { skip: 'define TEST_DATABASE_URL para correrlas' }, () => {});
  return;
}

process.env.DATABASE_URL = URL_BD;
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'prueba-solicitud-0123456789abcdef';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.COMPOINT_ID_EQUIPO;
delete process.env.COMPOINT_MARCAS;
delete process.env.FRONTEND_DIR;

const bcrypt = require('bcryptjs');
const lic = require('../utils/licencia');
const sol = require('../utils/licenciaSolicitud');
const envio = require('../utils/licenciaEnvio');
const pool = require('../db');

let base, servidor, falso, modo = 'ok', recibidas = [];
let tokenDueno, tokenCajero, tokenGerente, sucursalId;

const reloj = (fecha) => lic._fijarReloj(() => new Date(fecha + 'T18:00:00Z'));
async function api(metodo, ruta, cuerpo, token) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
  return { status: r.status, json };
}
async function entrar(usuario) {
  const r = await api('POST', '/api/auth/login', { usuario, password: 'Clave-Prueba-1' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.token;
}
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function hasta(fn, ms = 4000) {
  const fin = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > fin) throw new Error('se agotó la espera');
    await esperar(50);
  }
}

const DATOS = {
  negocio: 'Cremería La Vaquita', giro: 'Cremería', nombre_dueno: 'Juan Pérez', whatsapp: '33 2590 7090',
  email: 'juan@correo.com', direccion: 'Av. Siempre Viva 123', ciudad: 'Guadalajara', estado: 'Jalisco', cp: '44100',
  rfc: 'XAXX010101000', razon_social: 'Juan Pérez SA', cp_fiscal: '44100', email_factura: 'facturas@correo.com'
};
const pedir = (cambios = {}, token) => api('POST', '/api/licencia/solicitud', { plan: 'nube', sucursales: 2, acepto_privacidad: true, nota: 'Necesito factura', datos: DATOS, ...cambios }, token || tokenDueno);
const ultima = async () => (await pool.query('SELECT * FROM licencia_solicitud ORDER BY id DESC LIMIT 1')).rows[0];
const limpiarSolicitudes = async () => { await pool.query('DELETE FROM licencia_solicitud'); recibidas = []; modo = 'ok'; };
const ponerDemo = async () => {
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2026-10-10', '2026-11-09', 'demo', 'nube')");
  lic.invalidarCache();
};

test.before(async () => {
  // "solicitud.php" falso
  falso = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      if (modo === 'caido') { req.socket.destroy(); return; }
      const codigo = { '404': 404, '503': 503, '400': 400, '429': 429 }[modo];
      if (codigo) { res.writeHead(codigo, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Dato no válido (prueba)' })); return; }
      try { recibidas.push(JSON.parse(cuerpo)); } catch (e) { recibidas.push({ crudo: cuerpo }); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((ok) => falso.listen(0, '127.0.0.1', ok));
  process.env.COMPOINT_SOLICITUD_URL = 'http://127.0.0.1:' + falso.address().port + '/solicitud.php';

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
  const suc = await pool.query("INSERT INTO sucursales (nombre, activo) VALUES ('Matriz', true) RETURNING id");
  sucursalId = suc.rows[0].id;
  await pool.query('INSERT INTO configuracion (sucursal_id) VALUES ($1)', [sucursalId]);
  const hash = await bcrypt.hash('Clave-Prueba-1', 4);
  for (const [nombre, usuario, rol] of [['Dueño', 'dueno', 'dueno'], ['Cajera', 'cajera', 'cajero'], ['Gerente', 'gerente', 'gerente']]) {
    await pool.query('INSERT INTO usuarios (sucursal_id, nombre, usuario, password_hash, rol, activo) VALUES ($1,$2,$3,$4,$5,true)', [sucursalId, nombre, usuario, hash, rol]);
  }
  tokenDueno = await entrar('dueno');
  tokenCajero = await entrar('cajera');
  tokenGerente = await entrar('gerente');
  reloj('2026-10-16');
});

test.after(async () => {
  envio.detenerReintentos();
  await new Promise((ok) => { servidor.close(() => ok()); setTimeout(ok, 2000); });
  await new Promise((ok) => { falso.close(() => ok()); setTimeout(ok, 1000); });
  await pool.end().catch(() => {});
});

test('la migración 008 crea las tablas y no se copian al espejo en la nube', async () => {
  const t = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  const nombres = t.rows.map((r) => r.table_name);
  assert.ok(nombres.includes('datos_negocio') && nombres.includes('licencia_solicitud'));
  for (const archivo of ['../routes/sync.js', '../../escritorio/src/servidor/sync.js']) {
    const ruta = path.join(__dirname, archivo);
    if (!fs.existsSync(ruta)) continue; // el backend solo (sin la carpeta escritorio) también debe poder probarse
    const texto = fs.readFileSync(ruta, 'utf8');
    const m = /EXCLUIDAS = new Set\(\[([^\]]*)\]/.exec(texto);
    assert.ok(m, archivo);
    for (const tabla of ['datos_negocio', 'licencia_solicitud', 'licencia', 'instalacion']) assert.ok(m[1].includes("'" + tabla + "'"), `${tabla} en ${archivo}`);
  }
});

test('datos del negocio: solo dueño, jefe y gerente (el cajero no)', async () => {
  assert.equal((await api('GET', '/api/licencia/datos', null, tokenCajero)).status, 403);
  assert.equal((await api('PUT', '/api/licencia/datos', { datos: DATOS }, tokenCajero)).status, 403);
  assert.equal((await pedir({}, tokenCajero)).status, 403);
  assert.equal((await api('GET', '/api/licencia/datos', null, tokenGerente)).status, 200);
});

test('datos del negocio: vacío al principio, y sin demo no hay bienvenida', async () => {
  await pool.query('DELETE FROM licencia'); lic.invalidarCache();
  const r = await api('GET', '/api/licencia/datos', null, tokenDueno);
  assert.equal(r.status, 200);
  assert.equal(r.json.completado, false);
  assert.equal(r.json.datos.negocio, '');
  assert.equal(r.json.mostrar_bienvenida, false); // la nube propia no tiene prueba
  assert.equal(r.json.sugerencias.sucursales, 1);  // lo que ya sabe el sistema
});

test('datos del negocio: se validan y se guardan', async () => {
  const mal = await api('PUT', '/api/licencia/datos', { datos: { ...DATOS, email: 'no-es-correo' } }, tokenDueno);
  assert.equal(mal.status, 400);
  assert.ok(mal.json.campos.email);
  const sinNombre = await api('PUT', '/api/licencia/datos', { datos: { negocio: '' } }, tokenDueno);
  assert.equal(sinNombre.status, 400);

  const ok = await api('PUT', '/api/licencia/datos', { datos: DATOS }, tokenDueno);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.completado, true);
  const leer = await api('GET', '/api/licencia/datos', null, tokenDueno);
  assert.equal(leer.json.datos.negocio, 'Cremería La Vaquita');
  assert.equal(leer.json.datos.rfc, 'XAXX010101000');
  assert.equal(leer.json.completado, true);

  // con solo el nombre del negocio se guarda pero todavía no está "completo"
  const poco = await api('PUT', '/api/licencia/datos', { datos: { negocio: 'Solo nombre' } }, tokenDueno);
  assert.equal(poco.status, 200);
  assert.equal(poco.json.completado, false);
  await api('PUT', '/api/licencia/datos', { datos: DATOS }, tokenDueno);
});

test('datos del negocio: llenan el encabezado del ticket solo donde estaba vacío', async () => {
  await pool.query("UPDATE configuracion SET nombre_negocio = NULL, direccion = NULL, telefono = NULL, rfc = NULL WHERE sucursal_id = $1", [sucursalId]);
  const r1 = await api('PUT', '/api/licencia/datos', { datos: DATOS, aplicar_ticket: true }, tokenDueno);
  assert.deepEqual(r1.json.ticket_aplicado.sort(), ['direccion', 'nombre_negocio', 'rfc', 'telefono']);
  const c = (await pool.query('SELECT nombre_negocio, direccion, telefono, rfc FROM configuracion WHERE sucursal_id = $1', [sucursalId])).rows[0];
  assert.equal(c.nombre_negocio, 'Cremería La Vaquita');
  assert.equal(c.direccion, 'Av. Siempre Viva 123, Guadalajara, Jalisco');
  assert.equal(c.telefono, '33 2590 7090');
  assert.equal(c.rfc, 'XAXX010101000');

  // si ya tenían algo, NO se pisa
  await pool.query("UPDATE configuracion SET nombre_negocio = 'Mi nombre ya puesto', telefono = '555' WHERE sucursal_id = $1", [sucursalId]);
  const r2 = await api('PUT', '/api/licencia/datos', { datos: { ...DATOS, negocio: 'Otro nombre' }, aplicar_ticket: true }, tokenDueno);
  assert.deepEqual(r2.json.ticket_aplicado, []);
  const c2 = (await pool.query('SELECT nombre_negocio, telefono FROM configuracion WHERE sucursal_id = $1', [sucursalId])).rows[0];
  assert.deepEqual([c2.nombre_negocio, c2.telefono], ['Mi nombre ya puesto', '555']);

  // sin la casilla, no se toca el ticket
  await pool.query('UPDATE configuracion SET direccion = NULL WHERE sucursal_id = $1', [sucursalId]);
  const r3 = await api('PUT', '/api/licencia/datos', { datos: DATOS }, tokenDueno);
  assert.deepEqual(r3.json.ticket_aplicado, []);
  assert.equal((await pool.query('SELECT direccion FROM configuracion WHERE sucursal_id = $1', [sucursalId])).rows[0].direccion, null);
});

test('bienvenida del demo: aparece mientras faltan los datos y "más tarde" la pospone 2 días', async () => {
  await pool.query('DELETE FROM datos_negocio');
  await ponerDemo();
  reloj('2026-10-16');
  const a = await api('GET', '/api/licencia/datos', null, tokenDueno);
  assert.equal(a.json.mostrar_bienvenida, true);
  assert.equal(a.json.dias_prueba, 24);

  assert.equal((await api('POST', '/api/licencia/datos/despues', {}, tokenDueno)).status, 200);
  assert.equal((await api('GET', '/api/licencia/datos', null, tokenDueno)).json.mostrar_bienvenida, false);
  reloj('2026-10-17');
  assert.equal((await api('GET', '/api/licencia/datos', null, tokenDueno)).json.mostrar_bienvenida, false);
  reloj('2026-10-18');
  assert.equal((await api('GET', '/api/licencia/datos', null, tokenDueno)).json.mostrar_bienvenida, true);

  // al capturar los datos completos, ya no vuelve a salir
  await api('PUT', '/api/licencia/datos', { datos: DATOS }, tokenDueno);
  assert.equal((await api('GET', '/api/licencia/datos', null, tokenDueno)).json.mostrar_bienvenida, false);
  reloj('2026-10-16');
});

test('solicitud: pide lo necesario antes de armar nada', async () => {
  await ponerDemo();
  const sinPlan = await pedir({ plan: undefined });
  assert.equal(sinPlan.status, 400);
  assert.match(sinPlan.json.error, /plan/i);
  const sinAviso = await pedir({ acepto_privacidad: false });
  assert.equal(sinAviso.status, 400);
  assert.match(sinAviso.json.error, /privacidad/i);
  const sinTel = await pedir({ datos: { ...DATOS, telefono: '', whatsapp: '' } });
  assert.equal(sinTel.status, 400);
  assert.ok(sinTel.json.campos.whatsapp);
  const malSuc = await pedir({ sucursales: 99 });
  assert.equal(malSuc.status, 400);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM licencia_solicitud')).rows[0].n, 0, 'no debe guardar nada si algo falla');
});

test('solicitud: se guarda, se arma el código y se manda al servicio de Compoint', async () => {
  await limpiarSolicitudes(); await ponerDemo(); reloj('2026-10-16');
  const r = await pedir();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = r.json.solicitud;
  assert.equal(s.estado, 'pendiente'); // la respuesta es inmediata; el envío va aparte
  assert.equal(s.tipo, 'contratar');
  assert.equal(s.correo_destino, 'contacto@compoint.com.mx');

  const lectura = sol.leerCodigo(s.codigo);
  assert.equal(lectura.ok, true);
  const est = await lic.estado();
  assert.equal(lectura.datos.id_equipo, est.id_equipo);
  assert.equal(lectura.datos.plan, 'nube');
  assert.equal(lectura.datos.sucursales, 2);
  assert.equal(lectura.datos.prueba_dias_restantes, 24);
  assert.equal(lectura.datos.negocio.negocio, 'Cremería La Vaquita');
  assert.equal(lectura.datos.nota, 'Necesito factura');

  // WhatsApp y texto para copiar
  assert.ok(s.whatsapp_url.startsWith('https://wa.me/523325907090?text='));
  assert.ok(decodeURIComponent(s.whatsapp_url).includes(s.codigo));
  assert.ok(s.texto_completo.includes('Cremería La Vaquita') && s.texto_completo.includes(s.codigo));

  // el envío ocurre solo
  const enviada = await hasta(async () => { const f = await ultima(); return f.estado === 'enviada' ? f : null; });
  assert.equal(enviada.intentos, 1);
  assert.equal(recibidas.length, 1);
  assert.equal(recibidas[0].web, '');
  assert.equal(recibidas[0].codigo, s.codigo);
  assert.equal(recibidas[0].origen, 'nube');
  assert.equal(recibidas[0].id_equipo, est.id_equipo);

  const g = await api('GET', '/api/licencia/solicitud', null, tokenDueno);
  assert.equal(g.json.solicitud.estado, 'enviada');
  assert.equal(g.json.solicitud.codigo, s.codigo);

  // los datos quedaron guardados y se registró que aceptó el aviso
  const d = (await pool.query('SELECT acepto_privacidad_en, version_aviso FROM datos_negocio WHERE id = 1')).rows[0];
  assert.ok(d.acepto_privacidad_en);
  assert.equal(d.version_aviso, sol.VERSION_AVISO);
  // la bitácora no guarda el código ni los datos del cliente
  const b = await pool.query("SELECT valor_nuevo FROM bitacora WHERE accion = 'licencia_solicitud' ORDER BY id DESC LIMIT 1");
  assert.ok(!JSON.stringify(b.rows[0].valor_nuevo).includes('CPT-REQ'));
  assert.ok(!JSON.stringify(b.rows[0].valor_nuevo).includes('Vaquita'));
});

test('sin internet: la solicitud queda pendiente y se manda sola al volver (una sola vez)', async () => {
  await limpiarSolicitudes(); await ponerDemo();
  modo = 'caido';
  const r = await pedir();
  assert.equal(r.status, 200);
  const pendiente = await hasta(async () => { const f = await ultima(); return f.intentos >= 1 ? f : null; });
  assert.equal(pendiente.estado, 'pendiente');
  assert.match(pendiente.ultimo_error, /conexi/i);
  assert.equal(recibidas.length, 0);
  const g = await api('GET', '/api/licencia/solicitud', null, tokenDueno);
  assert.equal(g.json.solicitud.estado, 'pendiente');
  assert.match(g.json.solicitud.error, /conexi/i);

  // todavía no toca reintentar (esperó menos de 10 minutos): no hace nada
  modo = 'ok';
  await envio.procesarPendientes();
  assert.equal(recibidas.length, 0);
  assert.equal((await ultima()).estado, 'pendiente');

  // vuelve el internet y pasa el tiempo de espera
  await pool.query("UPDATE licencia_solicitud SET ultimo_intento = NOW() - interval '11 minutes'");
  await envio.procesarPendientes();
  const f = await ultima();
  assert.equal(f.estado, 'enviada');
  assert.equal(f.ultimo_error, null);
  assert.equal(recibidas.length, 1);
  await envio.procesarPendientes({ forzar: true });
  assert.equal(recibidas.length, 1, 'una solicitud enviada no se vuelve a mandar');
});

test('si el servicio de Compoint no está instalado o está ocupado, se reintenta; si rechaza los datos, no', async () => {
  for (const [m, esperado] of [['404', 'pendiente'], ['503', 'pendiente'], ['429', 'pendiente'], ['400', 'rechazada']]) {
    await limpiarSolicitudes(); await ponerDemo();
    modo = m;
    assert.equal((await pedir()).status, 200);
    const f = await hasta(async () => { const x = await ultima(); return x.intentos >= 1 ? x : null; });
    assert.equal(f.estado, esperado, 'modo ' + m);
    assert.ok(f.ultimo_error);
  }
  // una rechazada no se reintenta
  modo = 'ok';
  await envio.procesarPendientes({ forzar: true });
  assert.equal(recibidas.length, 0);
  assert.equal((await ultima()).estado, 'rechazada');
});

test('el botón "Reintentar envío" manda lo pendiente de inmediato', async () => {
  await limpiarSolicitudes(); await ponerDemo();
  modo = '503';
  await pedir();
  await hasta(async () => (await ultima()).intentos >= 1);
  modo = 'ok';
  const r = await api('POST', '/api/licencia/solicitud/reintentar', {}, tokenDueno);
  assert.equal(r.status, 200);
  assert.equal(r.json.solicitud.estado, 'enviada');
  assert.equal(recibidas.length, 1);
});

test('una solicitud nueva reemplaza a la pendiente anterior', async () => {
  await limpiarSolicitudes(); await ponerDemo();
  modo = 'caido';
  await pedir({ plan: 'local' });
  await hasta(async () => (await ultima()).intentos >= 1);
  modo = 'ok';
  await pedir({ plan: 'nube' });
  await hasta(async () => (await ultima()).estado === 'enviada');
  const estados = (await pool.query('SELECT plan, estado FROM licencia_solicitud ORDER BY id')).rows;
  assert.deepEqual(estados, [{ plan: 'local', estado: 'reemplazada' }, { plan: 'nube', estado: 'enviada' }]);
  assert.equal(recibidas.length, 1);
  assert.equal(recibidas[0].plan, 'nube');
  assert.equal((await api('GET', '/api/licencia/solicitud', null, tokenDueno)).json.solicitud.plan, 'nube');
});

test('solicitudes muy viejas dejan de reintentarse', async () => {
  await limpiarSolicitudes(); await ponerDemo();
  modo = 'caido';
  await pedir();
  await hasta(async () => (await ultima()).intentos >= 1);
  await pool.query("UPDATE licencia_solicitud SET creada_en = NOW() - interval '15 days', ultimo_intento = NOW() - interval '1 day'");
  modo = 'ok';
  await envio.procesarPendientes();
  assert.equal((await ultima()).estado, 'vencida');
  assert.equal(recibidas.length, 0);
});

test('con licencia de pago es "renovar"; y aun en solo consulta se puede pedir y guardar datos', async () => {
  await limpiarSolicitudes();
  await pool.query('DELETE FROM licencia');
  await pool.query("INSERT INTO licencia (id, fecha_inicio, fecha_vencimiento, tipo, plan) VALUES (1, '2025-09-01', '2026-09-01', 'anual', 'nube')");
  lic.invalidarCache();
  reloj('2026-10-16');
  assert.equal((await lic.estado()).estado, 'solo_consulta');
  // una escritura cualquiera sí se bloquea...
  assert.equal((await api('PUT', '/api/configuracion', { terminos: 'x' }, tokenDueno)).status, 402);
  // ...pero esto no
  assert.equal((await api('PUT', '/api/licencia/datos', { datos: DATOS }, tokenDueno)).status, 200);
  const r = await pedir();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.solicitud.tipo, 'renovar');
  assert.match(decodeURIComponent(r.json.solicitud.whatsapp_url), /quiero renovar/);
  await hasta(async () => (await ultima()).estado === 'enviada');
  assert.equal(sol.leerCodigo(recibidas[0].codigo).datos.tipo, 'renovar');
  assert.equal(sol.leerCodigo(recibidas[0].codigo).datos.prueba_dias_restantes, undefined);
});
