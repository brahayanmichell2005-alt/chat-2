import { z } from "zod";

export const INTENTS = [
  "saludo", "consulta_producto", "consulta_precio", "consulta_stock", "comparacion", "recomendacion", "solicitud_cotizacion", "intencion_compra",
  "formas_pago", "solicitud_instalacion", "consulta_tecnica", "programar_visita", "consulta_garantia", "reclamo", "seguimiento_pedido",
  "seguimiento_servicio", "solicitud_persona", "ambiguo", "fuera_de_ambito",
] as const;
export const TOOL_NAMES = ["search_products", "list_services", "get_company_info"] as const;

const toolCallSchema = z.object({ tool: z.object({ name: z.enum(TOOL_NAMES), args: z.record(z.string(), z.unknown()).default({}) }) });
const finalSchema = z.object({
  reply: z.string().trim().min(1).max(1500),
  needs_human: z.boolean().default(false),
  handoff_reason: z.string().trim().max(300).optional(),
  intents: z.array(z.string()).max(6).default([]).transform((a) => a.filter((x): x is (typeof INTENTS)[number] => (INTENTS as readonly string[]).includes(x)).slice(0, 4)),
  remember: z.record(z.string(), z.string().max(300)).optional(),
});

/**
 * Esquema JSON que se envía a Ollama como `format` para que la decodificación quede restringida
 * al formato esperado (evita "formato_invalido" con modelos pequeños). Debe mantenerse en sintonía
 * con `toolCallSchema` y `finalSchema`.
 */
export const MODEL_OUTPUT_SCHEMA = {
  anyOf: [
    {
      type: "object",
      properties: {
        tool: {
          type: "object",
          properties: { name: { enum: [...TOOL_NAMES] }, args: { type: "object" } },
          required: ["name", "args"],
        },
      },
      required: ["tool"],
    },
    {
      type: "object",
      properties: {
        reply: { type: "string" },
        needs_human: { type: "boolean" },
        handoff_reason: { type: "string" },
        intents: { type: "array", items: { type: "string" } },
        remember: { type: "object" },
      },
      required: ["reply", "needs_human"],
    },
  ],
} as const;

export type ModelOutput =
  | { kind: "tool"; name: (typeof TOOL_NAMES)[number]; args: Record<string, unknown> }
  | { kind: "final"; reply: string; needsHuman: boolean; handoffReason?: string; intents: string[]; remember: Record<string, string> };

/** Interpreta la salida del modelo; devuelve null si no cumple el formato (nunca se ejecuta texto libre). */
export function parseModelOutput(raw: string): ModelOutput | null {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  text = text.slice(start, end + 1);
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return null; }
  if (obj && typeof obj === "object" && "tool" in obj) {
    const t = toolCallSchema.safeParse(obj);
    return t.success ? { kind: "tool", name: t.data.tool.name, args: t.data.tool.args } : null;
  }
  const f = finalSchema.safeParse(obj);
  if (!f.success) return null;
  return { kind: "final", reply: f.data.reply, needsHuman: f.data.needs_human, handoffReason: f.data.handoff_reason, intents: f.data.intents, remember: f.data.remember ?? {} };
}

const HUMAN_RE = /\b(hablar|conversar|comunicar(?:me)?|atienda|atiéndame|atiendeme|pasar(?:me)?|quiero|necesito|prefiero)\b[^.!?\n]{0,40}\b(persona|asesor(?:a)?|humano|agente|encargad[oa]|vendedor(?:a)?|alguien real)\b/i;
const HUMAN_RE2 = /\b(asesor(?:a)?|agente humano|persona real|hablar con alguien)\b/i;
/** Regla determinista: el cliente pide expresamente a una persona. */
export function customerAsksForHuman(text: string): boolean {
  return HUMAN_RE.test(text) || HUMAN_RE2.test(text);
}

/** Mensajes no textuales guardados como "[tipo]". */
export function isNonText(text: string): boolean {
  return /^\[[A-Za-z]+\]$/.test(text.trim());
}
