// Pruebas (sin base de datos) de los datos del negocio y del código de solicitud.
const test = require('node:test');
const assert = require('node:assert/strict');
const sol = require('../utils/licenciaSolicitud');

const DATOS = {
  negocio: 'Cremería La Vaquita', giro: 'Cremería y salchichonería', nombre_dueno: 'Juan Pérez',
  telefono: '33 1597 0412', whatsapp: '33 2590 7090', email: 'JUAN@Correo.com',
  direccion: 'Av. Siempre Viva 123', ciudad: 'Guadalajara', estado: 'Jalisco', cp: '44100',
  rfc: ' xaxx010101000 ', razon_social: 'Juan Pérez SA de CV', cp_fiscal: '44100', email_factura: 'facturas@correo.com'
};
const ID = '8MM7-DE86-3CX7';

function armar(extra = {}) {
  const n = sol.normalizarDatos(DATOS, { contratar: true });
  assert.ok(n.ok, JSON.stringify(n.errores));
  return sol.construirCodigo({
    tipo: 'contratar', plan: 'nube', sucursales: 2, idEquipo: ID, datos: n.datos,
    nota: 'Necesito factura', fecha: '2026-10-16', app: '1.0.0', pruebaDiasRestantes: 12, ...extra
  });
}

test('normalizar: limpia espacios, pone mayúsculas al RFC y minúsculas al correo', () => {
  const r = sol.normalizarDatos(DATOS, { contratar: true });
  assert.equal(r.ok, true);
  assert.equal(r.datos.rfc, 'XAXX010101000');
  assert.equal(r.datos.email, 'juan@correo.com');
  assert.equal(r.datos.negocio, 'Cremería La Vaquita');
});

test('normalizar: quita saltos de línea (no se puede meter un renglón nuevo en los datos)', () => {
  const r = sol.normalizarDatos({ negocio: 'Mi\r\nnegocio raro', nombre_dueno: 'A\nB', whatsapp: '3312345678' }, { contratar: true });
  assert.equal(r.datos.negocio, 'Mi negocio raro');
  assert.equal(r.datos.nombre_dueno, 'A B');
});

test('normalizar: recorta lo que se pasa del largo permitido', () => {
  const r = sol.normalizarDatos({ negocio: 'x'.repeat(200) });
  assert.equal(r.datos.negocio.length, 60);
});

test('normalizar: avisa qué campo está mal, en español', () => {
  const r = sol.normalizarDatos({ negocio: '', whatsapp: '123', email: 'no-es-correo', rfc: 'ABC', cp: '4410', sucursales: 0 }, { contratar: true });
  assert.equal(r.ok, false);
  for (const c of ['negocio', 'nombre_dueno', 'whatsapp', 'email', 'rfc', 'cp', 'sucursales']) assert.ok(r.errores[c], 'falta error de ' + c);
  assert.match(r.errores.whatsapp, /lada/);
});

test('normalizar: para guardar solo se pide el nombre del negocio; para contratar también nombre y teléfono', () => {
  assert.equal(sol.normalizarDatos({ negocio: 'Mi tienda' }).ok, true);
  const r = sol.normalizarDatos({ negocio: 'Mi tienda' }, { contratar: true });
  assert.equal(r.ok, false);
  assert.ok(r.errores.nombre_dueno && r.errores.whatsapp);
  // con teléfono (sin WhatsApp) también vale
  assert.equal(sol.normalizarDatos({ negocio: 'Mi tienda', nombre_dueno: 'Ana', telefono: '3312345678' }, { contratar: true }).ok, true);
});

test('datosCompletos: negocio + nombre + (teléfono o WhatsApp)', () => {
  assert.equal(sol.datosCompletos({ negocio: 'A', nombre_dueno: 'B', telefono: '3312345678' }), true);
  assert.equal(sol.datosCompletos({ negocio: 'A', nombre_dueno: 'B' }), false);
  assert.equal(sol.datosCompletos(null), false);
});

test('código de solicitud: se arma y se lee igual', () => {
  const codigo = armar();
  assert.match(codigo, /^CPT-REQ-[A-Za-z0-9_-]+\.[0-9A-F]{4}$/);
  const r = sol.leerCodigo(codigo);
  assert.equal(r.ok, true);
  assert.equal(r.datos.v, 1);
  assert.equal(r.datos.tipo, 'contratar');
  assert.equal(r.datos.plan, 'nube');
  assert.equal(r.datos.sucursales, 2);
  assert.equal(r.datos.id_equipo, ID);
  assert.equal(r.datos.fecha, '2026-10-16');
  assert.equal(r.datos.prueba_dias_restantes, 12);
  assert.equal(r.datos.nota, 'Necesito factura');
  assert.equal(r.datos.negocio.negocio, 'Cremería La Vaquita');
  assert.equal(r.datos.negocio.rfc, 'XAXX010101000');
  assert.equal(r.datos.negocio.email, 'juan@correo.com');
  assert.ok(codigo.length < 800, 'debe ser corto para WhatsApp (largo ' + codigo.length + ')');
});

