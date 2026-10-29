/** Validación de respuestas por reglas (no por modelo). Pura y sin E/S. */

const MONEY_RE = /(?:S\/\.?\s?|US\$\s?|\$\s?)(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(?:soles|sol|PEN|USD|dólares|dolares)\b/gi;

export function parseAmount(s: string): number {
  let t = s.trim();
  if (t.includes(",") && t.includes(".")) t = t.replace(/[.,](?=\d{3}\b)/g, "").replace(",", ".");
  else if (t.includes(",")) t = /,\d{1,2}$/.test(t) ? t.replace(",", ".") : t.replace(/,/g, "");
  return Number(t);
}

export function extractAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const n = parseAmount(m[1] ?? m[2] ?? "");
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const FORBIDDEN: [RegExp, string][] = [
  [/\b(pago|depósito|deposito|transferencia|yape|plin)\b[^.!?]{0,30}\b(recibid[oa]|confirmad[oa]|verificad[oa]|acreditad[oa])\b/i, "confirma un pago"],
  [/\bhemos recibido (tu|su) (pago|depósito|deposito|transferencia)/i, "confirma un pago"],
  [/\b(cita|visita|instalación|instalacion)\b[^.!?]{0,30}\b(confirmad[oa]|agendad[oa]|programad[oa]|reservad[oa])\b/i, "confirma una cita"],
  [/\b(pedido|compra|orden)\b[^.!?]{0,30}\b(confirmad[oa]|registrad[oa]|procesad[oa]|realizad[oa])\b/i, "confirma un pedido"],
  [/\b(garantía|garantia|devolución|devolucion|reembolso|reemplazo|cambio)\b[^.!?]{0,30}\b(aprobad[oa]|procede|autorizad[oa]|aceptad[oa])\b/i, "aprueba una garantía o devolución"],
  [/\b(descuento|rebaja|promoción|promocion|oferta)\b[^.!?]{0,20}\d+\s?%/i, "promete un descuento"],
  [/\bte (hago|damos|doy|ofrezco) (un )?(descuento|rebaja)/i, "promete un descuento"],
  [/\b(en|dentro de)\s+\d+\s*(minutos|horas|min|h)\b[^.!?]{0,30}\b(te (atend|respond|llam|contact)|llegará|llegara)/i, "promete un tiempo de atención"],
];
const LEAKS = [/\{\s*"/, /search_products|list_services|get_company_info/i, /system prompt|prompt del sistema|instrucciones internas|\bjson\b/i, /RESULTADO/];

/** Afirmaciones sobre días u horarios de atención: solo válidas si la herramienta de empresa devolvió datos. */
const SCHEDULE_CLAIMS: RegExp[] = [
  /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)\b[^.!?]{0,40}\b(aten|atendemos|horario|abrimos|cerramos|trabajamos|abierto|cerrado)\b/i,
  /\b(aten|atendemos|horario|abrimos|cerramos|trabajamos|abierto|cerrado)\b[^.!?]{0,40}\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)\b/i,
  /\b\d{1,2}(:\d{2})?\s*(a\.?\s?m\.?|p\.?\s?m\.?)\b/i,
  /\bde\s+\d{1,2}(:\d{2})?\s*(a|hasta|-)\s*\d{1,2}(:\d{2})?\s*(h\b|hrs|horas|de la mañana|de la tarde|de la noche)/i,
];

export interface Validation { ok: boolean; problems: string[] }

export function validateReply(text: string, allowedAmounts: number[], previousBotReply?: string, opts: { companyInfoProvided?: boolean } = {}): Validation {
  const problems: string[] = [];
  const t = text.trim();
  if (!t) problems.push("respuesta vacía");
  if (t.length > 1200) problems.push("respuesta demasiado larga");
  for (const a of extractAmounts(t)) {
    if (!allowedAmounts.some((x) => Math.abs(x - a) < 0.005)) problems.push(`monto no respaldado por el catálogo: ${a}`);
  }
  for (const [re, why] of FORBIDDEN) if (re.test(t)) problems.push(why);
  for (const re of LEAKS) if (re.test(t)) problems.push("contiene texto interno o técnico");
  if (!opts.companyInfoProvided && SCHEDULE_CLAIMS.some((re) => re.test(t))) problems.push("afirma horarios o días de atención sin datos de la empresa");
  if (previousBotReply && similarity(t, previousBotReply) > 0.9) problems.push("repite la respuesta anterior");
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/** Similitud de Jaccard entre conjuntos de palabras (0..1). */
export function similarity(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter(Boolean));
  const A = tok(a), B = tok(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
