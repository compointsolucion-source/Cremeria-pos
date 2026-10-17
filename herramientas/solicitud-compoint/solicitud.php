<?php
/**
 * Compoint Punto — recibe las solicitudes de licencia (contratar / renovar) y las manda
 * por correo a contacto@compoint.com.mx.
 *
 * Se sube al hosting (cPanel) en:  public_html/punto/solicitud.php
 * Dirección final:                 https://www.compoint.com.mx/punto/solicitud.php
 * (instrucciones paso a paso en LEEME.txt)
 *
 * Quién la llama: el SERVIDOR del sistema del cliente (no el navegador), con un POST en JSON.
 * Si el cliente no tiene internet, el sistema reintenta solo después; por eso esta página es
 * "idempotente": si le llega dos veces la misma solicitud, el correo se manda una sola vez.
 *
 * Protecciones: solo POST, tamaño máximo, campo trampa (honeypot), límite por IP y por día,
 * se lee TODO desde el código de solicitud (con su control), se limpia cada dato y se evita
 * la inyección de encabezados de correo. Guarda copia de cada solicitud en una carpeta
 * protegida por si el correo llegara a fallar.
 */
declare(strict_types=1);

// ------------------------------------------------------------------ configuración
const CORREO_DESTINO = 'contacto@compoint.com.mx';
// Debe ser un correo de TU dominio (si no, muchos servidores de correo lo mandan a spam).
const CORREO_ORIGEN = 'no-responder@compoint.com.mx';
const MAX_BYTES = 8192;               // tamaño máximo de lo que se acepta
const LIMITE_POR_IP_HORA = 10;        // solicitudes por IP en una hora
const LIMITE_GLOBAL_DIA = 300;        // solicitudes en total por día
const CARPETA_DATOS = __DIR__ . '/solicitudes-datos';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function responder(int $codigo, array $cuerpo): void
{
    http_response_code($codigo);
    echo json_encode($cuerpo, JSON_UNESCAPED_UNICODE);
    exit;
}

// Una sola línea, sin caracteres de control, con largo máximo (evita inyectar encabezados de correo).
function linea($valor, int $max = 120): string
{
    if (!is_scalar($valor)) {
        return '';
    }
    $t = preg_replace('/[\x00-\x1F\x7F\x{2028}\x{2029}]+/u', ' ', (string)$valor) ?? '';
    $t = trim(preg_replace('/\s+/u', ' ', $t) ?? '');
    return function_exists('mb_substr') ? mb_substr($t, 0, $max, 'UTF-8') : substr($t, 0, $max);
}

function base64url_decode(string $t): string
{
    $r = base64_decode(strtr($t, '-_', '+/'), true);
    return $r === false ? '' : $r;
}

// ------------------------------------------------------------------ comprobación rápida (GET)
$metodo = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($metodo === 'GET' || $metodo === 'HEAD') {
    // Abre la dirección en el navegador: si dice "ok", está instalada.
    responder(200, ['ok' => true, 'servicio' => 'solicitud-licencia-compoint', 'version' => 1]);
}
if ($metodo !== 'POST') {
    header('Allow: GET, POST');
    responder(405, ['ok' => false, 'error' => 'Método no permitido']);
}

// ------------------------------------------------------------------ lectura del cuerpo
$crudo = file_get_contents('php://input', false, null, 0, MAX_BYTES + 1);
if ($crudo === false || $crudo === '') {
    responder(400, ['ok' => false, 'error' => 'Solicitud vacía']);
}
if (strlen($crudo) > MAX_BYTES) {
    responder(413, ['ok' => false, 'error' => 'La solicitud es demasiado grande']);
}
$entrada = json_decode($crudo, true, 6);
if (!is_array($entrada) || ($entrada['v'] ?? null) !== 1) {
    responder(400, ['ok' => false, 'error' => 'Formato no válido']);
}

// Campo trampa: las personas no lo ven ni lo llenan; los robots sí. Se contesta "ok" y se ignora.
if (isset($entrada['web']) && $entrada['web'] !== '') {
    responder(200, ['ok' => true]);
}

// ------------------------------------------------------------------ el código de solicitud
$codigo = is_string($entrada['codigo'] ?? null) ? preg_replace('/\s+/', '', $entrada['codigo']) : '';
if (!preg_match('/^CPT-REQ-([A-Za-z0-9_-]{20,6000})\.([0-9A-Fa-f]{4})$/', (string)$codigo, $m)) {
    responder(400, ['ok' => false, 'error' => 'Código de solicitud no válido']);
}
$cuerpoCodigo = $m[1];
$controlEsperado = strtoupper(substr(hash('sha256', 'cpt-req|' . $cuerpoCodigo), 0, 4));
if (strtoupper($m[2]) !== $controlEsperado) {
    responder(400, ['ok' => false, 'error' => 'El código de solicitud llegó dañado']);
}

