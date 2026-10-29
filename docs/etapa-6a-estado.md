# Etapa 6A — Cotizaciones, pedidos, stock y pagos: estado

Leyenda: ✅ verificado · ⚠️ escrito, NO ejecutado · ⏳ no corresponde aún

| Criterio | Estado | Cómo comprobar |
|---|---|---|
| Sintaxis TS | ✅ | análisis de sintaxis |
| Totales en céntimos, máquinas de estados, saldos, texto de cotización | ⚠️ | `npm test` (`sales.test.ts`) |
| Migración 008 y permisos nuevos (`quotes.discount`, `orders.confirm`) | ⚠️ | `npm run migrate`; `npm test` (`permissions.test.ts`) |
| Totales calculados en el servidor; precios del catálogo; el cliente no impone precios | ⚠️ | integración `sales.test.ts` |
| Descuentos solo con permiso; descuento ≤ línea; cantidades inválidas rechazadas | ⚠️ | integración |
| Ciclo cotización: borrador → enviada por WhatsApp → aceptada → pedido; convertir dos veces no duplica | ⚠️ | integración |
| Cotización vencida no se acepta; sin conversación no se envía | ⚠️ | integración |
| Pedido: confirmar reserva, completar descuenta, cancelar libera; todo o nada; sin sobre-reserva | ⚠️ | integración |
| Movimientos de inventario únicos por pedido | ⚠️ | integración |
| Pagos: nacen pendientes; solo otra persona verifica; no sobrepago; rechazo con motivo; pedido con pagos no se cancela | ⚠️ | integración |
| Permisos: trabajador crea cotizaciones/pedidos pero no confirma ni verifica pagos | ⚠️ | integración |
| Typecheck | ⚠️ | `npm run typecheck` |
| Panel: cotizaciones, pedidos, pagos | ⚠️ | uso manual |

## Reglas implementadas (valores por defecto, configurables en código)
- Vigencia de cotización: 7 días (1–60). Vence sola (revisión cada minuto).
- Precio de productos y servicios fijos sale siempre del catálogo; servicios "a cotizar/inspección" exigen precio manual.
- Stock: confirmar el pedido reserva; completar descuenta; cancelar libera. La cotización no reserva.
- Pagos: registro manual, estado inicial pendiente; verifican supervisor/administrador (otra persona distinta de quien registró, salvo administrador).
- La IA todavía no escribe cotizaciones, pedidos ni pagos (Etapa 6B).

## Limitaciones conocidas
- El panel no edita cotizaciones (la API sí: `PATCH /quotes/:id`); para corregir, cree otra y rechace la anterior.
- El comprobante de pago se registra como texto de referencia; la subida de archivos no está incluida.
- "Enviada" se marca al encolar el mensaje; el panel muestra el estado real del mensaje (por ejemplo "bloqueado" si el envío está apagado).
- No hay PDF de la cotización ni pedidos con entrega parcial.
