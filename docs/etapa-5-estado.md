# Etapa 5 — IA con Ollama: estado

Leyenda: ✅ verificado · ⚠️ escrito, NO ejecutado · ⏳ no corresponde aún

| Criterio | Estado | Cómo comprobar |
|---|---|---|
| Sintaxis TS | ✅ | análisis de sintaxis |
| Interpretación segura de la salida del modelo; reglas deterministas; validador de respuestas (precios, confirmaciones, descuentos, texto técnico, repetición, horarios sin datos) | ✅ | `npm test` (`ai.test.ts`, 24 pruebas) |
| Typecheck | ✅ | `npm run typecheck` |
| Migración 007 | ✅ | aplicada en la base `crm` (24/10/2026) |
| Consulta el catálogo antes de dar un precio / no inventa precios | ✅ | integración `ai.test.ts` (IA simulada) + prueba manual: el modelo llamó `search_products` |
| Respuesta idempotente por mensaje; control humano y IA desactivada no responden | ✅ | integración |
| Contingencia (Ollama caído, JSON inválido, respuesta rechazada) → derivación | ✅ | integración |
| Derivación a persona con aviso enviado | ✅ | integración |
| Probador sin enviar nada | ✅ | integración + uso manual |
| Calidad conversacional con el modelo real (`qwen2.5:3b`) | ✅ | manual: panel → IA → Probador (3 casos) |
| Rendimiento en tu equipo (tiempo por respuesta) | ✅ | 40–80 s por respuesta en CPU (timeout 180 s) |

## Resultados de la verificación (25/10/2026)

- `npm run typecheck`: sin errores.
- `npm test`: 61/61 (24 de IA).
- `npm run test:integration` (suite de IA, base exclusiva `crm_test`): 12/12.
- Probador con el modelo real:
  - "¿Cuál es su horario?" **sin datos de empresa** → respuesta inmediata (3 ms, sin llamar al modelo): "No tengo esa información configurada todavía. Una persona del equipo te la confirmará".
  - "¿Cuál es su horario?" **con datos de empresa cargados** → respondió exactamente los horarios configurados (lun–vie 9:00–18:00, sáb 9:00–13:00).
  - "¿Tienen routers wifi? ¿Cuánto cuestan?" → llamó `search_products`, no encontró y lo dijo.
  - "Quiero usar la garantía" → pidió modelo y número de serie, derivó a persona.
- Ajustes en `ai_settings`: `enabled = true`, `timeout_ms = 180000`, `temperature = 0.2`, `model = qwen2.5:3b`.

### Problema de hardware encontrado (y corregido)
Los errores `timeout` del panel no eran del modelo: Ollama usaba la GPU (Vulkan/CUDA) y el driver de la NVIDIA MX130 se caía a mitad de la generación (`ggml_vulkan: device lost` → HTTP 500 a los 80–120 s).

Solución aplicada en este equipo (Ollama 0.40.11, 8 GB de RAM):
- Variables de usuario `OLLAMA_VULKAN=0` y `CUDA_VISIBLE_DEVICES=` (vacío) para que Ollama use solo CPU.
- Reiniciar Ollama después de cambiarlas (`ollama ps` debe mostrar `100% CPU`).
- En CPU: ~11 s por generación en caliente; la primera carga del modelo tarda ~40 s (por eso el timeout de 40 s fallaba).

Nota: al reiniciar Ollama desde el menú Inicio en la misma sesión de Windows, Explorer puede conservar las variables antiguas; si vuelve a aparecer `100% GPU`, cerrar sesión y volver a entrar (o reiniciar) para que tome las variables nuevas.

## Diseño
- La IA **no** ve la BD. Solo 3 herramientas de lectura (`search_products`, `list_services`, `get_company_info`) con argumentos validados. La información de empresa (`get_company_info`) se consulta en el servidor y se inyecta en el prompt como bloque verificado; el modelo no puede modificarla.
- Protocolo propio JSON (sin depender de "tool calling" nativo del modelo): herramienta → resultado → respuesta. La salida se restringe con un **esquema JSON** enviado a Ollama (`format`), de modo que el modelo solo pueda emitir `{"tool":…}` o `{"reply":…}`.
- Si no hay datos de empresa configurados y el cliente pregunta por horarios, cobertura, pagos o entregas, se responde de forma determinista ("no tengo esa información, una persona lo confirma") sin llamar al modelo: evita invenciones y esperas largas.
- Los precios citados deben coincidir con los devueltos por las herramientas (o ya citados antes en la conversación). Si el modelo falla dos veces → derivación a persona.
- Los horarios, días de atención, cobertura, pagos y entregas solo se pueden afirmar si hay datos de empresa configurados; si no, la respuesta determinista sustituye al modelo (y el validador también rechaza horarios inventados).
- Reglas fijas versionadas en código (`PROMPT_VERSION=v3`); el administrador solo añade instrucciones de tono.
- IA **desactivada por defecto**. Aun activada, solo puede enviar a los números permitidos por `WHATSAPP_SEND_MODE`.
- Una generación a la vez; espera `debounce_ms` para agrupar mensajes seguidos; ignora mensajes de más de 10 min (atrasos).
- Pendiente para la Etapa 6: herramientas de escritura (borrador de cotización, solicitud de servicio, caso de garantía); hoy la IA recopila datos y deriva a una persona.
- Resúmenes de conversaciones largas: no incluidos aún (se usa una ventana de mensajes recientes + datos recordados).

## Pendiente recomendado (no bloquea la etapa)
- Cargar los datos reales de la empresa en **Configuración → Empresa/Políticas** (`system_settings.company` y `policies`): hoy está vacío, así que la IA no puede informar horarios, cobertura ni formas de pago.
- Cargar el catálogo real (hoy solo hay un producto de prueba: "pizza").
- Si se quiere más calidad conversacional, probar `llama3.2:3b` o `qwen2.5:7b`; en este equipo (4 núcleos, 8 GB) un 7B en CPU superaría el minuto por respuesta.
