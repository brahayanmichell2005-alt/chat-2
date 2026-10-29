// Requiere PostgreSQL real (TEST_DATABASE_URL). Usa un proveedor simulado: NO se conecta a WhatsApp ni envía mensajes reales.
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("WhatsApp: ingesta, control humano y cola de salida (integración, proveedor simulado)", () => {
  let app: any, db: typeof import("../../src/database/pool.js"), fake: any, outbox: typeof import("../../src/modules/whatsapp/outbox.service.js");
  let manager: any, ingest: typeof import("../../src/modules/whatsapp/ingest.service.js");
  let admin = "", agent = "", agentId = "";
  const PASS = "ClaveSegura#2024";
  const JID = "51900000001@s.whatsapp.net";
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const q = (sql: string, p: unknown[] = []) => db.getPool().query(sql, p);

  async function mkUser(email: string, role: string) {
    const { hashPassword } = await import("../../src/modules/auth/auth.service.js");
    const r = await q("INSERT INTO users (email, name, password_hash) VALUES ($1,$1,$2) RETURNING id", [email, await hashPassword(PASS)]);
    await q("INSERT INTO user_roles SELECT $1, id FROM roles WHERE code = $2", [r.rows[0].id, role]);
    return r.rows[0].id as string;
  }
  const login = async (email: string) => (await request(app).post("/api/v1/auth/login").send({ email, password: PASS })).body.accessToken as string;
  const setEnv = async (mode: string, nums = "") => {
    process.env.WHATSAPP_SEND_MODE = mode; process.env.WHATSAPP_ALLOWED_NUMBERS = nums; process.env.WHATSAPP_MIN_SEND_INTERVAL_MS = "0";
    (await import("../../src/config/env.js")).resetEnvForTests();
  };
  const convId = async () => (await q("SELECT id FROM conversations ORDER BY created_at DESC LIMIT 1")).rows[0].id as string;
  const runOutbox = async () => { outbox.resetRateLimiterForTests(); while ((await outbox.processOutboxOnce()) === "processed") outbox.resetRateLimiterForTests(); };

  beforeAll(async () => {
    process.env.DATABASE_URL = url!; process.env.JWT_ACCESS_SECRET = "t".repeat(40); process.env.LOG_LEVEL = "silent"; process.env.NODE_ENV = "test";
    db = await import("../../src/database/pool.js");
    await (await import("../../src/database/migrate.js")).runMigrations(() => undefined);
    const { WhatsAppManager, setManagerForTests } = await import("../../src/modules/whatsapp/whatsapp.service.js");
    const { FakeProvider } = await import("../../src/modules/whatsapp/fake.provider.js");
    fake = new FakeProvider(); manager = new WhatsAppManager(fake); setManagerForTests(manager);
    outbox = await import("../../src/modules/whatsapp/outbox.service.js");
    ingest = await import("../../src/modules/whatsapp/ingest.service.js");
    app = (await import("../../src/app.js")).createApp();
  });

  beforeEach(async () => {
    await q("TRUNCATE ai_usage_logs, human_handoffs, notification_events, import_jobs, inventory_movements, products, services, internal_notes, conversation_tags, messages, status_history, conversations, contacts, customer_addresses, customers, refresh_tokens, user_roles, users CASCADE");
    await mkUser("admin@t.local", "admin"); agentId = await mkUser("agent@t.local", "agent");
    admin = await login("admin@t.local"); agent = await login("agent@t.local");
    fake.sent.length = 0; fake.failWith = null;
    await manager.disconnect(false); await manager.connect(); fake.open();
    await setEnv("allowlist", "51900000001");
  });
  afterAll(async () => { await manager?.shutdown(); await db?.closePool(); });

  it("un mensaje entrante crea contacto, cliente y conversación; el duplicado no se guarda dos veces", async () => {
    fake.receive({ jid: JID, text: "Hola", pushName: "Ana", waMessageId: "A1" });
    await new Promise((r) => setTimeout(r, 300));
    fake.receive({ jid: JID, text: "Hola", pushName: "Ana", waMessageId: "A1" });
    await new Promise((r) => setTimeout(r, 300));
    expect(Number((await q("SELECT count(*) n FROM messages")).rows[0].n)).toBe(1);
    expect(Number((await q("SELECT count(*) n FROM conversations")).rows[0].n)).toBe(1);
    expect((await q("SELECT name FROM customers")).rows[0].name).toBe("Ana");
  });

  it("ignora grupos y estados", async () => {
    expect(await ingest.handleIncoming({ waMessageId: "G1", jid: "123@g.us", text: "x", timestamp: new Date(), fromMe: false })).toBe("ignored");
    expect(await ingest.handleIncoming({ waMessageId: "S1", jid: "status@broadcast", text: "x", timestamp: new Date(), fromMe: false })).toBe("ignored");
  });

  it("un mensaje propio desconocido (escrito desde el celular) pausa la IA", async () => {
    await ingest.handleIncoming({ waMessageId: "C1", jid: JID, text: "Hola", timestamp: new Date(), fromMe: false });
    expect(await ingest.handleIncoming({ waMessageId: "OWN1", jid: JID, text: "Te atiendo yo", timestamp: new Date(), fromMe: true })).toBe("external_reply");
    expect((await q("SELECT control_mode FROM conversations")).rows[0].control_mode).toBe("paused");
  });

  it("la respuesta de un trabajador toma el control, sale por la cola y su eco no pausa ni duplica", async () => {
    await ingest.handleIncoming({ waMessageId: "C2", jid: JID, text: "Precio?", timestamp: new Date(), fromMe: false });
    const id = await convId();
    const res = await request(app).post(`/api/v1/conversations/${id}/messages`).set(auth(admin)).send({ text: "Cuesta 100", idempotencyKey: "key-12345678" });
    expect(res.status).toBe(202);
    expect((await q("SELECT control_mode FROM conversations WHERE id = $1", [id])).rows[0].control_mode).toBe("human");
    await runOutbox();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].jid).toBe(JID);
    const waId = (await q("SELECT wa_message_id FROM messages WHERE direction='out'")).rows[0].wa_message_id;
    // el eco del mensaje propio llega con el mismo id: se descarta
    expect(await ingest.handleIncoming({ waMessageId: waId, jid: JID, text: "Cuesta 100", timestamp: new Date(), fromMe: true })).toBe("duplicate");
    expect((await q("SELECT control_mode FROM conversations")).rows[0].control_mode).toBe("human");
    // el mismo idempotencyKey no crea otro mensaje
    await request(app).post(`/api/v1/conversations/${id}/messages`).set(auth(admin)).send({ text: "Cuesta 100", idempotencyKey: "key-12345678" });
    expect(Number((await q("SELECT count(*) n FROM messages WHERE direction='out'")).rows[0].n)).toBe(1);
  });

  it("la IA no puede encolar con control humano y su respuesta pendiente se cancela si una persona toma el control", async () => {
    await ingest.handleIncoming({ waMessageId: "C3", jid: JID, text: "Hola", timestamp: new Date(), fromMe: false });
    const id = await convId();
    await outbox.enqueueAiMessage(id, "Respuesta IA", "ai-key-1234");
    await request(app).post(`/api/v1/conversations/${id}/handoff`).set(auth(admin)).send({ reason: "Cliente molesto" });
    await expect(outbox.enqueueAiMessage(id, "Otra", "ai-key-5678")).rejects.toMatchObject({ code: "HUMAN_CONTROL" });
    await runOutbox();
    expect(fake.sent).toHaveLength(0);
    expect((await q("SELECT status FROM messages WHERE sent_by='ai'")).rows[0].status).toBe("cancelled");
  });

  it("handoff: notifica, registra la transferencia y al devolver a la IA se cierra", async () => {
    await ingest.handleIncoming({ waMessageId: "C4", jid: JID, text: "Hola", timestamp: new Date(), fromMe: false });
    const id = await convId();
    const h1 = await request(app).post(`/api/v1/conversations/${id}/handoff`).set(auth(admin)).send({ reason: "Pide persona" });
    expect(h1.body.controlMode).toBe("human");
    await request(app).post(`/api/v1/conversations/${id}/handoff`).set(auth(admin)).send({ reason: "Otra vez" });
    expect(Number((await q("SELECT count(*) n FROM human_handoffs")).rows[0].n)).toBe(1);
    const r = await request(app).post(`/api/v1/conversations/${id}/resume-ai`).set(auth(admin));
    expect(r.body.controlMode).toBe("ai");
    expect((await q("SELECT ended_at FROM human_handoffs")).rows[0].ended_at).not.toBeNull();
  });

  it("un handoff sin responsable avisa a supervisores/administradores", async () => {
    await ingest.handleIncoming({ waMessageId: "C5", jid: JID, text: "Hola", timestamp: new Date(), fromMe: false });
    const id = await convId();
    const { requestHandoffTx } = await import("../../src/modules/conversations/handoff.service.js");
    await db.withTransaction((c) => requestHandoffTx(c, id, "La IA no pudo resolver", { by: "ai" }));
    const n = await request(app).get("/api/v1/notifications").set(auth(admin));
    expect(n.body.items.some((x: any) => x.type === "handoff_pending")).toBe(true);
    expect((await request(app).get("/api/v1/notifications").set(auth(agent))).body.unread).toBe(0);
  });

  it("modo off bloquea el envío; fuera de la lista también", async () => {
    await ingest.handleIncoming({ waMessageId: "C6", jid: JID, text: "Hola", timestamp: new Date(), fromMe: false });
    const id = await convId();
    await setEnv("off");
    await request(app).post(`/api/v1/conversations/${id}/messages`).set(auth(admin)).send({ text: "A" });
    await runOutbox();
    expect((await q("SELECT status FROM messages WHERE direction='out'")).rows[0].status).toBe("blocked");
    await q("DELETE FROM messages WHERE direction='out'");
    await setEnv("allowlist", "51999999999");
    await request(app).post(`/api/v1/conversations/${id}/messages`).set(auth(admin)).send({ text: "B" });
    await runOutbox();
    expect((await q("SELECT status FROM messages WHERE direction='out'")).rows[0].status).toBe("blocked");
    expect(fake.sent).toHaveLength(0);
  });

  it("error de envío con resultado desconocido queda 'uncertain' y NO se reintenta", async () => {
    await ingest.handleIncoming({ waMessageId: "C7", jid: JID, text: "Hola", timestamp: new Date(), fromMe: false });
    const id = await convId();
    await request(app).post(`/api/v1/conversations/${id}/messages`).set(auth(admin)).send({ text: "X" });
    fake.failWith = new Error("timeout de red");
    await runOutbox();
    await runOutbox();
    expect((await q("SELECT status FROM messages WHERE direction='out'")).rows[0].status).toBe("uncertain");
    expect(fake.sent).toHaveLength(0);
  });

  it("solo el administrador gestiona la conexión; el QR no se expone a otros", async () => {
    expect((await request(app).post("/api/v1/whatsapp/connect").set(auth(agent))).status).toBe(403);
    expect((await request(app).get("/api/v1/whatsapp/qr").set(auth(agent))).status).toBe(403);
    expect((await request(app).get("/api/v1/whatsapp/status").set(auth(admin))).body.status).toBeDefined();
  });

  it("desconexión: no hay bucle de reintentos infinito", async () => {
    fake.close("other");
    await new Promise((r) => setTimeout(r, 100));
    expect(["connecting", "error", "disconnected"]).toContain(manager.status);
    fake.close("logged_out");
    await new Promise((r) => setTimeout(r, 300));
    expect(manager.status).toBe("disconnected");
  });
});
