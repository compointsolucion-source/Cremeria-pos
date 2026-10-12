const express = require('express');
const router = express.Router();
const pool = require('../db');
const { verificarToken, requierePermiso, requiereSucursalId } = require('../middleware/auth');
const { registrarBitacora } = require('../utils/bitacora');

// Toda ruta de este archivo ya filtra por sucursal — se resuelve una sola
// vez aquí (req.sucursalId) en vez de repetirlo en cada endpoint.
router.use(verificarToken, requiereSucursalId);


const FORMAS_PAGO = ['efectivo', 'tarjeta', 'transferencia', 'dolares', 'cheque', 'vales'];
const redondear = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Arma todo el resumen de un turno (abierto o cerrado): caja, formas de pago,
// ventas por departamento, cuentas y movimientos. Es lo que se imprime en el
// corte de caja (X = turno abierto, Z = turno cerrado).
async function construirResumenTurno(db, turno) {
  const turnoId = turno.id;

  const tickets = await db.query(
    `SELECT t.id, t.folio, t.metodo_pago, t.monto_efectivo, t.monto_tarjeta, t.total, t.descuento_monto,
            COALESCE((SELECT SUM(d.descuento_monto) FROM ticket_detalle d WHERE d.ticket_id = t.id), 0) AS desc_items
     FROM tickets t WHERE t.turno_id = $1 AND t.estado = 'pagado' ORDER BY t.id ASC`,
    [turnoId]
  );

  const formas = { efectivo: 0, tarjeta: 0, transferencia: 0, dolares: 0, cheque: 0, vales: 0, credito: 0 };
  let bruto = 0, descuentos = 0, conDescuento = 0;
  tickets.rows.forEach(t => {
    const total = parseFloat(t.total);
    const desc = parseFloat(t.descuento_monto || 0) + parseFloat(t.desc_items || 0);
    const neto = total - desc;
    bruto += total; descuentos += desc; if (desc > 0) conDescuento++;
    const ef = parseFloat(t.monto_efectivo || 0), tj = parseFloat(t.monto_tarjeta || 0);
    formas.efectivo += ef;
    switch (t.metodo_pago) {
      case 'transferencia': formas.transferencia += tj; break;
      case 'dolares': formas.dolares += tj; break;
      case 'cheque': formas.cheque += tj; break;
      case 'vale_despensa': formas.vales += tj; break;
      case 'credito': formas.credito += neto; break;
      default: formas.tarjeta += tj; // tarjeta y la parte de tarjeta de un pago mixto
    }
  });
  Object.keys(formas).forEach(k => { formas[k] = redondear(formas[k]); });
  const totalFormas = redondear(Object.values(formas).reduce((a, b) => a + b, 0));
  const ventaNeta = redondear(bruto - descuentos);

  const deptos = await db.query(
    `SELECT CASE WHEN d.tipo = 'kit' THEN 'Kits' ELSE COALESCE(c.nombre, 'Sin departamento') END AS depto,
            COALESCE(SUM(d.subtotal - d.descuento_monto), 0) AS monto
     FROM ticket_detalle d
     JOIN tickets t ON t.id = d.ticket_id
     LEFT JOIN productos p ON p.id = d.producto_id
     LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE t.turno_id = $1 AND t.estado = 'pagado'
     GROUP BY 1 ORDER BY 2 DESC`,
    [turnoId]
  );

  const movs = await db.query(
    `SELECT tipo, monto, concepto, fecha FROM movimientos_caja WHERE turno_id = $1 ORDER BY fecha ASC`,
    [turnoId]
  );
  let depositos = 0, retiros = 0;
  movs.rows.forEach(m => { if (m.tipo === 'ingreso') depositos += parseFloat(m.monto); else retiros += parseFloat(m.monto); });

  const cancel = await db.query(
    `SELECT COUNT(*) AS n FROM tickets
     WHERE sucursal_id = $1 AND estado = 'cancelado' AND fecha_creacion >= $2 AND fecha_creacion <= COALESCE($3, NOW())`,
    [turno.sucursal_id, turno.fecha_apertura, turno.fecha_cierre]
  );

  const nombres = await db.query(
    `SELECT id, nombre FROM usuarios WHERE id = ANY($1::int[])`,
    [[turno.usuario_id, turno.cerrado_por].filter(Boolean)]
  );
  const nombreDe = (id) => (nombres.rows.find(u => u.id === id) || {}).nombre || null;

  const fondo = parseFloat(turno.fondo_inicial);
  const saldoEfectivo = redondear(fondo + formas.efectivo + depositos - retiros);
  const n = tickets.rows.length;

  return {
    turno: {
      id: turno.id,
      estado: turno.estado,
      fecha_apertura: turno.fecha_apertura,
      fecha_cierre: turno.fecha_cierre,
      cajero: nombreDe(turno.usuario_id),
      cerrado_por: nombreDe(turno.cerrado_por)
    },
    caja: {
      fondo_inicial: redondear(fondo),
      efectivo_ventas: formas.efectivo,
      depositos: redondear(depositos),
      retiros: redondear(retiros),
      saldo_efectivo: saldoEfectivo
    },
    formas,
    total_formas: totalFormas,
    ventas: {
      subtotal: redondear(bruto),
      descuentos: redondear(descuentos),
      venta_neta: ventaNeta,
      por_departamento: deptos.rows.map(r => ({ nombre: r.depto, monto: redondear(r.monto) }))
    },
    cuentas: {
      normales: n,
      canceladas: parseInt(cancel.rows[0].n),
      con_descuento: conDescuento,
      promedio: n ? redondear(ventaNeta / n) : 0,
      folio_inicial: n ? tickets.rows[0].folio : null,
      folio_final: n ? tickets.rows[n - 1].folio : null
    },
    movimientos: movs.rows.map(m => ({ tipo: m.tipo, monto: redondear(m.monto), concepto: m.concepto, fecha: m.fecha })),
    declaracion: turno.declaracion || null
  };
}

