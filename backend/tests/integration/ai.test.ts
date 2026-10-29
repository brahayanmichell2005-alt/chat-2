// Requiere PostgreSQL real (TEST_DATABASE_URL). Usa proveedores SIMULADOS de WhatsApp y de IA: no envía nada ni llama a Ollama.
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("IA: respuestas con catálogo real, validación y control humano (integración, simulada)", () => {
  let app: any, db: typeof import("../../src/database/pool.js"), fakeWa: any, manager: any, outbox: any, responder: any, fakeAi: any, AiError: any;
  let admin = "";
  const PASS = "ClaveSegura#2024";
  const JID = "51900000001@s.whatsapp.net";
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const q = (sql: string, p: unknown[] = []) => db.getPool().query(sql, p);
  const setEnv = async () => {
    process.env.WHATSAPP_SEND_MODE = "allowlist"; process.env.WHATSAPP_ALLOWED_NUMBERS = "51900000001"; process.env.WHATSAPP_MIN_SEND_INTERVAL_MS = "0";
    (await import("../../src/config/env.js")).resetEnvForTests();
  };
  const runOutbox = async () => { outbox.resetRateLimiterForTests(); while ((await outbox.processOutboxOnce()) === "processed") outbox.resetRateLimiterForTests(); };
  const customerSays = async (text: string) => {
    const ingest = await import("../../src/modules/whatsapp/ingest.service.js");
    await ingest.handleIncoming({ waMessageId: `W${Math.random().toString(36).slice(2)}`, jid: JID, text, timestamp: new Date(), fromMe: false });
    return (await q("SELECT id FROM conversations ORDER BY created_at DESC LIMIT 1")).rows[0].id as string;
  };
  const tool = (name: string, args: object) => JSON.stringify({ tool: { name, args } });
  const final = (reply: string, extra: object = {}) => JSON.stringify({ reply, needs_human: false, intents: ["consulta_precio"], ...extra });
  const lastOut = async () => (await q("SELECT body, status, sent_by, is_notice FROM messages WHERE direction='out' ORDER BY created_at DESC LIMIT 1")).rows[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = url!; process.env.JWT_ACCESS_SECRET = "t".repeat(40); process.env.LOG_LEVEL = "silent"; process.env.NODE_ENV = "test";
    db = await import("../../src/database/pool.js");
    await (await import("../../src/database/migrate.js")).runMigrations(() => undefined);
    const wa = await import("../../src/modules/whatsapp/whatsapp.service.js");
    const { FakeProvider } = await import("../../src/modules/whatsapp/fake.provider.js");
    fakeWa = new FakeProvider(); manager = new wa.WhatsAppManager(fakeWa); wa.setManagerForTests(manager);
    outbox = await import("../../src/modules/whatsapp/outbox.service.js");
    responder = await import("../../src/modules/ai/responder.js");
    const { FakeAiProvider } = await import("../../src/modules/ai/fake.provider.js");
    ({ AiError } = await import("../../src/modules/ai/provider.js"));
    fakeAi = new FakeAiProvider(); responder.setAiProviderForTests(fakeAi);
    app = (await import("../../src/app.js")).createApp();
  });

  beforeEach(async () => {
    await q("TRUNCATE ai_usage_logs, human_handoffs, notification_events, import_jobs, inventory_movements, products, services, internal_notes, conversation_tags, messages, status_history, conversations, contacts, customer_addresses, customers, refresh_tokens, user_roles, users CASCADE");
    // El TRUNCATE ... users CASCADE borra ai_settings (updated_by referencia a users): se recrea la fila única.
    await q("INSERT INTO ai_settings (id) VALUES ('main') ON CONFLICT (id) DO NOTHING");
    await q("UPDATE ai_settings SET enabled = true, debounce_ms = 0");
    const { hashPassword } = await import("../../src/modules/auth/auth.service.js");
    const u = await q("INSERT INTO users (email, name, password_hash) VALUES ('admin@t.local','Admin',$1) RETURNING id", [await hashPassword(PASS)]);
    await q("INSERT INTO user_roles SELECT $1, id FROM roles WHERE code = 'admin'", [u.rows[0].id]);
    admin = (await request(app).post("/api/v1/auth/login").send({ email: "admin@t.local", password: PASS })).body.accessToken;
    const cat = (await request(app).get("/api/v1/catalog/categories").set(auth(admin))).body.items[0].id;
    await request(app).post("/api/v1/catalog/products").set(auth(admin)).send({ sku: "RT-1", name: "Router AX Pro", brand: "TP", categoryId: cat, price: 199.9, stockOnHand: 4 });
    fakeAi.script = []; fakeAi.calls = []; fakeWa.sent.length = 0;
    await setEnv();
    await manager.disconnect(false); await manager.connect(); fakeWa.open();
  });
  afterAll(async () => { await manager?.shutdown(); await db?.closePool(); });

  it("consulta el catálogo antes de dar un precio y la respuesta sale por la cola", async () => {
    const id = await customerSays("cuanto cuesta un router");
    fakeAi.script = [tool("search_products", { query: "router" }), final("El Router AX Pro cuesta S/ 199.90 y hay stock. ¿Para cuántos equipos lo necesitas?")];
    expect(await responder.respondToConversation(id)).toBe("replied");
    expect(fakeAi.calls[1].messages.some((m: any) => m.content.includes("199.90"))).toBe(true); // el modelo recibió el precio real
    await runOutbox();
    expect(fakeWa.sent[0].text).toContain("S/ 199.90");
  });

  it("rechaza un precio inventado y, si insiste, deriva a una persona sin enviar el precio falso", async () => {
    const id = await customerSays("precio del router?");
    fakeAi.script = [final("Cuesta S/ 99"), final("Cuesta S/ 120")];
    expect(await responder.respondToConversation(id)).toBe("contingency");
    await runOutbox();
    expect(fakeWa.sent.every((s: any) => !/99|120/.test(s.text))).toBe(true);
    expect((await q("SELECT control_mode FROM conversations")).rows[0].control_mode).toBe("human");
  });

  it("corrige una respuesta rechazada si el segundo intento es válido", async () => {
    const id = await customerSays("precio del router?");
    fakeAi.script = [final("Te hago un descuento de 20%"), tool("search_products", { query: "router" }), final("Cuesta S/ 199.90.")];
    expect(await responder.respondToConversation(id)).toBe("replied");
  });

  it("no responde dos veces al mismo mensaje del cliente (idempotente)", async () => {
    const id = await customerSays("hola");
    fakeAi.script = [final("¡Hola! ¿En qué te ayudo?"), final("Otra respuesta")];
    expect(await responder.respondToConversation(id)).toBe("replied");
    expect(await responder.respondToConversation(id)).toBe("skipped");
    expect(Number((await q("SELECT count(*) n FROM messages WHERE direction='out'")).rows[0].n)).toBe(1);
  });

  it("si el cliente pide una persona: deriva sin llamar al modelo y envía el aviso", async () => {
    const id = await customerSays("quiero hablar con un asesor");
    expect(await responder.respondToConversation(id)).toBe("handoff");
    expect(fakeAi.calls).toHaveLength(0);
    await runOutbox();
    expect(fakeWa.sent).toHaveLength(1); // el aviso sale aunque ya hay control humano
    expect((await q("SELECT control_mode FROM conversations")).rows[0].control_mode).toBe("human");
  });

  it("needs_human: la IA responde, deriva y el aviso se envía", async () => {
    const id = await customerSays("mi router no funciona y quiero garantía");
    fakeAi.script = [final("Entiendo, registro tu caso para que una persona revise la garantía. ¿Cuándo lo compraste?", { needs_human: true, handoff_reason: "Reclamo de garantía", intents: ["consulta_garantia"] })];
    expect(await responder.respondToConversation(id)).toBe("handoff");
    await runOutbox();
    expect(fakeWa.sent).toHaveLength(1);
    expect((await q("SELECT count(*) n FROM human_handoffs WHERE ended_at IS NULL")).rows[0].n).toBe("1");
  });

  it("sin datos de empresa no inventa horarios: responde honestamente y deriva", async () => {
    await q("DELETE FROM system_settings WHERE key IN ('company','policies')");
    const id = await customerSays("¿cuál es su horario de atención?");
    fakeAi.script = [final("Atendemos de lunes a viernes de 9 a 18")];
    expect(await responder.respondToConversation(id)).toBe("handoff");
    expect(fakeAi.calls).toHaveLength(0); // ni siquiera consulta al modelo
    await runOutbox();
    expect(fakeWa.sent[0].text).toMatch(/no tengo esa información/i);
    expect(fakeWa.sent[0].text).not.toMatch(/lunes|viernes/);
  });

  it("Ollama caído o con tiempo agotado: contingencia + derivación, nunca una respuesta inventada", async () => {
    const id = await customerSays("hola, precios?");
    fakeAi.script = [new AiError("unavailable", "no conecta")];
    expect(await responder.respondToConversation(id)).toBe("contingency");
    await runOutbox();
    expect(fakeWa.sent[0].text).toMatch(/persona del equipo/i);
    expect((await q("SELECT outcome FROM ai_usage_logs ORDER BY id DESC LIMIT 1")).rows[0].outcome).toBe("contingency");
  });

  it("JSON inválido dos veces → contingencia", async () => {
    const id = await customerSays("hola");
    fakeAi.script = ["texto suelto", "otra vez texto"];
    expect(await responder.respondToConversation(id)).toBe("contingency");
  });

  it("con control humano o con la IA desactivada no responde", async () => {
    const id = await customerSays("hola");
    await q("UPDATE conversations SET control_mode = 'human'");
    expect(await responder.respondToConversation(id)).toBe("skipped");
    await q("UPDATE conversations SET control_mode = 'ai'; UPDATE ai_settings SET enabled = false");
    expect(await responder.respondToConversation(id)).toBe("skipped");
    expect(fakeAi.calls).toHaveLength(0);
  });

  it("el probador no envía nada ni guarda mensajes, y exige permiso ai.manage", async () => {
    fakeAi.script = [final("¡Hola! ¿Buscas algún producto?")];
    const res = await request(app).post("/api/v1/ai/test").set(auth(admin)).send({ messages: [{ role: "user", text: "hola" }] });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("reply");
    expect(Number((await q("SELECT count(*) n FROM messages")).rows[0].n)).toBe(0);
    expect((await request(app).post("/api/v1/ai/test").send({ messages: [{ role: "user", text: "hola" }] })).status).toBe(401);
  });

  it("la configuración valida los valores", async () => {
    expect((await request(app).patch("/api/v1/ai/settings").set(auth(admin)).send({ temperature: 9 })).status).toBe(400);
    expect((await request(app).patch("/api/v1/ai/settings").set(auth(admin)).send({ baseUrl: "ftp://x" })).status).toBe(400);
    expect((await request(app).patch("/api/v1/ai/settings").set(auth(admin)).send({ model: "otro:7b" })).body.model).toBe("otro:7b");
  });
});
