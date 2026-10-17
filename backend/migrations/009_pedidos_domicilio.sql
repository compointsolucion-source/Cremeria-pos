-- Pedidos a domicilio / para recoger / programados, repartidores y pedidos fijos de tiendas.
-- Todo es nuevo (nada se borra ni se cambia de lo que ya existe, salvo ampliar los roles permitidos).

-- ---------------------------------------------------------------- clientes
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tipo VARCHAR(10) NOT NULL DEFAULT 'publico' CHECK (tipo IN ('publico', 'tienda'));
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS usa_mayoreo BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------- usuarios: rol Repartidor + teléfono
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefono VARCHAR(20);
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('jefe_general', 'dueno', 'gerente', 'cajero', 'mostrador', 'repartidor'));

-- ---------------------------------------------------------------- configuración de pedidos
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS pedidos_envio_gratis_desde NUMERIC(10,2) NOT NULL DEFAULT 0;   -- 0 = no hay envío gratis
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS pedidos_min_preparacion INTEGER NOT NULL DEFAULT 30;           -- minutos antes de la entrega en que se avisa para preparar
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS pedidos_hora_aviso_fijos VARCHAR(5) NOT NULL DEFAULT '18:00'; -- a esta hora se generan los pedidos fijos de mañana
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS pedidos_foto_obligatoria BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS pedidos_firma_obligatoria BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------- zonas de envío
CREATE TABLE IF NOT EXISTS zonas_envio (
  id SERIAL PRIMARY KEY,
  sucursal_id INTEGER,
  nombre VARCHAR(80) NOT NULL,
  descripcion VARCHAR(160),
  costo NUMERIC(10,2) NOT NULL DEFAULT 0,
  envio_gratis_desde NUMERIC(10,2),          -- NULL = usa el monto general de la configuración
  orden INTEGER NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS zonas_envio_sucursal_idx ON zonas_envio (sucursal_id);

-- ---------------------------------------------------------------- direcciones del cliente
CREATE TABLE IF NOT EXISTS cliente_direcciones (
  id SERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  alias VARCHAR(60),                          -- Casa, Trabajo, Sucursal Centro...
  calle TEXT NOT NULL,
  colonia TEXT,
  cp VARCHAR(10),
  ciudad TEXT,
  referencias TEXT,
  latitud NUMERIC(10,7),
  longitud NUMERIC(10,7),
  ubicacion_enlace TEXT,                      -- el enlace/ubicación tal como lo mandó el cliente
  zona_id INTEGER,
  principal BOOLEAN NOT NULL DEFAULT FALSE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_uso TIMESTAMP,
  creado_en TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cliente_direcciones_cliente_idx ON cliente_direcciones (cliente_id);

-- ---------------------------------------------------------------- liquidaciones del repartidor
CREATE TABLE IF NOT EXISTS liquidaciones_repartidor (
  id SERIAL PRIMARY KEY,
  sucursal_id INTEGER,
  repartidor_id INTEGER NOT NULL,
  turno_id INTEGER,
  recibido_por INTEGER,                       -- quien contó y recibió el dinero
  creada_en TIMESTAMP NOT NULL DEFAULT NOW(),
  num_pedidos INTEGER NOT NULL DEFAULT 0,
  esperado_efectivo NUMERIC(10,2) NOT NULL DEFAULT 0,
  entregado_efectivo NUMERIC(10,2) NOT NULL DEFAULT 0,
  diferencia NUMERIC(10,2) NOT NULL DEFAULT 0,   -- entregado - esperado (negativo = faltó)
  total_transferencia NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_tarjeta NUMERIC(10,2) NOT NULL DEFAULT 0,
  notas TEXT
);
CREATE INDEX IF NOT EXISTS liquidaciones_repartidor_idx ON liquidaciones_repartidor (sucursal_id, repartidor_id);

-- ---------------------------------------------------------------- pedidos fijos (tiendas y clientes frecuentes)
CREATE TABLE IF NOT EXISTS pedidos_fijos (
  id SERIAL PRIMARY KEY,
  sucursal_id INTEGER,
  cliente_id INTEGER NOT NULL,
  direccion_id INTEGER,
  nombre VARCHAR(100),
  dias VARCHAR(20) NOT NULL,                  -- días de la semana en que se entrega: 0=domingo ... 6=sábado, ej. '1,3,5'
  hora VARCHAR(5) NOT NULL DEFAULT '09:00',   -- hora de entrega
  tipo VARCHAR(10) NOT NULL DEFAULT 'domicilio' CHECK (tipo IN ('domicilio', 'recoger')),
  pago_modo VARCHAR(12) NOT NULL DEFAULT 'credito' CHECK (pago_modo IN ('al_recibir', 'pagado', 'credito')),
  zona_id INTEGER,
  repartidor_id INTEGER,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{producto_id, nombre, cantidad}]
  notas TEXT,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pedidos_fijos_sucursal_idx ON pedidos_fijos (sucursal_id);

-- ---------------------------------------------------------------- pedidos
CREATE TABLE IF NOT EXISTS pedidos (
  id SERIAL PRIMARY KEY,
  sucursal_id INTEGER,
  ticket_id INTEGER NOT NULL UNIQUE REFERENCES tickets(id),
  cliente_id INTEGER,
  direccion_id INTEGER,
  tipo VARCHAR(10) NOT NULL DEFAULT 'domicilio' CHECK (tipo IN ('domicilio', 'recoger')),
  estado VARCHAR(14) NOT NULL DEFAULT 'preparando'
    CHECK (estado IN ('programado', 'preparando', 'listo', 'en_camino', 'entregado', 'no_entregado', 'cancelado')),
  -- datos de contacto y dirección tal como estaban al hacer el pedido (no cambian si luego editan al cliente)
  nombre_contacto VARCHAR(150),
  telefono VARCHAR(30),
  calle TEXT,
  colonia TEXT,
  cp VARCHAR(10),
  ciudad TEXT,
  referencias TEXT,
  latitud NUMERIC(10,7),
  longitud NUMERIC(10,7),
  ubicacion_enlace TEXT,
  zona_id INTEGER,
  costo_envio NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- cobro
  pago_modo VARCHAR(12) NOT NULL DEFAULT 'al_recibir' CHECK (pago_modo IN ('al_recibir', 'pagado', 'credito')),
  paga_con NUMERIC(10,2),                     -- con cuánto va a pagar el cliente (para llevar cambio)
  metodo_cobro VARCHAR(15),                   -- cómo pagó al repartidor: efectivo | transferencia | tarjeta
  monto_cobrado NUMERIC(10,2),
  -- fechas
  programado_para TIMESTAMP,                  -- hora local de entrega que pidió el cliente (NULL = lo antes posible)
  fecha_entrega DATE,                         -- el día de programado_para (para agenda y pedidos fijos)
  preparar_desde TIMESTAMP,                   -- hora local en que pasa solo de Programado a Preparando
  creado_en TIMESTAMP NOT NULL DEFAULT NOW(),
  creado_por INTEGER,
  listo_en TIMESTAMP,
  salio_en TIMESTAMP,
  llego_en TIMESTAMP,
  entregado_en TIMESTAMP,
  aviso_camino_en TIMESTAMP,                  -- cuándo se avisó al cliente por WhatsApp que va en camino
  -- reparto
  repartidor_id INTEGER,
  orden_ruta INTEGER,
  notas TEXT,
  motivo_no_entrega TEXT,
  motivo_cancelacion TEXT,
  liquidacion_id INTEGER,
  origen VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual', 'fijo')),
  pedido_fijo_id INTEGER
);
CREATE INDEX IF NOT EXISTS pedidos_sucursal_estado_idx ON pedidos (sucursal_id, estado);
CREATE INDEX IF NOT EXISTS pedidos_fecha_entrega_idx ON pedidos (sucursal_id, fecha_entrega);
CREATE INDEX IF NOT EXISTS pedidos_repartidor_idx ON pedidos (repartidor_id, estado);
-- un pedido fijo genera como máximo un pedido por día
CREATE UNIQUE INDEX IF NOT EXISTS pedidos_fijo_dia_idx ON pedidos (pedido_fijo_id, fecha_entrega) WHERE pedido_fijo_id IS NOT NULL;

-- ---------------------------------------------------------------- foto / firma de entrega
CREATE TABLE IF NOT EXISTS pedido_evidencias (
  id SERIAL PRIMARY KEY,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  tipo VARCHAR(10) NOT NULL CHECK (tipo IN ('foto', 'firma')),
  dato TEXT NOT NULL,                         -- imagen pequeña en formato data:image/...
  creado_por INTEGER,
  creado_en TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pedido_evidencias_pedido_idx ON pedido_evidencias (pedido_id);
