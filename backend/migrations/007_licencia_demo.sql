-- Licencia con prueba de 30 días, códigos de activación firmados y plan (sin nube / con nube).
-- Las instalaciones que ya tienen su fila de licencia (renta anual) quedan igual:
-- tipo 'anual', plan 'nube', sin código (siguen valiendo por su fecha de vencimiento).
ALTER TABLE licencia
  ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'anual',          -- demo | anual | permanente
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'nube',           -- local (sin nube) | nube
  ADD COLUMN IF NOT EXISTS max_sucursales INTEGER,                      -- NULL = usa la variable MAX_SUCURSALES
  ADD COLUMN IF NOT EXISTS codigo_activacion TEXT,                      -- código firmado (si se activó con código)
  ADD COLUMN IF NOT EXISTS serial BIGINT,
  ADD COLUMN IF NOT EXISTS ultima_fecha_vista DATE;                     -- candado contra atrasar el reloj

-- Identificador propio de esta instalación (sirve para ligar el código de activación a ella).
-- No se copia al espejo en la nube (ver EXCLUIDAS en routes/sync.js).
CREATE TABLE IF NOT EXISTS instalacion (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  id_instalacion TEXT NOT NULL,
  creada_en TIMESTAMP NOT NULL DEFAULT NOW()
);
