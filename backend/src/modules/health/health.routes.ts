import { Router } from "express";
import { getPool } from "../../database/pool.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";

export function createHealthRouter(): Router {
  const router = Router();

  // Público y mínimo: sin detalles internos.
  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Detalle de integraciones: solo con permiso. (WhatsApp y Ollama se añaden en etapas 4 y 5.)
  router.get("/integrations/health", requireAuth, requirePermission("settings.read"), async (_req, res) => {
    let database: "ok" | "error" = "ok";
    try {
      await getPool().query("SELECT 1");
    } catch {
      database = "error";
    }
    res.json({ database, whatsapp: "not_implemented", ai: "not_implemented" });
  });

  return router;
}
