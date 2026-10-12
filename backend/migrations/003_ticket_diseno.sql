-- Diseño del ticket: nombre, mensaje, tamaños de letra, acentos, logo y QR de promoción.
-- Es idempotente: se puede correr en bases nuevas o ya actualizadas.
DO $$
BEGIN
  IF to_regclass('public.configuracion') IS NOT NULL THEN
    ALTER TABLE configuracion
      ADD COLUMN IF NOT EXISTS nombre_negocio TEXT,
      ADD COLUMN IF NOT EXISTS mensaje_superior TEXT,
      ADD COLUMN IF NOT EXISTS ticket_letra TEXT,
      ADD COLUMN IF NOT EXISTS ticket_nombre_tamano TEXT NOT NULL DEFAULT 'grande',
      ADD COLUMN IF NOT EXISTS ticket_total_tamano TEXT NOT NULL DEFAULT 'grande',
      ADD COLUMN IF NOT EXISTS ticket_acentos TEXT NOT NULL DEFAULT 'quitar',
      ADD COLUMN IF NOT EXISTS ticket_logo_tamano TEXT NOT NULL DEFAULT 'mediano',
      ADD COLUMN IF NOT EXISTS ticket_logo_en_mostrador BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS qr_promo_activo BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS qr_promo_contenido TEXT,
      ADD COLUMN IF NOT EXISTS qr_promo_texto TEXT,
      ADD COLUMN IF NOT EXISTS qr_promo_tamano TEXT NOT NULL DEFAULT 'mediano',
      ADD COLUMN IF NOT EXISTS qr_promo_en_mostrador BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;
