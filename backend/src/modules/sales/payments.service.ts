import type { Request } from "express";
import type pg from "pg";
import { z } from "zod";
import type { AuthUser } from "@crm/shared";
import { writeAudit } from "../../common/audit.js";
import { AppError } from "../../common/errors.js";
import { fromCents, toCents } from "../../common/money.js";
import { uuidParam } from "../../common/http.js";
import { getPool, withTransaction } from "../../database/pool.js";
import { logStatus } from "./items.js";
import { can, PAYMENT_TRANSITIONS, paymentSummary, type PaymentStatus } from "./rules.js";

export const paymentCreateSchema = z.object({
  orderId: z.string().uuid(),
  amount: z.number().positive().max(99_999_999.99),
  method: z.enum(["efectivo", "transferencia", "yape", "plin", "tarjeta_pos", "otro"]),
  reference: z.string().trim().max(100).optional(),
  evidenceRef: z.string().trim().max(300).optional(),
});
export const paymentReasonSchema = z.object({ reason: z.string().trim().min(2).max(500) });
export const paymentListQuery = z.object({
  orderId: z.string().uuid().optional(),
  status: z.enum(["pending", "in_review", "verified", "rejected", "refunded"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const COLS = `p.id, p.code, p.order_id AS "orderId", o.code AS "orderCode", c.name AS "customerName", p.amount::float8 AS amount, p.method, p.reference,
  p.evidence_ref AS "evidenceRef", p.status, p.reason, ru.name AS "registeredBy", vu.name AS "verifiedBy", p.verified_at AS "verifiedAt", p.created_at AS "createdAt"`;
const FROM = `FROM payments p JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = o.customer_id
  LEFT JOIN users ru ON ru.id = p.registered_by LEFT JOIN users vu ON vu.id = p.verified_by`;

export async function listPayments(q: z.infer<typeof paymentListQuery>) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.orderId) { params.push(q.orderId); where.push(`p.order_id = $${params.length}`); }
  if (q.status) { params.push(q.status); where.push(`p.status = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM payments p ${w}`, params);
  params.push(q.limit, (q.page - 1) * q.limit);
  const { rows } = await getPool().query(`SELECT ${COLS} ${FROM} ${w} ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows, page: q.page, limit: q.limit, total: Number(total.rows[0]?.n ?? 0) };
}

async function getPayment(id: string, db: pg.Pool | pg.PoolClient = getPool()) {
  const r = await db.query(`SELECT ${COLS} ${FROM} WHERE p.id = $1`, [uuidParam(id)]);
  if (!r.rows[0]) throw new AppError(404, "NOT_FOUND", "Pago no encontrado");
  return r.rows[0];
}

/** Registra un pago PENDIENTE. Nunca queda verificado por sí solo ni por lo que diga el cliente o la IA. */
export async function createPayment(input: z.infer<typeof paymentCreateSchema>, auth: AuthUser, req: Request) {
  return withTransaction(async (client) => {
    const o = await client.query<{ status: string; total: string }>("SELECT status, total FROM orders WHERE id = $1 FOR UPDATE", [input.orderId]);
    if (!o.rows[0]) throw new AppError(404, "NOT_FOUND", "Pedido no encontrado");
    if (o.rows[0].status === "cancelled") throw new AppError(409, "ORDER_CANCELLED", "El pedido está cancelado");
    const pays = await client.query<{ status: PaymentStatus; amount: string }>("SELECT status, amount FROM payments WHERE order_id = $1", [input.orderId]);
    const s = paymentSummary(toCents(Number(o.rows[0].total)), pays.rows.map((p) => ({ status: p.status, amountCents: toCents(Number(p.amount)) })));
    if (toCents(input.amount) > s.registrableCents) {
      throw new AppError(409, "OVERPAYMENT", `El monto supera lo que falta por registrar (S/ ${fromCents(s.registrableCents).toFixed(2)})`);
    }
    const r = await client.query<{ id: string }>(
      "INSERT INTO payments (order_id, amount, method, reference, evidence_ref, registered_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [input.orderId, input.amount, input.method, input.reference ?? null, input.evidenceRef ?? null, auth.id]);
    const id = r.rows[0]!.id;
    await logStatus(client, "payment", id, null, "pending", auth.id);
    await writeAudit({ action: "payment.create", entityType: "payment", entityId: id, after: { orderId: input.orderId, amount: input.amount, method: input.method } }, req, client);
    return getPayment(id, client);
  });
}

async function transition(id: string, to: PaymentStatus, auth: AuthUser, req: Request, reason?: string) {
  return withTransaction(async (client) => {
    const cur = await client.query<{ status: PaymentStatus; registered_by: string | null }>("SELECT status, registered_by FROM payments WHERE id = $1 FOR UPDATE", [uuidParam(id)]);
    const p = cur.rows[0];
    if (!p) throw new AppError(404, "NOT_FOUND", "Pago no encontrado");
    if (!can(PAYMENT_TRANSITIONS, p.status, to)) throw new AppError(409, "INVALID_TRANSITION", `No se puede pasar de "${p.status}" a "${to}"`);
    // Doble control: quien registró el pago no lo verifica (salvo un administrador).
    if (to === "verified" && p.registered_by === auth.id && !auth.roles.includes("admin")) {
      throw new AppError(409, "SELF_VERIFY", "El pago debe ser verificado por otra persona");
    }
    const verifying = to === "verified" || to === "rejected" || to === "refunded";
    await client.query(
      "UPDATE payments SET status = $2, reason = COALESCE($3, reason), verified_by = CASE WHEN $4 THEN $5::uuid ELSE verified_by END, verified_at = CASE WHEN $4 THEN now() ELSE verified_at END WHERE id = $1",
      [id, to, reason ?? null, verifying, auth.id]);
    await logStatus(client, "payment", id, p.status, to, auth.id, reason);
    await writeAudit({ action: `payment.${to}`, entityType: "payment", entityId: id, before: { status: p.status }, after: { status: to, reason: reason ?? null } }, req, client);
    return getPayment(id, client);
  });
}

export const reviewPayment = (id: string, auth: AuthUser, req: Request) => transition(id, "in_review", auth, req);
export const verifyPayment = (id: string, auth: AuthUser, req: Request) => transition(id, "verified", auth, req);
export const rejectPayment = (id: string, reason: string, auth: AuthUser, req: Request) => transition(id, "rejected", auth, req, reason);
export const refundPayment = (id: string, reason: string, auth: AuthUser, req: Request) => transition(id, "refunded", auth, req, reason);
