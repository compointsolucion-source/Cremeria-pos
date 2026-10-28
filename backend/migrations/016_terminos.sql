-- Aceptación de los Términos y condiciones de Compoint Punto dentro del sistema.
-- Se guarda quién, cuándo, desde dónde, qué versión y la "huella" (SHA-256) del texto aceptado,
-- como constancia electrónica (Código de Comercio, art. 89 Bis). Nunca se borra ni se edita.
CREATE TABLE IF NOT EXISTS terminos_aceptaciones (
  id             SERIAL PRIMARY KEY,
  version        VARCHAR(20)  NOT NULL,
  huella         VARCHAR(64)  NOT NULL,
  usuario_id     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  usuario_nombre VARCHAR(120),
  usuario_rol    VARCHAR(30),
  ip             VARCHAR(60),
  navegador      VARCHAR(300),
  medio          VARCHAR(20)  NOT NULL DEFAULT 'sistema',
  creado_en      TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_terminos_version ON terminos_aceptaciones (version, creado_en DESC);
