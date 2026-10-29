import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";

const valid = {
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
  JWT_ACCESS_SECRET: "x".repeat(32),
};

describe("loadEnv", () => {
  it("acepta una configuración mínima válida y aplica valores por defecto", () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.APP_TIMEZONE).toBe("America/Lima");
    expect(env.COOKIE_SECURE).toBe(false);
  });

  it("falla con mensaje claro si falta DATABASE_URL", () => {
    expect(() => loadEnv({ JWT_ACCESS_SECRET: "x".repeat(32) })).toThrow(/DATABASE_URL/);
  });

  it("rechaza un secreto JWT corto", () => {
    expect(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: "corto" })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it("en producción activa cookies seguras por defecto y rechaza desactivarlas", () => {
    expect(loadEnv({ ...valid, NODE_ENV: "production" }).COOKIE_SECURE).toBe(true);
    expect(() => loadEnv({ ...valid, NODE_ENV: "production", COOKIE_SECURE: "false" })).toThrow(/COOKIE_SECURE/);
  });
});
