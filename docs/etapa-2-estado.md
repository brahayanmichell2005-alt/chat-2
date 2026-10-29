# Etapa 2 — estado de verificación

Leyenda: ✅ verificado · ⚠️ escrito, NO ejecutado · ⏳ no corresponde aún

| Criterio | Estado | Evidencia / cómo comprobar |
|---|---|---|
| Sintaxis TypeScript del backend y shared | ✅ | análisis con `node --experimental-strip-types` (solo sintaxis; no resuelve paquetes) |
| Variables validadas al iniciar; falla sin config crítica | ⚠️ | `tests/unit/env.test.ts` |
| Migraciones reproducibles desde cero | ⚠️ | `npm run migrate` en BD vacía; segunda corrida debe decir "Sin migraciones pendientes" |
| Login válido / inválido, bloqueo, rutas protegidas | ⚠️ | `tests/integration/auth.test.ts` |
| Permisos en backend (agent no crea usuarios) | ⚠️ | unit `permissions.test.ts` + integración |
| Semilla RBAC coincide con `@crm/shared` | ⚠️ | `permissions.test.ts` |
| Errores sin filtrar internos | ⚠️ | `errors.test.ts` |
| Frontend: login, ruta protegida, logout | ⚠️ | `npm run dev:frontend` + `npm run typecheck` |
| Docker Compose levanta PostgreSQL | ⚠️ | `npm run db:up` |
| "docker compose up levanta todo" (criterio de la Etapa 1) | ❌ ajustado | Solo PostgreSQL en dev; Docker completo en Etapa 9 |
| Documentación OpenAPI | ⏳ | pendiente; se genera al estabilizar contratos (Etapa 3) |
| CI | ⏳ | no incluido; proponer en Etapa 8 |

Versiones de dependencias: rangos sin verificar contra el registro (no había red). `npm install` resuelve las más recientes dentro del rango; si algo no compila, corregir y reportar.
