-- Tienda en línea: cada negocio escoge cómo se ve su tienda (tema) y, si quiere, sus colores.
ALTER TABLE tienda_config ADD COLUMN IF NOT EXISTS tema TEXT NOT NULL DEFAULT 'letrero';
ALTER TABLE tienda_config ADD COLUMN IF NOT EXISTS color_principal TEXT;
ALTER TABLE tienda_config ADD COLUMN IF NOT EXISTS color_oferta TEXT;

ALTER TABLE tienda_config DROP CONSTRAINT IF EXISTS tienda_config_tema_check;
ALTER TABLE tienda_config ADD CONSTRAINT tienda_config_tema_check CHECK (tema IN
  ('letrero','libreta','minisuper','tianguis','color','pizarron','receta','cuadritos','estraza','taller'));
ALTER TABLE tienda_config DROP CONSTRAINT IF EXISTS tienda_config_colores_check;
ALTER TABLE tienda_config ADD CONSTRAINT tienda_config_colores_check CHECK (
  (color_principal IS NULL OR color_principal ~ '^#[0-9A-Fa-f]{6}$') AND (color_oferta IS NULL OR color_oferta ~ '^#[0-9A-Fa-f]{6}$'));
