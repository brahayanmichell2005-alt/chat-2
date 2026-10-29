import type { Request } from "express";
import type pg from "pg";
import { z } from "zod";
import { writeAudit } from "../../common/audit.js";
import { AppError } from "../../common/errors.js";
import { likePattern, pgCode, uuidParam } from "../../common/http.js";
import { getPool, withTransaction } from "../../database/pool.js";

const money = z.number().min(0).max(99_999_999.99).multipleOf(0.01);
export const productCreateSchema = z.object({
  sku: z.string().trim().min(1).max(64).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  categoryId: z.string().uuid(),
  brand: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  price: money,
  cost: money.optional(),
  stockOnHand: z.number().int().min(0).default(0),
  stockMin: z.number().int().min(0).default(0),
  warrantyMonths: z.number().int().min(0).max(240).default(0),
  specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  imageUrls: z.array(z.string().url().max(500)).max(10).default([]),
});
export const productUpdateSchema = productCreateSchema
  .omit({ stockOnHand: true })
  .partial()
  .extend({ status: z.enum(["active", "inactive"]).optional(), cost: money.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: "Sin cambios" });
export const stockAdjustSchema = z.object({
  delta: z.number().int().refine((n) => n !== 0, "El ajuste no puede ser 0"),
  reason: z.string().trim().min(3).max(300),
});
export const productListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: z.string().uuid().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  lowStock: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const COLS = `p.id, p.sku, p.name, p.description, p.category_id AS "categoryId", c.name AS "categoryName", p.brand, p.model,
  p.price::float8 AS price, p.cost::float8 AS cost, p.stock_on_hand AS "stockOnHand", p.stock_reserved AS "stockReserved",
  p.stock_min AS "stockMin", p.warranty_months AS "warrantyMonths", p.specs, p.image_urls AS "imageUrls", p.status,
  p.created_at AS "createdAt", p.updated_at AS "updatedAt"`;
const FROM = "FROM products p JOIN product_categories c ON c.id = p.category_id";

