import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../../common/audit.js";
import { getPool } from "../../database/pool.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { getManager } from "./whatsapp.service.js";
import { getEnv } from "../../config/env.js";

export function createWhatsAppRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get("/status", requirePermission("whatsapp.read"), async (_req, res) => {
    const row = await getPool().query('SELECT last_connected_at AS "lastConnectedAt", last_error AS "lastError" FROM whatsapp_sessions WHERE id = \'main\'');
    const env = getEnv();
    res.json({ ...getManager().snapshot(), ...row.rows[0], sendMode: env.WHATSAPP_SEND_MODE, allowedNumbers: env.WHATSAPP_ALLOWED_NUMBERS.length });
  });

  r.post("/connect", requirePermission("whatsapp.manage"), async (req, res) => {
    const out = await getManager().connect();
    await writeAudit({ action: "whatsapp.connect", entityType: "whatsapp_session", entityId: "main" }, req);
    res.json(out);
  });

  r.get("/qr", requirePermission("whatsapp.manage"), async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const qr = await getManager().getQrDataUrl();
    res.json({ qr }); // null si no hay QR vigente
  });

  r.post("/disconnect", requirePermission("whatsapp.manage"), async (req, res) => {
    const { logout } = z.object({ logout: z.boolean().optional() }).parse(req.body ?? {});
    const out = await getManager().disconnect(logout ?? false);
    await writeAudit({ action: logout ? "whatsapp.logout" : "whatsapp.disconnect", entityType: "whatsapp_session", entityId: "main" }, req);
    res.json(out);
  });

  r.post("/reconnect", requirePermission("whatsapp.manage"), async (req, res) => {
    const out = await getManager().reconnect();
    await writeAudit({ action: "whatsapp.reconnect", entityType: "whatsapp_session", entityId: "main" }, req);
    res.json(out);
  });
  return r;
}
