import { appEvents, EVT_CUSTOMER_MESSAGE, type CustomerMessageEvent } from "../../common/events.js";
import { getLogger } from "../../common/logger.js";
import { getEnv } from "../../config/env.js";
import { getPool, withTransaction } from "../../database/pool.js";
import { requestHandoffTx } from "../conversations/handoff.service.js";
import { enqueueAiMessage, enqueueAiNotice } from "../whatsapp/outbox.service.js";
import { aiMayRespond } from "../whatsapp/rules.js";
import { OllamaProvider } from "./ollama.provider.js";
import { OpenAiCompatProvider } from "./openai.provider.js";
import { customerAsksForHuman, isNonText } from "./parse.js";
import type { AIProvider, ChatMessage } from "./provider.js";
import { loadAiSettings } from "./settings.js";
import { PROMPT_VERSION, runTurn } from "./turn.js";

/** Proveedor según .env: "ollama" (local) u "openai" (servicio con API compatible OpenAI: Groq/Gemini/OpenRouter…). */
function buildAiProvider(): AIProvider {
  return getEnv().AI_PROVIDER === "openai" ? new OpenAiCompatProvider() : new OllamaProvider();
}

let provider: AIProvider = buildAiProvider();
export function getAiProvider(): AIProvider { return provider; }
export function setAiProviderForTests(p: AIProvider) { provider = p; }

// Una sola generación a la vez (modelos grandes + hardware limitado).
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

type Outcome = "replied" | "handoff" | "contingency" | "skipped";

