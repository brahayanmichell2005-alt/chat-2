import { describe, expect, it } from "vitest";
import { customerAsksForHuman, isNonText, parseModelOutput } from "../../src/modules/ai/parse.js";
import { extractAmounts, parseAmount, similarity, validateReply } from "../../src/modules/ai/validator.js";

describe("parseModelOutput", () => {
  it("lee una respuesta final y filtra intenciones desconocidas", () => {
    const o = parseModelOutput('{"reply":"Hola","needs_human":false,"intents":["consulta_precio","inventada"]}');
    expect(o).toMatchObject({ kind: "final", reply: "Hola", needsHuman: false, intents: ["consulta_precio"] });
  });
  it("lee una llamada a herramienta y acepta bloques ```json", () => {
    const o = parseModelOutput('```json\n{"tool":{"name":"search_products","args":{"query":"router"}}}\n```');
    expect(o).toMatchObject({ kind: "tool", name: "search_products", args: { query: "router" } });
  });
  it("rechaza herramientas desconocidas, JSON inválido y texto libre", () => {
    expect(parseModelOutput('{"tool":{"name":"drop_tables","args":{}}}')).toBeNull();
    expect(parseModelOutput("hola, claro que sí")).toBeNull();
    expect(parseModelOutput('{"reply":""}')).toBeNull();
    expect(parseModelOutput("{no es json}")).toBeNull();
  });
});

describe("reglas deterministas", () => {
  it.each(["quiero hablar con una persona", "pásame con un asesor", "necesito un asesor", "prefiero hablar con alguien real"])("detecta petición de persona: %s", (t) => expect(customerAsksForHuman(t)).toBe(true));
  it.each(["cuánto cuesta el router", "tengo una persona en casa que usa el wifi"])("no confunde: %s", (t) => expect(customerAsksForHuman(t)).toBe(false));
  it("detecta mensajes no textuales", () => { expect(isNonText("[imageMessage]")).toBe(true); expect(isNonText("hola")).toBe(false); });
});

describe("validateReply", () => {
  it("acepta montos respaldados por herramientas", () => {
    expect(validateReply("El router cuesta S/ 199.90 y hay stock.", [199.9]).ok).toBe(true);
    expect(validateReply("Son 1,299.00 soles", [1299]).ok).toBe(true);
  });
  it("rechaza montos inventados", () => {
    const v = validateReply("Te sale S/ 150 con instalación", [199.9]);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/monto/);
  });
  it.each([
    "¡Listo! Hemos recibido tu pago.", "Tu cita está confirmada para mañana.", "Tu pedido ha sido confirmado.", "Tu garantía fue aprobada.",
    "Te hago un descuento especial.", "Hay un descuento del 15%.", "En 10 minutos te atendemos.",
  ])("rechaza afirmaciones no autorizadas: %s", (t) => expect(validateReply(t, []).ok).toBe(false));
  it("rechaza texto técnico/JSON y respuestas repetidas", () => {
    expect(validateReply('{"reply":"x"}', []).ok).toBe(false);
    expect(validateReply("Usé search_products para ti", []).ok).toBe(false);
    expect(validateReply("Claro, te ayudo con eso ahora mismo", [], "Claro, te ayudo con eso ahora mismo").ok).toBe(false);
  });
  it("permite palabras comunes como herramientas o sistema", () => {
    expect(validateReply("Tenemos herramientas para instalación y un sistema Wi-Fi mesh.", []).ok).toBe(true);
  });
  it("rechaza horarios inventados si no hay datos de la empresa", () => {
    const v = validateReply("Atendemos de lunes a viernes de 9:00 a. m. a 8:00 p. m. y no los sábados.", []);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/horarios/);
    expect(validateReply("Atendemos de lunes a viernes de 9:00 a. m. a 8:00 p. m.", [], undefined, { companyInfoProvided: true }).ok).toBe(true);
  });
  it("permite decir que no hay horarios configurados", () => {
    expect(validateReply("No tengo el horario configurado; una persona del equipo te lo confirma.", []).ok).toBe(true);
    expect(validateReply("¿Prefieres que te llame el lunes por la mañana?", []).ok).toBe(true);
  });
  it("utilidades", () => {
    expect(parseAmount("1.299,50")).toBe(1299.5);
    expect(extractAmounts("S/ 10 y 20 soles")).toEqual([10, 20]);
    expect(similarity("a b c", "a b c")).toBe(1);
  });
});
