const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol, requiereSucursalId } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Toda ruta de este archivo ya filtra por sucursal — se resuelve una sola
// vez aquí (req.sucursalId) en vez de repetirlo en cada endpoint.
router.use(verificarToken, requiereSucursalId);

const VALORES_POR_DEFECTO = {
  logo_url: null,
  direccion: null,
  telefono: null,
  rfc: null,
  ancho_ticket: '80mm',
  terminos: null,
  lineas_superiores: 0,
  lineas_inferiores: 3,
  incluir_precio_unitario: true,
  descripcion_completa: true,
  imprimir_datos_cliente: false,
  tipo_codigo_escaneo: 'qr',
  negocio_negritas: true,
  total_negritas: true,
  tamano_letra: 'normal',
  tipo_fuente: 'monospace',
  efectivo_bloquear_insuficiente: true,
  dolares_habilitado: false,
  tipo_cambio_dolar: 0,
  tarjeta_habilitado: true,
  tarjeta_comision_porcentaje: 0,
  transferencia_habilitado: true,
  transferencia_etiqueta: 'Transferencia',
  cheque_habilitado: false,
  vales_habilitado: false,
  mixto_habilitado: true,
  credito_habilitado: true,
  cajon_abrir_automatico: false,
  // Anuncios/promociones que rotan en el panel lateral de la Pantalla de
  // Turnos mientras los clientes esperan — cada uno es
  // { tipo: 'imagen'|'qr'|'video', titulo, imagen_url, qr_contenido, video_url }.
  promos_pantalla_turnos: [],
  // Segundos que cada anuncio permanece en pantalla antes de pasar al
  // siguiente (no aplica a un video: este avanza solo hasta que termina).
  promos_intervalo_segundos: 10,
  // Si está activo, los anuncios se muestran en orden aleatorio en vez del
  // orden en que se guardaron.
  promos_orden_aleatorio: false,
  // Etiqueta final de bolsa (báscula tipo Torrey): 'auto' = cada báscula
  // conectada imprime su propia etiqueta de forma autónoma (o no se usa
  // etiqueta); 'sistema' = Compoint genera e imprime la etiqueta usando la
  // impresora de etiquetas configurada, con el nombre/precio exactos del
  // sistema. Es política de negocio (aplica igual en todos los mostradores
  // de la sucursal), por eso vive aquí y no en localStorage.
  etiqueta_modo: 'auto',
  ancho_etiqueta: '50mm',
  // Cómo interpretar el dato numérico embebido en el código de barras de
  // las etiquetas que la báscula ya imprime por su cuenta (PLU + peso o
  // precio): 'peso' = kilogramos (3 decimales implícitos), 'precio' =
  // importe ya calculado en pesos (2 decimales implícitos). Es política de
  // negocio (debe coincidir con cómo está configurada la báscula física),
  // por eso vive aquí y no en localStorage.
  bascula_tipo_dato: 'peso'
};

// Campos cuyo valor es un objeto/arreglo (columna JSONB) — el driver de
// Postgres NO los serializa solo: un arreglo de JS pasado tal cual a una
// consulta parametrizada se manda como literal de arreglo de Postgres
// ("{...}"), que rompe una columna jsonb. Hay que JSON.stringify() antes.
const CAMPOS_JSON = ['promos_pantalla_turnos'];

const MAX_PROMOS = 8;

function validarPromos(promos) {
  if (!Array.isArray(promos)) return 'Los anuncios deben ser una lista';
  if (promos.length > MAX_PROMOS) return `Máximo ${MAX_PROMOS} anuncios`;
  for (const promo of promos) {
    if (!promo || typeof promo !== 'object') return 'Cada anuncio debe ser un objeto';
    if (!['imagen', 'qr', 'video'].includes(promo.tipo)) return 'Cada anuncio debe ser de tipo "imagen", "qr" o "video"';
    if (promo.titulo && String(promo.titulo).length > 80) return 'El título del anuncio es muy largo (máximo 80 caracteres)';
    if (promo.tipo === 'imagen' && !promo.imagen_url) return 'Falta la imagen de uno de los anuncios';
    if (promo.tipo === 'qr' && !promo.qr_contenido) return 'Falta el contenido del código QR de uno de los anuncios';
    if (promo.tipo === 'video' && !promo.video_url) return 'Falta el video de uno de los anuncios';
    if (promo.qr_contenido && String(promo.qr_contenido).length > 500) return 'El contenido del código QR es muy largo';
  }
  return true;
}