async function logUsage(o: { conversationId?: string; messageId?: string; model?: string; outcome: string; detail?: string; latencyMs?: number; tokensIn?: number; tokensOut?: number; tools?: string[]; intents?: string[] }) {
  await getPool().query(
    `INSERT INTO ai_usage_logs (conversation_id, message_id, model, prompt_version, outcome, detail, latency_ms, tokens_in, tokens_out, tools, intents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [o.conversationId ?? null, o.messageId ?? null, o.model ?? null, PROMPT_VERSION, o.outcome, o.detail?.slice(0, 500) ?? null, o.latencyMs ?? null, o.tokensIn ?? null, o.tokensOut ?? null, o.tools ?? [], o.intents ?? []],
  ).catch((e) => getLogger().error({ err: e }, "No se pudo registrar el uso de IA"));
}

async function handoff(conversationId: string, reason: string) {
  await withTransaction((c) => requestHandoffTx(c, conversationId, reason, { by: "ai" }));
}

/** Responde (si corresponde) al último mensaje del cliente. Seguro de llamar varias veces: la respuesta es idempotente por mensaje. */
export function respondToConversation(conversationId: string): Promise<Outcome> {
  return exclusive(() => respond(conversationId));
}

async function respond(conversationId: string): Promise<Outcome> {
  const settings = await loadAiSettings();
  if (!settings.enabled) return "skipped";
  const pool = getPool();

  const conv = await pool.query<{ control_mode: string; status: string; state: Record<string, unknown> }>("SELECT control_mode, status, state FROM conversations WHERE id = $1", [conversationId]);
  const c = conv.rows[0];
  if (!c || !aiMayRespond({ controlMode: c.control_mode, status: c.status })) return "skipped";

  const last = (await pool.query<{ id: string; body: string | null; created_at: Date }>(
    "SELECT id, body, created_at FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1", [conversationId])).rows[0];
  if (!last) return "skipped";
  if (Date.now() - last.created_at.getTime() > 10 * 60_000) return "skipped"; // no contestar atrasos tras una reconexión
  const answered = await pool.query("SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'out' AND created_at > $2 LIMIT 1", [conversationId, last.created_at]);
  if (answered.rowCount) return "skipped";
  const text = (last.body ?? "").trim();
  const base = { conversationId, messageId: last.id, model: settings.model };

  // Reglas deterministas antes del modelo
  if (customerAsksForHuman(text)) {
    await handoff(conversationId, "El cliente pidió hablar con una persona");
    await enqueueAiNotice(conversationId, "Claro, aviso a una persona del equipo para que continúe contigo.", `ai-notice:${last.id}`);
    await logUsage({ ...base, outcome: "handoff", detail: "Solicitud de persona (regla)", intents: ["solicitud_persona"] });
    return "handoff";
  }
  if (isNonText(text)) {
    await handoff(conversationId, "El cliente envió un archivo o contenido que la IA no puede leer");
    await enqueueAiNotice(conversationId, "Recibí tu mensaje, pero por ahora solo puedo leer texto. Una persona del equipo lo revisará.", `ai-notice:${last.id}`);
    await logUsage({ ...base, outcome: "handoff", detail: "Mensaje no textual" });
    return "handoff";
  }

  // Historial
  const rows = (await pool.query<{ direction: string; body: string | null }>(
    "SELECT direction, body FROM messages WHERE conversation_id = $1 AND body IS NOT NULL AND status NOT IN ('cancelled','blocked','failed') ORDER BY created_at DESC LIMIT $2", [conversationId, settings.historyMessages])).rows.reverse();
  const history: ChatMessage[] = [];
  for (const r of rows) {
    const role = r.direction === "in" ? "user" : "assistant";
    const prev = history[history.length - 1];
    if (prev && prev.role === role) prev.content += `\n${r.body}`;
    else history.push({ role, content: r.body! });
  }
  while (history.length && history[0]!.role !== "user") history.shift();

  const lastBot = (await pool.query<{ body: string; created_at: Date }>(
    "SELECT body, created_at FROM messages WHERE conversation_id = $1 AND direction = 'out' AND body IS NOT NULL ORDER BY created_at DESC LIMIT 1", [conversationId])).rows[0];
  const greetedRecently = !!lastBot && Date.now() - lastBot.created_at.getTime() < settings.greetingPauseMinutes * 60_000;
  const state = (c.state ?? {}) as { slots?: Record<string, string>; facts?: number[] };

  const result = await runTurn(getAiProvider(), {
    settings, history, slots: state.slots ?? {}, knownAmounts: state.facts ?? [], greetedRecently, previousBotReply: lastBot?.body, timezone: getEnv().APP_TIMEZONE,
  });

  // ¿Llegó otro mensaje del cliente mientras se generaba? Se descarta: el nuevo evento generará la respuesta.
  const newest = (await pool.query<{ id: string }>("SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1", [conversationId])).rows[0];
  if (newest && newest.id !== last.id) {
    await logUsage({ ...base, outcome: "skipped", detail: "Llegó un mensaje más reciente durante la generación", latencyMs: result.latencyMs, tools: result.tools });
    return "skipped";
  }

  if (result.kind === "contingency") {
    await handoff(conversationId, `IA no disponible o respuesta no válida (${result.reason})`).catch(() => undefined);
    await enqueueAiNotice(conversationId, settings.contingencyMessage, `ai-notice:${last.id}`).catch(() => undefined);
    await logUsage({ ...base, outcome: "contingency", detail: `${result.reason}: ${result.detail}`, latencyMs: result.latencyMs, tokensIn: result.tokensIn, tokensOut: result.tokensOut, tools: result.tools });
    return "contingency";
  }

  // Memoria de la conversación (datos del cliente y montos ya citados)
  const slots = { ...(state.slots ?? {}), ...Object.fromEntries(Object.entries(result.remember).slice(0, 4)) };
  const facts = [...new Set([...(state.facts ?? []), ...result.amounts])].slice(-40);
  await pool.query("UPDATE conversations SET state = state || $2::jsonb WHERE id = $1", [conversationId, JSON.stringify({ slots, facts, lastIntents: result.intents })]);

  try {
    if (result.needsHuman) {
      await handoff(conversationId, result.handoffReason ?? "La IA derivó la conversación a una persona");
      await enqueueAiNotice(conversationId, result.reply, `ai-notice:${last.id}`);
    } else {
      await enqueueAiMessage(conversationId, result.reply, `ai:${last.id}`);
    }
  } catch (e) {
    if ((e as { code?: string }).code === "HUMAN_CONTROL") { await logUsage({ ...base, outcome: "skipped", detail: "Una persona tomó el control" }); return "skipped"; }
    throw e;
  }
  await logUsage({ ...base, outcome: result.needsHuman ? "handoff" : "replied", detail: result.handoffReason, latencyMs: result.latencyMs, tokensIn: result.tokensIn, tokensOut: result.tokensOut, tools: result.tools, intents: result.intents });
  return result.needsHuman ? "handoff" : "replied";
}

// ---- Disparador: espera unos segundos por si el cliente envía varios mensajes seguidos ----
const timers = new Map<string, NodeJS.Timeout>();

export function startAiResponder(): () => void {
  const onMessage = (e: CustomerMessageEvent) => {
    void loadAiSettings().then((s) => {
      if (!s.enabled) return;
      const prev = timers.get(e.conversationId);
      if (prev) clearTimeout(prev);
      timers.set(e.conversationId, setTimeout(() => {
        timers.delete(e.conversationId);
        respondToConversation(e.conversationId).catch((err) => getLogger().error({ err }, "Error al responder con IA"));
      }, s.debounceMs));
    }).catch((err) => getLogger().error({ err }, "No se pudo leer la configuración de IA"));
  };
  appEvents.on(EVT_CUSTOMER_MESSAGE, onMessage);
  return () => { appEvents.off(EVT_CUSTOMER_MESSAGE, onMessage); for (const t of timers.values()) clearTimeout(t); timers.clear(); };
}
