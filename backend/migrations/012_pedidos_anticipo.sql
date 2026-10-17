-- Anticipo en pedidos (a domicilio y para recoger): dinero que el cliente ya dejó o pagó por adelantado.
--   anticipo         cuánto dejó (0 = nada). Si es igual al total, el cliente ya pagó todo.
--   anticipo_metodo  con qué lo dejó: efectivo, transferencia o tarjeta (solo cuando hay anticipo).
-- Lo que se cobra al entregar o al recoger es el total MENOS el anticipo.
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS anticipo NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS anticipo_metodo VARCHAR(15);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_anticipo_valido') THEN
    ALTER TABLE pedidos ADD CONSTRAINT pedidos_anticipo_valido
      CHECK (anticipo >= 0 AND (anticipo = 0 OR anticipo_metodo IN ('efectivo', 'transferencia', 'tarjeta')));
  END IF;
END $$;
