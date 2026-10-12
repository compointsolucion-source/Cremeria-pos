-- Facturación: los clientes piden su factura desde una página pública
-- (facturar.html) con el folio de su ticket y sus datos fiscales.
CREATE TABLE IF NOT EXISTS facturacion_solicitudes (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  sucursal_id INTEGER,
  folio VARCHAR(20) NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  rfc VARCHAR(13) NOT NULL,
  razon_social VARCHAR(200) NOT NULL,
  regimen_fiscal VARCHAR(3) NOT NULL,
  codigo_postal VARCHAR(5) NOT NULL,
  uso_cfdi VARCHAR(4) NOT NULL,
  correo VARCHAR(150) NOT NULL,
  telefono VARCHAR(20),
  estado VARCHAR(12) NOT NULL DEFAULT 'pendiente',
  nota_admin TEXT,
  uuid_factura VARCHAR(60),
  constancia_nombre VARCHAR(150),
  constancia_tipo VARCHAR(30),
  constancia_datos BYTEA,
  creado_en TIMESTAMP NOT NULL DEFAULT NOW(),
  actualizado_en TIMESTAMP NOT NULL DEFAULT NOW(),
  atendido_por INTEGER
);

-- Un ticket solo puede tener una solicitud vigente (si se rechaza, puede volver a pedirla).
CREATE UNIQUE INDEX IF NOT EXISTS facturacion_un_ticket_vigente
  ON facturacion_solicitudes (ticket_id) WHERE estado <> 'rechazada';
CREATE INDEX IF NOT EXISTS facturacion_estado_idx ON facturacion_solicitudes (sucursal_id, estado, creado_en DESC);

DO $$
BEGIN
  IF to_regclass('public.configuracion') IS NOT NULL THEN
    ALTER TABLE configuracion
      ADD COLUMN IF NOT EXISTS facturacion_activa BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS facturacion_dias_limite INTEGER NOT NULL DEFAULT 30,
      ADD COLUMN IF NOT EXISTS facturacion_leyenda_ticket BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;
