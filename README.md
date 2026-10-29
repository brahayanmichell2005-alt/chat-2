# whatsapp-tech-crm — Etapas 2 a 5

Estado: Etapa 2 verificada por el usuario (login). Etapa 3 **escrita, sin ejecutar** (el entorno donde se generó no tenía red, Docker ni PostgreSQL). Ver `docs/etapa-2-estado.md` y `docs/etapa-3-estado.md`.

## Requisitos
Node 20+ (probado solo con 22 para sintaxis), Docker (para PostgreSQL de desarrollo) o un PostgreSQL 13+ propio.

## Puesta en marcha (desarrollo)
```
cp .env.example .env          # completar DATABASE_URL, JWT_ACCESS_SECRET (>=32 caracteres)
export POSTGRES_PASSWORD=...  # la misma contraseña que usó en DATABASE_URL
npm install
npm run db:up
npm run migrate           # aplica también las migraciones de la Etapa 3
ADMIN_EMAIL=usted@dominio.com ADMIN_PASSWORD='(12+ caracteres)' npm run seed:admin
npm run dev:backend           # http://localhost:3000/api/v1/health
npm run dev:frontend          # http://localhost:5173
```

## Pruebas
- `npm test` — unitarias (sin base de datos).
- `TEST_DATABASE_URL=postgresql://... npm run test:integration` — integración de auth y permisos. **Vacía tablas de identidad: use una base exclusiva.**
- `npm run typecheck`.

## Decisiones por defecto (cambiables)
- Sin ORM: `pg` + migraciones SQL versionadas (`backend/migrations`) con runner propio y bloqueo asesor.
- Zona horaria `America/Lima`; interfaz en español; sesiones: access token 15 min (Bearer) + refresh rotatorio en cookie httpOnly.
- `docker-compose.dev.yml` levanta solo PostgreSQL; backend y panel corren con npm. Docker completo queda para la Etapa 9.
- Backend se ejecuta con `tsx`; el empaquetado de producción se define en la Etapa 9.

## WhatsApp (Etapa 4)
1. En `.env`: `WHATSAPP_SEND_MODE=allowlist` y `WHATSAPP_ALLOWED_NUMBERS=<su número de pruebas, solo dígitos con código de país>`.
2. `npm install`, `npm run migrate`, reinicie el backend.
3. Panel → **WhatsApp** → Conectar → escanee el QR con un **número secundario de pruebas** (Dispositivos vinculados).
4. Escriba al número vinculado desde otro teléfono: la conversación aparece sola. Responda desde el panel (toma el control de la conversación).
Con `WHATSAPP_SEND_MODE=off` (por defecto) nada se envía; los mensajes quedan "bloqueados".

## IA (Etapa 5)
1. Ollama encendido (`ollama serve` o la app). Modelo por defecto: `gemma4:26b` (cámbielo en el panel si es muy lento).
2. `npm install`, `npm run migrate`, reinicie el backend. Panel → **IA** → "Probar conexión con Ollama".
3. Cargue algunos productos reales y los datos de la empresa en **Ajustes**.
4. Pruebe en el **Probador** (no envía nada). Cuando las respuestas sean correctas, marque "IA activa".
