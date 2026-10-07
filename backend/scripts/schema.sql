-- Estructura de Compoint Punto generada por exportar-esquema.js
-- 2026-10-07T19:18:50.193Z


CREATE TABLE "bitacora" (
  "id" SERIAL,
  "usuario_id" integer,
  "accion" character varying(50) NOT NULL,
  "modulo" character varying(50) NOT NULL,
  "referencia_id" integer,
  "valor_anterior" jsonb,
  "valor_nuevo" jsonb,
  "fecha" timestamp without time zone DEFAULT now()
);

CREATE TABLE "categorias" (
  "id" SERIAL,
  "nombre" character varying(50) NOT NULL,
  "orden" integer DEFAULT 0
);

CREATE TABLE "clientes" (
  "id" SERIAL,
  "sucursal_id" integer,
  "nombre" character varying(150) NOT NULL,
  "telefono" character varying(20),
  "limite_credito" numeric(10,2) DEFAULT 0,
  "saldo_actual" numeric(10,2) DEFAULT 0,
  "activo" boolean DEFAULT true,
  "creado_en" timestamp without time zone DEFAULT now()
);

CREATE TABLE "compra_detalle" (
  "id" SERIAL,
  "compra_id" integer,
  "producto_id" integer,
  "cantidad" numeric(10,3) NOT NULL,
  "costo_unitario" numeric(10,2) NOT NULL,
  "precio_venta_nuevo" numeric(10,2),
  "subtotal" numeric(10,2) NOT NULL
);

CREATE TABLE "compras" (
  "id" SERIAL,
  "sucursal_id" integer,
  "proveedor_id" integer,
  "usuario_id" integer,
  "total" numeric(10,2) DEFAULT 0 NOT NULL,
  "fecha" timestamp without time zone DEFAULT now()
);

CREATE TABLE "configuracion" (
  "id" SERIAL,
  "sucursal_id" integer,
  "logo_url" text,
  "direccion" text,
  "telefono" character varying(20),
  "rfc" character varying(20),
  "ancho_ticket" character varying(5) DEFAULT '80mm'::character varying,
  "terminos" text,
  "lineas_superiores" integer DEFAULT 0 NOT NULL,
  "lineas_inferiores" integer DEFAULT 3 NOT NULL,
  "incluir_precio_unitario" boolean DEFAULT true NOT NULL,
  "descripcion_completa" boolean DEFAULT true NOT NULL,
  "imprimir_datos_cliente" boolean DEFAULT false NOT NULL,
  "tipo_codigo_escaneo" character varying(10) DEFAULT 'qr'::character varying NOT NULL,
  "negocio_negritas" boolean DEFAULT true NOT NULL,
  "total_negritas" boolean DEFAULT true NOT NULL,
  "tamano_letra" character varying(10) DEFAULT 'normal'::character varying NOT NULL,
  "tipo_fuente" character varying(20) DEFAULT 'monospace'::character varying NOT NULL,
  "efectivo_bloquear_insuficiente" boolean DEFAULT true NOT NULL,
  "dolares_habilitado" boolean DEFAULT false NOT NULL,
  "tipo_cambio_dolar" numeric(10,4) DEFAULT 0,
  "tarjeta_habilitado" boolean DEFAULT true NOT NULL,
  "tarjeta_comision_porcentaje" numeric(5,2) DEFAULT 0,
  "transferencia_habilitado" boolean DEFAULT true NOT NULL,
  "transferencia_etiqueta" character varying(50) DEFAULT 'Transferencia'::character varying,
  "cheque_habilitado" boolean DEFAULT false NOT NULL,
  "vales_habilitado" boolean DEFAULT false NOT NULL,
  "mixto_habilitado" boolean DEFAULT true NOT NULL,
  "credito_habilitado" boolean DEFAULT true NOT NULL,
  "cajon_abrir_automatico" boolean DEFAULT false NOT NULL,
  "promos_pantalla_turnos" jsonb DEFAULT '[]'::jsonb,
  "promos_intervalo_segundos" integer DEFAULT 10 NOT NULL,
  "promos_orden_aleatorio" boolean DEFAULT false NOT NULL,
  "etiqueta_modo" text DEFAULT 'auto'::text NOT NULL,
  "ancho_etiqueta" text DEFAULT '50mm'::text NOT NULL
);

