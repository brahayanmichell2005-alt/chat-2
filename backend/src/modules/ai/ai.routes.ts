import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../../common/audit.js";
import { getEnv } from "../../config/env.js";
import { getPool } from "../../database/pool.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { getAiProvider } from "./responder.js";
import { aiSettingsPatch, loadAiSettings, updateAiSettings } from "./settings.js";
import { PROMPT_VERSION, runTurn } from "./turn.js";

const testSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().trim().min(1).max(2000) })).min(1).max(20),
  greetedRecently: z.boolean().optional(),
}).refine((v) => v.messages[v.messages.length - 1]!.role === "user", { message: "El último mensaje debe ser del cliente" });

export function createAiRouter(): Router {
  const r = Router();
  r.use(requireAuth, requirePermission("ai.manage"));

  r.get("/settings", async (_req, res) => res.json({ ...(await loadAiSettings()), promptVersion: PROMPT_VERSION }));
  r.patch("/settings", async (req, res) => res.json(await updateAiSettings(aiSettingsPatch.parse(req.body), req)));

  r.get("/health", async (_req, res) => {
    const s = await loadAiSettings();
    res.json({ ...(await getAiProvider().health(s.baseUrl, s.model)), model: s.model, baseUrl: s.baseUrl });
  });

  /** Probador: ejecuta el mismo motor que el chatbot real, pero NO envía nada a WhatsApp ni guarda mensajes. */
  r.post("/test", async (req, res) => {
    const body = testSchema.parse(req.body);
    const s = await loadAiSettings();
    const result = await runTurn(getAiProvider(), {
      settings: s, history: body.messages.map((m) => ({ role: m.role, content: m.text })), slots: {}, knownAmounts: [],
      greetedRecently: body.greetedRecently ?? body.messages.length > 1, timezone: getEnv().APP_TIMEZONE,
    });
    await getPool().query(
      "INSERT INTO ai_usage_logs (model, prompt_version, outcome, detail, latency_ms, tokens_in, tokens_out, tools, intents) VALUES ($1,$2,'dry_run',$3,$4,$5,$6,$7,$8)",
      [s.model, PROMPT_VERSION, result.kind === "contingency" ? `${result.reason}: ${result.detail}`.slice(0, 500) : null, result.latencyMs, result.tokensIn, result.tokensOut, result.tools, result.kind === "reply" ? result.intents : []]);
    await writeAudit({ action: "ai.test", entityType: "ai_settings", entityId: "main" }, req);
    res.json(result);
  });

  r.get("/usage", async (_req, res) => {
    const { rows } = await getPool().query(
      `SELECT id, conversation_id AS "conversationId", model, outcome, detail, latency_ms AS "latencyMs", tokens_in AS "tokensIn", tokens_out AS "tokensOut", tools, intents, created_at AS "createdAt"
       FROM ai_usage_logs ORDER BY created_at DESC LIMIT 50`);
    res.json({ items: rows });
  });
  return r;
}
