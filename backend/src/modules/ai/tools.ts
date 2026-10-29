import { z } from "zod";
import { getPool } from "../../database/pool.js";
import { likePattern } from "../../common/http.js";

const money = (n: number) => `S/ ${n.toFixed(2)}`;

export interface ToolResult { data: unknown; amounts: number[] }

const searchArgs = z.object({ query: z.string().trim().min(1).max(100), limit: z.number().int().min(1).max(5).default(5) });
const servicesArgs = z.object({ query: z.string().trim().max(100).optional() });

/** Herramientas de solo lectura. Argumentos validados; nunca se ejecuta SQL ni texto generado por el modelo. */
export async function runTool(name: string, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  if (name === "search_products") {
    const a = searchArgs.safeParse(rawArgs);
    if (!a.success) return { data: { error: "Argumentos inválidos: se requiere query (texto)" }, amounts: [] };
    const { rows } = await getPool().query(
      `SELECT p.sku, p.name, p.brand, p.model, c.name AS category, p.price::float8 AS price, (p.stock_on_hand - p.stock_reserved) AS available, p.warranty_months AS "warrantyMonths"
       FROM products p JOIN product_categories c ON c.id = p.category_id
       WHERE p.status = 'active' AND (p.sku ILIKE $1 OR p.name ILIKE $1 OR p.brand ILIKE $1 OR p.model ILIKE $1 OR c.name ILIKE $1
         OR word_similarity($2, coalesce(p.name,'') || ' ' || coalesce(p.brand,'') || ' ' || coalesce(p.model,'')) > 0.45)
       ORDER BY word_similarity($2, coalesce(p.name,'') || ' ' || coalesce(p.brand,'') || ' ' || coalesce(p.model,'')) DESC, p.name LIMIT $3`,
      [likePattern(a.data.query), a.data.query, a.data.limit]);
    const items = rows.map((r) => ({ sku: r.sku, nombre: r.name, marca: r.brand, modelo: r.model, categoria: r.category, precio: money(r.price), disponible: r.available > 0, unidades_disponibles: Math.max(0, r.available), garantia_meses: r.warrantyMonths }));
    return { data: { encontrados: items.length, productos: items }, amounts: rows.map((r) => r.price as number) };
  }
  if (name === "list_services") {
    const a = servicesArgs.safeParse(rawArgs);
    if (!a.success) return { data: { error: "Argumentos inválidos" }, amounts: [] };
    const params: unknown[] = [];
    let where = "s.status = 'active'";
    if (a.data.query) { params.push(likePattern(a.data.query)); where += ` AND (s.name ILIKE $1 OR s.description ILIKE $1 OR c.name ILIKE $1)`; }
    const { rows } = await getPool().query(
      `SELECT s.code, s.name, c.name AS category, s.price_type, s.base_rate::float8 AS base_rate, s.requires_inspection, s.est_minutes, s.conditions, s.warranty_days
       FROM services s JOIN service_categories c ON c.id = s.category_id WHERE ${where} ORDER BY s.name LIMIT 10`, params);
    const items = rows.map((r) => ({
      codigo: r.code, nombre: r.name, categoria: r.category,
      precio: r.price_type === "fixed" ? money(r.base_rate) : r.price_type === "inspection" ? "requiere inspección previa; el costo se define tras la visita" : "se cotiza según el caso",
      requiere_inspeccion: r.requires_inspection, duracion_estimada_min: r.est_minutes, condiciones: r.conditions, garantia_dias: r.warranty_days,
    }));
    return { data: { encontrados: items.length, servicios: items }, amounts: rows.filter((r) => r.price_type === "fixed").map((r) => r.base_rate as number) };
  }
  if (name === "get_company_info") {
    const { rows } = await getPool().query<{ key: string; value: Record<string, string> }>("SELECT key, value FROM system_settings WHERE key IN ('company','policies')");
    const clean = (o: Record<string, string> | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => typeof v === "string" && v.trim() !== ""));
    const company = clean(rows.find((r) => r.key === "company")?.value);
    const policies = clean(rows.find((r) => r.key === "policies")?.value);
    return { data: { configurado: Object.keys(company).length + Object.keys(policies).length > 0, empresa: company, politicas: policies, nota: "Lo que no aparece aquí no está configurado: no lo afirmes." }, amounts: [] };
  }
  return { data: { error: "Herramienta desconocida" }, amounts: [] };
}
