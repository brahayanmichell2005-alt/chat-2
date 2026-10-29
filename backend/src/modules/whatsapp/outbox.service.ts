import type { Request } from "express";
import type { AuthUser } from "@crm/shared";
import { writeAudit } from "../../common/audit.js";
import { AppError } from "../../common/errors.js";
import { getLogger } from "../../common/logger.js";
import { getEnv } from "../../config/env.js";
import { getPool, withTransaction } from "../../database/pool.js";
import { getConversation } from "../conversations/conversations.service.js";
import { requestHandoffTx } from "../conversations/handoff.service.js";
import { NotConnectedError } from "./provider.js";
import { aiMayRespond, jidForContact, MAX_SEND_ATTEMPTS, retryDelayMs, sendGate, type SendMode } from "./rules.js";
import { getManager } from "./whatsapp.service.js";

const MESSAGE_COLS = `id, direction, body, sent_by AS "sentBy", status, last_error AS "lastError", created_at AS "createdAt"`;

interface EnqueueInput {
  conversationId: string;
  text: string;
  sentBy: "user" | "ai";
  userId: string | null;
  idempotencyKey?: string;
  handoffIfNeeded?: AuthUser;
  /** Aviso del sistema (p. ej. "te paso con una persona"): se envía aunque la conversación pase a control humano. */
  notice?: boolean;
}

async function enqueue(input: EnqueueInput) {
  const waId = getManager().provider.generateMessageId();
  return withTransaction(async (client) => {
    const cur = await client.query<{ control_mode: string; status: string }>("SELECT control_mode, status FROM conversations WHERE id = $1 FOR UPDATE", [input.conversationId]);
    const c = cur.rows[0];
    if (!c) throw new AppError(404, "NOT_FOUND", "Conversación no encontrada");
    if (c.status === "closed") throw new AppError(409, "CONVERSATION_CLOSED", "La conversación está cerrada");
    if (input.sentBy === "ai" && !input.notice && !aiMayRespond({ controlMode: c.control_mode, status: c.status })) {
      throw new AppError(409, "HUMAN_CONTROL", "La IA no puede responder: la conversación está bajo control humano o pausada");
    }
    // Un trabajador que responde toma el control: así la IA no puede contestar a la vez.
    if (input.sentBy === "user" && c.control_mode !== "human" && input.handoffIfNeeded) {
      await requestHandoffTx(client, input.conversationId, "Respuesta manual del trabajador", { by: "user", user: input.handoffIfNeeded });
    }
    const ins = await client.query(
      `INSERT INTO messages (conversation_id, direction, wa_message_id, body, sent_by, sent_by_user_id, status, idempotency_key, is_notice)
       VALUES ($1,'out',$2,$3,$4,$5,'queued',$6,$7) ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING ${MESSAGE_COLS}`,
      [input.conversationId, waId, input.text, input.sentBy, input.userId, input.idempotencyKey ?? null, input.notice ?? false]);
    if (!ins.rowCount) {
      // Reintento del mismo envío: se devuelve el original sin duplicar.
      return (await client.query(`SELECT ${MESSAGE_COLS} FROM messages WHERE idempotency_key = $1`, [input.idempotencyKey])).rows[0];
    }
    await client.query("UPDATE conversations SET last_message_at = now() WHERE id = $1", [input.conversationId]);
    return ins.rows[0];
  });
}

export async function enqueueHumanMessage(conversationId: string, text: string, auth: AuthUser, req: Request, idempotencyKey?: string) {
  await getConversation(conversationId, auth);
  const msg = await enqueue({ conversationId, text, sentBy: "user", userId: auth.id, idempotencyKey, handoffIfNeeded: auth });
  await writeAudit({ action: "message.enqueue", entityType: "conversation", entityId: conversationId }, req);
  return msg;
}

/** Para la Etapa 5: la IA encola su respuesta. Falla si hay control humano. */
export function enqueueAiMessage(conversationId: string, text: string, idempotencyKey?: string) {
  return enqueue({ conversationId, text, sentBy: "ai", userId: null, idempotencyKey });
}

/** La IA envía un aviso (derivación a una persona, contingencia). Sale aunque la conversación quede en control humano. */
export function enqueueAiNotice(conversationId: string, text: string, idempotencyKey: string) {
  return enqueue({ conversationId, text, sentBy: "ai", userId: null, idempotencyKey, notice: true });
}

// ---- Límite de envío (en memoria) ----
const sendTimes: number[] = [];
function rateAllows(now: number): boolean {
  const env = getEnv();
  while (sendTimes.length && now - sendTimes[0]! > 60_000) sendTimes.shift();
  const last = sendTimes[sendTimes.length - 1];
  return (last === undefined || now - last >= env.WHATSAPP_MIN_SEND_INTERVAL_MS) && sendTimes.length < env.WHATSAPP_MAX_PER_MINUTE;
}
export function resetRateLimiterForTests() { sendTimes.length = 0; }

