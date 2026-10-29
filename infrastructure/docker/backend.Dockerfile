# Imagen de producción del backend (CRM + Baileys).
# Se construye desde la raíz del monorepo:
#   docker build -f infrastructure/docker/backend.Dockerfile .
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Manifiestos primero para aprovechar la caché de capas
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund

# Código (tsx lo compila en caliente; no hace falta build aparte)
COPY packages/shared packages/shared
COPY backend backend

# La sesión de WhatsApp se guarda en un volumen persistente (montado desde compose)
ENV WHATSAPP_SESSION_PATH=/app/data/whatsapp-session
EXPOSE 3000

# Aplica migraciones (con bloqueo asesor: seguro en reinicios) y arranca el backend
CMD ["sh", "-c", "npm run migrate -w backend && npm start -w backend"]