CREATE TABLE "creditos_abono" (
  "id" SERIAL,
  "cliente_id" integer,
  "monto" numeric(10,2) NOT NULL,
  "metodo_pago" character varying(20),
  "turno_id" integer,
  "recibido_por" integer,
  "fecha" timestamp without time zone DEFAULT now()
);

CREATE TABLE "creditos_cargo" (
  "id" SERIAL,
  "cliente_id" integer,
  "ticket_id" integer,
  "monto" numeric(10,2) NOT NULL,
  "autorizado_por" integer,
  "fecha" timestamp without time zone DEFAULT now()
);

CREATE TABLE "devolucion_detalle" (
  "id" SERIAL,
  "devolucion_id" integer,
  "ticket_detalle_id" integer,
  "cantidad_devuelta" numeric(10,3) NOT NULL,
  "monto_devuelto" numeric(10,2) NOT NULL,
  "regresa_inventario" boolean DEFAULT true NOT NULL
);

CREATE TABLE "devoluciones" (
  "id" SERIAL,
  "ticket_id" integer,
  "turno_id" integer,
  "usuario_id" integer,
  "motivo" character varying(255),
  "monto_total" numeric(10,2) NOT NULL,
  "metodo_reembolso" character varying(20) NOT NULL,
  "fecha" timestamp without time zone DEFAULT now()
);

CREATE TABLE "fichas" (
  "id" SERIAL,
  "sucursal_id" integer,
  "numero" integer NOT NULL,
  "estado" character varying(20) DEFAULT 'esperando'::character varying NOT NULL,
  "mostrador_asignado" character varying(50),
  "fecha_creacion" timestamp without time zone DEFAULT now(),
  "fecha_llamado" timestamp without time zone
);

CREATE TABLE "inventario" (
  "producto_id" integer NOT NULL,
  "existencia_actual" numeric(10,3) DEFAULT 0 NOT NULL,
  "stock_minimo" numeric(10,3) DEFAULT 0,
  "stock_maximo" numeric(10,3)
);

CREATE TABLE "kit_productos" (
  "id" SERIAL,
  "kit_id" integer,
  "producto_id" integer,
  "cantidad" numeric(10,3) NOT NULL
);

CREATE TABLE "kits" (
  "id" SERIAL,
  "sucursal_id" integer,
  "nombre" character varying(150) NOT NULL,
  "precio_kit" numeric(10,2) NOT NULL,
  "imagen_url" text,
  "codigo_barras" character varying(50),
  "activo" boolean DEFAULT true,
  "creado_en" timestamp without time zone DEFAULT now()
);

CREATE TABLE "movimientos_caja" (
  "id" SERIAL,
  "turno_id" integer,
  "usuario_id" integer,
  "tipo" character varying(10) NOT NULL,
  "monto" numeric(10,2) NOT NULL,
  "concepto" character varying(255),
  "fecha" timestamp without time zone DEFAULT now()
);

CREATE TABLE "movimientos_inventario" (
  "id" SERIAL,
  "producto_id" integer,
  "tipo" character varying(20) NOT NULL,
  "cantidad" numeric(10,3) NOT NULL,
  "motivo" character varying(255),
  "referencia_id" integer,
  "usuario_id" integer,
  "fecha" timestamp without time zone DEFAULT now()
);

