-- Recuperar la contraseña desde el login: correo de cada usuario + códigos de un solo uso.
-- El código de 6 dígitos NO se guarda: solo su huella (hash). Vale 15 minutos y 5 intentos.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS correo VARCHAR(120);

CREATE TABLE IF NOT EXISTS recuperacion_codigos (
  id          SERIAL PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  codigo_hash TEXT NOT NULL,
  expira_en   TIMESTAMP NOT NULL,
  intentos    INTEGER NOT NULL DEFAULT 0,
  usado       BOOLEAN NOT NULL DEFAULT false,
  creado_en   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recuperacion_usuario ON recuperacion_codigos (usuario_id, creado_en DESC);
