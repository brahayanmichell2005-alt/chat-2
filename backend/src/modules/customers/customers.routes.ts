import { Router } from "express";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { uuidParam } from "../../common/http.js";
import * as s from "./customers.service.js";

export function createCustomersRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.get("/", requirePermission("customers.read"), async (req, res) => res.json(await s.listCustomers(s.customerListQuery.parse(req.query))));
  r.post("/", requirePermission("customers.write"), async (req, res) => res.status(201).json(await s.createCustomer(s.createCustomerSchema.parse(req.body), req)));
  r.get("/:id", requirePermission("customers.read"), async (req, res) => res.json(await s.getCustomer(uuidParam(req.params.id))));
  r.patch("/:id", requirePermission("customers.write"), async (req, res) => res.json(await s.updateCustomer(String(req.params.id), s.updateCustomerSchema.parse(req.body), req)));
  r.get("/:id/addresses", requirePermission("customers.read"), async (req, res) => res.json(await s.listAddresses(uuidParam(req.params.id))));
  r.post("/:id/addresses", requirePermission("customers.write"), async (req, res) => res.status(201).json(await s.addAddress(uuidParam(req.params.id), s.addressSchema.parse(req.body), req)));
  r.get("/:id/history", requirePermission("customers.read"), async (req, res) => res.json(await s.customerHistory(uuidParam(req.params.id))));
  return r;
}
