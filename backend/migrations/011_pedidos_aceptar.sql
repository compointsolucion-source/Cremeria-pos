-- Un pedido que se envía a preparar aparece en Mostrador; quien lo toma da "Aceptar".
--   aceptado_en   NULL = nadie lo ha aceptado todavía (en Mostrador sale como "NUEVO")
--   aceptado_por  quién lo aceptó en Mostrador (para mostrar "Lo prepara Juan" en las demás pantallas)
-- Si el pedido regresa a "preparando" (se reabre), estas dos columnas se vacían y vuelve a salir como nuevo.
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS aceptado_en TIMESTAMP,
  ADD COLUMN IF NOT EXISTS aceptado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
