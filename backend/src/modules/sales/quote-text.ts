import { formatPen } from "../../common/money.js";

export interface QuoteTextInput {
  code: string; customerName: string; validUntil: Date; timezone: string;
  items: { description: string; qty: number; unitPriceCents: number; discountCents: number; lineTotalCents: number }[];
  subtotalCents: number; discountCents: number; extraCents: number; totalCents: number; conditions?: string | null; notes?: string | null;
}

/** Texto de la cotización para WhatsApp. Usa SOLO los importes guardados (calculados por el servidor). */
export function formatQuoteText(q: QuoteTextInput): string {
  const lines = q.items.map((i, n) =>
    `${n + 1}. ${i.description} × ${i.qty} — ${formatPen(i.unitPriceCents)} c/u${i.discountCents > 0 ? ` (desc. ${formatPen(i.discountCents)})` : ""} = ${formatPen(i.lineTotalCents)}`);
  const out = [`*Cotización ${q.code}*`, `Cliente: ${q.customerName}`, "", ...lines, ""];
  out.push(`Subtotal: ${formatPen(q.subtotalCents)}`);
  if (q.discountCents > 0) out.push(`Descuento: -${formatPen(q.discountCents)}`);
  if (q.extraCents > 0) out.push(`Costos adicionales: ${formatPen(q.extraCents)}`);
  out.push(`*Total: ${formatPen(q.totalCents)}*`);
  out.push(`Válida hasta: ${q.validUntil.toLocaleDateString("es-PE", { timeZone: q.timezone, day: "2-digit", month: "2-digit", year: "numeric" })}`);
  if (q.conditions) out.push("", `Condiciones: ${q.conditions}`);
  if (q.notes) out.push("", `Observaciones: ${q.notes}`);
  out.push("", "Si estás de acuerdo, respóndenos por aquí y una persona del equipo confirmará tu pedido.");
  return out.join("\n");
}
