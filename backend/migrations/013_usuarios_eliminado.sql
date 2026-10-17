-- Eliminar un empleado desde la pantalla Equipo.
-- No se borra la fila (sus ventas, turnos y bitácora siguen apuntando a ella para que los reportes
-- no se rompan): se marca con la fecha en que se eliminó y deja de aparecer en Equipo y de poder entrar.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS eliminado_en TIMESTAMP;
