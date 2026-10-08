-- Columnas agregadas a "configuracion" después de la primera versión.
-- Es idempotente: se puede correr en bases nuevas o ya actualizadas.
DO $$
BEGIN
  IF to_regclass('public.configuracion') IS NOT NULL THEN
    ALTER TABLE configuracion
      ADD COLUMN IF NOT EXISTS etiqueta_modo TEXT NOT NULL DEFAULT 'auto',
      ADD COLUMN IF NOT EXISTS ancho_etiqueta TEXT NOT NULL DEFAULT '50mm',
      ADD COLUMN IF NOT EXISTS bascula_tipo_dato TEXT NOT NULL DEFAULT 'peso';
  END IF;
END $$;
