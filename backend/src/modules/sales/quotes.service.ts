import type { Request } from "express";
import type pg from "pg";
import { z } from "zod";
import type { AuthUser } from "@crm/shared";
import { writeAudit } from "../../common/audit.js";
import { AppError } from "../../common/errors.js";
import { fromCents, toCents } from "../../common/money.js";
import { getEnv } from "../../config/env.js";
import { getPool, withTransaction } from "../../database/pool.js";
import { uuidParam } from "../../common/http.js";
import { enqueueHumanMessage } from "../whatsapp/outbox.service.js";
import { buildDocument, documentInputSchema, insertLines, ITEM_COLS, logStatus } from "./items.js";
import { formatQuoteText } from "./quote-text.js";
import { can, QUOTE_TRANSITIONS, type QuoteStatus } from "./rules.js";

export const quoteCreateSchema = documentInputSchema.extend({
  validDays: z.number().int().min(1).max(60).default(7),
  conditions: z.string().trim().max(1000).optional(),
});
export const quoteListQuery = z.object({
  status: z.enum(["draft", "pending_send", "sent", "accepted", "rejected", "expired", "converted"]).optional(),
  customerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const reasonSchema = z.object({ reason: z.string().trim().min(2).max(500) });
export const convertSchema = z.object({ deliveryTerms: z.string().trim().max(500).optional() });

const COLS = `q.id, q.code, q.status, q.customer_id AS "customerId", c.name AS "customerName", q.conversation_id AS "conversationId",
  q.valid_until AS "validUntil", q.notes, q.conditions, q.subtotal::float8 AS subtotal, q.discount_total::float8 AS "discountTotal",
  q.extra_total::float8 AS "extraTotal", q.total::float8 AS total, q.reject_reason AS "rejectReason", q.sent_at AS "sentAt",
  q.accepted_at AS "acceptedAt", q.created_at AS "createdAt", q.version, o.id AS "orderId", o.code AS "orderCode",
  m.status AS "sendStatus", m.last_error AS "sendError"`;
const FROM = `FROM quotes q JOIN customers c ON c.id = q.customer_id LEFT JOIN orders o ON o.quote_id = q.id LEFT JOIN messages m ON m.id = q.send_message_id`;

export async function listQuotes(q: z.infer<typeof quoteListQuery>) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) { params.push(q.status); where.push(`q.status = $${params.length}`); }
  if (q.customerId) { params.push(q.customerId); where.push(`q.customer_id = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM quotes q ${w}`, params);
  params.push(q.limit, (q.page - 1) * q.limit);
  const { rows } = await getPool().query(`SELECT ${COLS} ${FROM} ${w} ORDER BY q.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows, page: q.page, limit: q.limit, total: Number(total.rows[0]?.n ?? 0) };
}

export async function getQuote(id: string, db: pg.Pool | pg.PoolClient = getPool()) {
  const r = await db.query(`SELECT ${COLS} ${FROM} WHERE q.id = $1`, [uuidParam(id)]);
  if (!r.rows[0]) throw new AppError(404, "NOT_FOUND", "Cotización no encontrada");
  const items = await db.query(`SELECT ${ITEM_COLS} FROM quote_items WHERE quote_id = $1 ORDER BY line_no`, [id]);
  return { ...r.rows[0], items: items.rows };
}

async function lockQuote(client: pg.PoolClient, id: string) {
  const r = await client.query<{ status: QuoteStatus; valid_until: Date; version: number; customer_id: string; conversation_id: string | null }>(
    "SELECT status, valid_until, version, customer_id, conversation_id FROM quotes WHERE id = $1 FOR UPDATE", [uuidParam(id)]);
  if (!r.rows[0]) throw new AppError(404, "NOT_FOUND", "Cotización no encontrada");
  return r.rows[0];
}

async function expireIfDue(client: pg.PoolClient, id: string, q: { status: QuoteStatus; valid_until: Date }): Promise<boolean> {
  if (["draft", "pending_send", "sent"].includes(q.status) && q.valid_until.getTime() < Date.now()) {
    await client.query("UPDATE quotes SET status = 'expired' WHERE id = $1", [id]);
    await logStatus(client, "quote", id, q.status, "expired", null, "Vencida");
    return true;
  }
  return false;
}

function move(q: { status: QuoteStatus }, to: QuoteStatus) {
  if (!can(QUOTE_TRANSITIONS, q.status, to)) throw new AppError(409, "INVALID_TRANSITION", `No se puede pasar de "${q.status}" a "${to}"`);
}

export async function createQuote(input: z.infer<typeof quoteCreateSchema>, auth: AuthUser, req: Request) {
  return withTransaction(async (client) => {
    const cust = await client.query("SELECT 1 FROM customers WHERE id = $1 AND status = 'active'", [input.customerId]);
    if (!cust.rowCount) throw new AppError(400, "UNKNOWN_CUSTOMER", "Cliente inexistente o inactivo");
    const doc = await buildDocument(client, input.items, input.extraCost, auth);
    const r = await client.query<{ id: string }>(
      `INSERT INTO quotes (customer_id, conversation_id, valid_until, notes, conditions, subtotal, discount_total, extra_total, total, created_by)
       VALUES ($1,$2, now() + make_interval(days => $3), $4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [input.customerId, input.conversationId ?? null, input.validDays, input.notes ?? null, input.conditions ?? null,
       fromCents(doc.subtotalCents), fromCents(doc.discountCents), fromCents(doc.extraCents), fromCents(doc.totalCents), auth.id]);
    const id = r.rows[0]!.id;
    await insertLines(client, "quote_items", "quote_id", id, doc.lines);
    await logStatus(client, "quote", id, null, "draft", auth.id);
    await writeAudit({ action: "quote.create", entityType: "quote", entityId: id, after: { total: fromCents(doc.totalCents), discount: fromCents(doc.discountCents) } }, req, client);
    return getQuote(id, client);
  });
}

