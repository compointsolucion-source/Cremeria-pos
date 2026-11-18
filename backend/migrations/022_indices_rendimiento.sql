-- Índices para que las ventas, cortes, historiales y créditos sigan rápidos con meses o años de información.
-- (PostgreSQL no crea índices solos para las columnas que apuntan a otra tabla.)
CREATE INDEX IF NOT EXISTS idx_tickets_suc_fecha ON tickets (sucursal_id, (COALESCE(fecha_pago, fecha_creacion)));
CREATE INDEX IF NOT EXISTS idx_tickets_suc_estado ON tickets (sucursal_id, estado, fecha_pago DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_turno ON tickets (turno_id);
CREATE INDEX IF NOT EXISTS idx_tickets_cajero ON tickets (cajero_usuario_id);
CREATE INDEX IF NOT EXISTS idx_tickets_cliente ON tickets (cliente_id);
CREATE INDEX IF NOT EXISTS idx_ticket_detalle_ticket ON ticket_detalle (ticket_id);
CREATE INDEX IF NOT EXISTS idx_mov_inv_producto_fecha ON movimientos_inventario (producto_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_mov_inv_referencia ON movimientos_inventario (referencia_id);
CREATE INDEX IF NOT EXISTS idx_productos_suc_activo ON productos (sucursal_id, activo);
CREATE INDEX IF NOT EXISTS idx_creditos_cargo_ticket ON creditos_cargo (ticket_id);
CREATE INDEX IF NOT EXISTS idx_creditos_cargo_cliente ON creditos_cargo (cliente_id);
CREATE INDEX IF NOT EXISTS idx_creditos_abono_cliente ON creditos_abono (cliente_id);
CREATE INDEX IF NOT EXISTS idx_devoluciones_ticket ON devoluciones (ticket_id);
CREATE INDEX IF NOT EXISTS idx_turnos_abierto ON turnos (sucursal_id, usuario_id) WHERE estado = 'abierto';

-- Un mismo usuario no puede tener DOS turnos de caja abiertos en la misma sucursal (doble clic, dos pestañas).
-- Si ya hubiera alguno duplicado de antes, no se crea el candado (para no frenar la actualización);
-- en ese caso hay que cerrar el turno duplicado y crear el candado a mano (queda el aviso en los Logs).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM turnos WHERE estado = 'abierto' GROUP BY sucursal_id, usuario_id HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS ux_turno_abierto_usuario ON turnos (sucursal_id, usuario_id) WHERE estado = 'abierto';
  ELSE
    RAISE NOTICE 'Hay turnos abiertos duplicados: no se creó el candado ux_turno_abierto_usuario';
  END IF;
END $$;
