-- Control de licencia anual (una sola fila por instalación).
CREATE TABLE IF NOT EXISTS licencia (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cliente TEXT,
  fecha_inicio DATE NOT NULL,
  fecha_vencimiento DATE NOT NULL,
  actualizado_en TIMESTAMP NOT NULL DEFAULT NOW()
);
