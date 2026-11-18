-- Candados de dinero: la base de datos ya no acepta totales, pagos, precios, cantidades ni descuentos
-- negativos en ventas, ni fondo inicial negativo en un turno. (El sistema ya lo revisaba; esto es la
-- segunda cerradura por si algún día un error se lo salta.)
-- Cada candado se pone SOLO si ninguna venta vieja lo rompe; si alguna lo rompe, se omite ese candado
-- (queda el aviso en los Logs) y la actualización sigue normal.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_tickets_dinero') THEN
    IF NOT EXISTS (SELECT 1 FROM tickets WHERE total < 0 OR descuento_monto < 0 OR COALESCE(monto_efectivo, 0) < 0
                   OR COALESCE(monto_tarjeta, 0) < 0 OR COALESCE(efectivo_recibido, 0) < 0) THEN
      ALTER TABLE tickets ADD CONSTRAINT ck_tickets_dinero CHECK (total >= 0 AND descuento_monto >= 0
        AND COALESCE(monto_efectivo, 0) >= 0 AND COALESCE(monto_tarjeta, 0) >= 0 AND COALESCE(efectivo_recibido, 0) >= 0);
    ELSE
      RAISE NOTICE 'Hay tickets viejos con montos negativos: no se puso el candado ck_tickets_dinero';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ticket_detalle_dinero') THEN
    IF NOT EXISTS (SELECT 1 FROM ticket_detalle WHERE cantidad <= 0 OR precio_unitario < 0 OR subtotal < 0
                   OR descuento_monto < 0 OR cantidad_devuelta < 0) THEN
      ALTER TABLE ticket_detalle ADD CONSTRAINT ck_ticket_detalle_dinero CHECK (cantidad > 0 AND precio_unitario >= 0
        AND subtotal >= 0 AND descuento_monto >= 0 AND cantidad_devuelta >= 0);
    ELSE
      RAISE NOTICE 'Hay renglones viejos con cantidades o montos negativos: no se puso el candado ck_ticket_detalle_dinero';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_turnos_fondo') THEN
    IF NOT EXISTS (SELECT 1 FROM turnos WHERE fondo_inicial < 0) THEN
      ALTER TABLE turnos ADD CONSTRAINT ck_turnos_fondo CHECK (fondo_inicial >= 0);
    ELSE
      RAISE NOTICE 'Hay turnos viejos con fondo negativo: no se puso el candado ck_turnos_fondo';
    END IF;
  END IF;
END $$;