CREATE TABLE "productos" (
  "id" SERIAL,
  "sucursal_id" integer,
  "categoria_id" integer,
  "nombre" character varying(150) NOT NULL,
  "precio" numeric(10,2) NOT NULL,
  "imagen_url" text,
  "favorito" boolean DEFAULT false,
  "orden" integer DEFAULT 0,
  "activo" boolean DEFAULT true,
  "creado_en" timestamp without time zone DEFAULT now(),
  "codigo_barras" character varying(50),
  "tipo_venta" character varying(10) DEFAULT 'peso'::character varying NOT NULL,
  "precio_costo" numeric(10,2),
  "ganancia_porcentaje" numeric(5,2),
  "precio_mayoreo" numeric(10,2),
  "usa_inventario" boolean DEFAULT true NOT NULL
);

CREATE TABLE "promociones" (
  "id" SERIAL,
  "producto_id" integer,
  "cantidad_minima" numeric(10,3) NOT NULL,
  "precio_promocional" numeric(10,2) NOT NULL,
  "activo" boolean DEFAULT true NOT NULL,
  "creado_en" timestamp without time zone DEFAULT now()
);

CREATE TABLE "proveedores" (
  "id" SERIAL,
  "sucursal_id" integer,
  "nombre" character varying(150) NOT NULL,
  "contacto" character varying(100),
  "telefono" character varying(20),
  "activo" boolean DEFAULT true
);

CREATE TABLE "sucursales" (
  "id" SERIAL,
  "nombre" character varying(100) NOT NULL,
  "direccion" text,
  "telefono" character varying(20),
  "codigo_secreto" character varying(4),
  "activo" boolean DEFAULT true,
  "creado_en" timestamp without time zone DEFAULT now()
);

CREATE TABLE "ticket_detalle" (
  "id" SERIAL,
  "ticket_id" integer,
  "producto_id" integer,
  "nombre_producto" character varying(150) NOT NULL,
  "cantidad" numeric(10,3) NOT NULL,
  "precio_unitario" numeric(10,2) NOT NULL,
  "subtotal" numeric(10,2) NOT NULL,
  "tipo" character varying(10) DEFAULT 'producto'::character varying NOT NULL,
  "kit_id" integer,
  "cantidad_devuelta" numeric(10,3) DEFAULT 0 NOT NULL,
  "descuento_monto" numeric(10,2) DEFAULT 0 NOT NULL,
  "descuento_motivo" character varying(255)
);

CREATE TABLE "tickets" (
  "id" SERIAL,
  "folio" character varying(20) NOT NULL,
  "sucursal_id" integer,
  "mostrador_usuario_id" integer,
  "cajero_usuario_id" integer,
  "turno_id" integer,
  "estado" character varying(20) DEFAULT 'pendiente'::character varying,
  "total" numeric(10,2) DEFAULT 0 NOT NULL,
  "metodo_pago" character varying(20),
  "monto_efectivo" numeric(10,2) DEFAULT 0,
  "monto_tarjeta" numeric(10,2) DEFAULT 0,
  "fecha_creacion" timestamp without time zone DEFAULT now(),
  "fecha_pago" timestamp without time zone,
  "cliente_id" integer,
  "descuento_monto" numeric(10,2) DEFAULT 0 NOT NULL,
  "descuento_motivo" character varying(255),
  "descuento_autorizado_por" integer,
  "efectivo_recibido" numeric(10,2)
);

CREATE TABLE "turnos" (
  "id" SERIAL,
  "sucursal_id" integer,
  "usuario_id" integer,
  "fondo_inicial" numeric(10,2) DEFAULT 0 NOT NULL,
  "saldo_teorico" numeric(10,2) DEFAULT 0,
  "saldo_contado" numeric(10,2),
  "estado" character varying(20) DEFAULT 'abierto'::character varying,
  "fecha_apertura" timestamp without time zone DEFAULT now(),
  "fecha_cierre" timestamp without time zone
);

CREATE TABLE "usuarios" (
  "id" SERIAL,
  "sucursal_id" integer,
  "nombre" character varying(100) NOT NULL,
  "usuario" character varying(50) NOT NULL,
  "password_hash" character varying(255) NOT NULL,
  "rol" character varying(20) NOT NULL,
  "permisos" jsonb DEFAULT '{}'::jsonb,
  "activo" boolean DEFAULT true,
  "creado_en" timestamp without time zone DEFAULT now(),
  "nombre_mostrador" character varying(50)
);

