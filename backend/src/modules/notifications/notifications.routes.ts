import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import * as s from "./notifications.service.js";

export function createNotificationsRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.get("/", async (req, res) => res.json(await s.listNotifications(req.auth!.id, req.query.unread === "true")));
  r.post("/read-all", async (req, res) => { await s.markAllRead(req.auth!.id); res.status(204).end(); });
  return r;
}