// Lo que "debería haber" por cada forma de pago al cerrar (efectivo = saldo de caja).
function esperadoPorForma(resumen) {
  return {
    efectivo: resumen.caja.saldo_efectivo,
    tarjeta: resumen.formas.tarjeta,
    transferencia: resumen.formas.transferencia,
    dolares: resumen.formas.dolares,
    cheque: resumen.formas.cheque,
    vales: resumen.formas.vales
  };
}

// Dueño, gerente y jefe general ven y cierran los turnos de todos los cajeros;
// los demás roles solo trabajan con su propio turno (cada cajero su caja).
const esSupervisor = (u) => ['jefe_general', 'dueno', 'gerente'].includes(u.rol);

// Obtener el turno abierto del usuario que consulta (cada cajero tiene su propio turno)
router.get('/actual', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM turnos WHERE sucursal_id = $1 AND usuario_id = $2 AND estado = 'abierto' ORDER BY fecha_apertura DESC LIMIT 1`,
      [req.sucursalId, req.usuario.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el turno actual' });
  }
});

// Abrir turno
router.post('/abrir', verificarToken, requierePermiso('CAJA_ABRIR'), async (req, res) => {
  try {
    const { fondo_inicial } = req.body;

    const abierto = await pool.query(
      `SELECT * FROM turnos WHERE sucursal_id = $1 AND usuario_id = $2 AND estado = 'abierto'`,
      [req.sucursalId, req.usuario.id]
    );
    if (abierto.rows.length > 0) {
      return res.status(400).json({ error: 'Ya tienes un turno abierto' });
    }

    const result = await pool.query(
      `INSERT INTO turnos (sucursal_id, usuario_id, fondo_inicial) VALUES ($1, $2, $3) RETURNING *`,
      [req.sucursalId, req.usuario.id, fondo_inicial || 0]
    );

    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'abrir_turno',
      modulo: 'turnos',
      referencia_id: result.rows[0].id,
      valor_nuevo: { fondo_inicial: fondo_inicial || 0 }
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al abrir el turno' });
  }
});

// Cerrar turno (corte de caja). El cajero DECLARA lo que contó por cada forma
// de pago (efectivo, tarjeta, transferencia, dólares en USD, cheque, vales); el
// sistema compara contra lo esperado y guarda la diferencia.
router.post('/:id/cerrar', verificarToken, requierePermiso('CAJA_CERRAR'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const turnoId = req.params.id;
    const body = req.body || {};

    // Compatibilidad: si solo llega saldo_contado (versión vieja), es el efectivo declarado.
    const declarado = { efectivo: 0, tarjeta: 0, transferencia: 0, dolares: 0, cheque: 0, vales: 0 };
    const entrada = body.declaracion || {};
    FORMAS_PAGO.forEach(k => {
      const v = parseFloat(k === 'efectivo' && body.declaracion === undefined ? body.saldo_contado : entrada[k]);
      if (Number.isFinite(v)) {
        if (v < 0) throw Object.assign(new Error('Los importes declarados no pueden ser negativos'), { status: 400 });
        declarado[k] = v;
      }
    });
    const dolaresUsd = Number.isFinite(parseFloat(entrada.dolares_usd)) ? parseFloat(entrada.dolares_usd) : null;

    await cliente.query('BEGIN');

    const turnoActual = await cliente.query('SELECT * FROM turnos WHERE id = $1 AND sucursal_id = $2 FOR UPDATE', [turnoId, req.sucursalId]);
    if (turnoActual.rows.length === 0) {
      await cliente.query('ROLLBACK');
      return res.status(404).json({ error: 'Turno no encontrado' });
    }
    if (turnoActual.rows[0].estado !== 'abierto') {
      await cliente.query('ROLLBACK');
      return res.status(400).json({ error: 'Este turno ya fue cerrado anteriormente' });
    }
    if (!esSupervisor(req.usuario) && turnoActual.rows[0].usuario_id !== req.usuario.id) {
      await cliente.query('ROLLBACK');
      return res.status(403).json({ error: 'Solo el cajero de este turno (o un gerente) puede cerrarlo' });
    }

    const resumenAntes = await construirResumenTurno(cliente, turnoActual.rows[0]);
    const esperado = esperadoPorForma(resumenAntes);

    let tipoCambio = null;
    if (dolaresUsd !== null) {
      const cfg = await cliente.query('SELECT tipo_cambio_dolar FROM configuracion WHERE sucursal_id = $1 LIMIT 1', [req.sucursalId]);
      tipoCambio = parseFloat((cfg.rows[0] || {}).tipo_cambio_dolar || 0);
      declarado.dolares = tipoCambio > 0 ? dolaresUsd * tipoCambio : 0;
    }

    const diferencias = {};
    let totalDeclarado = 0, totalEsperado = 0;
    FORMAS_PAGO.forEach(k => {
      declarado[k] = redondear(declarado[k]);
      diferencias[k] = redondear(declarado[k] - esperado[k]);
      totalDeclarado += declarado[k];
      totalEsperado += esperado[k];
    });
    totalDeclarado = redondear(totalDeclarado);
    totalEsperado = redondear(totalEsperado);
    const diferenciaTotal = redondear(totalDeclarado - totalEsperado);

    const declaracion = {
      importes: declarado, dolares_usd: dolaresUsd, tipo_cambio: tipoCambio,
      esperado, diferencias, total_declarado: totalDeclarado, total_esperado: totalEsperado, diferencia: diferenciaTotal
    };

    const result = await cliente.query(
      `UPDATE turnos SET estado = 'cerrado', saldo_teorico = $1, saldo_contado = $2, fecha_cierre = NOW(),
              declaracion = $3, cerrado_por = $4
       WHERE id = $5 AND estado = 'abierto' RETURNING *`,
      [resumenAntes.caja.saldo_efectivo, declarado.efectivo, JSON.stringify(declaracion), req.usuario.id, turnoId]
    );

    await registrarBitacora(cliente, {
      usuario_id: req.usuario.id,
      accion: 'cerrar_turno',
      modulo: 'turnos',
      referencia_id: parseInt(turnoId),
      valor_nuevo: { saldo_teorico: resumenAntes.caja.saldo_efectivo, saldo_contado: declarado.efectivo, diferencia_total: diferenciaTotal, diferencias }
    });

    const corte = await construirResumenTurno(cliente, result.rows[0]);
    await cliente.query('COMMIT');

    res.json({
      ...result.rows[0],
      resumen: {
        fondo_inicial: resumenAntes.caja.fondo_inicial,
        ventas_efectivo: resumenAntes.caja.efectivo_ventas,
        ventas_tarjeta: resumenAntes.formas.tarjeta,
        ingresos: resumenAntes.caja.depositos,
        egresos: resumenAntes.caja.retiros,
        diferencia: diferenciaTotal
      },
      corte
    });
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Error al cerrar el turno' });
  } finally {
    cliente.release();
  }
});

// Resumen de un turno (corte X si sigue abierto, corte Z si ya se cerró) — para verlo e imprimirlo.
router.get('/:id/resumen', verificarToken, async (req, res) => {
  try {
    const turnoResult = await pool.query('SELECT * FROM turnos WHERE id = $1 AND sucursal_id = $2', [req.params.id, req.sucursalId]);
    if (turnoResult.rows.length === 0) return res.status(404).json({ error: 'Turno no encontrado' });
    if (!esSupervisor(req.usuario) && turnoResult.rows[0].usuario_id !== req.usuario.id) {
      return res.status(403).json({ error: 'Este turno es de otro cajero' });
    }
    res.json(await construirResumenTurno(pool, turnoResult.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el resumen del turno' });
  }
});

// Historial de turnos
router.get('/historial', verificarToken, async (req, res) => {
  try {
    // Filtros opcionales (buscador de cortes): desde, hasta (YYYY-MM-DD), usuario_id, estado
    const params = [req.sucursalId];
    const filtros = ['t.sucursal_id = $1'];
    const fechaLocal = "(t.fecha_apertura AT TIME ZONE 'America/Mexico_City')::date";
    const esFecha = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    if (esFecha(req.query.desde)) { params.push(req.query.desde); filtros.push(`${fechaLocal} >= $${params.length}`); }
    if (esFecha(req.query.hasta)) { params.push(req.query.hasta); filtros.push(`${fechaLocal} <= $${params.length}`); }
    // Cajero: solo ve sus turnos. Supervisor: todos, o el que elija en el filtro.
    const usuarioFiltro = esSupervisor(req.usuario) ? parseInt(req.query.usuario_id, 10) : req.usuario.id;
    if (usuarioFiltro > 0) { params.push(usuarioFiltro); filtros.push(`t.usuario_id = $${params.length}`); }
    if (['abierto', 'cerrado'].includes(req.query.estado)) { params.push(req.query.estado); filtros.push(`t.estado = $${params.length}`); }
    const limite = Math.min(parseInt(req.query.limite, 10) || 50, 500);
    const result = await pool.query(
      `SELECT t.*, u.nombre AS usuario_nombre FROM turnos t
       JOIN usuarios u ON t.usuario_id = u.id
       WHERE ${filtros.join(' AND ')} ORDER BY t.fecha_apertura DESC LIMIT ${limite}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el historial' });
  }
});

// Solo registra en bitácora que alguien abrió el cajón sin que fuera parte
// de un cobro (ej. para sacar/meter dinero) — la apertura física la hace el
// navegador directo a la impresora; esto es nada más el rastro de auditoría.
router.post('/registrar-apertura-cajon', verificarToken, requierePermiso('CAJA_MOVIMIENTO'), async (req, res) => {
  try {
    const { motivo } = req.body;
    await registrarBitacora(pool, {
      usuario_id: req.usuario.id,
      accion: 'abrir_cajon_manual',
      modulo: 'turnos',
      valor_nuevo: { motivo: motivo || null }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la apertura del cajón' });
  }
});

module.exports = router;
