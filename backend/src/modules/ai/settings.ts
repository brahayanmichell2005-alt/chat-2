import type { Request } from "express";
import { z } from "zod";
import { writeAudit } from "../../common/audit.js";
import { getPool } from "../../database/pool.js";

export interface AiSettings {
  enabled: boolean; baseUrl: string; model: string; temperature: number; maxOutputTokens: number; numCtx: number; timeoutMs: number;
  historyMessages: number; debounceMs: number; maxToolSteps: number; greetingPauseMinutes: number; contingencyMessage: string; extraInstructions: string;
}

const COLS = `enabled, base_url AS "baseUrl", model, temperature::float8 AS temperature, max_output_tokens AS "maxOutputTokens", num_ctx AS "numCtx",
  timeout_ms AS "timeoutMs", history_messages AS "historyMessages", debounce_ms AS "debounceMs", max_tool_steps AS "maxToolSteps",
  greeting_pause_minutes AS "greetingPauseMinutes", contingency_message AS "contingencyMessage", extra_instructions AS "extraInstructions"`;

export async function loadAiSettings(): Promise<AiSettings> {
  const { rows } = await getPool().query<AiSettings>(`SELECT ${COLS} FROM ai_settings WHERE id = 'main'`);
  return rows[0]!;
}

const httpUrl = z.string().trim().url().max(200).refine((u) => /^https?:\/\//.test(u), "Debe empezar con http:// o https://");
export const aiSettingsPatch = z
  .object({
    enabled: z.boolean(), baseUrl: httpUrl, model: z.string().trim().min(1).max(100),
    temperature: z.number().min(0).max(2), maxOutputTokens: z.number().int().min(50).max(4000), numCtx: z.number().int().min(1024).max(65536),
    timeoutMs: z.number().int().min(5000).max(600000), historyMessages: z.number().int().min(2).max(50), debounceMs: z.number().int().min(0).max(30000),
    maxToolSteps: z.number().int().min(1).max(6), greetingPauseMinutes: z.number().int().min(1).max(10080),
    contingencyMessage: z.string().trim().min(1).max(500), extraInstructions: z.string().trim().max(2000),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Sin cambios" });

const COLUMN: Record<string, string> = {
  enabled: "enabled", baseUrl: "base_url", model: "model", temperature: "temperature", maxOutputTokens: "max_output_tokens", numCtx: "num_ctx",
  timeoutMs: "timeout_ms", historyMessages: "history_messages", debounceMs: "debounce_ms", maxToolSteps: "max_tool_steps",
  greetingPauseMinutes: "greeting_pause_minutes", contingencyMessage: "contingency_message", extraInstructions: "extra_instructions",
};

export async function updateAiSettings(patch: z.infer<typeof aiSettingsPatch>, req: Request): Promise<AiSettings> {
  const before = await loadAiSettings();
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    params.push(v);
    sets.push(`${COLUMN[k]} = $${params.length}`);
  }
  params.push(req.auth!.id);
  await getPool().query(`UPDATE ai_settings SET ${sets.join(", ")}, updated_by = $${params.length}, updated_at = now() WHERE id = 'main'`, params);
  const after = await loadAiSettings();
  await writeAudit({ action: "ai.settings_update", entityType: "ai_settings", entityId: "main", before: { enabled: before.enabled, model: before.model }, after: { enabled: after.enabled, model: after.model } }, req);
  return after;
}