// Todo se toma del código (así lo que llega por aquí no se puede contradecir). Si el servidor
// no tuviera zlib, se usan los campos sueltos.
$datos = null;
if (function_exists('gzinflate')) {
    $bin = base64url_decode($cuerpoCodigo);
    $json = $bin === '' ? false : @gzinflate($bin, 20000);
    $datos = $json === false ? null : json_decode($json, true, 6);
}
if (!is_array($datos)) {
    $datos = $entrada;
}
if (($datos['v'] ?? null) !== 1) {
    responder(400, ['ok' => false, 'error' => 'Versión de solicitud no reconocida']);
}

$tipo = ($datos['tipo'] ?? '') === 'renovar' ? 'renovar' : 'contratar';
$plan = ($datos['plan'] ?? '') === 'local' ? 'local' : 'nube';
$sucursales = (int)($datos['sucursales'] ?? 1);
$idEquipo = strtoupper(linea($datos['id_equipo'] ?? '', 20));
if (!preg_match('/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/', $idEquipo)) {
    responder(400, ['ok' => false, 'error' => 'ID de equipo no válido']);
}
if ($sucursales < 1 || $sucursales > 50) {
    $sucursales = 1;
}
$neg = is_array($datos['negocio'] ?? null) ? $datos['negocio'] : [];
$campos = [
    'negocio' => 60, 'giro' => 60, 'nombre_dueno' => 80, 'telefono' => 20, 'whatsapp' => 20, 'email' => 80,
    'direccion' => 120, 'ciudad' => 60, 'estado' => 40, 'cp' => 5,
    'rfc' => 13, 'razon_social' => 100, 'cp_fiscal' => 5, 'email_factura' => 80,
];
$n = [];
foreach ($campos as $c => $max) {
    $n[$c] = linea($neg[$c] ?? '', $max);
}
if ($n['negocio'] === '') {
    responder(400, ['ok' => false, 'error' => 'Falta el nombre del negocio']);
}
if ($n['telefono'] === '' && $n['whatsapp'] === '') {
    responder(400, ['ok' => false, 'error' => 'Falta un teléfono o WhatsApp de contacto']);
}
$nota = linea($datos['nota'] ?? '', 300);
$fecha = linea($datos['fecha'] ?? '', 10);
$app = linea($datos['app'] ?? '', 20);
$prueba = isset($datos['prueba_dias_restantes']) && is_numeric($datos['prueba_dias_restantes'])
    ? (int)$datos['prueba_dias_restantes'] : null;
$origen = linea($entrada['origen'] ?? '', 10);

