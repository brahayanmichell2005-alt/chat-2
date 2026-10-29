// Requiere PostgreSQL real. Se omite si TEST_DATABASE_URL no está definida.
// ATENCIÓN: vacía las tablas de identidad de la base indicada. Use una base exclusiva de pruebas.
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("auth + permisos (integración)", () => {
  let app: any;
  let db: typeof import("../../src/database/pool.js");
  const ADMIN = { email: "admin@test.local", password: "ClaveSegura#2024" };
  const AGENT = { email: "agente@test.local", password: "OtraClave#2024x" };

  beforeAll(async () => {
    process.env.DATABASE_URL = url!;
    process.env.JWT_ACCESS_SECRET = "t".repeat(40);
    process.env.LOG_LEVEL = "silent";
    process.env.NODE_ENV = "test";
    db = await import("../../src/database/pool.js");
    await (await import("../../src/database/migrate.js")).runMigrations(() => undefined);
    app = (await import("../../src/app.js")).createApp();
  });

  beforeEach(async () => {
    const pool = db.getPool();
    await pool.query("DELETE FROM refresh_tokens");
    await pool.query("DELETE FROM user_roles");
    await pool.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update");
    await pool.query("DELETE FROM audit_logs");
    await pool.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update");
    await pool.query("DELETE FROM users");
    const { hashPassword } = await import("../../src/modules/auth/auth.service.js");
    for (const [u, role] of [[ADMIN, "admin"], [AGENT, "agent"]] as const) {
      const r = await pool.query("INSERT INTO users (email, name, password_hash) VALUES ($1, $1, $2) RETURNING id", [u.email, await hashPassword(u.password)]);
      await pool.query("INSERT INTO user_roles SELECT $1, id FROM roles WHERE code = $2", [r.rows[0].id, role]);
    }
  });

  afterAll(async () => { await db?.closePool(); });

  const login = (u: { email: string; password: string }) => request(app).post("/api/v1/auth/login").send(u);

  it("login válido devuelve token, usuario y cookie httpOnly", async () => {
    const res = await login(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.headers["set-cookie"]?.[0]).toMatch(/HttpOnly/i);
  });

  it("contraseña incorrecta no permite acceso y no distingue usuario inexistente", async () => {
    const bad = await login({ ...ADMIN, password: "incorrecta-123456" });
    const ghost = await login({ email: "nadie@test.local", password: "incorrecta-123456" });
    expect(bad.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(bad.body.code).toBe(ghost.body.code);
  });

  it("bloquea la cuenta tras varios intentos fallidos", async () => {
    for (let i = 0; i < 5; i++) await login({ ...AGENT, password: "incorrecta-123456" });
    const res = await login(AGENT);
    expect(res.status).toBe(429);
  });

  it("rutas protegidas rechazan sin token y con token inválido", async () => {
    expect((await request(app).get("/api/v1/users")).status).toBe(401);
    expect((await request(app).get("/api/v1/users").set("Authorization", "Bearer abc")).status).toBe(401);
  });

  it("un trabajador no puede crear usuarios (403) y un admin sí (201)", async () => {
    const agent = (await login(AGENT)).body.accessToken;
    const admin = (await login(ADMIN)).body.accessToken;
    const body = { email: "nuevo@test.local", name: "Nuevo", password: "ClaveNueva#2024", roleCodes: ["agent"] };
    expect((await request(app).post("/api/v1/users").set("Authorization", `Bearer ${agent}`).send(body)).status).toBe(403);
    const ok = await request(app).post("/api/v1/users").set("Authorization", `Bearer ${admin}`).send(body);
    expect(ok.status).toBe(201);
    expect(JSON.stringify(ok.body)).not.toContain("password");
  });

  it("refresh rota el token y el anterior deja de servir", async () => {
    const first = await login(ADMIN);
    const cookie = first.headers["set-cookie"]![0]!.split(";")[0]!;
    const r1 = await request(app).post("/api/v1/auth/refresh").set("X-Requested-With", "crm").set("Cookie", cookie);
    expect(r1.status).toBe(200);
    const r2 = await request(app).post("/api/v1/auth/refresh").set("X-Requested-With", "crm").set("Cookie", cookie);
    expect(r2.status).toBe(401);
  });

  it("refresh sin cabecera CSRF es rechazado", async () => {
    const first = await login(ADMIN);
    const cookie = first.headers["set-cookie"]![0]!.split(";")[0]!;
    expect((await request(app).post("/api/v1/auth/refresh").set("Cookie", cookie)).status).toBe(403);
  });

  it("un usuario desactivado pierde el acceso de inmediato", async () => {
    const admin = (await login(ADMIN)).body.accessToken;
    const agentLogin = await login(AGENT);
    const id = agentLogin.body.user.id;
    await request(app).patch(`/api/v1/users/${id}`).set("Authorization", `Bearer ${admin}`).send({ status: "disabled" });
    expect((await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${agentLogin.body.accessToken}`)).status).toBe(401);
  });

  it("no permite desactivar al último administrador activo", async () => {
    const admin = await login(ADMIN);
    const res = await request(app).patch(`/api/v1/users/${admin.body.user.id}`).set("Authorization", `Bearer ${admin.body.accessToken}`).send({ status: "disabled" });
    expect(res.status).toBe(409);
  });
});