function validarIntervaloPromos(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 3 || n > 120) return 'El intervalo de anuncios debe ser un número entre 3 y 120 segundos';
  return true;
}

// Lista blanca de campos editables desde el PUT — evita construir la
// consulta SQL a mano cada vez que se agrega una opción nueva (así se
// redujo el riesgo de error al ir creciendo esta pantalla con el tiempo).
const CAMPOS_EDITABLES = Object.keys(VALORES_POR_DEFECTO);

const VALIDACIONES = {
  ancho_ticket: (v) => ['58mm', '80mm'].includes(v) || 'Ancho de ticket inválido',
  tipo_codigo_escaneo: (v) => ['qr', 'barras', 'ambos'].includes(v) || 'Tipo de código de escaneo inválido',
  tamano_letra: (v) => ['normal', 'grande'].includes(v) || 'Tamaño de letra inválido',
  tipo_fuente: (v) => ['monospace', 'sans-serif'].includes(v) || 'Tipo de fuente inválido',
  promos_pantalla_turnos: validarPromos,
  promos_intervalo_segundos: validarIntervaloPromos,
  etiqueta_modo: (v) => ['auto', 'sistema'].includes(v) || 'Modo de etiqueta inválido',
  ancho_etiqueta: (v) => ['40mm', '50mm', '58mm'].includes(v) || 'Ancho de etiqueta inválido',
  bascula_tipo_dato: (v) => ['peso', 'precio'].includes(v) || 'Tipo de dato de báscula inválido'
};

// Obtener la configuración de la sucursal (valores por defecto si no existe)
router.get('/', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM configuracion WHERE sucursal_id = $1', [req.sucursalId]);
    if (result.rows.length === 0) {
      return res.json({ sucursal_id: req.sucursalId, ...VALORES_POR_DEFECTO });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la configuración' });
  }
});

// Actualizar (o crear si no existe) la configuración. Construye el UPDATE
// dinámicamente solo con los campos que realmente llegaron en el body —
// los demás se quedan como estaban (no se pisan con null por accidente).
router.put('/', verificarToken, requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  try {
    const camposRecibidos = CAMPOS_EDITABLES.filter(campo => req.body[campo] !== undefined);

    for (const campo of camposRecibidos) {
      if (VALIDACIONES[campo]) {
        const resultado = VALIDACIONES[campo](req.body[campo]);
        if (resultado !== true) return res.status(400).json({ error: resultado });
      }
    }

    if (camposRecibidos.length === 0) {
      const actual = await pool.query('SELECT * FROM configuracion WHERE sucursal_id = $1', [req.sucursalId]);
      return res.json(actual.rows[0] || { sucursal_id: req.sucursalId, ...VALORES_POR_DEFECTO });
    }

    const columnas = ['sucursal_id', ...camposRecibidos];
    const valores = [
      req.sucursalId,
      ...camposRecibidos.map(c => CAMPOS_JSON.includes(c) ? JSON.stringify(req.body[c]) : req.body[c])
    ];
    const marcadores = valores.map((_, i) => `$${i + 1}`);
    const actualizaciones = camposRecibidos.map((campo, i) => `${campo} = $${i + 2}`).join(', ');

    const result = await pool.query(
      `INSERT INTO configuracion (${columnas.join(', ')})
       VALUES (${marcadores.join(', ')})
       ON CONFLICT (sucursal_id) DO UPDATE SET ${actualizaciones}
       RETURNING *`,
      valores
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'actualizar_configuracion',
      modulo: 'configuracion',
      referencia_id: req.sucursalId,
      // logo_url y promos_pantalla_turnos excluidos a propósito: pueden pesar
      // varios KB (imágenes/URLs), no aportan nada útil en la bitácora
      valor_nuevo: Object.fromEntries(camposRecibidos.filter(c => !['logo_url', 'promos_pantalla_turnos'].includes(c)).map(c => [c, req.body[c]]))
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la configuración' });
  }
});

module.exports = router;
