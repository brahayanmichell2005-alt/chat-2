import type { Request } from "express";
import type pg from "pg";
import type { AuthUser } from "@crm/shared";
import { writeAudit } from "../../common/audit.js";
import { AppError } from "../../common/errors.js";
import { uuidParam } from "../../common/http.js";
import { withTransaction } from "../../database/pool.js";
import { notifyByPermission, notifyUser } from "../notifications/notifications.service.js";
import { getConversation } from "./conversations.service.js";

export type Requester = { by: "ai" | "customer" | "system" } | { by: "user"; user: AuthUser };

async function logChange(client: pg.PoolClient, id: string, field: string, from: string | null, to: string, userId: string | null, reason?: string) {
  if (from === to) return;
  await client.query(
    "INSERT INTO status_history (entity_type, entity_id, field, from_value, to_value, changed_by, reason) VALUES ('conversation',$1,$2,$3,$4,$5,$6)",
    [id, field, from, to, userId, reason ?? null]);
}

/**
 * Pasa la conversación a control humano en una sola transacción. Idempotente: si ya está en control humano no crea otra transferencia.
 * Desde este momento la IA no puede responder (aiMayRespond = false) y el envío automático se cancela en la cola.
 */
export async function requestHandoffTx(client: pg.PoolClient, conversationId: string, reason: string, who: Requester): Promise<{ created: boolean }> {
  const cur = await client.query<{ control_mode: string; status: string; assigned_user_id: string | null }>(
    "SELECT control_mode, status, assigned_user_id FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
  const c = cur.rows[0];
  if (!c) throw new AppError(404, "NOT_FOUND", "Conversación no encontrada");
  if (c.control_mode === "human") return { created: false };

  const requesterId = who.by === "user" ? who.user.id : null;
  const assignee = c.assigned_user_id ?? requesterId;
  await client.query(
    `INSERT INTO human_handoffs (conversation_id, reason, requested_by, requested_by_user_id, assigned_user_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (conversation_id) WHERE ended_at IS NULL DO NOTHING`,
    [conversationId, reason.slice(0, 500), who.by, requesterId, assignee]);
  await client.query(
    "UPDATE conversations SET control_mode = 'human', status = CASE WHEN status = 'closed' THEN 'closed' WHEN $2::uuid IS NULL THEN 'pending_human' ELSE 'open' END, assigned_user_id = $2, version = version + 1 WHERE id = $1",
    [conversationId, assignee]);
  await logChange(client, conversationId, "control_mode", c.control_mode, "human", requesterId, reason);

  const payload = { conversationId, reason };
  if (assignee && assignee !== requesterId) await notifyUser(assignee, "handoff_assigned", payload, client);
  if (!assignee) await notifyByPermission(["conversations.assign", "conversations.read_all"], "handoff_pending", payload, client);
  return { created: true };
}

export async function requestHandoff(id: string, reason: string, auth: AuthUser, req: Request) {
  await getConversation(uuidParam(id), auth);
  return withTransaction(async (client) => {
    const r = await requestHandoffTx(client, id, reason, { by: "user", user: auth });
    await writeAudit({ action: "conversation.handoff", entityType: "conversation", entityId: id, after: { reason, created: r.created } }, req, client);
    return getConversation(id, auth, client);
  });
}

/** Devuelve el control a la IA (también sale del estado "pausada"). Cierra la transferencia abierta. */
export async function resumeAi(id: string, auth: AuthUser, req: Request) {
  await getConversation(uuidParam(id), auth);
  return withTransaction(async (client) => {
    const cur = await client.query<{ control_mode: string }>("SELECT control_mode FROM conversations WHERE id = $1 FOR UPDATE", [id]);
    const mode = cur.rows[0]!.control_mode;
    if (mode === "ai") return getConversation(id, auth, client);
    await client.query("UPDATE human_handoffs SET ended_at = now(), ended_by = $2 WHERE conversation_id = $1 AND ended_at IS NULL", [id, auth.id]);
    await client.query("UPDATE conversations SET control_mode = 'ai', status = CASE WHEN status = 'pending_human' THEN 'open' ELSE status END, version = version + 1 WHERE id = $1", [id]);
    await logChange(client, id, "control_mode", mode, "ai", auth.id);
    await writeAudit({ action: "conversation.resume_ai", entityType: "conversation", entityId: id, before: { controlMode: mode } }, req, client);
    return getConversation(id, auth, client);
  });
}
