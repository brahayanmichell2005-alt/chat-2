import type pg from "pg";
import { z } from "zod";
import type { AuthUser } from "@crm/shared";
import { AppError } from "../../common/errors.js";
import { fromCents, toCents } from "../../common/money.js";
import { computeTotals } from "./rules.js";

export const itemInputSchema = z.object({
  type: z.enum(["product", "service"]),
  id: z.string().uuid(),
  qty: z.number().int().min(1).max(10_000),
  /** Solo para servicios "a cotizar" o "con inspección": su precio no es fijo y lo fija una persona. */
  unitPrice: z.number().min(0).max(99_999_999.99).optional(),
  /** Descuento en soles sobre la línea completa. Requiere permiso quotes.discount. */
  discount: z.number().min(0).max(99_999_999.99).optional(),
});
export const documentInputSchema = z.object({
  customerId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  items: z.array(itemInputSchema).min(1).max(50),
  extraCost: z.number().min(0).max(99_999_999.99).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type ItemInput = z.infer<typeof itemInputSchema>;

export interface BuiltLine {
  lineNo: number; itemType: "product" | "service"; productId: string | null; serviceId: string | null;
  description: string; qty: number; unitPriceCents: number; discountCents: number; lineTotalCents: number;
}
export interface BuiltDocument { lines: BuiltLine[]; subtotalCents: number; discountCents: number; extraCents: number; totalCents: number }

/** Resuelve precios desde el catálogo (nunca desde el cliente ni la IA) y calcula los totales en el servidor. */
export async function buildDocument(client: pg.Pool | pg.PoolClient, items: ItemInput[], extraCost: number | undefined, auth: AuthUser): Promise<BuiltDocument> {
  const canDiscount = auth.permissions.includes("quotes.discount");
  const lines: BuiltLine[] = [];
  for (const [i, it] of items.entries()) {
    const discountCents = toCents(it.discount ?? 0);
    if (discountCents > 0 && !canDiscount) throw new AppError(403, "DISCOUNT_FORBIDDEN", "Solo un supervisor o administrador puede aplicar descuentos");
    if (it.type === "product") {
      const r = await client.query<{ name: string; brand: string | null; model: string | null; price: string; status: string }>("SELECT name, brand, model, price, status FROM products WHERE id = $1", [it.id]);
      const p = r.rows[0];
      if (!p || p.status !== "active") throw new AppError(400, "PRODUCT_UNAVAILABLE", `Producto no disponible (línea ${i + 1})`);
      if (it.unitPrice !== undefined) throw new AppError(400, "PRICE_NOT_ALLOWED", "El precio de un producto sale del catálogo");
      lines.push({ lineNo: i + 1, itemType: "product", productId: it.id, serviceId: null, description: [p.name, p.brand, p.model].filter(Boolean).join(" "), qty: it.qty, unitPriceCents: toCents(Number(p.price)), discountCents, lineTotalCents: 0 });
    } else {
      const r = await client.query<{ name: string; price_type: string; base_rate: string | null; status: string }>("SELECT name, price_type, base_rate, status FROM services WHERE id = $1", [it.id]);
      const s = r.rows[0];
      if (!s || s.status !== "active") throw new AppError(400, "SERVICE_UNAVAILABLE", `Servicio no disponible (línea ${i + 1})`);
      let unit: number;
      if (s.price_type === "fixed") {
        if (it.unitPrice !== undefined) throw new AppError(400, "PRICE_NOT_ALLOWED", "Este servicio tiene tarifa fija");
        unit = toCents(Number(s.base_rate));
      } else {
        if (it.unitPrice === undefined) throw new AppError(400, "PRICE_REQUIRED", `El servicio "${s.name}" se cotiza según el caso: indique su precio (línea ${i + 1})`);
        unit = toCents(it.unitPrice);
      }
      lines.push({ lineNo: i + 1, itemType: "service", productId: null, serviceId: it.id, description: s.name, qty: it.qty, unitPriceCents: unit, discountCents, lineTotalCents: 0 });
    }
  }
  let t;
  try {
    t = computeTotals(lines.map((l) => ({ qty: l.qty, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents })), toCents(extraCost ?? 0));
  } catch (e) {
    throw new AppError(400, "INVALID_AMOUNTS", (e as Error).message);
  }
  lines.forEach((l, n) => { l.lineTotalCents = t.lineTotalsCents[n]!; });
  return { lines, subtotalCents: t.subtotalCents, discountCents: t.discountCents, extraCents: t.extraCents, totalCents: t.totalCents };
}

export async function insertLines(client: pg.PoolClient, table: "quote_items" | "order_items", fk: "quote_id" | "order_id", id: string, lines: BuiltLine[]) {
  for (const l of lines) {
    await client.query(
      `INSERT INTO ${table} (${fk}, line_no, item_type, product_id, service_id, description, qty, unit_price, discount, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, l.lineNo, l.itemType, l.productId, l.serviceId, l.description, l.qty, fromCents(l.unitPriceCents), fromCents(l.discountCents), fromCents(l.lineTotalCents)]);
  }
}

export async function logStatus(client: pg.PoolClient, entityType: string, id: string, from: string | null, to: string, userId: string | null, reason?: string) {
  await client.query(
    "INSERT INTO status_history (entity_type, entity_id, field, from_value, to_value, changed_by, reason) VALUES ($1,$2,'status',$3,$4,$5,$6)",
    [entityType, id, from, to, userId, reason ?? null]);
}

export const ITEM_COLS = `line_no AS "lineNo", item_type AS "itemType", product_id AS "productId", service_id AS "serviceId", description, qty,
  unit_price::float8 AS "unitPrice", discount::float8 AS discount, line_total::float8 AS "lineTotal"`;