// ------------------------------------------------------------------ carpeta protegida
if (!is_dir(CARPETA_DATOS)) {
    @mkdir(CARPETA_DATOS, 0750, true);
}
if (!is_dir(CARPETA_DATOS) || !is_writable(CARPETA_DATOS)) {
    responder(500, ['ok' => false, 'error' => 'El servicio no puede guardar datos (revisa permisos de la carpeta)']);
}
if (!is_file(CARPETA_DATOS . '/.htaccess')) {
    @file_put_contents(CARPETA_DATOS . '/.htaccess', "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
    @file_put_contents(CARPETA_DATOS . '/index.html', '');
}

$archivoSolicitud = CARPETA_DATOS . '/sol-' . hash('sha256', $codigo) . '.json';
$yaRegistrada = null;
if (is_file($archivoSolicitud)) {
    $yaRegistrada = json_decode((string)@file_get_contents($archivoSolicitud), true);
    // Ya se mandó el correo de esta misma solicitud (el sistema reintentó por no ver la respuesta).
    if (is_array($yaRegistrada) && !empty($yaRegistrada['correo_enviado'])) {
        responder(200, ['ok' => true, 'repetida' => true]);
    }
}

// ------------------------------------------------------------------ límites de uso
/** Cuenta un uso en un archivo con marcas de tiempo; regresa false si ya se pasó del límite. */
function dentroDelLimite(string $archivo, int $ventanaSeg, int $max): bool
{
    $f = @fopen($archivo, 'c+');
    if (!$f) {
        return true; // si no se puede contar, no se bloquea a nadie
    }
    flock($f, LOCK_EX);
    $contenido = stream_get_contents($f);
    $marcas = $contenido ? (json_decode($contenido, true) ?: []) : [];
    $ahora = time();
    $marcas = array_values(array_filter($marcas, static fn($t) => is_int($t) && $t > $ahora - $ventanaSeg));
    $permitido = count($marcas) < $max;
    if ($permitido) {
        $marcas[] = $ahora;
    }
    ftruncate($f, 0);
    rewind($f);
    fwrite($f, json_encode($marcas));
    flock($f, LOCK_UN);
    fclose($f);
    return $permitido;
}

if ($yaRegistrada === null) { // una solicitud repetida no gasta el límite
    $ip = (string)($_SERVER['REMOTE_ADDR'] ?? 'desconocida');
    if (!dentroDelLimite(CARPETA_DATOS . '/lim-ip-' . hash('sha256', $ip) . '.json', 3600, LIMITE_POR_IP_HORA)
        || !dentroDelLimite(CARPETA_DATOS . '/lim-dia.json', 86400, LIMITE_GLOBAL_DIA)) {
        header('Retry-After: 3600');
        responder(429, ['ok' => false, 'error' => 'Demasiadas solicitudes, intenta más tarde']);
    }
}

// ------------------------------------------------------------------ armar y mandar el correo
$textoPlan = $plan === 'local' ? 'Sin nube (trabaja sin internet)' : 'Con servicio en la nube';
$direccion = implode(', ', array_filter([$n['direccion'], $n['ciudad'], $n['estado'], $n['cp'] !== '' ? 'C.P. ' . $n['cp'] : '']));
$lineas = [
    'Nueva solicitud para ' . ($tipo === 'renovar' ? 'RENOVAR' : 'CONTRATAR') . ' Compoint Punto',
    '',
    'Plan: ' . $textoPlan,
    'Sucursales: ' . $sucursales,
    'ID de equipo: ' . $idEquipo,
];
if ($fecha !== '') {
    $lineas[] = 'Fecha de la solicitud: ' . $fecha;
}
if ($prueba !== null) {
    $lineas[] = 'Prueba: le ' . ($prueba === 1 ? 'quedaba 1 día' : 'quedaban ' . $prueba . ' días');
}
$lineas[] = 'Sistema: ' . ($origen === 'local' ? 'en la computadora del cliente (sin nube)' : ($origen === 'nube' ? 'en la nube' : 'no indicado')) . ($app !== '' ? ' · versión ' . $app : '');
$lineas[] = '';
$lineas[] = 'NEGOCIO';
$lineas[] = 'Nombre: ' . $n['negocio'];
foreach ([['giro', 'Giro'], ['nombre_dueno', 'Dueño o contacto'], ['whatsapp', 'WhatsApp'], ['telefono', 'Teléfono'], ['email', 'Correo']] as [$k, $etq]) {
    if ($n[$k] !== '') {
        $lineas[] = $etq . ': ' . $n[$k];
    }
}
if ($direccion !== '') {
    $lineas[] = 'Dirección: ' . $direccion;
}
if ($n['rfc'] !== '' || $n['razon_social'] !== '' || $n['cp_fiscal'] !== '' || $n['email_factura'] !== '') {
    $lineas[] = '';
    $lineas[] = 'DATOS PARA FACTURA';
    foreach ([['razon_social', 'Razón social'], ['rfc', 'RFC'], ['cp_fiscal', 'C.P. fiscal'], ['email_factura', 'Correo para factura']] as [$k, $etq]) {
        if ($n[$k] !== '') {
            $lineas[] = $etq . ': ' . $n[$k];
        }
    }
}
if ($nota !== '') {
    $lineas[] = '';
    $lineas[] = 'Nota del cliente: ' . $nota;
}
$lineas[] = '';
$lineas[] = 'CÓDIGO DE SOLICITUD (pégalo en el Activador Compoint → Nueva activación):';
$lineas[] = $codigo;
$lineas[] = '';
$lineas[] = 'Responde a este correo (si el cliente dejó su correo) o escríbele por WhatsApp.';
$cuerpoCorreo = implode("\r\n", $lineas);

$asunto = 'Solicitud de licencia: ' . $n['negocio'] . ' (' . ($plan === 'local' ? 'sin nube' : 'con nube') . ', ' . $sucursales . ' suc.)';
$cabeceras = [
    'From: Compoint Punto <' . CORREO_ORIGEN . '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'X-Compoint: solicitud-licencia',
];
$correoCliente = $n['email'] !== '' && filter_var($n['email'], FILTER_VALIDATE_EMAIL) ? $n['email'] : '';
if ($correoCliente !== '') {
    $cabeceras[] = 'Reply-To: ' . $correoCliente;
}

$enviado = @mail(
    CORREO_DESTINO,
    '=?UTF-8?B?' . base64_encode($asunto) . '?=',
    chunk_split(base64_encode($cuerpoCorreo)),
    implode("\r\n", $cabeceras),
    '-f' . CORREO_ORIGEN
);

// Copia en la carpeta protegida (sirve si el correo falla o se pierde).
@file_put_contents($archivoSolicitud, json_encode([
    'recibida' => date('c'),
    'correo_enviado' => (bool)$enviado,
    'tipo' => $tipo, 'plan' => $plan, 'sucursales' => $sucursales, 'id_equipo' => $idEquipo,
    'negocio' => $n, 'nota' => $nota, 'codigo' => $codigo,
], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);

if (!$enviado) {
    // El sistema del cliente lo reintentará más tarde.
    responder(503, ['ok' => false, 'error' => 'No se pudo mandar el correo en este momento']);
}
responder(200, ['ok' => true]);
