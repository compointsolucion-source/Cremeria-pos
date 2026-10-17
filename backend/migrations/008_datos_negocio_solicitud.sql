-- Datos del negocio (para agilizar el registro al contratar) y cola de solicitudes de licencia.
-- Son de ESTA instalación; no se copian al espejo en la nube (ver EXCLUIDAS en routes/sync.js).
CREATE TABLE IF NOT EXISTS datos_negocio (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  negocio TEXT,
  giro TEXT,
  nombre_dueno TEXT,
  telefono TEXT,
  whatsapp TEXT,
  email TEXT,
  direccion TEXT,
  ciudad TEXT,
  estado TEXT,
  cp TEXT,
  sucursales INTEGER,
  rfc TEXT,
  razon_social TEXT,
  cp_fiscal TEXT,
  email_factura TEXT,
  completado BOOLEAN NOT NULL DEFAULT FALSE,   -- ya capturó lo mínimo (negocio, contacto y teléfono)
  bienvenida_vista_en DATE,                    -- último día en que se le mostró la bienvenida del demo
  acepto_privacidad_en TIMESTAMP,              -- cuándo aceptó el aviso al enviar su solicitud
  version_aviso INTEGER,
  actualizado_en TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS licencia_solicitud (
  id SERIAL PRIMARY KEY,
  creada_en TIMESTAMP NOT NULL DEFAULT NOW(),
  tipo TEXT NOT NULL,                          -- contratar | renovar
  plan TEXT NOT NULL,                          -- local (sin nube) | nube
  sucursales INTEGER NOT NULL DEFAULT 1,
  codigo TEXT NOT NULL,                        -- código de solicitud (CPT-REQ-...)
  estado TEXT NOT NULL DEFAULT 'pendiente',    -- pendiente | enviada | rechazada | reemplazada | vencida
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_intento TIMESTAMP,
  enviada_en TIMESTAMP,
  ultimo_error TEXT
);
CREATE INDEX IF NOT EXISTS licencia_solicitud_estado_idx ON licencia_solicitud (estado);
