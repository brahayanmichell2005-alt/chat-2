// Requiere PostgreSQL real (TEST_DATABASE_URL). Vacía tablas de catálogo y CRM de esa base.
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("CRM y catálogo (integración)", () => {
  let app: any;
  let db: typeof import("../../src/database/pool.js");
  let admin = "", agent = "", agent2 = "", agentId = "";
  const PASS = "ClaveSegura#2024";

  async function mkUser(email: string, role: string) {
    const { hashPassword } = await import("../../src/modules/auth/auth.service.js");
    const r = await db.getPool().query("INSERT INTO users (email, name, password_hash) VALUES ($1,$1,$2) RETURNING id", [email, await hashPassword(PASS)]);
    await db.getPool().query("INSERT INTO user_roles SELECT $1, id FROM roles WHERE code = $2", [r.rows[0].id, role]);
    return r.rows[0].id as string;
  }
  const login = async (email: string) => (await request(app).post("/api/v1/auth/login").send({ email, password: PASS })).body.accessToken as string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    process.env.DATABASE_URL = url!; process.env.JWT_ACCESS_SECRET = "t".repeat(40); process.env.LOG_LEVEL = "silent"; process.env.NODE_ENV = "test";
    db = await import("../../src/database/pool.js");
    await (await import("../../src/database/migrate.js")).runMigrations(() => undefined);
    app = (await import("../../src/app.js")).createApp();
  });

  beforeEach(async () => {
    const pool = db.getPool();
    await pool.query("TRUNCATE ai_usage_logs, human_handoffs, notification_events, import_jobs, inventory_movements, products, services, internal_notes, conversation_tags, messages, status_history, conversations, contacts, customer_addresses, customers, refresh_tokens, user_roles, users CASCADE");
    await mkUser("admin@t.local", "admin");
    agentId = await mkUser("agent@t.local", "agent");
    await mkUser("agent2@t.local", "agent");
    [admin, agent, agent2] = [await login("admin@t.local"), await login("agent@t.local"), await login("agent2@t.local")];
  });
  afterAll(async () => { await db?.closePool(); });

  const categoryId = async () => (await request(app).get("/api/v1/catalog/categories").set(auth(admin))).body.items[0].id as string;
  const newProduct = async (sku = "R-1", extra = {}) =>
    request(app).post("/api/v1/catalog/products").set(auth(admin)).send({ sku, name: "Router AX", categoryId: await categoryId(), price: 199.9, stockOnHand: 5, ...extra });

  it("admin crea producto; trabajador puede leer pero no escribir (403)", async () => {
    const created = await newProduct();
    expect(created.status).toBe(201);
    expect(created.body.sku).toBe("R-1");
    expect((await request(app).get("/api/v1/catalog/products").set(auth(agent))).status).toBe(200);
    const denied = await request(app).post("/api/v1/catalog/products").set(auth(agent)).send({ sku: "X", name: "X", categoryId: await categoryId(), price: 1 });
    expect(denied.status).toBe(403);
  });

  it("rechaza SKU repetido (409) y precios inválidos (400)", async () => {
    await newProduct("DUP");
    expect((await newProduct("dup")).status).toBe(409);
    expect((await newProduct("NEG", { price: -5 })).status).toBe(400);
  });

  it("el ajuste de stock no puede dejarlo negativo y registra movimientos", async () => {
    const id = (await newProduct()).body.id;
    const bad = await request(app).post(`/api/v1/catalog/products/${id}/stock-adjustments`).set(auth(admin)).send({ delta: -10, reason: "merma" });
    expect(bad.status).toBe(409);
    const ok = await request(app).post(`/api/v1/catalog/products/${id}/stock-adjustments`).set(auth(admin)).send({ delta: -2, reason: "merma" });
    expect(ok.body.stockOnHand).toBe(3);
    const mv = await request(app).get(`/api/v1/catalog/products/${id}/movements`).set(auth(admin));
    expect(mv.body.items.map((m: any) => m.type).sort()).toEqual(["adjustment", "initial"]);
  });

  describe("importación", () => {
    const file = (body: string) => Buffer.from(`sku,nombre,categoria,precio,stock\n${body}`);
    const upload = (buf: Buffer, mode = "insert_only", token = admin) =>
      request(app).post("/api/v1/catalog/products/import").set(auth(token)).field("mode", mode).attach("file", buf, "p.csv");
    const count = async () => Number((await db.getPool().query("SELECT count(*) n FROM products")).rows[0].n);

    it("la vista previa NO modifica productos; confirmar sí, y no se puede confirmar dos veces", async () => {
      const prev = await upload(file("A1,Cámara,Videovigilancia,120,3\nA2,DVR,Videovigilancia,300,1"));
      expect(prev.status).toBe(201);
      expect(prev.body.summary.toCreate).toBe(2);
      expect(await count()).toBe(0);
      const ok = await request(app).post(`/api/v1/catalog/products/import/${prev.body.id}/confirm`).set(auth(admin));
      expect(ok.body).toMatchObject({ created: 2, updated: 0 });
      expect(await count()).toBe(2);
      expect((await request(app).post(`/api/v1/catalog/products/import/${prev.body.id}/confirm`).set(auth(admin))).status).toBe(409);
    });

    it("reporta filas con error y permite cancelar sin cambios", async () => {
      const prev = await upload(file("B1,Ok,Videovigilancia,10,1\nB2,Mala categoria,Nada,10,1\nB3,Precio,Videovigilancia,xx,1"));
      expect(prev.body.summary).toMatchObject({ validRows: 1, errorRows: 2 });
      expect(prev.body.errors).toHaveLength(2);
      const cancel = await request(app).delete(`/api/v1/catalog/products/import/${prev.body.id}`).set(auth(admin));
      expect(cancel.body.status).toBe("cancelled");
      expect((await request(app).post(`/api/v1/catalog/products/import/${prev.body.id}/confirm`).set(auth(admin))).status).toBe(409);
      expect(await count()).toBe(0);
    });

    it("insert_only no toca existentes; upsert actualiza precio pero ignora el stock del archivo", async () => {
      const id = (await newProduct("EX-1")).body.id;
      const a = await upload(file("EX-1,Nuevo nombre,Videovigilancia,999,50"), "insert_only");
      expect(a.body.summary).toMatchObject({ toCreate: 0, toUpdate: 0, skippedExisting: 1 });
      const b = await upload(file("EX-1,Nuevo nombre,Videovigilancia,999,50"), "upsert");
      expect(b.body.summary.toUpdate).toBe(1);
      await request(app).post(`/api/v1/catalog/products/import/${b.body.id}/confirm`).set(auth(admin));
      const p = await request(app).get(`/api/v1/catalog/products/${id}`).set(auth(admin));
      expect(p.body).toMatchObject({ name: "Nuevo nombre", price: 999, stockOnHand: 5 });
    });

    it("un trabajador no puede importar (403)", async () => {
      expect((await upload(file("C1,X,Videovigilancia,1,1"), "insert_only", agent)).status).toBe(403);
    });

    it("rechaza archivos de formato no admitido", async () => {
      const res = await request(app).post("/api/v1/catalog/products/import").set(auth(admin)).attach("file", Buffer.from("x"), "a.txt");
      expect(res.status).toBe(400);
    });
  });

  it("clientes: detecta duplicados por teléfono y permite forzar", async () => {
    const a = await request(app).post("/api/v1/customers").set(auth(admin)).send({ name: "Ana Pérez", phone: "910 989 309" });
    expect(a.status).toBe(201);
    expect(a.body.phones).toEqual(["+51910989309"]);
    const dup = await request(app).post("/api/v1/customers").set(auth(admin)).send({ name: "Otra Ana", phone: "+51910989309" });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("DUPLICATE_CUSTOMER");
  });

  it("servicios: precio fijo exige tarifa", async () => {
    const cat = (await request(app).get("/api/v1/services/categories").set(auth(admin))).body.items[0].id;
    const bad = await request(app).post("/api/v1/services").set(auth(admin)).send({ code: "WIFI", name: "Wi-Fi", categoryId: cat, priceType: "fixed" });
    expect(bad.status).toBe(400);
    const ok = await request(app).post("/api/v1/services").set(auth(admin)).send({ code: "wifi", name: "Wi-Fi", categoryId: cat, priceType: "inspection" });
    expect(ok.status).toBe(201);
    expect(ok.body.code).toBe("WIFI");
  });

  it("conversaciones: un trabajador solo ve las asignadas a él", async () => {
    const created = await request(app).post("/api/v1/conversations").set(auth(agent)).send({ phone: "999111222", name: "Cliente" });
    expect(created.status).toBe(201);
    expect(created.body.assignedUserId).toBe(agentId);
    const id = created.body.id;
    expect((await request(app).get(`/api/v1/conversations/${id}`).set(auth(agent))).status).toBe(200);
    expect((await request(app).get(`/api/v1/conversations/${id}`).set(auth(agent2))).status).toBe(404);
    expect((await request(app).get("/api/v1/conversations").set(auth(agent2))).body.total).toBe(0);
    expect((await request(app).get("/api/v1/conversations").set(auth(admin))).body.total).toBe(1);
  });

  it("conversaciones: notas internas, etiquetas, asignación solo con permiso y una abierta por contacto", async () => {
    const id = (await request(app).post("/api/v1/conversations").set(auth(admin)).send({ phone: "999111222" })).body.id;
    expect((await request(app).post("/api/v1/conversations").set(auth(admin)).send({ phone: "999111222" })).status).toBe(409);
    const note = await request(app).post(`/api/v1/conversations/${id}/notes`).set(auth(admin)).send({ body: "Llamar mañana" });
    expect(note.status).toBe(201);
    const tags = (await request(app).get("/api/v1/conversations/tags").set(auth(admin))).body.items;
    const tagged = await request(app).put(`/api/v1/conversations/${id}/tags`).set(auth(admin)).send({ tagIds: [tags[0].id] });
    expect(tagged.body.tags).toHaveLength(1);
    expect((await request(app).post(`/api/v1/conversations/${id}/assign`).set(auth(agent)).send({ userId: agentId })).status).toBe(403);
    const assigned = await request(app).post(`/api/v1/conversations/${id}/assign`).set(auth(admin)).send({ userId: agentId });
    expect(assigned.body.assignedUserId).toBe(agentId);
    const detail = await request(app).get(`/api/v1/conversations/${id}`).set(auth(admin));
    expect(detail.body.notes).toHaveLength(1);
  });

  it("ajustes de empresa: solo el admin escribe y no acepta claves desconocidas", async () => {
    expect((await request(app).patch("/api/v1/settings").set(auth(agent)).send({ company: { name: "X" } })).status).toBe(403);
    const ok = await request(app).patch("/api/v1/settings").set(auth(admin)).send({ company: { name: "Mi Empresa" } });
    expect(ok.body.company.name).toBe("Mi Empresa");
    expect((await request(app).patch("/api/v1/settings").set(auth(admin)).send({ company: { hack: "x" } })).status).toBe(400);
  });
});
