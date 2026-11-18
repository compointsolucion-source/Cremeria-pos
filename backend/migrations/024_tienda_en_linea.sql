-- Tienda en línea: los clientes del negocio piden desde su celular y el pedido llega a Pedidos
-- como "Por confirmar" (un pedido programado SIN enviar a preparar, con origen 'en_linea').
-- Al dar ✓ Confirmar pasa a "Preparando" y sigue el camino de siempre (Listo → En camino → Entregado).

CREATE TABLE IF NOT EXISTS tienda_config (
  sucursal_id INTEGER PRIMARY KEY,
  activo BOOLEAN NOT NULL DEFAULT FALSE,                  -- recibir pedidos por internet
  giro VARCHAR(120),                                      -- "Pañales, abarrotes y lácteos en la colonia Centro"
  horario JSONB NOT NULL DEFAULT '{"semana":["08:00","20:00"],"domingo":["09:00","14:00"]}',
  tiempo_entrega VARCHAR(40) NOT NULL DEFAULT '30 a 45 min',
  pedido_minimo NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (pedido_minimo >= 0),
  max_pendientes_por_telefono INTEGER NOT NULL DEFAULT 2 CHECK (max_pendientes_por_telefono BETWEEN 1 AND 20),
  acepta_tarjeta BOOLEAN NOT NULL DEFAULT TRUE,           -- el repartidor lleva terminal
  fiado_en_linea BOOLEAN NOT NULL DEFAULT TRUE,           -- "Anótalo a mi cuenta" (solo con enlace personal)
  ocultar_sin_existencia BOOLEAN NOT NULL DEFAULT TRUE,
  imprimir_al_confirmar BOOLEAN NOT NULL DEFAULT TRUE,
  sonido BOOLEAN NOT NULL DEFAULT TRUE,
  actualizado_en TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Cada producto se puede ocultar de la tienda (por defecto se ve).
ALTER TABLE productos ADD COLUMN IF NOT EXISTS en_tienda BOOLEAN NOT NULL DEFAULT TRUE;

-- Enlace personal de un cliente con crédito: con él ve su saldo y puede pedir "a su cuenta".
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS enlace_tienda VARCHAR(40);
CREATE UNIQUE INDEX IF NOT EXISTS clientes_enlace_tienda_uq ON clientes (enlace_tienda) WHERE enlace_tienda IS NOT NULL;

-- Datos del pedido en línea.
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS seguimiento VARCHAR(40),        -- clave del enlace de seguimiento del cliente
  ADD COLUMN IF NOT EXISTS si_falta VARCHAR(12),           -- parecido | llamar | quitar
  ADD COLUMN IF NOT EXISTS pago_previsto VARCHAR(12),      -- efectivo | tarjeta | cuenta
  ADD COLUMN IF NOT EXISTS confirmado_en TIMESTAMP;        -- cuándo lo confirmó la tienda
CREATE UNIQUE INDEX IF NOT EXISTS pedidos_seguimiento_uq ON pedidos (seguimiento) WHERE seguimiento IS NOT NULL;
CREATE INDEX IF NOT EXISTS pedidos_en_linea_idx ON pedidos (sucursal_id, telefono) WHERE origen = 'en_linea' AND confirmado_en IS NULL;

ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_origen_check;
ALTER TABLE pedidos ADD CONSTRAINT pedidos_origen_check CHECK (origen IN ('manual', 'fijo', 'en_linea'));
