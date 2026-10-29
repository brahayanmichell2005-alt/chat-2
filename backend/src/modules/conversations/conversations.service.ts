import type { Request } from "express";
import type pg from "pg";
import { z } from "zod";
import type { AuthUser } from "@crm/shared";
import { writeAudit } from "../../common/audit.js";
import { AppError } from "../../common/errors.js";
import { likePattern, pgCode, uuidParam } from "../../common/http.js";
import { normalizePhone } from "../../common/phone.js";
import { getPool, withTransaction } from "../../database/pool.js";

export const listQuery = z.object({
  status: z.enum(["open", "pending_human", "closed"]).optional(),
  assignedUserId: z.union([z.string().uuid(), z.literal("none")]).optional(),
  tagId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const createSchema = z.object({
  phone: z.string().trim().min(6).max(30),
  name: z.string().trim().min(2).max(160).optional(),
});
export const assignSchema = z.object({ userId: z.string().uuid().nullable() });
export const updateSchema = z
  .object({ status: z.enum(["open", "pending_human", "closed"]).optional(), priority: z.enum(["low", "normal", "high"]).optional() })
  .refine((v) => Object.keys(v).length > 0, { message: "Sin cambios" });
export const noteSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export const tagsSchema = z.object({ tagIds: z.array(z.string().uuid()).max(20) });
export const tagCreateSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,40}$/, "Use letras, números y _"),
  name: z.string().trim().min(2).max(60),
});
export const messagesQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) });

const canSeeAll = (a: AuthUser) => a.permissions.includes("conversations.read_all");

/** Condición SQL de visibilidad: quien no ve todo, solo ve lo asignado a sí mismo. */
function scope(a: AuthUser, params: unknown[]): string {
  if (canSeeAll(a)) return "TRUE";
  params.push(a.id);
  return `cv.assigned_user_id = $${params.length}`;
}

const BASE = `
  FROM conversations cv
  JOIN contacts ct ON ct.id = cv.contact_id
  LEFT JOIN customers cu ON cu.id = cv.customer_id
  LEFT JOIN users u ON u.id = cv.assigned_user_id`;
const COLS = `cv.id, cv.status, cv.control_mode AS "controlMode", cv.priority, cv.assigned_user_id AS "assignedUserId", u.name AS "assignedUserName",
  cv.last_message_at AS "lastMessageAt", cv.created_at AS "createdAt", cv.version,
  ct.id AS "contactId", ct.phone_e164 AS phone, ct.display_name AS "displayName", cu.id AS "customerId", cu.name AS "customerName",
  COALESCE((SELECT array_agg(t.code ORDER BY t.code) FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = cv.id), '{}') AS tags,
  (SELECT m.body FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.created_at DESC LIMIT 1) AS "lastMessage"`;

