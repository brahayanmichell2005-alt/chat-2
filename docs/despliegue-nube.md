# Despliegue en la nube — Frontend en Vercel + Backend y BD en VPS

Arquitectura elegida:

```
Navegador ──> Vercel (frontend React) ─── rewrite /api/v1/* ───> VPS (Caddy HTTPS)
                                                                  ├─ backend (Baileys 24/7)
                                                                  └─ PostgreSQL 16
```

- **Vercel**: solo el frontend estático de Vite. Gracias al *rewrite* de `/api/v1/*` hacia la VPS
  (`frontend/vercel.json`), el navegador ve todo como mismo origen: **no hace falta tocar cookies,
  CORS ni tokens**.
- **VPS**: corre `docker compose` con 3 servicios: PostgreSQL, el backend (con Baileys conectado
  24/7 a WhatsApp) y Caddy, que pone HTTPS automático con Let's Encrypt.
- **IA (Ollama)**: ver sección 7; en la nube conviene optar entre un subdominio propio de la VPS
  (opción más simple y recomendada por su proyecto actual).

> ⚠️ **Requisito: su propio dominio** (p. ej. `midominio.com`, ~$10/año). Vercel necesita un
> backend bajo HTTPS con nombre fijo; `*.vercel.app` no permite proxy inverso hacia él.

---

## 1. VPS recomendado

| Proveedor | Plan | RAM | Precio aprox. | ¿Ollama? |
|---|---|---|---|---|
| **Oracle Cloud Free** | A1 ARM x4 | 24 GB | **Gratis** | Sí, modelos medianos (12B) |
| Hetzner | CX/CPX | 4 GB | ~€4.5/mes | No (26B no cabe) |
| DigitalOcean | Basic 2 GB | 2 GB | $12/mes | No |

Cree la VPS con **Ubuntu 24.04 LTS** y anote su IP.

## 2. Preparar el servidor (una sola vez)

Conéctese por SSH (`ssh root@IP_DE_LA_VPS`) y ejecute:

```bash
# Docker Engine
curl -fsSL https://get.docker.com | sh

# Firewall: solo SSH y web
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw --force enable
```

## 3. Subir el código

Con Git (recomendado; permite actualizar con `git pull`):

```bash
# En su PC, dentro de la carpeta whatsapp-tech-crm:
git init && git add -A && git commit -m "Despliegue nube"
git remote add origin https://github.com/SU_USUARIO/whatsapp-tech-crm.git
git push -u origin main

# En la VPS:
git clone https://github.com/SU_USUARIO/whatsapp-tech-crm.git /opt/crm
```

## 4. Configurar y levantar

```bash
cd /opt/crm/infrastructure/docker

# a) Crear el .env de nube
cp env.prod.example .env
nano .env        # Complete: API_DOMAIN, FRONTEND_URL, secretos NUEVOS, WHATSAPP_*

# b) Levantar (Postgres + backend + Caddy)
docker compose --env-file .env -f docker-compose.prod.yml up -d --build

# c) Crear el admin de la BD
docker compose --env-file .env -f docker-compose.prod.yml run --rm \
  -e ADMIN_EMAIL=usted@dominio.com -e ADMIN_PASSWORD='UNA_CLAVE_NUEVA_LARGA' \
  backend npm run seed:admin -w backend
```

Antes de esto, **en su gestor de DNS** cree un registro `A`:
`api.tudominio.com → IP_DE_LA_VPS` (y espere a que propague). Caddy emite el certificado
automáticamente al primer arranque.

Verificación: `curl https://api.tudominio.com/api/v1/health` debe responder `{"ok":true,…}`.

## 5. Migrar sus datos locales (clientes, productos, etc.)

En su PC con Windows (Postgres corre en Docker local):

```powershell
# Ver el nombre del contenedor postgres local
docker ps
# Exportar la BD completa a un archivo
docker exec -t NOMBRE_CONTENEDOR_POSTGRES pg_dump -U crm -Fc crm > crm-local.dump
```

Suba `crm-local.dump` a la VPS (p. ej. con `scp crm-local.dump root@IP:/opt/crm/`) y restáurela:

