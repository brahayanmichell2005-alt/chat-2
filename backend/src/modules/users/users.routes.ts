import { Router } from "express";
import { createUserSchema, listQuerySchema, updateUserSchema } from "@crm/shared";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import * as service from "./users.service.js";

export function createUsersRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", requirePermission("users.read"), async (req, res) => {
    const { page, limit } = listQuerySchema.parse(req.query);
    res.json(await service.listUsers(page, limit));
  });

  router.post("/", requirePermission("users.write"), async (req, res) => {
    const input = createUserSchema.parse(req.body);
    res.status(201).json(await service.createUser(input, req));
  });

  router.patch("/:id", requirePermission("users.write"), async (req, res) => {
    const input = updateUserSchema.parse(req.body);
    res.json(await service.updateUser(String(req.params.id), input, req));
  });

  return router;
}
