const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requierePermiso, requiereRol, requiereSucursalId } = require('../middleware/auth');
const { validarTurno, esSupervisor } = require('../utils/seguridadCaja');
const { registrarBitacora } = require('../utils/bitacora');
const proveedor = require('../utils/proveedorRecargas');

// ============================================================================
// RECARGAS DE TIEMPO AIRE Y PAGO DE SERVICIOS
// ============================================================================
// Reglas:
//  - Solo con turno de caja ABIERTO del propio cajero, en su sucursal (igual que cobrar).
//  - Cada venta se guarda ANTES de mandarla al proveedor, así nunca se pierde el rastro.
//  - Un mismo clic no se cobra dos veces (clave única) y la misma recarga al mismo número
//    en menos de 3 minutos pide confirmación.
//  - Las ventas en modo prueba se guardan, pero NO cuentan en el corte de caja.

router.use(verificarToken, requiereSucursalId);

const redondear = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const METODOS = ['efectivo', 'tarjeta'];
const MINUTOS_REPETIDA = 3;

async function leerConfig(db = pool) {
  const r = await db.query('SELECT activo, cargo_servicio, comision_pct FROM recargas_config WHERE id = 1');
  const c = r.rows[0] || { activo: true, cargo_servicio: 10, comision_pct: 0 };
  return { activo: !!c.activo, cargo_servicio: Number(c.cargo_servicio), comision_pct: Number(c.comision_pct) };
}