ALTER TABLE "bitacora" ADD CONSTRAINT "bitacora_pkey" PRIMARY KEY (id);
ALTER TABLE "categorias" ADD CONSTRAINT "categorias_pkey" PRIMARY KEY (id);
ALTER TABLE "clientes" ADD CONSTRAINT "clientes_pkey" PRIMARY KEY (id);
ALTER TABLE "compra_detalle" ADD CONSTRAINT "compra_detalle_pkey" PRIMARY KEY (id);
ALTER TABLE "compras" ADD CONSTRAINT "compras_pkey" PRIMARY KEY (id);
ALTER TABLE "configuracion" ADD CONSTRAINT "configuracion_pkey" PRIMARY KEY (id);
ALTER TABLE "creditos_abono" ADD CONSTRAINT "creditos_abono_pkey" PRIMARY KEY (id);
ALTER TABLE "creditos_cargo" ADD CONSTRAINT "creditos_cargo_pkey" PRIMARY KEY (id);
ALTER TABLE "devolucion_detalle" ADD CONSTRAINT "devolucion_detalle_pkey" PRIMARY KEY (id);
ALTER TABLE "devoluciones" ADD CONSTRAINT "devoluciones_pkey" PRIMARY KEY (id);
ALTER TABLE "fichas" ADD CONSTRAINT "fichas_pkey" PRIMARY KEY (id);
ALTER TABLE "inventario" ADD CONSTRAINT "inventario_pkey" PRIMARY KEY (producto_id);
ALTER TABLE "kit_productos" ADD CONSTRAINT "kit_productos_pkey" PRIMARY KEY (id);
ALTER TABLE "kits" ADD CONSTRAINT "kits_pkey" PRIMARY KEY (id);
ALTER TABLE "movimientos_caja" ADD CONSTRAINT "movimientos_caja_pkey" PRIMARY KEY (id);
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_pkey" PRIMARY KEY (id);
ALTER TABLE "productos" ADD CONSTRAINT "productos_pkey" PRIMARY KEY (id);
ALTER TABLE "promociones" ADD CONSTRAINT "promociones_pkey" PRIMARY KEY (id);
ALTER TABLE "proveedores" ADD CONSTRAINT "proveedores_pkey" PRIMARY KEY (id);
ALTER TABLE "sucursales" ADD CONSTRAINT "sucursales_pkey" PRIMARY KEY (id);
ALTER TABLE "ticket_detalle" ADD CONSTRAINT "ticket_detalle_pkey" PRIMARY KEY (id);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_pkey" PRIMARY KEY (id);
ALTER TABLE "turnos" ADD CONSTRAINT "turnos_pkey" PRIMARY KEY (id);
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_pkey" PRIMARY KEY (id);
ALTER TABLE "configuracion" ADD CONSTRAINT "configuracion_sucursal_id_key" UNIQUE (sucursal_id);
ALTER TABLE "kit_productos" ADD CONSTRAINT "kit_productos_kit_id_producto_id_key" UNIQUE (kit_id, producto_id);
ALTER TABLE "kits" ADD CONSTRAINT "kits_codigo_barras_key" UNIQUE (codigo_barras);
ALTER TABLE "productos" ADD CONSTRAINT "productos_codigo_barras_key" UNIQUE (codigo_barras);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_folio_key" UNIQUE (folio);
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_usuario_key" UNIQUE (usuario);
ALTER TABLE "configuracion" ADD CONSTRAINT "configuracion_ancho_ticket_check" CHECK (((ancho_ticket)::text = ANY ((ARRAY['58mm'::character varying, '80mm'::character varying])::text[])));
ALTER TABLE "configuracion" ADD CONSTRAINT "configuracion_tamano_letra_check" CHECK (((tamano_letra)::text = ANY ((ARRAY['normal'::character varying, 'grande'::character varying])::text[])));
ALTER TABLE "configuracion" ADD CONSTRAINT "configuracion_tipo_codigo_escaneo_check" CHECK (((tipo_codigo_escaneo)::text = ANY ((ARRAY['qr'::character varying, 'barras'::character varying, 'ambos'::character varying])::text[])));
ALTER TABLE "configuracion" ADD CONSTRAINT "configuracion_tipo_fuente_check" CHECK (((tipo_fuente)::text = ANY ((ARRAY['monospace'::character varying, 'sans-serif'::character varying])::text[])));
ALTER TABLE "creditos_abono" ADD CONSTRAINT "creditos_abono_metodo_pago_check" CHECK (((metodo_pago)::text = ANY ((ARRAY['efectivo'::character varying, 'tarjeta'::character varying, 'transferencia'::character varying])::text[])));
ALTER TABLE "devoluciones" ADD CONSTRAINT "devoluciones_metodo_reembolso_check" CHECK (((metodo_reembolso)::text = ANY ((ARRAY['efectivo'::character varying, 'ajuste_credito'::character varying, 'sin_reembolso'::character varying])::text[])));
ALTER TABLE "fichas" ADD CONSTRAINT "fichas_estado_check" CHECK (((estado)::text = ANY ((ARRAY['esperando'::character varying, 'llamado'::character varying, 'atendido'::character varying, 'cancelado'::character varying])::text[])));
ALTER TABLE "movimientos_caja" ADD CONSTRAINT "movimientos_caja_tipo_check" CHECK (((tipo)::text = ANY ((ARRAY['ingreso'::character varying, 'egreso'::character varying])::text[])));
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_tipo_check" CHECK (((tipo)::text = ANY ((ARRAY['entrada_compra'::character varying, 'salida_venta'::character varying, 'merma'::character varying, 'ajuste_manual'::character varying, 'devolucion_venta'::character varying, 'entrada_manual'::character varying])::text[])));
ALTER TABLE "productos" ADD CONSTRAINT "productos_tipo_venta_check" CHECK (((tipo_venta)::text = ANY ((ARRAY['peso'::character varying, 'unidad'::character varying])::text[])));
ALTER TABLE "ticket_detalle" ADD CONSTRAINT "ticket_detalle_tipo_check" CHECK (((tipo)::text = ANY ((ARRAY['producto'::character varying, 'kit'::character varying])::text[])));
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_estado_check" CHECK (((estado)::text = ANY ((ARRAY['pendiente'::character varying, 'pagado'::character varying, 'cancelado'::character varying])::text[])));
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_metodo_pago_check" CHECK (((metodo_pago)::text = ANY ((ARRAY['efectivo'::character varying, 'tarjeta'::character varying, 'transferencia'::character varying, 'mixto'::character varying, 'credito'::character varying, 'dolares'::character varying, 'cheque'::character varying, 'vale_despensa'::character varying])::text[])));
ALTER TABLE "turnos" ADD CONSTRAINT "turnos_estado_check" CHECK (((estado)::text = ANY ((ARRAY['abierto'::character varying, 'cerrado'::character varying])::text[])));
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_rol_check" CHECK (((rol)::text = ANY ((ARRAY['jefe_general'::character varying, 'dueno'::character varying, 'gerente'::character varying, 'cajero'::character varying, 'mostrador'::character varying])::text[])));
ALTER TABLE "bitacora" ADD CONSTRAINT "bitacora_usuario_id_fkey" FOREIGN KEY (usuario_id) REFERENCES usuarios(id);
ALTER TABLE "clientes" ADD CONSTRAINT "clientes_sucursal_id_fkey" FOREIGN KEY (sucursal_id) REFERENCES sucursales(id);
ALTER TABLE "compra_detalle" ADD CONSTRAINT "compra_detalle_compra_id_fkey" FOREIGN KEY (compra_id) REFERENCES compras(id) ON DELETE CASCADE;
ALTER TABLE "compra_detalle" ADD CONSTRAINT "compra_detalle_producto_id_fkey" FOREIGN KEY (producto_id) REFERENCES productos(id);
ALTER TABLE "compras" ADD CONSTRAINT "compras_proveedor_id_fkey" FOREIGN KEY (proveedor_id) REFERENCES proveedores(id);
ALTER TABLE "compras" ADD CONSTRAINT "compras_sucursal_id_fkey" FOREIGN KEY (sucursal_id) REFERENCES sucursales(id);
ALTER TABLE "compras" ADD CONSTRAINT "compras_usuario_id_fkey" FOREIGN KEY (usuario_id) REFERENCES usuarios(id);
ALTER TABLE "configuracion" ADD CONSTRAINT "configuracion_sucursal_id_fkey" FOREIGN KEY (sucursal_id) REFERENCES sucursales(id);
ALTER TABLE "creditos_abono" ADD CONSTRAINT "creditos_abono_cliente_id_fkey" FOREIGN KEY (cliente_id) REFERENCES clientes(id);
ALTER TABLE "creditos_abono" ADD CONSTRAINT "creditos_abono_recibido_por_fkey" FOREIGN KEY (recibido_por) REFERENCES usuarios(id);
ALTER TABLE "creditos_abono" ADD CONSTRAINT "creditos_abono_turno_id_fkey" FOREIGN KEY (turno_id) REFERENCES turnos(id);
ALTER TABLE "creditos_cargo" ADD CONSTRAINT "creditos_cargo_autorizado_por_fkey" FOREIGN KEY (autorizado_por) REFERENCES usuarios(id);
ALTER TABLE "creditos_cargo" ADD CONSTRAINT "creditos_cargo_cliente_id_fkey" FOREIGN KEY (cliente_id) REFERENCES clientes(id);
ALTER TABLE "creditos_cargo" ADD CONSTRAINT "creditos_cargo_ticket_id_fkey" FOREIGN KEY (ticket_id) REFERENCES tickets(id);
ALTER TABLE "devolucion_detalle" ADD CONSTRAINT "devolucion_detalle_devolucion_id_fkey" FOREIGN KEY (devolucion_id) REFERENCES devoluciones(id) ON DELETE CASCADE;
ALTER TABLE "devolucion_detalle" ADD CONSTRAINT "devolucion_detalle_ticket_detalle_id_fkey" FOREIGN KEY (ticket_detalle_id) REFERENCES ticket_detalle(id);
ALTER TABLE "devoluciones" ADD CONSTRAINT "devoluciones_ticket_id_fkey" FOREIGN KEY (ticket_id) REFERENCES tickets(id);
ALTER TABLE "devoluciones" ADD CONSTRAINT "devoluciones_turno_id_fkey" FOREIGN KEY (turno_id) REFERENCES turnos(id);
ALTER TABLE "devoluciones" ADD CONSTRAINT "devoluciones_usuario_id_fkey" FOREIGN KEY (usuario_id) REFERENCES usuarios(id);
ALTER TABLE "fichas" ADD CONSTRAINT "fichas_sucursal_id_fkey" FOREIGN KEY (sucursal_id) REFERENCES sucursales(id);
ALTER TABLE "inventario" ADD CONSTRAINT "inventario_producto_id_fkey" FOREIGN KEY (producto_id) REFERENCES productos(id);
ALTER TABLE "kit_productos" ADD CONSTRAINT "kit_productos_kit_id_fkey" FOREIGN KEY (kit_id) REFERENCES kits(id) ON DELETE CASCADE;
ALTER TABLE "kit_productos" ADD CONSTRAINT "kit_productos_producto_id_fkey" FOREIGN KEY (producto_id) REFERENCES productos(id);
ALTER TABLE "kits" ADD CONSTRAINT "kits_sucursal_id_fkey" FOREIGN KEY (sucursal_id) REFERENCES sucursales(id);
ALTER TABLE "movimientos_caja" ADD CONSTRAINT "movimientos_caja_turno_id_fkey" FOREIGN KEY (turno_id) REFERENCES turnos(id);
ALTER TABLE "movimientos_caja" ADD CONSTRAINT "movimientos_caja_usuario_id_fkey" FOREIGN KEY (usuario_id) REFERENCES usuarios(id);
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_producto_id_fkey" FOREIGN KEY (producto_id) REFERENCES productos(id);
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_usuario_id_fkey" FOREIGN KEY (usuario_id) REFERENCES usuarios(id);
ALTER TABLE "productos" ADD CONSTRAINT "productos_categoria_id_fkey" FOREIGN KEY (categoria_id) REFERENCES categorias(id);
ALTER TABLE "productos" ADD CONSTRAINT "productos_sucursal_id_fkey" FOREIGN KEY (sucursal_id) REFERENCES sucursales(id);
ALTER TABLE "promociones" ADD CONSTRAINT "promociones_producto_id_fkey" FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE CASCADE;
ALTER TABLE "proveedores" ADD CONSTRAINT "proveedores_sucursal_id_fkey" FOREIGN KEY (sucursal_id) REFERENCES sucursales(id);
ALTER TABLE "ticket_detalle" ADD CONSTRAINT "ticket_detalle_producto_id_fkey" FOREIGN KEY (producto_id) REFERENCES productos(id);
ALTER TABLE "ticket_detalle" ADD CONSTRAINT "ticket_detalle_ticket_id_fkey" FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_cajero_usuario_id_fkey" FOREIGN KEY (cajero_usuario_id) REFERENCES usuarios(id);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_cliente_id_fkey" FOREIGN KEY (cliente_id) REFERENCES clientes(id);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_descuento_autorizado_por_fkey" FOREIGN KEY (descuento_autorizado_por) REFERENCES usuarios(id);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_mostrador_usuario_id_fkey" FOREIGN KEY (mostrador_usuario_id) REFERENCES usuarios(id);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sucursal_id_fkey" FOREIGN KEY (sucursal_id) REFERENCES sucursales(id);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_turno_id_fkey" FOREIGN KEY (turno_id) REFERENCES turnos(id);
ALTER TABLE "turnos" ADD CONSTRAINT "turnos_sucursal_id_fkey" FOREIGN KEY (sucursal_id) REFERENCES sucursales(id);
ALTER TABLE "turnos" ADD CONSTRAINT "turnos_usuario_id_fkey" FOREIGN KEY (usuario_id) REFERENCES usuarios(id);
ALTER TABLE "usuarios" ADD CONSTRAINT "fk_usuarios_sucursal" FOREIGN KEY (sucursal_id) REFERENCES sucursales(id);
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_sucursal_id_fkey" FOREIGN KEY (sucursal_id) REFERENCES sucursales(id);

CREATE INDEX IF NOT EXISTS idx_bitacora_fecha ON public.bitacora USING btree (fecha);
CREATE INDEX IF NOT EXISTS idx_bitacora_usuario ON public.bitacora USING btree (usuario_id);
CREATE INDEX IF NOT EXISTS idx_fichas_sucursal_fecha ON public.fichas USING btree (sucursal_id, fecha_creacion);
CREATE INDEX IF NOT EXISTS idx_kits_codigo_barras ON public.kits USING btree (codigo_barras);
CREATE INDEX IF NOT EXISTS idx_movimientos_turno ON public.movimientos_caja USING btree (turno_id);
CREATE INDEX IF NOT EXISTS idx_productos_activo ON public.productos USING btree (activo);
CREATE INDEX IF NOT EXISTS idx_productos_codigo_barras ON public.productos USING btree (codigo_barras);
CREATE INDEX IF NOT EXISTS idx_promociones_producto ON public.promociones USING btree (producto_id);
CREATE INDEX IF NOT EXISTS idx_tickets_estado ON public.tickets USING btree (estado);
CREATE INDEX IF NOT EXISTS idx_tickets_folio ON public.tickets USING btree (folio);