export async function listConversations(q: z.infer<typeof listQuery>, auth: AuthUser) {
  const params: unknown[] = [];
  const where: string[] = [scope(auth, params)];
  if (q.status) { params.push(q.status); where.push(`cv.status = $${params.length}`); }
  if (q.assignedUserId === "none") where.push("cv.assigned_user_id IS NULL");
  else if (q.assignedUserId) { params.push(q.assignedUserId); where.push(`cv.assigned_user_id = $${params.length}`); }
  if (q.tagId) { params.push(q.tagId); where.push(`EXISTS (SELECT 1 FROM conversation_tags x WHERE x.conversation_id = cv.id AND x.tag_id = $${params.length})`); }
  if (q.q) { params.push(likePattern(q.q)); where.push(`(ct.phone_e164 LIKE $${params.length} OR ct.display_name ILIKE $${params.length} OR cu.name ILIKE $${params.length})`); }
  if (q.from) { params.push(q.from); where.push(`COALESCE(cv.last_message_at, cv.created_at) >= $${params.length}`); }
  if (q.to) { params.push(q.to); where.push(`COALESCE(cv.last_message_at, cv.created_at) <= $${params.length}`); }
  const w = `WHERE ${where.join(" AND ")}`;
  const total = await getPool().query<{ n: string }>(`SELECT count(*) AS n ${BASE} ${w}`, params);
  params.push(q.limit, (q.page - 1) * q.limit);
  const { rows } = await getPool().query(
    `SELECT ${COLS} ${BASE} ${w} ORDER BY COALESCE(cv.last_message_at, cv.created_at) DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows, page: q.page, limit: q.limit, total: Number(total.rows[0]?.n ?? 0) };
}

/** Devuelve la conversación si el usuario puede verla; si no, 404 (no revela su existencia). */
export async function getConversation(id: string, auth: AuthUser, client: pg.Pool | pg.PoolClient = getPool()) {
  const params: unknown[] = [uuidParam(id)];
  const sc = scope(auth, params);
  const { rows } = await client.query(`SELECT ${COLS} ${BASE} WHERE cv.id = $1 AND ${sc}`, params);
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Conversación no encontrada");
  return rows[0];
}

export async function getConversationDetail(id: string, auth: AuthUser) {
  const conv = await getConversation(id, auth);
  const notes = await getPool().query(
    'SELECT n.id, n.body, n.created_at AS "createdAt", u.name AS "userName" FROM internal_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.conversation_id = $1 ORDER BY n.created_at DESC LIMIT 200',
    [id],
  );
  return { ...conv, notes: notes.rows };
}

export async function listMessages(id: string, q: z.infer<typeof messagesQuery>, auth: AuthUser) {
  await getConversation(id, auth);
  const { rows } = await getPool().query(
    `SELECT id, direction, body, sent_by AS "sentBy", status, created_at AS "createdAt"
     FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [id, q.limit, (q.page - 1) * q.limit],
  );
  return { items: rows.reverse(), page: q.page, limit: q.limit };
}

/** Alta manual (sirve hasta que la Etapa 4 cree conversaciones automáticamente al recibir mensajes). */
export async function createConversation(input: z.infer<typeof createSchema>, auth: AuthUser, req: Request) {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError(400, "INVALID_PHONE", "Teléfono inválido");
  try {
    return await withTransaction(async (client) => {
      const c = await client.query<{ id: string; customer_id: string | null }>(
        `INSERT INTO contacts (phone_e164, display_name) VALUES ($1, $2)
         ON CONFLICT (phone_e164) DO UPDATE SET display_name = COALESCE(contacts.display_name, EXCLUDED.display_name)
         RETURNING id, customer_id`, [phone, input.name ?? null]);
      const contact = c.rows[0]!;
      const open = await client.query("SELECT id FROM conversations WHERE contact_id = $1 AND status <> 'closed'", [contact.id]);
      if (open.rowCount) throw new AppError(409, "CONVERSATION_EXISTS", "Ya existe una conversación abierta con ese número", { conversationId: open.rows[0].id });
      const assignee = canSeeAll(auth) ? null : auth.id;
      const r = await client.query<{ id: string }>(
        "INSERT INTO conversations (contact_id, customer_id, assigned_user_id) VALUES ($1,$2,$3) RETURNING id", [contact.id, contact.customer_id, assignee]);
      await writeAudit({ action: "conversation.create", entityType: "conversation", entityId: r.rows[0]!.id, after: { source: "manual" } }, req, client);
      return getConversation(r.rows[0]!.id, auth, client);
    });
  } catch (e) {
    if (pgCode(e) === "23505") throw new AppError(409, "CONVERSATION_EXISTS", "Ya existe una conversación abierta con ese número");
    throw e;
  }
}

async function recordChange(client: pg.PoolClient, id: string, field: string, from: unknown, to: unknown, userId: string) {
  if (String(from ?? "") === String(to ?? "")) return;
  await client.query(
    "INSERT INTO status_history (entity_type, entity_id, field, from_value, to_value, changed_by) VALUES ('conversation',$1,$2,$3,$4,$5)",
    [id, field, from == null ? null : String(from), to == null ? null : String(to), userId]);
}

