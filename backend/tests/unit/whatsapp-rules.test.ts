import { describe, expect, it } from "vitest";
import { ingestAllowed, aiMayRespond, contactKeyFromJid, jidForContact, reconnectDelayMs, retryDelayMs, sendGate, shouldIgnoreJid } from "../../src/modules/whatsapp/rules.js";
import { loadEnv } from "../../src/config/env.js";

describe("JID y contactos", () => {
  it("ignora grupos, estados y canales", () => {
    for (const j of ["123@g.us", "status@broadcast", "x@newsletter", "lista@broadcast"]) expect(shouldIgnoreJid(j)).toBe(true);
    expect(shouldIgnoreJid("51910989309@s.whatsapp.net")).toBe(false);
  });
  it("deriva la clave de contacto y quita el sufijo de dispositivo", () => {
    expect(contactKeyFromJid("51910989309@s.whatsapp.net")).toBe("+51910989309");
    expect(contactKeyFromJid("51910989309:12@s.whatsapp.net")).toBe("+51910989309");
    expect(contactKeyFromJid("987654321@lid")).toBe("lid:987654321");
    expect(contactKeyFromJid("basura")).toBeNull();
  });
  it("construye el JID de envío", () => {
    expect(jidForContact("+51910989309", null)).toBe("51910989309@s.whatsapp.net");
    expect(jidForContact("lid:1", "1@lid")).toBe("1@lid");
    expect(jidForContact("lid:1", null)).toBeNull();
  });
});

describe("compuerta de envío", () => {
  it("off bloquea todo", () => expect(sendGate("off", [], "+51910989309").ok).toBe(false));
  it("allowlist solo permite números listados", () => {
    expect(sendGate("allowlist", ["51910989309"], "+51910989309").ok).toBe(true);
    expect(sendGate("allowlist", ["51910989309"], "+51999999999").ok).toBe(false);
    expect(sendGate("allowlist", ["123"], "lid:123").ok).toBe(true); // coincide por dígitos; los lid no se usan con listas reales
  });
  it("all permite", () => expect(sendGate("all", [], "+51999999999").ok).toBe(true));
});

describe("tiempos y control", () => {
  it("backoff acotado", () => {
    expect([1, 2, 3, 9].map(retryDelayMs)).toEqual([2000, 10000, 30000, 30000]);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(20)).toBe(60000);
  });
  it("la IA solo responde en modo ai y conversación no cerrada", () => {
    expect(aiMayRespond({ controlMode: "ai", status: "open" })).toBe(true);
    expect(aiMayRespond({ controlMode: "human", status: "open" })).toBe(false);
    expect(aiMayRespond({ controlMode: "paused", status: "open" })).toBe(false);
    expect(aiMayRespond({ controlMode: "ai", status: "closed" })).toBe(false);
  });
});

describe("configuración de WhatsApp", () => {
  const base = { DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db", JWT_ACCESS_SECRET: "x".repeat(32) };
  it("por defecto el envío está apagado", () => expect(loadEnv(base).WHATSAPP_SEND_MODE).toBe("off"));
  it("allowlist exige números", () => {
    expect(() => loadEnv({ ...base, WHATSAPP_SEND_MODE: "allowlist" })).toThrow(/WHATSAPP_ALLOWED_NUMBERS/);
    expect(loadEnv({ ...base, WHATSAPP_SEND_MODE: "allowlist", WHATSAPP_ALLOWED_NUMBERS: "51 900-000-000, 51911111111" }).WHATSAPP_ALLOWED_NUMBERS).toEqual(["51900000000", "51911111111"]);
  });
});

describe("registro de conversaciones en modo de pruebas", () => {
  it("allowlist solo registra números permitidos; off y all registran todo", () => {
    expect(ingestAllowed("allowlist", ["51918897402"], "+51918897402")).toBe(true);
    expect(ingestAllowed("allowlist", ["51918897402"], "lid:1", "+51918897402")).toBe(true);
    expect(ingestAllowed("allowlist", ["51918897402"], "+51999999999")).toBe(false);
    expect(ingestAllowed("off", [], "+51999999999")).toBe(true);
    expect(ingestAllowed("all", [], "+51999999999")).toBe(true);
  });
});
