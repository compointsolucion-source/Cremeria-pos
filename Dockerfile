# Compoint Punto en el servidor Compoint (Coolify).
# Un solo contenedor por cliente: el servidor (backend) también entrega las páginas (frontend),
# así la dirección del cliente (ej. https://cp1007.compoint.com.mx) sirve todo.
# Coolify lo construye desde la rama «estable». Las variables de cada cliente las pone el panel
# Licencias Punto (DATABASE_URL, JWT_SECRET, MAX_SUCURSALES, COMPOINT_LICENCIA_TOKEN...).
FROM node:22-alpine

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend/ ./
COPY frontend/ /app/frontend/

ENV NODE_ENV=production \
    PORT=3000 \
    FRONTEND_DIR=/app/frontend \
    DB_SSL=false \
    TZ_NEGOCIO=America/Mexico_City

EXPOSE 3000
USER node

# 1) primer-arranque.js: si la base está vacía y vienen los datos del alta, crea dueño y licencia.
# 2) server.js: pone al día las migraciones y arranca.
CMD ["sh", "-c", "node scripts/primer-arranque.js && exec node server.js"]
