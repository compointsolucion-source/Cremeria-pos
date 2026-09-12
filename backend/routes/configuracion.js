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
  tipo_fuente: 'monospace'
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

// Actualizar (o crear si no existe) la configuración
router.put('/', verificarToken, requiereRol('dueno', 'gerente'), async (req, res) => {
  try {
    const {
      logo_url, direccion, telefono, rfc, ancho_ticket, terminos,
      lineas_superiores, lineas_inferiores, incluir_precio_unitario,
      descripcion_completa, imprimir_datos_cliente, tipo_codigo_escaneo,
      negocio_negritas, total_negritas, tamano_letra, tipo_fuente
    } = req.body;

    if (ancho_ticket && !['58mm', '80mm'].includes(ancho_ticket)) {
      return res.status(400).json({ error: 'Ancho de ticket inválido' });
    }
    if (tipo_codigo_escaneo && !['qr', 'barras', 'ambos'].includes(tipo_codigo_escaneo)) {
      return res.status(400).json({ error: 'Tipo de código de escaneo inválido' });
    }
    if (tamano_letra && !['normal', 'grande'].includes(tamano_letra)) {
      return res.status(400).json({ error: 'Tamaño de letra inválido' });
    }
    if (tipo_fuente && !['monospace', 'sans-serif'].includes(tipo_fuente)) {
      return res.status(400).json({ error: 'Tipo de fuente inválido' });
    }

    const result = await pool.query(
      `INSERT INTO configuracion (
         sucursal_id, logo_url, direccion, telefono, rfc, ancho_ticket, terminos,
         lineas_superiores, lineas_inferiores, incluir_precio_unitario,
         descripcion_completa, imprimir_datos_cliente, tipo_codigo_escaneo,
         negocio_negritas, total_negritas, tamano_letra, tipo_fuente
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (sucursal_id) DO UPDATE SET
         logo_url = COALESCE($2, configuracion.logo_url),
         direccion = COALESCE($3, configuracion.direccion),
         telefono = COALESCE($4, configuracion.telefono),
         rfc = COALESCE($5, configuracion.rfc),
         ancho_ticket = COALESCE($6, configuracion.ancho_ticket),
         terminos = COALESCE($7, configuracion.terminos),
         lineas_superiores = COALESCE($8, configuracion.lineas_superiores),
         lineas_inferiores = COALESCE($9, configuracion.lineas_inferiores),
         incluir_precio_unitario = COALESCE($10, configuracion.incluir_precio_unitario),
         descripcion_completa = COALESCE($11, configuracion.descripcion_completa),
         imprimir_datos_cliente = COALESCE($12, configuracion.imprimir_datos_cliente),
         tipo_codigo_escaneo = COALESCE($13, configuracion.tipo_codigo_escaneo),
         negocio_negritas = COALESCE($14, configuracion.negocio_negritas),
         total_negritas = COALESCE($15, configuracion.total_negritas),
         tamano_letra = COALESCE($16, configuracion.tamano_letra),
         tipo_fuente = COALESCE($17, configuracion.tipo_fuente)
       RETURNING *`,
      [
        req.usuario.sucursal_id, logo_url || null, direccion || null, telefono || null, rfc || null,
        ancho_ticket || null, terminos || null,
        lineas_superiores !== undefined ? lineas_superiores : null,
        lineas_inferiores !== undefined ? lineas_inferiores : null,
        incluir_precio_unitario !== undefined ? incluir_precio_unitario : null,
        descripcion_completa !== undefined ? descripcion_completa : null,
        imprimir_datos_cliente !== undefined ? imprimir_datos_cliente : null,
        tipo_codigo_escaneo || null,
        negocio_negritas !== undefined ? negocio_negritas : null,
        total_negritas !== undefined ? total_negritas : null,
        tamano_letra || null,
        tipo_fuente || null
      ]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'actualizar_configuracion',
      modulo: 'configuracion',
      referencia_id: req.usuario.sucursal_id,
      valor_nuevo: { direccion, telefono, rfc, ancho_ticket, terminos, tipo_codigo_escaneo } // logo_url excluido: puede pesar varios KB en base64
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la configuración' });
  }
});

module.exports = router;