```bash
cd /opt/crm/infrastructure/docker
docker compose --env-file .env -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U crm -d crm --clean --if-exists < /opt/crm/crm-local.dump
```

## 6. WhatsApp

Sus conversaciones y contactos están en la BD ya migrada. La **sesión de WhatsApp se debe
re-vincular** (es un "dispositivo" nuevo por seguridad):

1. Panel → **WhatsApp** → Conectar → escanee el QR con su número (Dispositivos vinculados).
2. En la VPS, una vez vinculada, active el auto-conectado en `infrastructure/docker/.env`:
   `WHATSAPP_AUTOCONNECT=true` → `docker compose --env-file .env -f docker-compose.prod.yml up -d backend`.
3. Cuando deje de usar el número de pruebas, cambie `WHATSAPP_SEND_MODE=all` en el `.env` y reinicie.

## 7. IA gratis en la nube (sin Ollama)

El backend ahora tiene dos proveedores (variable `AI_PROVIDER` del `.env`):
`ollama` (como antes) o **`openai`** — cualquier servicio con API compatible OpenAI.
Los tres mejores con **nivel gratuito** (sin tarjeta):

| Servicio | Clave gratis (dónde) | baseUrl para el Panel → IA | Modelo sugerido |
|---|---|---|---|
| **Groq** | console.groq.com/keys | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| **Google Gemini** | aistudio.google.com/apikey | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| **OpenRouter** | openrouter.ai/keys | `https://openrouter.ai/api/v1` | buscar `[free]` en openrouter.ai/models |

Pasos:

1. En `infrastructure/docker/.env` de la VPS:
   ```
   AI_PROVIDER=openai
   AI_API_KEY=SU_CLAVE_GRATUITA
   ```
   → `docker compose --env-file .env -f docker-compose.prod.yml up -d backend`
2. Panel → **IA**: fija la baseUrl y el modelo de la tabla. El botón "Probar conexión" lista
   los modelos disponibles. Los niveles gratuitos tienen tasas por minuto/día (revisado el panel → IA → uso).
3. Pruebe en el **Probador** (no envía nada) y active "IA activa" cuando responda bien.

Para desarrollo local funciona igual: `AI_PROVIDER=openai` y `AI_API_KEY` en el `.env` local.
Mañana, si pasa a un servicio de pago (OpenAI, DeepSeek, Anthropic), solo cambian `baseUrl`,
`model` y la clave — el código no se toca.

## 8. Vercel (frontend)

1. En Vercel → **Add New Project** → importe el repo de GitHub.
2. En **Root Directory** ponga `whatsapp-tech-crm/frontend` (Framework: Vite detectado solo).
3. Antes del deploy, en `frontend/vercel.json` cambie `api.tudominio.com` por su dominio real
   (ya está preparado el rewrite de `/api/v1/*`).
4. Deploy. Opcional: en Vercel → Settings → Domains, fije su dominio propio.

Nada más: al usar el rewrite, el login, las cookies y los tokens funcionan sin cambios.

## 9. Mantenimiento

```bash
cd /opt/crm && git pull
docker compose --env-file infrastructure/docker/.env -f infrastructure/docker/docker-compose.prod.yml up -d --build
docker compose --env-file infrastructure/docker/.env -f infrastructure/docker/docker-compose.prod.yml logs -f backend   # ver sesión de WhatsApp
```

Backup diario de la BD (cron en la VPS): `postgres` a `pg_dump -U crm -Fc crm` hacia un archivo
con fecha. Ejemplo en `/etc/cron.d/crm-backup`.

## 10. Seguridad (importante)

- `JWT_ACCESS_SECRET` y `POSTGRES_PASSWORD` de la nube deben ser **nuevos** (distinct de los de su
  `.env` local).
- La `.env` local ya está en `.gitignore`: verifique que nunca se publique la contraseña real.
- Tras crear el admin (`seed:admin`), **no deje** `ADMIN_EMAIL`/`ADMIN_PASSWORD` dentro del `.env`
  de la VPS, y elimine la variable si estuviera: se ejecutan solo una vez.
- Nunca exponga puertos 3000 ni 5432 a internet desde compose (solo Caddy 80/443).