export async function listProducts(q: z.infer<typeof productListQuery>) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.q) {
    params.push(likePattern(q.q), q.q);
    where.push(`(p.sku ILIKE $${params.length - 1} OR p.name ILIKE $${params.length - 1} OR p.brand ILIKE $${params.length - 1} OR p.model ILIKE $${params.length - 1}
      OR word_similarity($${params.length}, coalesce(p.name,'') || ' ' || coalesce(p.brand,'') || ' ' || coalesce(p.model,'')) > 0.45)`);
  }
  if (q.categoryId) { params.push(q.categoryId); where.push(`p.category_id = $${params.length}`); }
  if (q.status) { params.push(q.status); where.push(`p.status = $${params.length}`); }
  if (q.lowStock === "true") where.push("p.stock_on_hand <= p.stock_min");
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await getPool().query<{ n: string }>(`SELECT count(*) AS n ${FROM} ${w}`, params);
  params.push(q.limit, (q.page - 1) * q.limit);
  const { rows } = await getPool().query(`SELECT ${COLS} ${FROM} ${w} ORDER BY p.name LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows, page: q.page, limit: q.limit, total: Number(total.rows[0]?.n ?? 0) };
}

export async function getProduct(id: string, client: pg.Pool | pg.PoolClient = getPool()) {
  const { rows } = await client.query(`SELECT ${COLS} ${FROM} WHERE p.id = $1`, [uuidParam(id)]);
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Producto no encontrado");
  return rows[0];
}

function mapDbError(e: unknown): never {
  const code = pgCode(e);
  if (code === "23505") throw new AppError(409, "SKU_TAKEN", "Ya existe un producto con ese SKU");
  if (code === "23503") throw new AppError(400, "UNKNOWN_CATEGORY", "Categoría inexistente");
  throw e;
}

export async function createProduct(input: z.infer<typeof productCreateSchema>, req: Request) {
  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO products (sku, name, description, category_id, brand, model, price, cost, stock_on_hand, stock_min, warranty_months, specs, image_urls)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [input.sku, input.name, input.description ?? null, input.categoryId, input.brand ?? null, input.model ?? null, input.price, input.cost ?? null,
         input.stockOnHand, input.stockMin, input.warrantyMonths, JSON.stringify(input.specs), input.imageUrls],
      );
      const id = rows[0]!.id;
      if (input.stockOnHand > 0) {
        await client.query(
          "INSERT INTO inventory_movements (product_id, type, qty, balance_after, reason, created_by) VALUES ($1,'initial',$2,$2,'Stock inicial',$3)",
          [id, input.stockOnHand, req.auth?.id ?? null],
        );
      }
      await writeAudit({ action: "product.create", entityType: "product", entityId: id, after: { sku: input.sku, price: input.price } }, req, client);
      return getProduct(id, client);
    });
  } catch (e) { return mapDbError(e); }
}

const COLUMN_MAP: Record<string, string> = {
  sku: "sku", name: "name", description: "description", categoryId: "category_id", brand: "brand", model: "model", price: "price", cost: "cost",
  stockMin: "stock_min", warrantyMonths: "warranty_months", status: "status",
};

export async function updateProduct(id: string, input: z.infer<typeof productUpdateSchema>, req: Request) {
  uuidParam(id);
  try {
    return await withTransaction(async (client) => {
      const before = await getProduct(id, client);
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [k, v] of Object.entries(input)) {
        if (v === undefined) continue;
        if (k === "specs") { params.push(JSON.stringify(v)); sets.push(`specs = $${params.length}`); continue; }
        if (k === "imageUrls") { params.push(v); sets.push(`image_urls = $${params.length}`); continue; }
        const col = COLUMN_MAP[k];
        if (!col) continue;
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
      if (sets.length) await client.query(`UPDATE products SET ${sets.join(", ")} WHERE id = $1`, params);
      const after = await getProduct(id, client);
      await writeAudit(
        { action: "product.update", entityType: "product", entityId: id,
          before: { sku: before.sku, price: before.price, cost: before.cost, status: before.status },
          after: { sku: after.sku, price: after.price, cost: after.cost, status: after.status } },
        req, client);
      return after;
    });
  } catch (e) { return mapDbError(e); }
}

/** Ajuste manual de existencias, atómico: la fila se bloquea y el saldo nunca queda negativo. */
export async function adjustStock(id: string, input: z.infer<typeof stockAdjustSchema>, req: Request) {
  uuidParam(id);
  return withTransaction(async (client) => {
    const cur = await client.query<{ stock_on_hand: number; stock_reserved: number }>("SELECT stock_on_hand, stock_reserved FROM products WHERE id = $1 FOR UPDATE", [id]);
    if (!cur.rows[0]) throw new AppError(404, "NOT_FOUND", "Producto no encontrado");
    const next = cur.rows[0].stock_on_hand + input.delta;
    if (next < 0) throw new AppError(409, "INSUFFICIENT_STOCK", "El ajuste dejaría el stock en negativo");
    if (next < cur.rows[0].stock_reserved) throw new AppError(409, "BELOW_RESERVED", "El stock no puede quedar por debajo de lo reservado");
    await client.query("UPDATE products SET stock_on_hand = $2 WHERE id = $1", [id, next]);
    await client.query(
      "INSERT INTO inventory_movements (product_id, type, qty, balance_after, reason, created_by) VALUES ($1,'adjustment',$2,$3,$4,$5)",
      [id, input.delta, next, input.reason, req.auth?.id ?? null],
    );
    await writeAudit({ action: "product.stock_adjust", entityType: "product", entityId: id, before: { stock: cur.rows[0].stock_on_hand }, after: { stock: next, reason: input.reason } }, req, client);
    return getProduct(id, client);
  });
}

export async function listMovements(id: string) {
  await getProduct(id);
  const { rows } = await getPool().query(
    `SELECT id, type, qty, balance_after AS "balanceAfter", reason, created_by AS "createdBy", created_at AS "createdAt"
     FROM inventory_movements WHERE product_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`, [id]);
  return { items: rows };
}

export async function listCategories() {
  const { rows } = await getPool().query('SELECT id, name, parent_id AS "parentId", active FROM product_categories ORDER BY name');
  return { items: rows };
}
export const categorySchema = z.object({ name: z.string().trim().min(2).max(80), parentId: z.string().uuid().optional() });
export async function createCategory(input: z.infer<typeof categorySchema>, req: Request) {
  try {
    const { rows } = await getPool().query('INSERT INTO product_categories (name, parent_id) VALUES ($1,$2) RETURNING id, name, parent_id AS "parentId", active', [input.name, input.parentId ?? null]);
    await writeAudit({ action: "category.create", entityType: "product_category", entityId: rows[0].id, after: { name: input.name } }, req);
    return rows[0];
  } catch (e) {
    if (pgCode(e) === "23505") throw new AppError(409, "CATEGORY_EXISTS", "La categoría ya existe");
    if (pgCode(e) === "23503") throw new AppError(400, "UNKNOWN_CATEGORY", "Categoría padre inexistente");
    throw e;
  }
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita inyección de fórmulas al abrir en Excel
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportProductsCsv(): Promise<string> {
  const { rows } = await getPool().query(`SELECT ${COLS} ${FROM} ORDER BY p.sku`);
  const header = ["sku", "nombre", "categoria", "marca", "modelo", "precio", "costo", "stock", "stock_minimo", "garantia_meses", "estado"];
  const lines = rows.map((r) => [r.sku, r.name, r.categoryName, r.brand, r.model, r.price, r.cost, r.stockOnHand, r.stockMin, r.warrantyMonths, r.status].map(csvCell).join(","));
  return `\uFEFF${[header.join(","), ...lines].join("\r\n")}\r\n`;
}
