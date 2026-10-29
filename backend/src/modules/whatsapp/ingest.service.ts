import { appEvents, EVT_CUSTOMER_MESSAGE } from "../../common/events.js";
import { getPool, withTransaction } from "../../database/pool.js";
import { notifyByPermission, notifyUser } from "../notifications/notifications.service.js";
import type { IncomingMessage } from "./provider.js";
import { getEnv } from "../../config/env.js";
import { contactKeyFromJid, ingestAllowed, shouldIgnoreJid, type SendMode } from "./rules.js";

export type IngestResult = "ignored" | "duplicate" | "stored" | "external_reply";

/**
 * Registra un mensaje de WhatsApp. Idempotente: el mismo wa_message_id nunca se guarda dos veces
 * (los mensajes que envía este sistema ya existen en la BD con su id, así que su "eco" se descarta como duplicado).
 * Un mensaje propio desconocido (escrito desde el celular) pausa la IA en esa conversación.
 */
export async function handleIncoming(m: IncomingMessage): Promise<IngestResult> {
  if (shouldIgnoreJid(m.jid)) return "ignored";
  const jid = m.jid.replace(/:\d+@/, "@");
  const lidKey = contactKeyFromJid(jid);
  if (!lidKey) return "ignored";
  const altKey = m.altJid ? contactKeyFromJid(m.altJid.replace(/:\d+@/, "@")) : null;
  const env = getEnv();
  if (!ingestAllowed(env.WHATSAPP_SEND_MODE as SendMode, env.WHATSAPP_ALLOWED_NUMBERS, lidKey, altKey)) {
    // Un contacto ya conocido (mismo identificador de WhatsApp) cuyo número real está en la lista sigue permitido aunque WhatsApp no informe el número en este mensaje.
    const known = await getPool().query<{ phone_e164: string }>("SELECT phone_e164 FROM contacts WHERE wa_jid = $1", [jid]);
    const knownOk = known.rows[0] ? ingestAllowed(env.WHATSAPP_SEND_MODE as SendMode, env.WHATSAPP_ALLOWED_NUMBERS, known.rows[0].phone_e164) : false;
    if (!knownOk) {
      console.info(`[whatsapp] mensaje ignorado: fuera de la lista de pruebas (contacto=${jid.endsWith("@lid") ? "lid" : "numero"}, numero_real_informado=${altKey ? "si" : "no"}, propio=${m.fromMe})`);
      return "ignored";
    }
  }

  const out = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lidKey]);
    // Si WhatsApp ocultó el número pero informó el real, se usa el real (y se migra un contacto "lid:" anterior).
    let key = lidKey;
    if (lidKey.startsWith("lid:") && altKey?.startsWith("+")) {
      await client.query("UPDATE contacts SET phone_e164 = $1 WHERE phone_e164 = $2 AND NOT EXISTS (SELECT 1 FROM contacts WHERE phone_e164 = $1)", [altKey, lidKey]);
      key = altKey;
    }
    const dup = await client.query("SELECT 1 FROM messages WHERE wa_message_id = $1", [m.waMessageId]);
    if (dup.rowCount) return { result: "duplicate" as IngestResult };

    // Primero por identificador de WhatsApp (evita chocar con el índice único de wa_jid cuando el mismo chat llega con otra clave).
    const byJid = await client.query<{ id: string; customer_id: string | null }>("SELECT id, customer_id FROM contacts WHERE wa_jid = $1", [jid]);
    const contact = byJid.rows[0] ? byJid : await client.query<{ id: string; customer_id: string | null }>(
      `INSERT INTO contacts (phone_e164, wa_jid, display_name) VALUES ($1, $2, $3)
       ON CONFLICT (phone_e164) DO UPDATE SET wa_jid = COALESCE(contacts.wa_jid, EXCLUDED.wa_jid), display_name = COALESCE(contacts.display_name, EXCLUDED.display_name)
       RETURNING id, customer_id`,
      [key, jid, m.fromMe ? null : (m.pushName?.slice(0, 160) ?? null)]);
    const ct = contact.rows[0]!;

    let customerId = ct.customer_id;
    if (!customerId && !m.fromMe) {
      const c = await client.query<{ id: string }>("INSERT INTO customers (name) VALUES ($1) RETURNING id", [(m.pushName?.trim() || key).slice(0, 160)]);
      customerId = c.rows[0]!.id;
      await client.query("UPDATE contacts SET customer_id = $1 WHERE id = $2", [customerId, ct.id]);
    }

    let conv = (await client.query<{ id: string; control_mode: string; assigned_user_id: string | null }>(
      "SELECT id, control_mode, assigned_user_id FROM conversations WHERE contact_id = $1 AND status <> 'closed' FOR UPDATE", [ct.id])).rows[0];
    if (!conv) {
      conv = (await client.query<{ id: string; control_mode: string; assigned_user_id: string | null }>(
        "INSERT INTO conversations (contact_id, customer_id) VALUES ($1, $2) RETURNING id, control_mode, assigned_user_id", [ct.id, customerId])).rows[0]!;
    }

    const ins = await client.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, direction, wa_message_id, body, sent_by, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING RETURNING id`,
      [conv.id, m.fromMe ? "out" : "in", m.waMessageId, m.text.slice(0, 4000), m.fromMe ? "user" : "customer", m.fromMe ? "sent" : "received", m.timestamp]);
    if (!ins.rowCount) return { result: "duplicate" as IngestResult };
    await client.query("UPDATE conversations SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2) WHERE id = $1", [conv.id, m.timestamp]);

    if (m.fromMe) {
      if (conv.control_mode === "ai") {
        await client.query("UPDATE conversations SET control_mode = 'paused', version = version + 1 WHERE id = $1", [conv.id]);
        await client.query(
          "INSERT INTO status_history (entity_type, entity_id, field, from_value, to_value, reason) VALUES ('conversation',$1,'control_mode','ai','paused','Mensaje escrito desde el celular/WhatsApp Web')", [conv.id]);
        const payload = { conversationId: conv.id };
        if (conv.assigned_user_id) await notifyUser(conv.assigned_user_id, "ai_paused_external", payload, client);
        else await notifyByPermission(["conversations.assign", "conversations.read_all"], "ai_paused_external", payload, client);
      }
      return { result: "external_reply" as IngestResult };
    }

    if (conv.control_mode === "human") {
      const payload = { conversationId: conv.id };
      if (conv.assigned_user_id) await notifyUser(conv.assigned_user_id, "new_message", payload, client);
      else await notifyByPermission(["conversations.assign", "conversations.read_all"], "new_message", payload, client);
    }
    return { result: "stored" as IngestResult, conversationId: conv.id, messageId: ins.rows[0]!.id };
  });

  if (out.result === "stored" && "conversationId" in out) {
    appEvents.emit(EVT_CUSTOMER_MESSAGE, { conversationId: out.conversationId, messageId: out.messageId });
  }
  return out.result;
}
