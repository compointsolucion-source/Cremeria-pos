-- La licencia de un servidor local puede venir de la NUBE del cliente (al conectar con su usuario dueño):
--   desde_nube      NULL = se activó en esta computadora (código o prueba)
--                   'codigo' = código firmado que la nube ya tenía (se comprueba la firma aquí también)
--                   'fila' = la nube tiene licencia vigente sin código (la puso Compoint a mano)
--                   'sin_control' = la nube es un sistema propio de Compoint (sin control de licencia)
--   nube_id_equipo  ID del equipo de la NUBE al que está ligado ese código (el código no es de esta PC sino de la nube)
ALTER TABLE licencia
  ADD COLUMN IF NOT EXISTS desde_nube TEXT,
  ADD COLUMN IF NOT EXISTS nube_id_equipo TEXT;
