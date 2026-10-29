/** Reglas puras de ventas: totales, máquinas de estados y saldos. Sin E/S. */

export type QuoteStatus = "draft" | "pending_send" | "sent" | "accepted" | "rejected" | "expired" | "converted";
export const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  draft: ["pending_send", "sent", "rejected", "expired"],
  pending_send: ["draft", "sent", "rejected", "expired"],
  sent: ["accepted", "rejected", "expired"],
  accepted: ["converted"],
  rejected: [], expired: [], converted: [],
};

export type OrderStatus = "requested" | "confirmed" | "preparing" | "completed" | "cancelled";
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["preparing", "completed", "cancelled"],
  preparing: ["completed", "cancelled"],
  completed: [], cancelled: [],
};

export type PaymentStatus = "pending" | "in_review" | "verified" | "rejected" | "refunded";
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ["in_review", "verified", "rejected"],
  in_review: ["verified", "rejected"],
  verified: ["refunded"],
  rejected: [], refunded: [],
};

export const can = <S extends string>(map: Record<S, S[]>, from: S, to: S): boolean => map[from]?.includes(to) ?? false;

export interface LineInput { qty: number; unitPriceCents: number; discountCents: number }
export interface Totals { subtotalCents: number; discountCents: number; extraCents: number; totalCents: number; lineTotalsCents: number[] }

/** total = suma(cantidad × precio) − descuentos + costos adicionales. Lanza RangeError si un descuento supera su línea. */
export function computeTotals(lines: LineInput[], extraCents = 0): Totals {
  if (lines.length === 0) throw new RangeError("Se requiere al menos una línea");
  if (!Number.isInteger(extraCents) || extraCents < 0) throw new RangeError("Costo adicional inválido");
  let subtotal = 0, discount = 0;
  const lineTotals: number[] = [];
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty <= 0) throw new RangeError("Cantidad inválida");
    if (!Number.isInteger(l.unitPriceCents) || l.unitPriceCents < 0) throw new RangeError("Precio inválido");
    if (!Number.isInteger(l.discountCents) || l.discountCents < 0) throw new RangeError("Descuento inválido");
    const gross = l.qty * l.unitPriceCents;
    if (l.discountCents > gross) throw new RangeError("El descuento supera el importe de la línea");
    subtotal += gross;
    discount += l.discountCents;
    lineTotals.push(gross - l.discountCents);
  }
  return { subtotalCents: subtotal, discountCents: discount, extraCents, totalCents: subtotal - discount + extraCents, lineTotalsCents: lineTotals };
}

export interface PaymentLite { status: PaymentStatus; amountCents: number }
/** Saldo del pedido: solo cuentan como pagados los pagos VERIFICADOS. */
export function paymentSummary(totalCents: number, payments: PaymentLite[]) {
  const sum = (s: PaymentStatus[]) => payments.filter((p) => s.includes(p.status)).reduce((a, p) => a + p.amountCents, 0);
  const verified = sum(["verified"]);
  const open = sum(["pending", "in_review"]);
  return { totalCents, verifiedCents: verified, openCents: open, balanceCents: totalCents - verified, registrableCents: Math.max(0, totalCents - verified - open) };
}

/** Une líneas del mismo producto para reservar/descontar stock una sola vez por producto. */
export function aggregateProductQty(items: { productId: string | null; qty: number }[]): [string, number][] {
  const m = new Map<string, number>();
  for (const i of items) if (i.productId) m.set(i.productId, (m.get(i.productId) ?? 0) + i.qty);
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)); // orden fijo: evita bloqueos cruzados
}
