-- Paquete contratado (Básico / Negocio / Pro) que manda Compoint desde su panel (consulta central de licencia).
-- NULL = sin paquete asignado: no se limita nada (como Pro). Así a nadie se le quita lo que ya usaba.
ALTER TABLE IF EXISTS licencia
  ADD COLUMN IF NOT EXISTS paquete VARCHAR(10),          -- basico | negocio | pro
  ADD COLUMN IF NOT EXISTS max_usuarios INTEGER,         -- NULL = ilimitados
  ADD COLUMN IF NOT EXISTS con_domicilio BOOLEAN;        -- servicio a domicilio y app del repartidor (NULL = sí)
