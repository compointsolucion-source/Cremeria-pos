const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

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
  cajon_abrir_automatico: false
};

// Lista blanca de campos editables desde el PUT — evita construir la
// consulta SQL a mano cada vez que se agrega una opción nueva (así se
// redujo el riesgo de error al ir creciendo esta pantalla con el tiempo).
const CAMPOS_EDITABLES = Object.keys(VALORES_POR_DEFECTO);

const VALIDACIONES = {
  ancho_ticket: (v) => ['58mm', '80mm'].includes(v) || 'Ancho de ticket inválido',
  tipo_codigo_escaneo: (v) => ['qr', 'barras', 'ambos'].includes(v) || 'Tipo de código de escaneo inválido',
  tamano_letra: (v) => ['normal', 'grande'].includes(v) || 'Tamaño de letra inválido',
  tipo_fuente: (v) => ['monospace', 'sans-serif'].includes(v) || 'Tipo de fuente inválido'
};

// Obtener la configuración de la sucursal (valores por defecto si no existe)
router.get('/', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM configuracion WHERE sucursal_id = $1', [req.usuario.sucursal_id]);
    if (result.rows.length === 0) {
      return res.json({ sucursal_id: req.usuario.sucursal_id, ...VALORES_POR_DEFECTO });
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
router.put('/', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    const camposRecibidos = CAMPOS_EDITABLES.filter(campo => req.body[campo] !== undefined);

    for (const campo of camposRecibidos) {
      if (VALIDACIONES[campo]) {
        const resultado = VALIDACIONES[campo](req.body[campo]);
        if (resultado !== true) return res.status(400).json({ error: resultado });
      }
    }

    if (camposRecibidos.length === 0) {
      const actual = await pool.query('SELECT * FROM configuracion WHERE sucursal_id = $1', [req.usuario.sucursal_id]);
      return res.json(actual.rows[0] || { sucursal_id: req.usuario.sucursal_id, ...VALORES_POR_DEFECTO });
    }

    const columnas = ['sucursal_id', ...camposRecibidos];
    const valores = [req.usuario.sucursal_id, ...camposRecibidos.map(c => req.body[c])];
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
      referencia_id: req.usuario.sucursal_id,
      // logo_url excluido a propósito: puede pesar varios KB, no aporta nada útil en la bitácora
      valor_nuevo: Object.fromEntries(camposRecibidos.filter(c => c !== 'logo_url').map(c => [c, req.body[c]]))
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la configuración' });
  }
});

module.exports = router;
