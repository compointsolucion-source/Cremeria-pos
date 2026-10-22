const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requiereRol, requierePermiso, requiereSucursalId } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');
const { normalizarDireccion, soloDigitos } = require('../utils/pedidosUtil');

// Toda ruta de este archivo ya filtra por sucursal — se resuelve una sola
// vez aquí (req.sucursalId) en vez de repetirlo en cada endpoint.
router.use(verificarToken, requiereSucursalId);

// Listar clientes. Soporta paginación opcional con ?limit=&offset=
router.get('/', verificarToken, async (req, res) => {
  try {
    const { limit, offset } = req.query;
    let query = 'SELECT * FROM clientes WHERE sucursal_id = $1 AND activo = true ORDER BY nombre ASC';
    const valores = [req.sucursalId];

    if (limit) {
      valores.push(parseInt(limit));
      query += ` LIMIT $${valores.length}`;
      if (offset) {
        valores.push(parseInt(offset));
        query += ` OFFSET $${valores.length}`;
      }
    }

    const result = await pool.query(query, valores);

    if (limit) {
      const totalResult = await pool.query(
        'SELECT COUNT(*) FROM clientes WHERE sucursal_id = $1 AND activo = true',
        [req.sucursalId]
      );
      res.json({ clientes: result.rows, total: parseInt(totalResult.rows[0].count) });
    } else {
      res.json(result.rows);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

// Buscar clientes por nombre o por teléfono (selector de Fiado en caja y de Pedidos a domicilio)
router.get('/buscar/:texto', verificarToken, async (req, res) => {
  try {
    const digitos = soloDigitos(req.params.texto);
    // Solo se busca por teléfono si escribieron al menos 3 números (si no, "1" traería a medio mundo).
    const porTelefono = digitos.length >= 3;
    const result = await pool.query(
      `SELECT * FROM clientes WHERE sucursal_id = $1 AND activo = true
         AND (nombre ILIKE $2 ${porTelefono ? "OR REGEXP_REPLACE(COALESCE(telefono, ''), '[^0-9]', '', 'g') LIKE $3" : ''})
       ORDER BY nombre ASC LIMIT 10`,
      porTelefono ? [req.sucursalId, `%${req.params.texto}%`, `%${digitos}%`] : [req.sucursalId, `%${req.params.texto}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar clientes' });
  }
});

// Crear cliente
router.post('/', verificarToken, requierePermiso('CLIENTES_CREAR'), async (req, res) => {
  try {
    const { nombre, telefono, limite_credito, tipo, usa_mayoreo } = req.body;
    if (!nombre) return res.status(400).json({ error: 'El nombre es requerido' });
    if (tipo !== undefined && !['publico', 'tienda'].includes(tipo)) return res.status(400).json({ error: 'Tipo de cliente inválido' });

    const result = await pool.query(
      `INSERT INTO clientes (sucursal_id, nombre, telefono, limite_credito, tipo, usa_mayoreo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.sucursalId, nombre, telefono || null, limite_credito || 0, tipo || 'publico', usa_mayoreo === true]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'crear_cliente',
      modulo: 'clientes',
      referencia_id: result.rows[0].id,
      valor_nuevo: { nombre, telefono, limite_credito: limite_credito || 0 }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear cliente' });
  }
});

// Importación masiva desde Excel (columnas: Nombre, Teléfono, Límite de crédito y Saldo).
// El navegador ya convirtió el archivo a una lista; llega en tandas chicas. Si el nombre
// ya existe (sin importar mayúsculas), se ACTUALIZAN su teléfono y su límite de crédito
// pero NUNCA su saldo (para no pisar lo que ya debe de verdad); si no existe, se CREA
// con el saldo que traía del sistema anterior. Filas sin nombre se omiten.
router.post('/importar', verificarToken, requierePermiso('CLIENTES_CREAR'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    const { clientes } = req.body;
    if (!Array.isArray(clientes) || clientes.length === 0) {
      return res.status(400).json({ error: 'No se recibieron clientes para importar' });
    }
    if (clientes.length > 500) {
      return res.status(400).json({ error: 'Son demasiados clientes en una sola tanda (máximo 500)' });
    }

    const monto = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n * 100) / 100, 99999999) : 0; };

    const existentes = await conexion.query('SELECT id, LOWER(TRIM(nombre)) AS nombre_lower FROM clientes WHERE sucursal_id = $1', [req.sucursalId]);
    const porNombre = {};
    existentes.rows.forEach(c => { porNombre[c.nombre_lower] = c.id; });

    let creados = 0, actualizados = 0, omitidos = 0;
    await conexion.query('BEGIN');
    for (const fila of clientes) {
      const nombre = String(fila.nombre || '').trim().slice(0, 150);
      if (!nombre) { omitidos++; continue; }
      const telefono = String(fila.telefono || '').trim().slice(0, 20) || null;
      const limite = monto(fila.limite_credito);
      const saldo = monto(fila.saldo);
      const clave = nombre.toLowerCase();

      if (porNombre[clave]) {
        await conexion.query(
          `UPDATE clientes SET telefono = COALESCE($1, telefono),
             limite_credito = CASE WHEN $2 > 0 THEN $2 ELSE limite_credito END
           WHERE id = $3`,
          [telefono, limite, porNombre[clave]]
        );
        actualizados++;
      } else {
        const nuevo = await conexion.query(
          `INSERT INTO clientes (sucursal_id, nombre, telefono, limite_credito, saldo_actual)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [req.sucursalId, nombre, telefono, limite, saldo]
        );
        // Se anota en memoria: si el archivo repite el nombre más abajo, se actualiza en vez de duplicar.
        porNombre[clave] = nuevo.rows[0].id;
        creados++;
      }
    }
    await conexion.query('COMMIT');

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'importar_clientes',
      modulo: 'clientes',
      valor_nuevo: { total: clientes.length, creados, actualizados, omitidos }
    });

    res.json({ creados, actualizados, omitidos });
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al importar los clientes: ' + err.message });
  } finally {
    conexion.release();
  }
});

// Editar cliente (nombre, teléfono, límite)
router.put('/:id', verificarToken, requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  try {
    const { nombre, telefono, limite_credito, activo, tipo, usa_mayoreo } = req.body;
    if (tipo !== undefined && !['publico', 'tienda'].includes(tipo)) return res.status(400).json({ error: 'Tipo de cliente inválido' });
    const result = await pool.query(
      `UPDATE clientes SET
        nombre = COALESCE($1, nombre),
        telefono = COALESCE($2, telefono),
        limite_credito = COALESCE($3, limite_credito),
        activo = COALESCE($4, activo),
        tipo = COALESCE($7, tipo),
        usa_mayoreo = COALESCE($8, usa_mayoreo)
       WHERE id = $5 AND sucursal_id = $6 RETURNING *`,
      [nombre, telefono, limite_credito, activo, req.params.id, req.sucursalId, tipo === undefined ? null : tipo, typeof usa_mayoreo === 'boolean' ? usa_mayoreo : null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar cliente' });
  }
});

// Estado de cuenta: cargos y abonos de un cliente
router.get('/:id/estado-cuenta', verificarToken, async (req, res) => {
  try {
    const cliente = await pool.query('SELECT * FROM clientes WHERE id = $1 AND sucursal_id = $2', [req.params.id, req.sucursalId]);
    if (cliente.rows.length === 0) return res.status(404).json({ error: 'Cliente no encontrado' });

    const cargos = await pool.query(
      `SELECT cc.*, t.folio FROM creditos_cargo cc JOIN tickets t ON cc.ticket_id = t.id
       WHERE cc.cliente_id = $1 ORDER BY cc.fecha DESC`,
      [req.params.id]
    );
    const abonos = await pool.query(
      'SELECT * FROM creditos_abono WHERE cliente_id = $1 ORDER BY fecha DESC',
      [req.params.id]
    );

    res.json({ cliente: cliente.rows[0], cargos: cargos.rows, abonos: abonos.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el estado de cuenta' });
  }
});

// Registrar un abono (pago a cuenta)
router.post('/:id/abono', verificarToken, requierePermiso('CREDITO_ABONO'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const { monto, metodo_pago, turno_id } = req.body;
    if (!monto || monto <= 0) return res.status(400).json({ error: 'Monto inválido' });

    await cliente.query('BEGIN');

    await cliente.query(
      `INSERT INTO creditos_abono (cliente_id, monto, metodo_pago, turno_id, recibido_por)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, monto, metodo_pago || 'efectivo', turno_id || null, req.usuario.id]
    );

    const result = await cliente.query(
      `UPDATE clientes SET saldo_actual = saldo_actual - $1 WHERE id = $2 RETURNING *`,
      [monto, req.params.id]
    );

    await cliente.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await cliente.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al registrar el abono' });
  } finally {
    cliente.release();
  }
});

// ------------------------------------------------------------ direcciones de entrega del cliente
// Las usan los pedidos a domicilio: se capturan una vez y la próxima vez ya están guardadas.
async function clienteDeEstaSucursal(id, sucursalId) {
  const r = await pool.query('SELECT id FROM clientes WHERE id = $1 AND sucursal_id = $2', [id, sucursalId]);
  return r.rows.length > 0;
}
async function zonaValida(zonaId, sucursalId) {
  if (!zonaId) return true;
  const r = await pool.query('SELECT 1 FROM zonas_envio WHERE id = $1 AND sucursal_id = $2', [zonaId, sucursalId]);
  return r.rows.length > 0;
}

router.get('/:id/direcciones', verificarToken, async (req, res) => {
  try {
    if (!(await clienteDeEstaSucursal(req.params.id, req.sucursalId))) return res.status(404).json({ error: 'Cliente no encontrado' });
    const r = await pool.query(
      `SELECT * FROM cliente_direcciones WHERE cliente_id = $1 AND activo = true
       ORDER BY principal DESC, ultimo_uso DESC NULLS LAST, id ASC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las direcciones' });
  }
});

router.post('/:id/direcciones', verificarToken, requierePermiso('VENTAS_CREAR'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    if (!(await clienteDeEstaSucursal(req.params.id, req.sucursalId))) return res.status(404).json({ error: 'Cliente no encontrado' });
    const d = normalizarDireccion(req.body);
    if (d.error) return res.status(400).json({ error: d.error });
    if (!(await zonaValida(d.zona_id, req.sucursalId))) return res.status(400).json({ error: 'La zona de envío no existe' });

    await conexion.query('BEGIN');
    const hay = await conexion.query('SELECT COUNT(*)::int AS n FROM cliente_direcciones WHERE cliente_id = $1 AND activo = true', [req.params.id]);
    const principal = req.body.principal === true || hay.rows[0].n === 0; // la primera siempre es la principal
    if (principal) await conexion.query('UPDATE cliente_direcciones SET principal = false WHERE cliente_id = $1', [req.params.id]);
    const r = await conexion.query(
      `INSERT INTO cliente_direcciones (cliente_id, alias, calle, colonia, cp, ciudad, referencias, latitud, longitud, ubicacion_enlace, zona_id, principal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.params.id, d.alias, d.calle, d.colonia, d.cp, d.ciudad, d.referencias, d.latitud, d.longitud, d.ubicacion_enlace, d.zona_id, principal]
    );
    await conexion.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la dirección' });
  } finally {
    conexion.release();
  }
});

router.put('/:id/direcciones/:dirId', verificarToken, requierePermiso('VENTAS_CREAR'), async (req, res) => {
  const conexion = await pool.connect();
  try {
    if (!(await clienteDeEstaSucursal(req.params.id, req.sucursalId))) return res.status(404).json({ error: 'Cliente no encontrado' });
    const d = normalizarDireccion(req.body);
    if (d.error) return res.status(400).json({ error: d.error });
    if (!(await zonaValida(d.zona_id, req.sucursalId))) return res.status(400).json({ error: 'La zona de envío no existe' });

    await conexion.query('BEGIN');
    if (req.body.principal === true) await conexion.query('UPDATE cliente_direcciones SET principal = false WHERE cliente_id = $1', [req.params.id]);
    const r = await conexion.query(
      `UPDATE cliente_direcciones SET alias = $1, calle = $2, colonia = $3, cp = $4, ciudad = $5, referencias = $6,
              latitud = $7, longitud = $8, ubicacion_enlace = $9, zona_id = $10,
              principal = CASE WHEN $11::boolean THEN true ELSE principal END
       WHERE id = $12 AND cliente_id = $13 AND activo = true RETURNING *`,
      [d.alias, d.calle, d.colonia, d.cp, d.ciudad, d.referencias, d.latitud, d.longitud, d.ubicacion_enlace, d.zona_id, req.body.principal === true, req.params.dirId, req.params.id]
    );
    if (!r.rows.length) { await conexion.query('ROLLBACK'); return res.status(404).json({ error: 'Dirección no encontrada' }); }
    await conexion.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar la dirección' });
  } finally {
    conexion.release();
  }
});

// Quitar una dirección: no se borra (los pedidos ya hechos la conservan); solo deja de ofrecerse.
router.delete('/:id/direcciones/:dirId', verificarToken, requierePermiso('VENTAS_CREAR'), async (req, res) => {
  try {
    if (!(await clienteDeEstaSucursal(req.params.id, req.sucursalId))) return res.status(404).json({ error: 'Cliente no encontrado' });
    const r = await pool.query('UPDATE cliente_direcciones SET activo = false, principal = false WHERE id = $1 AND cliente_id = $2 AND activo = true RETURNING id', [req.params.dirId, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Dirección no encontrada' });
    // Si era la principal, la más reciente pasa a serlo.
    await pool.query(
      `UPDATE cliente_direcciones SET principal = true WHERE id = (
         SELECT id FROM cliente_direcciones WHERE cliente_id = $1 AND activo = true ORDER BY ultimo_uso DESC NULLS LAST, id DESC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM cliente_direcciones WHERE cliente_id = $1 AND activo = true AND principal = true)`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al quitar la dirección' });
  }
});

module.exports = router;
