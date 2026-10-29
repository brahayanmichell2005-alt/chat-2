import type { Request } from "express";
import type pg from "pg";
import { z } from "zod";
import type { AuthUser } from "@crm/shared";
import { writeAudit } from "../../common/audit.js";
import { AppError } from "../../common/errors.js";
import { fromCents, toCents } from "../../common/money.js";
import { uuidParam } from "../../common/http.js";
import { getPool, withTransaction } from "../../database/pool.js";
import { buildDocument, documentInputSchema, insertLines, ITEM_COLS, logStatus } from "./items.js";
import { aggregateProductQty, can, ORDER_TRANSITIONS, paymentSummary, type OrderStatus, type PaymentStatus } from "./rules.js";

export const orderCreateSchema = documentInputSchema.extend({ deliveryTerms: z.string().trim().max(500).optional() });
export const orderStatusSchema = z.object({
  status: z.enum(["confirmed", "preparing", "completed", "cancelled"]),
  reason: z.string().trim().min(2).max(500).optional(),
});
export const orderListQuery = z.object({
  status: z.enum(["requested", "confirmed", "preparing", "completed", "cancelled"]).optional(),
  customerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const COLS = `o.id, o.code, o.status, o.customer_id AS "customerId", c.name AS "customerName", o.quote_id AS "quoteId", o.conversation_id AS "conversationId",
  o.subtotal::float8 AS subtotal, o.discount_total::float8 AS "discountTotal", o.extra_total::float8 AS "extraTotal", o.total::float8 AS total,
  o.delivery_terms AS "deliveryTerms", o.cancel_reason AS "cancelReason", o.confirmed_at AS "confirmedAt", o.completed_at AS "completedAt", o.created_at AS "createdAt"`;
const FROM = "FROM orders o JOIN customers c ON c.id = o.customer_id";

export async function listOrders(q: z.infer<typeof orderListQuery>) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) { params.push(q.status); where.push(`o.status = $${params.length}`); }
  if (q.customerId) { params.push(q.customerId); where.push(`o.customer_id = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM orders o ${w}`, params);
  params.push(q.limit, (q.page - 1) * q.limit);
  const { rows } = await getPool().query(
    `SELECT ${COLS},
       COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.order_id = o.id AND p.status = 'verified'), 0)::float8 AS "paidTotal"
     ${FROM} ${w} ORDER BY o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows, page: q.page, limit: q.limit, total: Number(total.rows[0]?.n ?? 0) };
}

export async function getOrder(id: string, db: pg.Pool | pg.PoolClient = getPool()) {
  const r = await db.query(`SELECT ${COLS} ${FROM} WHERE o.id = $1`, [uuidParam(id)]);
  const o = r.rows[0];
  if (!o) throw new AppError(404, "NOT_FOUND", "Pedido no encontrado");
  const items = await db.query(`SELECT ${ITEM_COLS} FROM order_items WHERE order_id = $1 ORDER BY line_no`, [id]);
  const pays = await db.query(
    `SELECT id, code, amount::float8 AS amount, method, reference, evidence_ref AS "evidenceRef", status, reason, created_at AS "createdAt", verified_at AS "verifiedAt"
     FROM payments WHERE order_id = $1 ORDER BY created_at`, [id]);
  const s = paymentSummary(toCents(o.total), pays.rows.map((p) => ({ status: p.status as PaymentStatus, amountCents: toCents(p.amount) })));
  return { ...o, items: items.rows, payments: pays.rows,
    paymentSummary: { total: fromCents(s.totalCents), verified: fromCents(s.verifiedCents), open: fromCents(s.openCents), balance: fromCents(s.balanceCents), registrable: fromCents(s.registrableCents) } };
}

export async function createOrder(input: z.infer<typeof orderCreateSchema>, auth: AuthUser, req: Request) {
  return withTransaction(async (client) => {
    const cust = await client.query("SELECT 1 FROM customers WHERE id = $1 AND status = 'active'", [input.customerId]);
    if (!cust.rowCount) throw new AppError(400, "UNKNOWN_CUSTOMER", "Cliente inexistente o inactivo");
    const doc = await buildDocument(client, input.items, input.extraCost, auth);
    const r = await client.query<{ id: string }>(
      `INSERT INTO orders (customer_id, conversation_id, subtotal, discount_total, extra_total, total, delivery_terms, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [input.customerId, input.conversationId ?? null, fromCents(doc.subtotalCents), fromCents(doc.discountCents), fromCents(doc.extraCents), fromCents(doc.totalCents), input.deliveryTerms ?? null, auth.id]);
    const id = r.rows[0]!.id;
    await insertLines(client, "order_items", "order_id", id, doc.lines);
    await logStatus(client, "order", id, null, "requested", auth.id);
    await writeAudit({ action: "order.create", entityType: "order", entityId: id, after: { total: fromCents(doc.totalCents) } }, req, client);
    return getOrder(id, client);
  });
}

