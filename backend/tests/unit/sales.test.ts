import { describe, expect, it } from "vitest";
import { formatPen, fromCents, toCents } from "../../src/common/money.js";
import { aggregateProductQty, can, computeTotals, ORDER_TRANSITIONS, PAYMENT_TRANSITIONS, paymentSummary, QUOTE_TRANSITIONS } from "../../src/modules/sales/rules.js";
import { formatQuoteText } from "../../src/modules/sales/quote-text.js";

describe("dinero en céntimos", () => {
  it("evita errores de coma flotante", () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(199.9)).toBe(19990);
    expect(fromCents(19990)).toBe(199.9);
    expect(formatPen(123456)).toBe("S/ 1234.56");
  });
});

describe("computeTotals", () => {
  it("calcula subtotal, descuento, adicional y total", () => {
    const t = computeTotals([{ qty: 2, unitPriceCents: 19990, discountCents: 1000 }, { qty: 1, unitPriceCents: 5000, discountCents: 0 }], 1500);
    expect(t).toMatchObject({ subtotalCents: 44980, discountCents: 1000, extraCents: 1500, totalCents: 45480, lineTotalsCents: [38980, 5000] });
  });
  it("rechaza datos inválidos", () => {
    expect(() => computeTotals([])).toThrow();
    expect(() => computeTotals([{ qty: 0, unitPriceCents: 100, discountCents: 0 }])).toThrow(/Cantidad/);
    expect(() => computeTotals([{ qty: 1, unitPriceCents: -1, discountCents: 0 }])).toThrow(/Precio/);
    expect(() => computeTotals([{ qty: 1, unitPriceCents: 100, discountCents: 101 }])).toThrow(/descuento/i);
    expect(() => computeTotals([{ qty: 1, unitPriceCents: 100, discountCents: 0 }], -5)).toThrow();
    expect(() => computeTotals([{ qty: 1.5, unitPriceCents: 100, discountCents: 0 }])).toThrow();
  });
});

describe("máquinas de estados", () => {
  it("cotización: no se puede aceptar un borrador ni reabrir una vencida", () => {
    expect(can(QUOTE_TRANSITIONS, "draft", "accepted")).toBe(false);
    expect(can(QUOTE_TRANSITIONS, "sent", "accepted")).toBe(true);
    expect(can(QUOTE_TRANSITIONS, "expired", "sent")).toBe(false);
    expect(can(QUOTE_TRANSITIONS, "accepted", "converted")).toBe(true);
    expect(can(QUOTE_TRANSITIONS, "converted", "accepted")).toBe(false);
  });
  it("pedido: no hay saltos ni salidas desde estados finales", () => {
    expect(can(ORDER_TRANSITIONS, "requested", "completed")).toBe(false);
    expect(can(ORDER_TRANSITIONS, "requested", "confirmed")).toBe(true);
    expect(can(ORDER_TRANSITIONS, "completed", "cancelled")).toBe(false);
    expect(can(ORDER_TRANSITIONS, "cancelled", "confirmed")).toBe(false);
  });
  it("pago: solo verificado puede reembolsarse", () => {
    expect(can(PAYMENT_TRANSITIONS, "pending", "verified")).toBe(true);
    expect(can(PAYMENT_TRANSITIONS, "pending", "refunded")).toBe(false);
    expect(can(PAYMENT_TRANSITIONS, "verified", "refunded")).toBe(true);
    expect(can(PAYMENT_TRANSITIONS, "rejected", "verified")).toBe(false);
  });
});

describe("saldos y stock", () => {
  it("solo los pagos verificados reducen el saldo; los abiertos reducen lo registrable", () => {
    const s = paymentSummary(10000, [
      { status: "verified", amountCents: 3000 }, { status: "pending", amountCents: 2000 }, { status: "in_review", amountCents: 1000 },
      { status: "rejected", amountCents: 4000 }, { status: "refunded", amountCents: 500 },
    ]);
    expect(s).toMatchObject({ verifiedCents: 3000, openCents: 3000, balanceCents: 7000, registrableCents: 4000 });
  });
  it("une líneas del mismo producto y ordena de forma estable", () => {
    expect(aggregateProductQty([{ productId: "b", qty: 1 }, { productId: "a", qty: 2 }, { productId: "b", qty: 3 }, { productId: null, qty: 9 }])).toEqual([["a", 2], ["b", 4]]);
  });
});

describe("texto de la cotización", () => {
  it("incluye líneas, totales y vigencia", () => {
    const t = formatQuoteText({
      code: "COT-000001", customerName: "Ana", validUntil: new Date("2026-11-01T12:00:00Z"), timezone: "America/Lima",
      items: [{ description: "Router AX", qty: 2, unitPriceCents: 19990, discountCents: 1000, lineTotalCents: 38980 }],
      subtotalCents: 39980, discountCents: 1000, extraCents: 1500, totalCents: 40480, conditions: "Pago al contado",
    });
    expect(t).toContain("COT-000001");
    expect(t).toContain("1. Router AX × 2 — S/ 199.90 c/u (desc. S/ 10.00) = S/ 389.80");
    expect(t).toContain("*Total: S/ 404.80*");
    expect(t).toContain("Costos adicionales: S/ 15.00");
    expect(t).toContain("Pago al contado");
    expect(t).toContain("01/11/2026");
  });
});
