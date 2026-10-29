# Etapa 3 — CRM y catálogo: estado

Leyenda: ✅ verificado · ⚠️ escrito, NO ejecutado · ⏳ no corresponde aún

| Criterio | Estado | Cómo comprobar |
|---|---|---|
| Sintaxis TS del backend | ✅ | análisis de sintaxis (no resuelve paquetes) |
| Migraciones 003–005 desde cero y repetibles | ⚠️ | `npm run migrate` (2 veces). Requiere `pg_trgm` (incluida en Postgres estándar) |
| CRUD de productos con permisos (agent solo lee) | ⚠️ | `npm run test:integration` |
| Importación: vista previa no modifica datos; confirmar aplica una sola vez; cancelar | ⚠️ | integración `catalog.test.ts` |
| Importación: errores por fila/columna, SKU repetido en archivo, formato inválido | ✅/⚠️ | unit `import.test.ts` (corre sin BD tras `npm install`) |
| Duplicados de clientes por teléfono/correo | ⚠️ | integración |
| Stock no negativo y movimientos registrados | ⚠️ | integración |
| Servicios: precio fijo exige tarifa | ⚠️ | integración |
| Conversaciones: trabajador solo ve asignadas; notas, etiquetas, asignación con permiso; una abierta por contacto | ⚠️ | integración |
| Ajustes de empresa (solo claves conocidas, solo admin escribe) | ⚠️ | integración |
| Frontend: productos, importación, clientes, servicios, conversaciones, ajustes | ⚠️ | `npm run typecheck` y uso manual |

## Decisiones y desvíos
- `contacts` sin vínculo a sesión de WhatsApp (se añade en Etapa 4). Una sola cuenta de WhatsApp.
- Mensajes: tabla y lectura listas; se llenan en la Etapa 4. Hay alta manual de conversaciones para probar.
- Tablas no creadas aún (sin uso en esta etapa): `customer_consents`, `service_pricing_rules`, `product_images` (se usa `image_urls`), cotizaciones, pedidos, pagos, agenda, garantías.
- Historial de cliente: solo conversaciones; el resto llega en la Etapa 6.
- Importación: si el SKU existe y se elige "actualizar", el stock del archivo se ignora (el stock solo cambia con ajustes registrados). Categorías desconocidas son error (no se crean solas).
- Contratos de la API no pasan aún por `packages/shared` (esquemas en cada módulo); OpenAPI sigue pendiente.
- Catálogo, servicios y datos de empresa nacen vacíos (no se inventó nada). Solo se sembraron categorías y etiquetas.

## Nuevas dependencias (sin verificar contra el registro)
`csv-parse`, `exceljs`, `multer`, `@types/multer`. Ejecute `npm install` de nuevo.
