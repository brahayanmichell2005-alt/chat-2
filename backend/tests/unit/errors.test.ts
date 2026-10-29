import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/db";
process.env.JWT_ACCESS_SECRET = "x".repeat(32);
process.env.LOG_LEVEL = "silent";
const { AppError, errorHandler } = await import("../../src/common/errors.js");

function fakeRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn((b: unknown) => { res.body = b; return res; });
  return res;
}

describe("errorHandler", () => {
  it("convierte errores de Zod en 400 con detalle", () => {
    const res = fakeRes();
    const parsed = z.object({ a: z.string() }).safeParse({});
    errorHandler((parsed as any).error, { id: "c1" } as any, res, vi.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.correlationId).toBe("c1");
  });

  it("respeta AppError", () => {
    const res = fakeRes();
    errorHandler(new AppError(409, "X", "msg"), { id: "c2" } as any, res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("X");
  });

  it("no filtra detalles de errores desconocidos (500)", () => {
    const res = fakeRes();
    errorHandler(new Error("secreto interno: password=abc"), { id: "c3" } as any, res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secreto");
  });
});
