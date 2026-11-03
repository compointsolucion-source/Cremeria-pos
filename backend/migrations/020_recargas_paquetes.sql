-- Paquetes de celular (Amigo Sin Límite, internet…): se guarda el nombre del paquete vendido.
ALTER TABLE IF EXISTS recargas_ventas ADD COLUMN IF NOT EXISTS producto VARCHAR(80);
