-- Declaración de importes al cerrar el turno (por forma de pago) y quién cerró.
DO $$
BEGIN
  IF to_regclass('public.turnos') IS NOT NULL THEN
    ALTER TABLE turnos
      ADD COLUMN IF NOT EXISTS declaracion JSONB,
      ADD COLUMN IF NOT EXISTS cerrado_por INTEGER;
  END IF;
END $$;
