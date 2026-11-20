-- Preparación para la red de tiendas de Compoint Pedidos (se prende cuando haya más de 100 clientes).
-- Por ahora solo se guarda: dónde está la tienda y si el dueño quiere aparecer. Nadie más lo lee todavía.
ALTER TABLE tienda_config ADD COLUMN IF NOT EXISTS red_visible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tienda_config ADD COLUMN IF NOT EXISTS red_lat NUMERIC(9,6);
ALTER TABLE tienda_config ADD COLUMN IF NOT EXISTS red_lng NUMERIC(9,6);
ALTER TABLE tienda_config ADD COLUMN IF NOT EXISTS red_direccion TEXT;
ALTER TABLE tienda_config ADD COLUMN IF NOT EXISTS red_domicilio BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE tienda_config ADD COLUMN IF NOT EXISTS red_recoger BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tienda_config ADD COLUMN IF NOT EXISTS red_buscar BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE tienda_config DROP CONSTRAINT IF EXISTS tienda_config_red_check;
ALTER TABLE tienda_config ADD CONSTRAINT tienda_config_red_check CHECK (
  (red_lat IS NULL) = (red_lng IS NULL)
  AND (red_lat IS NULL OR (red_lat BETWEEN -90 AND 90 AND red_lng BETWEEN -180 AND 180))
  AND (NOT red_visible OR red_lat IS NOT NULL));