type StockOp = "reserve" | "release" | "sale_out";

/**
 * Política de stock: confirmar RESERVA, cancelar LIBERA, completar DESCUENTA. Cada operación es atómica y única por pedido
 * (índice único de inventory_movements); la reserva falla entera si algún producto no alcanza.
 */
async function applyStock(client: pg.PoolClient, orderId: string, op: StockOp, userId: string) {
  const items = await client.query<{ product_id: string | null; qty: number }>("SELECT product_id, qty FROM order_items WHERE order_id = $1", [orderId]);
  for (const [productId, qty] of aggregateProductQty(items.rows.map((i) => ({ productId: i.product_id, qty: i.qty })))) {
    let sql: string;
    let movement: string;
    let signed: number;
    if (op === "reserve") {
      sql = "UPDATE products SET stock_reserved = stock_reserved + $2 WHERE id = $1 AND status = 'active' AND stock_on_hand - stock_reserved >= $2 RETURNING stock_on_hand, name";
      movement = "sale_reserve"; signed = qty;
    } else if (op === "release") {
      sql = "UPDATE products SET stock_reserved = stock_reserved - $2 WHERE id = $1 AND stock_reserved >= $2 RETURNING stock_on_hand, name";
      movement = "sale_release"; signed = -qty;
    } else {
      sql = "UPDATE products SET stock_on_hand = stock_on_hand - $2, stock_reserved = stock_reserved - $2 WHERE id = $1 AND stock_reserved >= $2 AND stock_on_hand >= $2 RETURNING stock_on_hand, name";
      movement = "sale_out"; signed = -qty;
    }
    const r = await client.query<{ stock_on_hand: number; name: string }>(sql, [productId, qty]);
    if (!r.rows[0]) {
      const p = await client.query<{ name: string; stock_on_hand: number; stock_reserved: number }>("SELECT name, stock_on_hand, stock_reserved FROM products WHERE id = $1", [productId]);
      const name = p.rows[0]?.name ?? "producto";
      if (op === "reserve") throw new AppError(409, "INSUFFICIENT_STOCK", `Stock insuficiente para "${name}": disponible ${Math.max(0, (p.rows[0]?.stock_on_hand ?? 0) - (p.rows[0]?.stock_reserved ?? 0))}, solicitado ${qty}`);
      throw new AppError(409, "STOCK_INCONSISTENT", `Inconsistencia de stock en "${name}". Revise los movimientos antes de continuar.`);
    }
    try {
      await client.query(
        `INSERT INTO inventory_movements (product_id, type, qty, balance_after, ref_type, ref_id, reason, created_by) VALUES ($1,$2,$3,$4,'order',$5,$6,$7)`,
        [productId, movement, signed, r.rows[0].stock_on_hand, orderId, `Pedido ${orderId.slice(0, 8)}`, userId]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new AppError(409, "STOCK_ALREADY_APPLIED", "El movimiento de stock de este pedido ya fue registrado");
      throw e;
    }
  }
}

export async function changeOrderStatus(id: string, input: z.infer<typeof orderStatusSchema>, auth: AuthUser, req: Request) {
  uuidParam(id);
  return withTransaction(async (client) => {
    const cur = await client.query<{ status: OrderStatus }>("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [id]);
    if (!cur.rows[0]) throw new AppError(404, "NOT_FOUND", "Pedido no encontrado");
    const from = cur.rows[0].status;
    const to = input.status;
    if (!can(ORDER_TRANSITIONS, from, to)) throw new AppError(409, "INVALID_TRANSITION", `No se puede pasar de "${from}" a "${to}"`);
    if (to === "cancelled" && !input.reason) throw new AppError(400, "REASON_REQUIRED", "Indique el motivo de la cancelación");

    if (to === "cancelled") {
      const v = await client.query("SELECT 1 FROM payments WHERE order_id = $1 AND status IN ('verified', 'in_review', 'pending') LIMIT 1", [id]);
      if (v.rowCount) throw new AppError(409, "HAS_PAYMENTS", "El pedido tiene pagos registrados: rechácelos o reembólselos antes de cancelar");
    }
    if (to === "confirmed") await applyStock(client, id, "reserve", auth.id);
    if (to === "completed") await applyStock(client, id, "sale_out", auth.id);
    if (to === "cancelled" && from !== "requested") await applyStock(client, id, "release", auth.id);

    await client.query(
      `UPDATE orders SET status = $2, cancel_reason = COALESCE($3, cancel_reason),
         confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END, completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END WHERE id = $1`,
      [id, to, to === "cancelled" ? input.reason : null]);
    await logStatus(client, "order", id, from, to, auth.id, input.reason);
    await writeAudit({ action: `order.${to}`, entityType: "order", entityId: id, before: { status: from }, after: { status: to, reason: input.reason ?? null } }, req, client);
    return getOrder(id, client);
  });
}
