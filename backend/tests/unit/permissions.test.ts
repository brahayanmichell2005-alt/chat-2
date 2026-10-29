import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@crm/shared";
import { AppError } from "../../src/common/errors.js";

vi.mock("../../src/modules/auth/auth.repository.js", () => ({ loadAuthUser: vi.fn() }));
const { requirePermission, requireCsrfHeader } = await import("../../src/middleware/auth.js");

function run(mw: (req: any, res: any, next: any) => unknown, req: any) {
  let error: unknown;
  try {
    mw(req, {}, (e?: unknown) => { error = e; });
  } catch (e) {
    error = e;
  }
  return error as AppError | undefined;
}

describe("requirePermission", () => {
  it("rechaza sin autenticación (401)", () => {
    expect(run(requirePermission("users.read"), {})?.status).toBe(401);
  });
  it("rechaza si falta el permiso (403)", () => {
    const req = { auth: { permissions: ["catalog.read"] } };
    expect(run(requirePermission("catalog.write"), req)?.status).toBe(403);
  });
  it("permite con el permiso", () => {
    const req = { auth: { permissions: ["catalog.write"] } };
    expect(run(requirePermission("catalog.write"), req)).toBeUndefined();
  });
});

describe("requireCsrfHeader", () => {
  it("exige la cabecera X-Requested-With: crm", () => {
    expect(run(requireCsrfHeader, { header: () => undefined })?.status).toBe(403);
    expect(run(requireCsrfHeader, { header: () => "crm" })).toBeUndefined();
  });
});

describe("semilla RBAC", () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
  const sql = fs.readFileSync(path.join(dir, "002_seed_rbac.sql"), "utf8");
  const seeded: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of text.matchAll(/INSERT INTO permissions \(code\) VALUES([\s\S]*?)(?:ON CONFLICT|;)/g)) {
      for (const c of m[1]!.matchAll(/\('([a-z_.]+)'\)/g)) seeded.push(c[1]!);
    }
  }

  it("los permisos sembrados por las migraciones coinciden con los de @crm/shared", () => {
    expect([...seeded].sort()).toEqual([...PERMISSIONS].sort());
  });

  it("el rol agent no recibe permisos de administración ni de decisión", () => {
    const agentBlock = sql.split("-- agent")[1]!;
    for (const forbidden of ["users.write", "catalog.write", "payments.verify", "warranties.decide", "settings.write"]) {
      expect(agentBlock).not.toContain(`'${forbidden}'`);
    }
  });
});
