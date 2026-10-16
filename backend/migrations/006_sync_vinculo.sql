-- Clave de sincronización guardada EN LA NUBE.
-- Se crea sola cuando el dueño vincula el servidor del negocio con su usuario y contraseña
-- (así no hace falta tocar variables en Render). Solo se guarda el "hash" de la clave.
-- Esta tabla NO se copia al espejo (ver EXCLUIDAS en routes/sync.js).
CREATE TABLE IF NOT EXISTS sync_vinculo (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  clave_hash TEXT NOT NULL,
  vinculado_por TEXT,
  vinculado_en TIMESTAMP NOT NULL DEFAULT NOW()
);
