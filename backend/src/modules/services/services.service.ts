import type { Request } from "express";
import type pg from "pg";
import { z } from "zod";
import { writeAudit } from "../../common/audit.js";
import { AppError } from "../../common/errors.js";
import { likePattern, pgCode, uuidParam } from "../../common/http.js";
import { getPool, withTransaction } from "../../database/pool.js";

const base = z.object({
  code: z.string().trim().min(1).max(40).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2).max(160),
  categoryId: z.string().uuid(),
  description: z.string().trim().max(4000).optional(),
  priceType: z.enum(["fixed", "quote", "inspection"]),
  baseRate: z.number().min(0).max(99_999_999.99).nullable().optional(),
  requiresInspection: z.boolean().default(false),
  estMinutes: z.number().int().min(1).max(100_000).nullable().optional(),
  conditions: z.string().trim().max(4000).optional(),
  requirements: z.string().trim().max(4000).optional(),
  warrantyDays: z.number().int().min(0).max(3650).default(0),
});
const fixedNeedsRate = (v: { priceType?: string; baseRate?: number | null }) => v.priceType !== "fixed" || (v.baseRate !== undefined && v.baseRate !== null);
export const serviceCreateSchema = base.refine(fixedNeedsRate, { message: "Un servicio de precio fijo requiere tarifa base", path: ["baseRate"] });
export const serviceUpdateSchema = base.partial().extend({ status: z.enum(["active", "inactive"]).optional() }).refine((v) => Object.keys(v).length > 0, { message: "Sin cambios" });
export const serviceListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: z.string().uuid().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const COLS = `s.id, s.code, s.name, s.category_id AS "categoryId", c.name AS "categoryName", s.description, s.price_type AS "priceType",
  s.base_rate::float8 AS "baseRate", s.requires_inspection AS "requiresInspection", s.est_minutes AS "estMinutes", s.conditions, s.requirements,
  s.warranty_days AS "warrantyDays", s.status, s.created_at AS "createdAt", s.updated_at AS "updatedAt"`;
const FROM = "FROM services s JOIN service_categories c ON c.id = s.category_id";

export async function listServices(q: z.infer<typeof serviceListQuery>) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.q) { params.push(likePattern(q.q)); where.push(`(s.name ILIKE $${params.length} OR s.code ILIKE $${params.length})`); }
  if (q.categoryId) { params.push(q.categoryId); where.push(`s.category_id = $${params.length}`); }
  if (q.status) { params.push(q.status); where.push(`s.status = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await getPool().query<{ n: string }>(`SELECT count(*) AS n ${FROM} ${w}`, params);
  params.push(q.limit, (q.page - 1) * q.limit);
  const { rows } = await getPool().query(`SELECT ${COLS} ${FROM} ${w} ORDER BY s.name LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows, page: q.page, limit: q.limit, total: Number(total.rows[0]?.n ?? 0) };
}

export async function getService(id: string, client: pg.Pool | pg.PoolClient = getPool()) {
  const { rows } = await client.query(`SELECT ${COLS} ${FROM} WHERE s.id = $1`, [uuidParam(id)]);
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Servicio no encontrado");
  return rows[0];
}

function mapDbError(e: unknown): never {
  const c = pgCode(e);
  if (c === "23505") throw new AppError(409, "CODE_TAKEN", "Ya existe un servicio con ese código");
  if (c === "23503") throw new AppError(400, "UNKNOWN_CATEGORY", "Categoría inexistente");
  if (c === "23514") throw new AppError(400, "INVALID_RATE", "Un servicio de precio fijo requiere tarifa base");
  throw e;
}

const MAP: Record<string, string> = {
  code: "code", name: "name", categoryId: "category_id", description: "description", priceType: "price_type", baseRate: "base_rate",
  requiresInspection: "requires_inspection", estMinutes: "est_minutes", conditions: "conditions", requirements: "requirements",
  warrantyDays: "warranty_days", status: "status",
};

export async function createService(i: z.infer<typeof serviceCreateSchema>, req: Request) {
  try {
    return await withTransaction(async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO services (code, name, category_id, description, price_type, base_rate, requires_inspection, est_minutes, conditions, requirements, warranty_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [i.code, i.name, i.categoryId, i.description ?? null, i.priceType, i.baseRate ?? null, i.requiresInspection, i.estMinutes ?? null, i.conditions ?? null, i.requirements ?? null, i.warrantyDays],
      );
      await writeAudit({ action: "service.create", entityType: "service", entityId: r.rows[0]!.id, after: { code: i.code, priceType: i.priceType, baseRate: i.baseRate ?? null } }, req, client);
      return getService(r.rows[0]!.id, client);
    });
  } catch (e) { return mapDbError(e); }
}

export async function updateService(id: string, i: z.infer<typeof serviceUpdateSchema>, req: Request) {
  uuidParam(id);
  try {
    return await withTransaction(async (client) => {
      const before = await getService(id, client);
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [k, v] of Object.entries(i)) {
        if (v === undefined || !MAP[k]) continue;
        params.push(v);
        sets.push(`${MAP[k]} = $${params.length}`);
      }
      if (sets.length) await client.query(`UPDATE services SET ${sets.join(", ")} WHERE id = $1`, params);
      const after = await getService(id, client);
      await writeAudit({ action: "service.update", entityType: "service", entityId: id,
        before: { baseRate: before.baseRate, priceType: before.priceType, status: before.status },
        after: { baseRate: after.baseRate, priceType: after.priceType, status: after.status } }, req, client);
      return after;
    });
  } catch (e) { return mapDbError(e); }
}

export async function listServiceCategories() {
  const { rows } = await getPool().query("SELECT id, name, active FROM service_categories ORDER BY name");
  return { items: rows };
}