// Le dice a la pantalla si se puede usar y en qué modo.
router.get('/estado', async (req, res) => {
  try {
    const cfg = await leerConfig();
    res.json({ configurado: proveedor.estaConfigurado(), modo: proveedor.modo(), ...cfg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al revisar el módulo de recargas' });
  }
});

router.get('/catalogo', async (req, res) => {
  try {
    res.json(await proveedor.obtenerCatalogo());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las compañías' });
  }
});

// Saldo con el proveedor (solo dueño, gerente y jefe general).
router.get('/saldo', requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  try {
    res.json(await proveedor.consultarSaldo());
  } catch (err) {
    res.status(503).json({ error: err.message || 'No se pudo consultar el saldo' });
  }
});

// Ajustes: cargo por pagar un servicio, comisión del proveedor y encender/apagar.
router.put('/config', requiereRol('jefe_general', 'dueno', 'gerente'), async (req, res) => {
  try {
    const b = req.body || {};
    const actual = await leerConfig();
    const activo = b.activo === undefined ? actual.activo : b.activo === true;
    const cargo = b.cargo_servicio === undefined ? actual.cargo_servicio : Number(b.cargo_servicio);
    const pct = b.comision_pct === undefined ? actual.comision_pct : Number(b.comision_pct);
    if (!(Number.isFinite(cargo) && cargo >= 0 && cargo <= 200)) return res.status(400).json({ error: 'La comisión por servicio debe ser de $0 a $200' });
    if (!(Number.isFinite(pct) && pct >= 0 && pct <= 30)) return res.status(400).json({ error: 'El porcentaje del proveedor debe ser de 0 a 30' });
    await pool.query(
      `INSERT INTO recargas_config (id, activo, cargo_servicio, comision_pct, actualizado_en) VALUES (1, $1, $2, $3, NOW())
       ON CONFLICT (id) DO UPDATE SET activo = $1, cargo_servicio = $2, comision_pct = $3, actualizado_en = NOW()`,
      [activo, redondear(cargo), redondear(pct)]
    );
    await registrarBitacora(pool, { usuario_id: req.usuario.id, accion: 'config_recargas', modulo: 'recargas', valor_anterior: actual, valor_nuevo: { activo, cargo_servicio: cargo, comision_pct: pct } });
    res.json(await leerConfig());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar los ajustes de recargas' });
  }
});

// Vender una recarga o pagar un servicio.
router.post('/vender', requierePermiso('RECARGAS_VENDER'), async (req, res) => {
  const b = req.body || {};
  try {
    const cfg = await leerConfig();
    if (!cfg.activo) return res.status(403).json({ error: 'Las recargas están apagadas. El dueño las puede encender en Configuración.' });

    const item = proveedor.buscarEnCatalogo(String(b.compania || ''));
    if (!item) return res.status(400).json({ error: 'Elige una compañía de la lista' });

    const referencia = String(b.referencia || '').replace(/[\s-]/g, '');
    let monto = Number(b.monto);
    if (item.tipo === 'recarga') {
      if (!/^\d{10}$/.test(referencia)) return res.status(400).json({ error: 'El número de celular debe tener 10 dígitos' });
      if (!item.montos.includes(monto)) return res.status(400).json({ error: `Ese monto no existe para ${item.nombre}` });
    } else {
      if (!/^[0-9A-Za-z]{6,30}$/.test(referencia)) return res.status(400).json({ error: 'Revisa el número del recibo: solo números y letras, de 6 a 30' });
      if (!(Number.isFinite(monto) && monto >= 1 && monto <= proveedor.SERVICIO_MAX)) {
        return res.status(400).json({ error: `El monto del recibo debe ser de $1 a $${proveedor.SERVICIO_MAX.toLocaleString('es-MX')}` });
      }
      monto = redondear(monto);
    }
    const metodo = String(b.metodo_pago || 'efectivo');
    if (!METODOS.includes(metodo)) return res.status(400).json({ error: 'Forma de pago no válida (efectivo o tarjeta)' });
    const clave = b.clave === undefined || b.clave === null || b.clave === '' ? null : String(b.clave);
    if (clave !== null && !/^[A-Za-z0-9-]{8,40}$/.test(clave)) return res.status(400).json({ error: 'Clave de operación no válida' });

    let turno;
    try {
      turno = await validarTurno(pool, { turnoId: b.turno_id, sucursalId: req.sucursalId, usuario: req.usuario, obligatorio: true });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.error });
    }

    const prueba = proveedor.modo() === 'prueba';
    const cargo = item.tipo === 'servicio' ? redondear(cfg.cargo_servicio) : 0;
    const total = redondear(monto + cargo);

    // Mismo clic repetido: se devuelve la venta que ya existe (no se cobra dos veces).
    if (clave) {
      const ya = await pool.query('SELECT * FROM recargas_ventas WHERE sucursal_id = $1 AND clave = $2', [req.sucursalId, clave]);
      if (ya.rows[0]) return res.json({ ...ya.rows[0], repetida_clic: true, modo: prueba ? 'prueba' : 'real' });
    }
    // Misma recarga al mismo número hace poco: casi siempre es un error. Se pide confirmar.
    if (b.confirmar_repetida !== true) {
      const rep = await pool.query(
        `SELECT id, fecha FROM recargas_ventas
         WHERE sucursal_id = $1 AND referencia = $2 AND monto = $3 AND estado IN ('exitosa', 'pendiente') AND modo_prueba = $4
           AND fecha > NOW() - make_interval(mins => $5::int)
         ORDER BY fecha DESC LIMIT 1`,
        [req.sucursalId, referencia, monto, prueba, MINUTOS_REPETIDA]
      );
      if (rep.rows[0]) {
        return res.status(409).json({ repetida: true, error: `Hace menos de ${MINUTOS_REPETIDA} minutos ya se hizo esta misma ${item.tipo === 'recarga' ? 'recarga' : 'operación'} a ese número. ¿Seguro que quieres hacerla otra vez?` });
      }
    }

    // 1) Se guarda ANTES de mandarla, como "pendiente".
    let fila;
    try {
      fila = (await pool.query(
        `INSERT INTO recargas_ventas (sucursal_id, turno_id, usuario_id, tipo, compania, referencia, monto, cargo, total, metodo_pago, estado, modo_prueba, clave)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pendiente', $11, $12) RETURNING *`,
        [req.sucursalId, turno.id, req.usuario.id, item.tipo, item.codigo, referencia, monto, cargo, total, metodo, prueba, clave]
      )).rows[0];
    } catch (e) {
      if (e.code === '23505' && clave) { // dos clics al mismo tiempo
        const ya = await pool.query('SELECT * FROM recargas_ventas WHERE sucursal_id = $1 AND clave = $2', [req.sucursalId, clave]);
        if (ya.rows[0]) return res.json({ ...ya.rows[0], repetida_clic: true, modo: prueba ? 'prueba' : 'real' });
      }
      throw e;
    }

    // 2) Se manda al proveedor.
    let r;
    try {
      r = await proveedor.venderRecarga({ tipo: item.tipo, compania: item.codigo, referencia, monto, folio_interno: fila.id });
    } catch (e) {
      r = { estado: 'fallida', folio: null, mensaje: String(e.message || 'No se pudo hacer la venta').slice(0, 200), sinIntegrar: e.codigo === 'SIN_INTEGRAR' };
    }
    const estado = ['exitosa', 'fallida', 'pendiente'].includes(r.estado) ? r.estado : 'pendiente';
    fila = (await pool.query(
      'UPDATE recargas_ventas SET estado = $1, folio_proveedor = $2, mensaje = $3 WHERE id = $4 RETURNING *',
      [estado, r.folio ? String(r.folio).slice(0, 60) : null, r.mensaje ? String(r.mensaje).slice(0, 200) : null, fila.id]
    )).rows[0];

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id, accion: item.tipo === 'recarga' ? 'venta_recarga' : 'pago_servicio', modulo: 'recargas', referencia_id: fila.id,
      valor_nuevo: { compania: item.codigo, referencia, monto, cargo, total, metodo, estado, prueba, turno_id: turno.id }
    });

    if (r.sinIntegrar) return res.status(503).json({ error: 'El proveedor de recargas todavía no está conectado. No cobres esta venta.', venta: fila });
    res.json({ ...fila, modo: prueba ? 'prueba' : 'real' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al hacer la recarga. Revisa en "Recargas de hoy" antes de intentar otra vez.' });
  }
});

// Lista de recargas (por turno o de hoy). El cajero solo ve las suyas.
router.get('/ventas', async (req, res) => {
  try {
    const params = [req.sucursalId];
    let filtro = '';
    const turnoId = parseInt(req.query.turno_id, 10);
    if (turnoId > 0) { params.push(turnoId); filtro += ` AND r.turno_id = $${params.length}`; }
    else filtro += ` AND r.fecha >= date_trunc('day', NOW()) - INTERVAL '1 day'`;
    if (!esSupervisor(req.usuario)) { params.push(req.usuario.id); filtro += ` AND r.usuario_id = $${params.length}`; }
    const r = await pool.query(
      `SELECT r.id, r.tipo, r.compania, r.referencia, r.monto, r.cargo, r.total, r.metodo_pago, r.estado, r.modo_prueba,
              r.folio_proveedor, r.mensaje, r.fecha, u.nombre AS cajero
       FROM recargas_ventas r LEFT JOIN usuarios u ON u.id = r.usuario_id
       WHERE r.sucursal_id = $1 ${filtro} ORDER BY r.fecha DESC LIMIT 200`,
      params
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las recargas' });
  }
});

module.exports = router;
