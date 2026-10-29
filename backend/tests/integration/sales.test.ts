// Requiere PostgreSQL real (TEST_DATABASE_URL). Proveedor de WhatsApp SIMULADO. Vacía tablas de ventas, CRM y usuarios de esa base.
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("Ventas: cotizaciones, pedidos, stock y pagos (integración)", () => {
  let app: any, db: typeof import("../../src/database/pool.js"), fakeWa: any, manager: any, outbox: any;
  let admin = "", sup = "", agent = "";
  let customerId = "", productA = "", productB = "", serviceFixed = "", serviceQuote = "", conversationId = "";
  const PASS = "ClaveSegura#2024";
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const q = (sql: string, p: unknown[] = []) => db.getPool().query(sql, p);

  async function mkUser(email: string, role: string) {
    const { hashPassword } = await import("../../src/modules/auth/auth.service.js");
    const r = await q("INSERT INTO users (email, name, password_hash) VALUES ($1,$1,$2) RETURNING id", [email, await hashPassword(PASS)]);
    await q("INSERT INTO user_roles SELECT $1, id FROM roles WHERE code = $2", [r.rows[0].id, role]);
  }
  const login = async (email: string) => (await request(app).post("/api/v1/auth/login").send({ email, password: PASS })).body.accessToken as string;
  const runOutbox = async () => { outbox.resetRateLimiterForTests(); while ((await outbox.processOutboxOnce()) === "processed") outbox.resetRateLimiterForTests(); };
  const post = (t: string, path: string, body?: object) => request(app).post(`/api/v1${path}`).set(auth(t)).send(body ?? {});
  const stock = async (id: string) => (await q("SELECT stock_on_hand, stock_reserved FROM products WHERE id = $1", [id])).rows[0] as { stock_on_hand: number; stock_reserved: number };
  const newQuote = (t: string, items: object[], extra: object = {}) => post(t, "/quotes", { customerId, items, ...extra });

  beforeAll(async () => {
    process.env.DATABASE_URL = url!; process.env.JWT_ACCESS_SECRET = "t".repeat(40); process.env.LOG_LEVEL = "silent"; process.env.NODE_ENV = "test";
    db = await import("../../src/database/pool.js");
    await (await import("../../src/database/migrate.js")).runMigrations(() => undefined);
    const wa = await import("../../src/modules/whatsapp/whatsapp.service.js");
    const { FakeProvider } = await import("../../src/modules/whatsapp/fake.provider.js");
    fakeWa = new FakeProvider(); manager = new wa.WhatsAppManager(fakeWa); wa.setManagerForTests(manager);
    outbox = await import("../../src/modules/whatsapp/outbox.service.js");
    app = (await import("../../src/app.js")).createApp();
  });

  beforeEach(async () => {
    await q("TRUNCATE payments, order_items, orders, quote_items, quotes, ai_usage_logs, human_handoffs, notification_events, import_jobs, inventory_movements, products, services, internal_notes, conversation_tags, messages, status_history, conversations, contacts, customer_addresses, customers, refresh_tokens, user_roles, users CASCADE");
    await q("INSERT INTO ai_settings (id) VALUES ('main') ON CONFLICT (id) DO NOTHING");
    await mkUser("admin@t.local", "admin"); await mkUser("sup@t.local", "supervisor"); await mkUser("agent@t.local", "agent");
    [admin, sup, agent] = [await login("admin@t.local"), await login("sup@t.local"), await login("agent@t.local")];
    process.env.WHATSAPP_SEND_MODE = "allowlist"; process.env.WHATSAPP_ALLOWED_NUMBERS = "51911000111"; process.env.WHATSAPP_MIN_SEND_INTERVAL_MS = "0";
    (await import("../../src/config/env.js")).resetEnvForTests();
    await manager.disconnect(false); await manager.connect(); fakeWa.open(); fakeWa.sent.length = 0;

    const cat = (await request(app).get("/api/v1/catalog/categories").set(auth(admin))).body.items[0].id;
    const prod = async (sku: string, price: number, stockOnHand: number) =>
      (await post(admin, "/catalog/products", { sku, name: `Producto ${sku}`, categoryId: cat, price, stockOnHand })).body.id as string;
    productA = await prod("A", 199.9, 5); productB = await prod("B", 50, 2);
    const scat = (await request(app).get("/api/v1/services/categories").set(auth(admin))).body.items[0].id;
    serviceFixed = (await post(admin, "/services", { code: "FIJO", name: "Instalación fija", categoryId: scat, priceType: "fixed", baseRate: 80 })).body.id;
    serviceQuote = (await post(admin, "/services", { code: "COTIZA", name: "Cableado", categoryId: scat, priceType: "quote" })).body.id;
    customerId = (await post(admin, "/customers", { name: "Ana Pérez", phone: "911000111" })).body.id;
    conversationId = (await post(admin, "/conversations", { phone: "911000111" })).body.id;
  });
  afterAll(async () => { await manager?.shutdown(); await db?.closePool(); });

  describe("cotizaciones", () => {
    it("el servidor calcula los totales con precios del catálogo", async () => {
      const r = await newQuote(agent, [{ type: "product", id: productA, qty: 2 }, { type: "service", id: serviceFixed, qty: 1 }, { type: "service", id: serviceQuote, qty: 1, unitPrice: 120.5 }], { extraCost: 10 });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ subtotal: 599.3, discountTotal: 0, extraTotal: 10, total: 609.3, status: "draft" });
      expect(r.body.code).toMatch(/^COT-\d{6}$/);
    });

    it("no acepta precios del cliente para productos ni servicios fijos, y exige precio en servicios a cotizar", async () => {
      expect((await newQuote(agent, [{ type: "product", id: productA, qty: 1, unitPrice: 1 }])).status).toBe(400);
      expect((await newQuote(agent, [{ type: "service", id: serviceFixed, qty: 1, unitPrice: 1 }])).status).toBe(400);
      expect((await newQuote(agent, [{ type: "service", id: serviceQuote, qty: 1 }])).body.code).toBe("PRICE_REQUIRED");
    });

    it("rechaza cantidades inválidas y descuentos mayores a la línea", async () => {
      expect((await newQuote(admin, [{ type: "product", id: productA, qty: 0 }])).status).toBe(400);
      expect((await newQuote(sup, [{ type: "product", id: productA, qty: 1, discount: 500 }])).status).toBe(400);
    });

    it("solo supervisor/administrador aplican descuentos", async () => {
      const denied = await newQuote(agent, [{ type: "product", id: productA, qty: 1, discount: 10 }]);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("DISCOUNT_FORBIDDEN");
      const ok = await newQuote(sup, [{ type: "product", id: productA, qty: 1, discount: 10 }]);
      expect(ok.body.total).toBe(189.9);
    });

    it("ciclo completo: enviar por WhatsApp → aceptar → convertir; convertir otra vez no duplica", async () => {
      const id = (await newQuote(agent, [{ type: "product", id: productA, qty: 1 }])).body.id;
      const prev = await request(app).get(`/api/v1/quotes/${id}/preview`).set(auth(admin));
      expect(prev.body.destinationPhone).toBe("+51911000111");
      expect(prev.body.text).toContain("Total: S/ 199.90");
      const sent = await post(admin, `/quotes/${id}/send`);
      expect(sent.body.status).toBe("sent");
      await runOutbox();
      expect(fakeWa.sent[0].text).toContain("Total: S/ 199.90");
      expect((await post(admin, `/quotes/${id}/send`)).status).toBe(409); // ya enviada: no se reenvía
      expect((await post(agent, `/quotes/${id}/accept`)).body.status).toBe("accepted");
      const c1 = await post(agent, `/quotes/${id}/convert-to-order`);
      const c2 = await post(agent, `/quotes/${id}/convert-to-order`);
      expect(c1.body.alreadyConverted).toBe(false);
      expect(c2.body).toMatchObject({ orderId: c1.body.orderId, alreadyConverted: true });
      expect(Number((await q("SELECT count(*) n FROM orders")).rows[0].n)).toBe(1);
    });

    it("no se puede aceptar un borrador ni una cotización vencida", async () => {
      const id = (await newQuote(admin, [{ type: "product", id: productA, qty: 1 }])).body.id;
      expect((await post(admin, `/quotes/${id}/accept`)).status).toBe(409);
      await post(admin, `/quotes/${id}/send`);
      await q("UPDATE quotes SET valid_until = now() - interval '1 day' WHERE id = $1", [id]);
      const r = await post(admin, `/quotes/${id}/accept`);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("EXPIRED");
      expect((await q("SELECT status FROM quotes WHERE id = $1", [id])).rows[0].status).toBe("expired");
    });

    it("sin conversación abierta no se puede enviar", async () => {
      await q("UPDATE conversations SET status = 'closed'");
      const id = (await newQuote(admin, [{ type: "product", id: productA, qty: 1 }])).body.id;
      expect((await post(admin, `/quotes/${id}/send`)).body.code).toBe("NO_CONVERSATION");
    });
  });

  describe("pedidos y stock", () => {
    const mkOrder = async (qtyA = 2, qtyB = 0) =>
      (await post(agent, "/orders", { customerId, items: [{ type: "product", id: productA, qty: qtyA }, ...(qtyB ? [{ type: "product", id: productB, qty: qtyB }] : [])] })).body.id as string;
    const setStatus = (t: string, id: string, status: string, reason?: string) => request(app).patch(`/api/v1/orders/${id}/status`).set(auth(t)).send({ status, reason });

    it("un trabajador crea el pedido pero no puede confirmarlo (403); un supervisor sí", async () => {
      const id = await mkOrder();
      expect((await setStatus(agent, id, "confirmed")).status).toBe(403);
      expect((await setStatus(sup, id, "confirmed")).body.status).toBe("confirmed");
    });

    it("confirmar reserva; completar descuenta; los movimientos quedan registrados una vez", async () => {
      const id = await mkOrder(2);
      await setStatus(sup, id, "confirmed");
      expect(await stock(productA)).toEqual({ stock_on_hand: 5, stock_reserved: 2 });
      expect((await setStatus(sup, id, "confirmed")).status).toBe(409);
      await setStatus(sup, id, "preparing");
      await setStatus(sup, id, "completed");
      expect(await stock(productA)).toEqual({ stock_on_hand: 3, stock_reserved: 0 });
      const mv = (await q("SELECT type FROM inventory_movements WHERE product_id = $1 AND ref_type = 'order' ORDER BY id", [productA])).rows.map((r) => r.type);
      expect(mv).toEqual(["sale_reserve", "sale_out"]);
    });

    it("stock insuficiente: error claro y NADA queda reservado (todo o nada)", async () => {
      const id = await mkOrder(2, 5); // B solo tiene 2
      const r = await setStatus(sup, id, "confirmed");
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("INSUFFICIENT_STOCK");
      expect(await stock(productA)).toEqual({ stock_on_hand: 5, stock_reserved: 0 });
      expect((await q("SELECT status FROM orders WHERE id = $1", [id])).rows[0].status).toBe("requested");
    });

    it("dos pedidos no pueden reservar más de lo disponible", async () => {
      const a = await mkOrder(4), b = await mkOrder(4);
      expect((await setStatus(sup, a, "confirmed")).status).toBe(200);
      expect((await setStatus(sup, b, "confirmed")).status).toBe(409);
      expect(await stock(productA)).toEqual({ stock_on_hand: 5, stock_reserved: 4 });
    });

    it("cancelar libera la reserva y exige motivo; no se cancela un pedido completado", async () => {
      const id = await mkOrder(2);
      await setStatus(sup, id, "confirmed");
      expect((await setStatus(sup, id, "cancelled")).status).toBe(400);
      expect((await setStatus(sup, id, "cancelled", "Cliente desistió")).body.status).toBe("cancelled");
      expect(await stock(productA)).toEqual({ stock_on_hand: 5, stock_reserved: 0 });
      const done = await mkOrder(1);
      await setStatus(sup, done, "confirmed"); await setStatus(sup, done, "completed");
      expect((await setStatus(sup, done, "cancelled", "tarde")).status).toBe(409);
    });
  });

  describe("pagos", () => {
    let orderId = "";
    beforeEach(async () => {
      orderId = (await post(agent, "/orders", { customerId, items: [{ type: "product", id: productA, qty: 1 }] })).body.id; // total 199.90
    });
    const pay = (t: string, amount: number, extra: object = {}) => post(t, "/payments", { orderId, amount, method: "yape", ...extra });

    it("se registra como PENDIENTE y no cuenta como pagado hasta que otra persona lo verifica", async () => {
      const p = await pay(sup, 100);
      expect(p.status).toBe(201);
      expect(p.body.status).toBe("pending");
      expect((await request(app).get(`/api/v1/orders/${orderId}`).set(auth(admin))).body.paymentSummary).toMatchObject({ verified: 0, open: 100, balance: 199.9 });
      expect((await post(sup, `/payments/${p.body.id}/verify`)).body.code).toBe("SELF_VERIFY");
      const ok = await post(admin, `/payments/${p.body.id}/verify`);
      expect(ok.body.status).toBe("verified");
      expect((await request(app).get(`/api/v1/orders/${orderId}`).set(auth(admin))).body.paymentSummary).toMatchObject({ verified: 100, balance: 99.9 });
    });

    it("el trabajador no registra ni verifica pagos (403)", async () => {
      expect((await pay(agent, 10)).status).toBe(403);
      const p = await pay(sup, 10);
      expect((await post(agent, `/payments/${p.body.id}/verify`)).status).toBe(403);
    });

    it("no permite pagar de más ni montos inválidos", async () => {
      expect((await pay(sup, 150)).status).toBe(201);
      expect((await pay(sup, 100)).body.code).toBe("OVERPAYMENT");
      expect((await pay(sup, 0)).status).toBe(400);
      expect((await pay(sup, -5)).status).toBe(400);
    });

    it("rechazar exige motivo y libera el monto; reembolsar solo un pago verificado", async () => {
      const p = await pay(sup, 199.9);
      expect((await post(admin, `/payments/${p.body.id}/reject`, {})).status).toBe(400);
      expect((await post(admin, `/payments/${p.body.id}/reject`, { reason: "Comprobante ilegible" })).body.status).toBe("rejected");
      expect((await pay(sup, 199.9)).status).toBe(201);
      const q2 = (await q("SELECT id FROM payments WHERE status = 'pending'")).rows[0].id;
      expect((await post(admin, `/payments/${q2}/refund`, { reason: "x1" })).status).toBe(409);
    });

    it("un pedido con pagos activos no se puede cancelar", async () => {
      await pay(sup, 50);
      await request(app).patch(`/api/v1/orders/${orderId}/status`).set(auth(sup)).send({ status: "confirmed" });
      const r = await request(app).patch(`/api/v1/orders/${orderId}/status`).set(auth(sup)).send({ status: "cancelled", reason: "Se canceló" });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("HAS_PAYMENTS");
    });
  });

  it("sin autenticación nada es accesible", async () => {
    for (const path of ["/quotes", "/orders", "/payments"]) expect((await request(app).get(`/api/v1${path}`)).status).toBe(401);
  });
});
