-- Referencia de pago: un comentario que el cajero escribe al cobrar con tarjeta o transferencia
-- (por ejemplo "Terminal Banorte" o "BBVA, Juan Pérez"). Es solo para control interno: no sale en el ticket del cliente.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS referencia_pago VARCHAR(100);
