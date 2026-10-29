import crypto from "node:crypto";
import { getLogger } from "../../common/logger.js";
import { AiError, type AIProvider, type ChatMessage } from "./provider.js";
import { parseModelOutput } from "./parse.js";
import { buildSystemPrompt, PROMPT_VERSION } from "./prompt.js";
import type { AiSettings } from "./settings.js";
import { runTool } from "./tools.js";
import { validateReply } from "./validator.js";

export interface TurnInput {
  settings: AiSettings;
  history: ChatMessage[];            // user/assistant, orden cronológico, termina en un mensaje del cliente
  slots: Record<string, string>;
  knownAmounts: number[];            // montos ya citados antes en la conversación (state.facts)
  greetedRecently: boolean;
  previousBotReply?: string;
  timezone: string;
}

export type TurnResult =
  | { kind: "reply"; reply: string; needsHuman: boolean; handoffReason?: string; intents: string[]; remember: Record<string, string>; tools: string[]; amounts: number[]; tokensIn: number; tokensOut: number; latencyMs: number; problems: string[] }
  | { kind: "contingency"; reason: string; detail: string; tools: string[]; tokensIn: number; tokensOut: number; latencyMs: number; problems: string[] };

/** Preguntas que dependen de datos de la empresa (horarios, cobertura, pagos, envíos). */
const COMPANY_QUESTION_RE = /\b(horarios?|atienden|abren|cierran|abiertos?|cerrados?|cobertura|zonas?|pagos?|yape|plin|transferencias?|dep[oó]sitos?|delivery|env[ií]os?|entregas?)\b/i;
const NO_COMPANY_DATA_REPLY = "No tengo esa información configurada todavía. Una persona del equipo te la confirmará en breve.";

/** Ejecuta un turno completo del modelo: herramientas → respuesta → validación (con un reintento). Sin efectos en la BD. */
export async function runTurn(provider: AIProvider, input: TurnInput): Promise<TurnResult> {
  const s = input.settings;
  const started = Date.now();
  const nonce = crypto.randomBytes(4).toString("hex");
  const tools: string[] = [];
  const amounts = [...input.knownAmounts];
  let tokensIn = 0, tokensOut = 0;
  const problemsSeen: string[] = [];

  // Datos de empresa verificados: se inyectan en el prompt para que el modelo no dependa de pedirlos
  // (con modelos pequeños la herramienta se ignoraba y el modelo inventaba horarios).
  const company = await runTool("get_company_info", {});
  let companyInfo = Boolean((company.data as { configurado?: boolean }).configurado);

  // Sin datos de empresa, un modelo pequeño inventa horarios/cobertura/pagos: se responde de forma
  // determinista y se deriva a una persona en lugar de arriesgar información falsa.
  const lastUserText = [...input.history].reverse().find((m) => m.role === "user")?.content ?? "";
  if (!companyInfo && COMPANY_QUESTION_RE.test(lastUserText)) {
    return {
      kind: "reply", reply: NO_COMPANY_DATA_REPLY, needsHuman: true, handoffReason: "sin datos de la empresa",
      intents: [], remember: {}, tools: [], amounts: [...input.knownAmounts], tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - started, problems: [],
    };
  }

  const system = buildSystemPrompt({
    timezone: input.timezone,
    nowText: new Date().toLocaleString("es-PE", { timeZone: input.timezone, dateStyle: "full", timeStyle: "short" }),
    greetedRecently: input.greetedRecently, slots: input.slots, extraInstructions: s.extraInstructions, nonce,
    companyInfo: JSON.stringify(company.data),
  });
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...input.history];

  const call = async () => {
    const r = await provider.chat({ baseUrl: s.baseUrl, model: s.model, messages, json: true, temperature: s.temperature, maxTokens: s.maxOutputTokens, numCtx: s.numCtx, timeoutMs: s.timeoutMs });
    tokensIn += r.tokensIn ?? 0; tokensOut += r.tokensOut ?? 0;
    return r.content;
  };
  const fail = (reason: string, detail: string): TurnResult => ({ kind: "contingency", reason, detail, tools, tokensIn, tokensOut, latencyMs: Date.now() - started, problems: problemsSeen });

  let repairs = 0;
  let validationRetries = 0;
  try {
    for (let step = 0; step <= s.maxToolSteps + 2; step++) {
      const raw = await call();
      const out = parseModelOutput(raw);
      if (!out) {
        if (repairs++ >= 1) return fail("formato_invalido", "El modelo no devolvió un JSON válido");
        messages.push({ role: "assistant", content: raw.slice(0, 2000) }, { role: "user", content: `[[RESULTADO ${nonce}]] Formato inválido. Responde solo con un objeto JSON válido con el formato indicado.` });
        continue;
      }
      if (out.kind === "tool") {
        if (tools.length >= s.maxToolSteps) {
          messages.push({ role: "assistant", content: raw.slice(0, 2000) }, { role: "user", content: `[[RESULTADO ${nonce}]] Límite de herramientas alcanzado. Responde ahora al cliente con lo que tienes.` });
          continue;
        }
        tools.push(out.name);
        const res = await runTool(out.name, out.args);
        if (out.name === "get_company_info") companyInfo = Boolean((res.data as { configurado?: boolean }).configurado);
        amounts.push(...res.amounts);
        messages.push({ role: "assistant", content: raw.slice(0, 2000) }, { role: "user", content: `[[RESULTADO ${nonce}]] ${out.name}: ${JSON.stringify(res.data).slice(0, 6000)}\nContinúa. Responde solo JSON.` });
        continue;
      }
      const v = validateReply(out.reply, amounts, input.previousBotReply, { companyInfoProvided: companyInfo });
      if (!v.ok) {
        problemsSeen.push(...v.problems);
        if (validationRetries++ >= 1) {
          if (v.problems.some((p) => p.includes("horarios"))) {
            return {
              kind: "reply", reply: NO_COMPANY_DATA_REPLY, needsHuman: true, handoffReason: "sin datos de la empresa",
              intents: out.intents, remember: {}, tools, amounts, tokensIn, tokensOut, latencyMs: Date.now() - started, problems: problemsSeen,
            };
          }
          return fail("respuesta_rechazada", v.problems.join("; "));
        }
        messages.push({ role: "assistant", content: raw.slice(0, 2000) }, { role: "user", content: `[[RESULTADO ${nonce}]] Tu respuesta fue rechazada: ${v.problems.join("; ")}. Corrígela usando solo datos de las herramientas o del bloque DATOS DE LA EMPRESA. Si no tienes el dato, di con claridad que no lo sabes y ofrece pasar con una persona (needs_human=true); no supongas horarios, precios ni condiciones. Responde solo JSON.` });
        continue;
      }
      return {
        kind: "reply", reply: out.reply, needsHuman: out.needsHuman, handoffReason: out.handoffReason, intents: out.intents, remember: out.remember,
        tools, amounts, tokensIn, tokensOut, latencyMs: Date.now() - started, problems: problemsSeen,
      };
    }
    return fail("demasiados_pasos", "El modelo no llegó a una respuesta final");
  } catch (e) {
    if (e instanceof AiError) return fail(e.kind, e.message);
    getLogger().error({ err: e }, "Error inesperado en el turno de IA");
    return fail("error", "Error interno al generar la respuesta");
  }
}

export { PROMPT_VERSION };