export type OutboxResult = "idle" | "processed";

/** Procesa a lo sumo un mensaje pendiente. El orden dentro de cada conversación se respeta. */
export async function processOutboxOnce(): Promise<OutboxResult> {
  const env = getEnv();
  if (!rateAllows(Date.now())) return "idle";

  const claimed = await withTransaction(async (client) => {
    const r = await client.query<{
      id: string; body: string; wa_message_id: string; sent_by: string; is_notice: boolean; attempts: number; created_at: Date;
      control_mode: string; conv_status: string; phone: string; wa_jid: string | null;
    }>(
      `SELECT m.id, m.body, m.wa_message_id, m.sent_by, m.is_notice, m.attempts, m.created_at, c.control_mode, c.status AS conv_status, ct.phone_e164 AS phone, ct.wa_jid
       FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
       WHERE m.direction = 'out' AND m.status = 'queued' AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= now())
         AND NOT EXISTS (SELECT 1 FROM messages p WHERE p.conversation_id = m.conversation_id AND p.direction = 'out' AND p.status IN ('queued','sending') AND p.created_at < m.created_at)
       ORDER BY m.created_at LIMIT 1 FOR UPDATE OF m SKIP LOCKED`);
    const m = r.rows[0];
    if (!m) return null;
    const finish = async (status: string, error: string | null) => {
      await client.query("UPDATE messages SET status = $2, last_error = $3 WHERE id = $1", [m.id, status, error]);
      return null;
    };
    if (m.sent_by === "ai" && !m.is_notice && !aiMayRespond({ controlMode: m.control_mode, status: m.conv_status })) return finish("cancelled", "Control humano activo: respuesta de la IA descartada");
    const gate = sendGate(env.WHATSAPP_SEND_MODE as SendMode, env.WHATSAPP_ALLOWED_NUMBERS, m.phone);
    if (!gate.ok) return finish("blocked", gate.reason);
    const jid = jidForContact(m.phone, m.wa_jid);
    if (!jid) return finish("failed", "El contacto no tiene un identificador de WhatsApp válido");
    if (getManager().status !== "connected") {
      if (Date.now() - m.created_at.getTime() > 10 * 60_000) return finish("failed", "Expirado: WhatsApp no estuvo conectado");
      await client.query("UPDATE messages SET next_attempt_at = now() + interval '5 seconds' WHERE id = $1", [m.id]);
      return null;
    }
    await client.query("UPDATE messages SET status = 'sending', attempts = attempts + 1, next_attempt_at = now() WHERE id = $1", [m.id]);
    return { id: m.id, body: m.body, waId: m.wa_message_id, jid, attempts: m.attempts + 1 };
  });
  if (!claimed) return "idle";

  sendTimes.push(Date.now());
  try {
    await getManager().provider.sendText(claimed.jid, claimed.body, claimed.waId);
    await getPool().query("UPDATE messages SET status = 'sent', last_error = NULL WHERE id = $1", [claimed.id]);
  } catch (e) {
    if (e instanceof NotConnectedError) {
      // Seguro que NO salió: se puede reintentar sin riesgo de duplicar.
      if (claimed.attempts >= MAX_SEND_ATTEMPTS) await getPool().query("UPDATE messages SET status = 'failed', last_error = $2 WHERE id = $1", [claimed.id, "Sin conexión tras varios intentos"]);
      else await getPool().query("UPDATE messages SET status = 'queued', next_attempt_at = now() + make_interval(secs => $2), last_error = $3 WHERE id = $1", [claimed.id, retryDelayMs(claimed.attempts) / 1000, "Sin conexión"]);
    } else {
      // No se sabe si salió: NO se reintenta automáticamente. Requiere revisión humana.
      await getPool().query("UPDATE messages SET status = 'uncertain', last_error = $2 WHERE id = $1", [claimed.id, (e as Error).message.slice(0, 300)]);
      getLogger().warn({ messageId: claimed.id }, "Envío con resultado incierto");
    }
  }
  return "processed";
}

/** Tras un reinicio: lo que quedó "enviando" no se sabe si salió → incierto (no se reenvía a ciegas). */
export async function recoverStuckSending(): Promise<number> {
  const r = await getPool().query(
    "UPDATE messages SET status = 'uncertain', last_error = 'Interrumpido durante el envío (reinicio o caída)' WHERE direction = 'out' AND status = 'sending' AND next_attempt_at < now() - interval '2 minutes'");
  return r.rowCount ?? 0;
}

export function startOutboxWorker(): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    let next = 1000;
    try {
      await recoverStuckSending();
      if ((await processOutboxOnce()) === "processed") next = 200;
    } catch (e) { getLogger().error({ err: e }, "Error en el procesador de salida"); next = 5000; }
    if (!stopped) timer = setTimeout(() => void tick(), next);
  };
  timer = setTimeout(() => void tick(), 1000);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