test('código de solicitud: renovar y plan sin nube', () => {
  const r = sol.leerCodigo(armar({ tipo: 'renovar', plan: 'local', pruebaDiasRestantes: null }));
  assert.equal(r.datos.tipo, 'renovar');
  assert.equal(r.datos.plan, 'local');
  assert.equal(r.datos.prueba_dias_restantes, undefined);
});

test('código de solicitud: acepta texto alrededor, saltos de línea y espacios', () => {
  const codigo = armar();
  const partido = codigo.match(/.{1,40}/g).join('\n  ');
  const r = sol.leerCodigo(`Hola, aquí va:\n${partido}\n\nGracias!!`);
  assert.equal(r.ok, true);
  assert.equal(r.datos.id_equipo, ID);
});

test('código de solicitud: detecta un código cortado o con un caracter cambiado', () => {
  const codigo = armar();
  assert.equal(sol.leerCodigo('nada de nada').motivo, 'prefijo');
  assert.equal(sol.leerCodigo(codigo.slice(0, -10)).ok, false);
  const i = 30;
  const malo = codigo.slice(0, i) + (codigo[i] === 'A' ? 'B' : 'A') + codigo.slice(i + 1);
  const r = sol.leerCodigo(malo);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'control');
});

test('mensaje de WhatsApp: resume al cliente y termina con el código completo', () => {
  const n = sol.normalizarDatos(DATOS, { contratar: true });
  const codigo = armar();
  const m = sol.mensajeWhatsApp({ tipo: 'contratar', plan: 'nube', sucursales: 2, idEquipo: ID, datos: n.datos, codigo });
  assert.match(m, /quiero contratar Compoint Punto/);
  assert.match(m, /Negocio: Cremería La Vaquita/);
  assert.match(m, /Plan: Con nube · 2 sucursales/);
  assert.match(m, new RegExp('ID de equipo: ' + ID));
  assert.ok(m.endsWith(codigo));
  assert.match(sol.mensajeWhatsApp({ tipo: 'renovar', plan: 'local', sucursales: 1, idEquipo: ID, datos: n.datos, codigo }), /quiero renovar[\s\S]*Sin nube · Renovación de actualizaciones y soporte \(\$990\) · 1 sucursal\n/);
});

test('texto completo (para copiar o guardar en archivo): trae todos los datos y el código', () => {
  const n = sol.normalizarDatos(DATOS, { contratar: true });
  const codigo = armar();
  const t = sol.textoCompleto({ tipo: 'contratar', plan: 'nube', sucursales: 2, idEquipo: ID, datos: n.datos, nota: 'Necesito factura', fecha: '2026-10-16', codigo });
  for (const frag of ['SOLICITUD PARA CONTRATAR', 'Con servicio en la nube', 'Cremería La Vaquita', 'Juan Pérez', 'XAXX010101000', 'Av. Siempre Viva 123, Guadalajara, Jalisco, C.P. 44100', 'Necesito factura', codigo]) {
    assert.ok(t.includes(frag), 'falta: ' + frag);
  }
});

// Un código fijo, para que el Activador (programa en Go) compruebe que lo lee igual que este sistema.
// Solo se usa para LEER (el resultado de comprimir puede variar entre versiones de zlib, leer no).
const EJEMPLO = 'CPT-REQ-VVHRSiQxEPyVUM_ZZWbW29U83aJycJxyIMi-Db2ZXo3MJGMnWUHxg-7Br_DHJLOKt-SlSXVVV3W_YA9TayQ3BhjY4JNQIoHG2JOHgc9bhkbMNkukniNMo-G6lh_zgXR6dbWaXVyeLmeL880KGju29wSDpmqWs7qa1UtoeL4L1gWYl-8S58IDy_sbqT-kbukxu0TQuHNyhBZ6GLbCbZfZF-h3Jq_-vv8TfobG0z2lSOMIg8VCNT_OKrWqzipo8ECuh8FDJv_TBhEOcxsGaHRO2FoXSsb1fq5uHA-jsLp1e1J1s4CGdbmjDga_MnXU0wNJscIxUTeZoN5FG0pnGX1yUldlpuwsDDbrzaaqp3f4pefg2xiso_44gLpZTxLtzkU7gV9Kk_t2RzZlKQv9rOL_SV41DsnreTUvpFEyb6ntHMVWilefytHqpiwxFZlrthxdCupL-fUD.8918';
test('ejemplo fijo: el código de muestra (el mismo que debe leer el Activador) se lee bien', () => {
  const r = sol.leerCodigo(EJEMPLO);
  assert.equal(r.ok, true);
  assert.equal(r.datos.id_equipo, '8MM7-DE86-3CX7');
  assert.equal(r.datos.plan, 'nube');
  assert.equal(r.datos.sucursales, 2);
  assert.equal(r.datos.prueba_dias_restantes, 12);
  assert.equal(r.datos.negocio.negocio, 'Cremería La Vaquita');
  assert.equal(r.datos.negocio.razon_social, 'Juan Pérez SA');
  assert.equal(r.datos.nota, 'Necesito factura');
});
