# Etapa 4 — WhatsApp y control de mensajes: estado

Leyenda: ✅ verificado · ⚠️ escrito, NO ejecutado · ⏳ no corresponde aún

| Criterio | Estado | Cómo comprobar |
|---|---|---|
| Sintaxis TS | ✅ | análisis de sintaxis |
| Reglas puras (JID, compuerta de envío, backoff, IA vs control humano, config) | ⚠️ | `npm test` (`whatsapp-rules.test.ts`) |
| Migración 006 | ⚠️ | `npm run migrate` |
| Typecheck (incluye tipos de Baileys) | ⚠️ | `npm run typecheck` — **es probable que Baileys requiera pequeños ajustes de tipos** |
| Mensaje entrante registrado una vez aunque llegue duplicado | ⚠️ | integración `whatsapp.test.ts` (proveedor simulado) |
| Grupos/estados ignorados | ⚠️ | integración |
| Mensaje escrito desde el celular pausa la IA | ⚠️ | integración |
| Respuesta del trabajador toma el control, sale por la cola, eco descartado, idempotencia | ⚠️ | integración |
| IA no responde bajo control humano (encolar rechazado, pendiente cancelada) | ⚠️ | integración |
| Transferencia: registro, notificación, devolver a la IA, sin duplicados | ⚠️ | integración |
| Envío bloqueado en modo off / fuera de la lista | ⚠️ | integración |
| Resultado de envío incierto no se reintenta | ⚠️ | integración |
| Sin bucle de reconexión; permisos de conexión solo admin | ⚠️ | integración |
| Conexión real por QR y recepción/envío reales con número de pruebas | ⚠️ | manual (ver README) |

## Decisiones y límites
- Envío **apagado por defecto** (`WHATSAPP_SEND_MODE=off`). `allowlist` exige `WHATSAPP_ALLOWED_NUMBERS`. `all` solo tras terminar las pruebas.
- Sin SSE: el panel consulta cada 5–10 s (más simple y robusto); SSE queda como mejora.
- Contactos con identificador oculto (`@lid`) se guardan como `lid:<id>`; el envío por lista de números permitidos solo sirve con números normales.
- Mensajes no textuales se guardan como `[tipo]` (imagen sin texto, audio, etc.). No se descargan archivos todavía.
- Los mensajes escritos desde el celular se registran pero no pueden enviarse desde el CRM sin conexión; la IA se pausa y hay que pulsar "Devolver a la IA".
- Credenciales de sesión en `WHATSAPP_SESSION_PATH` (carpeta ignorada por Git). Proteger el disco; se cifrarán/rotarán en la Etapa 8.
- Una sola instancia del backend por sesión (bloqueo en PostgreSQL).
- Dependencias nuevas sin verificar: `@whiskeysockets/baileys` (^6.7.x), `qrcode`, `@types/qrcode`.
