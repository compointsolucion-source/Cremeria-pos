-- Recargas de tiempo aire y pago de servicios (CFE, Telmex, agua, etc.).
-- Cada venta queda guardada con su turno de caja, para que entre al corte.
-- Las ventas en "modo prueba" (sin proveedor conectado) se guardan pero NO cuentan en el corte.
CREATE TABLE IF NOT EXISTS recargas_ventas (
  id              SERIAL PRIMARY KEY,
  sucursal_id     INTEGER NOT NULL REFERENCES sucursales(id),
  turno_id        INTEGER REFERENCES turnos(id),
  usuario_id      INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo            VARCHAR(10)   NOT NULL,              -- recarga | servicio
  compania        VARCHAR(30)   NOT NULL,              -- telcel, cfe, ...
  referencia      VARCHAR(40)   NOT NULL,              -- número de celular o número de servicio
  monto           NUMERIC(10,2) NOT NULL,              -- lo que se abona al celular o al recibo
  cargo           NUMERIC(10,2) NOT NULL DEFAULT 0,    -- lo que cobra el negocio de más (servicios)
  total           NUMERIC(10,2) NOT NULL,              -- monto + cargo = lo que paga el cliente
  metodo_pago     VARCHAR(15)   NOT NULL DEFAULT 'efectivo',
  estado          VARCHAR(12)   NOT NULL DEFAULT 'pendiente', -- pendiente | exitosa | fallida
  modo_prueba     BOOLEAN       NOT NULL DEFAULT TRUE,
  folio_proveedor VARCHAR(60),
  mensaje         VARCHAR(200),
  clave           VARCHAR(40),                         -- evita cobrar dos veces el mismo clic
  fecha           TIMESTAMP     NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_recargas_clave ON recargas_ventas (sucursal_id, clave) WHERE clave IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recargas_turno ON recargas_ventas (turno_id);
CREATE INDEX IF NOT EXISTS idx_recargas_suc_fecha ON recargas_ventas (sucursal_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_recargas_repetida ON recargas_ventas (sucursal_id, referencia, fecha DESC);

-- Ajustes del módulo (una sola fila por negocio).
CREATE TABLE IF NOT EXISTS recargas_config (
  id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  activo         BOOLEAN       NOT NULL DEFAULT TRUE,
  cargo_servicio NUMERIC(8,2)  NOT NULL DEFAULT 10,   -- comisión por pagar un recibo
  comision_pct   NUMERIC(5,2)  NOT NULL DEFAULT 0,    -- lo que paga el proveedor por recarga (solo informativo)
  actualizado_en TIMESTAMP     NOT NULL DEFAULT NOW()
);
INSERT INTO recargas_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