export async function assignConversation(id: string, userId: string | null, auth: AuthUser, req: Request) {
  uuidParam(id);
  return withTransaction(async (client) => {
    const cur = await client.query<{ assigned_user_id: string | null }>("SELECT assigned_user_id FROM conversations WHERE id = $1 FOR UPDATE", [id]);
    if (!cur.rows[0]) throw new AppError(404, "NOT_FOUND", "Conversación no encontrada");
    if (userId) {
      const ok = await client.query(
        `SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE u.id = $1 AND u.status = 'active' AND p.code IN ('conversations.read_assigned', 'conversations.read_all') LIMIT 1`, [userId]);
      if (!ok.rowCount) throw new AppError(400, "INVALID_ASSIGNEE", "El usuario no existe, está desactivado o no puede atender conversaciones");
    }
    await client.query("UPDATE conversations SET assigned_user_id = $2, version = version + 1 WHERE id = $1", [id, userId]);
    await recordChange(client, id, "assigned_user_id", cur.rows[0].assigned_user_id, userId, auth.id);
    await writeAudit({ action: "conversation.assign", entityType: "conversation", entityId: id, before: { userId: cur.rows[0].assigned_user_id }, after: { userId } }, req, client);
    return getConversation(id, auth, client).catch(() => ({ id, assignedUserId: userId }));
  });
}

export async function updateConversation(id: string, input: z.infer<typeof updateSchema>, auth: AuthUser, req: Request) {
  await getConversation(id, auth);
  return withTransaction(async (client) => {
    const cur = await client.query<{ status: string; priority: string }>("SELECT status, priority FROM conversations WHERE id = $1 FOR UPDATE", [id]);
    const row = cur.rows[0]!;
    try {
      await client.query("UPDATE conversations SET status = COALESCE($2, status), priority = COALESCE($3, priority), version = version + 1 WHERE id = $1", [id, input.status ?? null, input.priority ?? null]);
    } catch (e) {
      if (pgCode(e) === "23505") throw new AppError(409, "CONVERSATION_EXISTS", "Ya hay otra conversación abierta con este contacto");
      throw e;
    }
    if (input.status) await recordChange(client, id, "status", row.status, input.status, auth.id);
    if (input.priority) await recordChange(client, id, "priority", row.priority, input.priority, auth.id);
    await writeAudit({ action: "conversation.update", entityType: "conversation", entityId: id, before: row, after: input }, req, client);
    return getConversation(id, auth, client);
  });
}

export async function addNote(id: string, body: string, auth: AuthUser, req: Request) {
  await getConversation(id, auth);
  const { rows } = await getPool().query('INSERT INTO internal_notes (conversation_id, user_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at AS "createdAt"', [id, auth.id, body]);
  await writeAudit({ action: "conversation.note", entityType: "conversation", entityId: id }, req);
  return { ...rows[0], userName: auth.name };
}

export async function setTags(id: string, tagIds: string[], auth: AuthUser, req: Request) {
  await getConversation(id, auth);
  const unique = [...new Set(tagIds)];
  return withTransaction(async (client) => {
    if (unique.length) {
      const found = await client.query("SELECT id FROM tags WHERE id = ANY($1::uuid[])", [unique]);
      if (found.rowCount !== unique.length) throw new AppError(400, "UNKNOWN_TAG", "Etiqueta inexistente");
    }
    await client.query("DELETE FROM conversation_tags WHERE conversation_id = $1", [id]);
    if (unique.length) await client.query("INSERT INTO conversation_tags (conversation_id, tag_id) SELECT $1, unnest($2::uuid[])", [id, unique]);
    await writeAudit({ action: "conversation.tags", entityType: "conversation", entityId: id, after: { tagIds: unique } }, req, client);
    return getConversation(id, auth, client);
  });
}

export async function listTags() {
  const { rows } = await getPool().query("SELECT id, code, name FROM tags ORDER BY name");
  return { items: rows };
}
export async function createTag(input: z.infer<typeof tagCreateSchema>, req: Request) {
  try {
    const { rows } = await getPool().query("INSERT INTO tags (code, name) VALUES ($1,$2) RETURNING id, code, name", [input.code, input.name]);
    await writeAudit({ action: "tag.create", entityType: "tag", entityId: rows[0].id, after: input }, req);
    return rows[0];
  } catch (e) {
    if (pgCode(e) === "23505") throw new AppError(409, "TAG_EXISTS", "La etiqueta ya existe");
    throw e;
  }
}
