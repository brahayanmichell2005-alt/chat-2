import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../../common/audit.js";
import { getPool } from "../../database/pool.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";

const str = z.string().trim().max(2000);
// Solo claves conocidas. Todo es opcional: la información de la empresa la define el administrador.
const company = z.object({ name: str, phone: str, address: str, hours: str, coverage: str }).partial().strict();
const policies = z.object({ warranty: str, payment: str, delivery: str }).partial().strict();
const patchSchema = z.object({ company: company.optional(), policies: policies.optional() }).strict()
  .refine((v) => v.company !== undefined || v.policies !== undefined, { message: "Sin cambios" });

async function readAll() {
  const { rows } = await getPool().query<{ key: string; value: Record<string, string> }>("SELECT key, value FROM system_settings WHERE key IN ('company', 'policies')");
  const out: Record<string, Record<string, string>> = { company: {}, policies: {} };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function createSettingsRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.get("/", requirePermission("settings.read"), async (_req, res) => res.json(await readAll()));
  r.patch("/", requirePermission("settings.write"), async (req, res) => {
    const body = patchSchema.parse(req.body);
    const before = await readAll();
    for (const key of ["company", "policies"] as const) {
      const patch = body[key];
      if (!patch) continue;
      const merged = { ...before[key], ...patch };
      await getPool().query(
        `INSERT INTO system_settings (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = system_settings.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(merged), req.auth!.id],
      );
    }
    const after = await readAll();
    await writeAudit({ action: "settings.update", entityType: "system_settings", before, after }, req);
    res.json(after);
  });
  return r;
}
