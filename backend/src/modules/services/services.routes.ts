import { Router } from "express";
import { uuidParam } from "../../common/http.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import * as s from "./services.service.js";

export function createServicesRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.get("/categories", requirePermission("catalog.read"), async (_req, res) => res.json(await s.listServiceCategories()));
  r.get("/", requirePermission("catalog.read"), async (req, res) => res.json(await s.listServices(s.serviceListQuery.parse(req.query))));
  r.post("/", requirePermission("catalog.write"), async (req, res) => res.status(201).json(await s.createService(s.serviceCreateSchema.parse(req.body), req)));
  r.get("/:id", requirePermission("catalog.read"), async (req, res) => res.json(await s.getService(uuidParam(req.params.id))));
  r.patch("/:id", requirePermission("catalog.write"), async (req, res) => res.json(await s.updateService(String(req.params.id), s.serviceUpdateSchema.parse(req.body), req)));
  return r;
}