/** Reemplaza las líneas de una cotización aún no enviada. Vuelve a borrador. */
export async function updateQuote(id: string, input: z.infer<typeof quoteCreateSchema>, auth: AuthUser, req: Request) {
  return withTransaction(async (client) => {
    const q = await lockQuote(client, id);
    if (!["draft", "pending_send"].includes(q.status)) throw new AppError(409, "NOT_EDITABLE", "Solo se puede editar una cotización en borrador o pendiente de envío");
    if (q.customer_id !== input.customerId) throw new AppError(400, "CUSTOMER_LOCKED", "No se puede cambiar el cliente de una cotización");
    const doc = await buildDocument(client, input.items, input.extraCost, auth);
    await client.query("DELETE FROM quote_items WHERE quote_id = $1", [id]);
    await insertLines(client, "quote_items", "quote_id", id, doc.lines);
    await client.query(
      `UPDATE quotes SET status = 'draft', notes = $2, conditions = $3, subtotal = $4, discount_total = $5, extra_total = $6, total = $7,
         valid_until = now() + make_interval(days => $8), version = version + 1 WHERE id = $1`,
      [id, input.notes ?? null, input.conditions ?? null, fromCents(doc.subtotalCents), fromCents(doc.discountCents), fromCents(doc.extraCents), fromCents(doc.totalCents), input.validDays]);
    if (q.status !== "draft") await logStatus(client, "quote", id, q.status, "draft", auth.id, "Editada");
    await writeAudit({ action: "quote.update", entityType: "quote", entityId: id, after: { total: fromCents(doc.totalCents) } }, req, client);
    return getQuote(id, client);
  });
}

export async function submitQuote(id: string, auth: AuthUser, req: Request) {
  return withTransaction(async (client) => {
    const q = await lockQuote(client, id);
    if (await expireIfDue(client, id, q)) throw new AppError(409, "EXPIRED", "La cotización venció");
    move(q, "pending_send");
    await client.query("UPDATE quotes SET status = 'pending_send' WHERE id = $1", [id]);
    await logStatus(client, "quote", id, q.status, "pending_send", auth.id);
    await writeAudit({ action: "quote.submit", entityType: "quote", entityId: id }, req, client);
    return getQuote(id, client);
  });
}

async function quoteMessage(id: string) {
  const quote = await getQuote(id);
  const items = quote.items as { description: string; qty: number; unitPrice: number; discount: number; lineTotal: number }[];
  const text = formatQuoteText({
    code: quote.code, customerName: quote.customerName, validUntil: new Date(quote.validUntil), timezone: getEnv().APP_TIMEZONE,
    items: items.map((i) => ({ description: i.description, qty: i.qty, unitPriceCents: toCents(i.unitPrice), discountCents: toCents(i.discount), lineTotalCents: toCents(i.lineTotal) })),
    subtotalCents: toCents(quote.subtotal), discountCents: toCents(quote.discountTotal), extraCents: toCents(quote.extraTotal), totalCents: toCents(quote.total),
    conditions: quote.conditions, notes: quote.notes,
  });
  const dest = await getPool().query<{ conversation_id: string; phone: string }>(
    `SELECT cv.id AS conversation_id, ct.phone_e164 AS phone FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
     WHERE ct.customer_id = $1 AND cv.status <> 'closed' ORDER BY (cv.id = $2) DESC, cv.last_message_at DESC NULLS LAST LIMIT 1`, [quote.customerId, quote.conversationId]);
  return { quote, text, destination: dest.rows[0] ?? null };
}

/** Vista previa: destinatario e importes tal como se enviarán (el usuario los comprueba antes de enviar). */
export async function previewQuote(id: string) {
  const { quote, text, destination } = await quoteMessage(id);
  return { code: quote.code, status: quote.status, total: quote.total, text, destinationPhone: destination?.phone ?? null, conversationId: destination?.conversation_id ?? null };
}

