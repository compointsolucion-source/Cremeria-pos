-- Versión de sesión de cada usuario: al cambiar o restablecer su contraseña sube en 1 y todas
-- sus sesiones abiertas (en cualquier computadora o celular) dejan de servir.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