/** Envía la cotización por WhatsApp (cola de salida; respeta la compuerta de envío). Idempotente por versión de la cotización. */
export async function sendQuote(id: string, auth: AuthUser, req: Request) {
  const { quote, text, destination } = await quoteMessage(id);
  if (!["draft", "pending_send"].includes(quote.status)) throw new AppError(409, "INVALID_TRANSITION", `No se puede enviar una cotización en estado "${quote.status}"`);
  if (new Date(quote.validUntil).getTime() < Date.now()) throw new AppError(409, "EXPIRED", "La cotización venció");
  if (!destination) throw new AppError(409, "NO_CONVERSATION", "El cliente no tiene una conversación de WhatsApp abierta para enviarle la cotización");
  const msg = await enqueueHumanMessage(destination.conversation_id, text, auth, req, `quote-send:${id}:${quote.version}`) as { id: string };
  return withTransaction(async (client) => {
    const q = await lockQuote(client, id);
    if (["draft", "pending_send"].includes(q.status)) {
      await client.query("UPDATE quotes SET status = 'sent', sent_at = now(), send_message_id = $2, conversation_id = $3 WHERE id = $1", [id, msg.id, destination.conversation_id]);
      await logStatus(client, "quote", id, q.status, "sent", auth.id);
      await writeAudit({ action: "quote.send", entityType: "quote", entityId: id, after: { messageId: msg.id } }, req, client);
    }
    return getQuote(id, client);
  });
}

export async function acceptQuote(id: string, auth: AuthUser, req: Request) {
  return withTransaction(async (client) => {
    const q = await lockQuote(client, id);
    if (await expireIfDue(client, id, q)) { await writeAudit({ action: "quote.expire", entityType: "quote", entityId: id }, req, client); throw new AppError(409, "EXPIRED", "La cotización venció"); }
    move(q, "accepted");
    await client.query("UPDATE quotes SET status = 'accepted', accepted_at = now() WHERE id = $1", [id]);
    await logStatus(client, "quote", id, q.status, "accepted", auth.id, "Aceptada por el cliente (registrada por una persona)");
    await writeAudit({ action: "quote.accept", entityType: "quote", entityId: id }, req, client);
    return getQuote(id, client);
  });
}

export async function rejectQuote(id: string, reason: string, auth: AuthUser, req: Request) {
  return withTransaction(async (client) => {
    const q = await lockQuote(client, id);
    move(q, "rejected");
    await client.query("UPDATE quotes SET status = 'rejected', reject_reason = $2 WHERE id = $1", [id, reason]);
    await logStatus(client, "quote", id, q.status, "rejected", auth.id, reason);
    await writeAudit({ action: "quote.reject", entityType: "quote", entityId: id, after: { reason } }, req, client);
    return getQuote(id, client);
  });
}

/** Convierte una cotización aceptada en pedido. Idempotente: si ya fue convertida devuelve el mismo pedido. */
export async function convertQuote(id: string, deliveryTerms: string | undefined, auth: AuthUser, req: Request) {
  return withTransaction(async (client) => {
    const q = await lockQuote(client, id);
    const existing = await client.query<{ id: string }>("SELECT id FROM orders WHERE quote_id = $1", [id]);
    if (existing.rows[0]) return { orderId: existing.rows[0].id, alreadyConverted: true };
    move(q, "converted");
    const full = await client.query(
      "SELECT customer_id, conversation_id, subtotal, discount_total, extra_total, total FROM quotes WHERE id = $1", [id]);
    const f = full.rows[0];
    const o = await client.query<{ id: string }>(
      `INSERT INTO orders (customer_id, quote_id, conversation_id, subtotal, discount_total, extra_total, total, delivery_terms, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [f.customer_id, id, f.conversation_id, f.subtotal, f.discount_total, f.extra_total, f.total, deliveryTerms ?? null, auth.id]);
    const orderId = o.rows[0]!.id;
    await client.query(
      `INSERT INTO order_items (order_id, line_no, item_type, product_id, service_id, description, qty, unit_price, discount, line_total)
       SELECT $1, line_no, item_type, product_id, service_id, description, qty, unit_price, discount, line_total FROM quote_items WHERE quote_id = $2`, [orderId, id]);
    await client.query("UPDATE quotes SET status = 'converted' WHERE id = $1", [id]);
    await logStatus(client, "quote", id, q.status, "converted", auth.id);
    await logStatus(client, "order", orderId, null, "requested", auth.id, `Desde la cotización`);
    await writeAudit({ action: "quote.convert", entityType: "quote", entityId: id, after: { orderId } }, req, client);
    return { orderId, alreadyConverted: false };
  });
}

/** Marca como vencidas las cotizaciones cuya vigencia terminó. Se ejecuta periódicamente. */
export async function expireDueQuotes(): Promise<number> {
  const r = await getPool().query<{ id: string; old_status: string }>(
    `UPDATE quotes q SET status = 'expired' FROM (SELECT id, status FROM quotes WHERE status IN ('draft','pending_send','sent') AND valid_until < now() FOR UPDATE) old
     WHERE q.id = old.id RETURNING q.id, old.status AS old_status`);
  for (const row of r.rows) {
    await getPool().query("INSERT INTO status_history (entity_type, entity_id, field, from_value, to_value, reason) VALUES ('quote',$1,'status',$2,'expired','Vigencia terminada')", [row.id, row.old_status]);
  }
  return r.rowCount ?? 0;
}
