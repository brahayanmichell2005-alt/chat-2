import { Router } from "express";
import { uuidParam } from "../../common/http.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import * as o from "./orders.service.js";
import * as p from "./payments.service.js";
import * as q from "./quotes.service.js";

export function createQuotesRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.get("/", requirePermission("quotes.read"), async (req, res) => res.json(await q.listQuotes(q.quoteListQuery.parse(req.query))));
  r.post("/", requirePermission("quotes.write"), async (req, res) => res.status(201).json(await q.createQuote(q.quoteCreateSchema.parse(req.body), req.auth!, req)));
  r.get("/:id", requirePermission("quotes.read"), async (req, res) => res.json(await q.getQuote(uuidParam(req.params.id))));
  r.patch("/:id", requirePermission("quotes.write"), async (req, res) => res.json(await q.updateQuote(uuidParam(req.params.id), q.quoteCreateSchema.parse(req.body), req.auth!, req)));
  r.get("/:id/preview", requirePermission("quotes.read"), async (req, res) => res.json(await q.previewQuote(uuidParam(req.params.id))));
  r.post("/:id/submit", requirePermission("quotes.write"), async (req, res) => res.json(await q.submitQuote(uuidParam(req.params.id), req.auth!, req)));
  r.post("/:id/send", requirePermission("quotes.write", "conversations.reply"), async (req, res) => res.json(await q.sendQuote(uuidParam(req.params.id), req.auth!, req)));
  r.post("/:id/accept", requirePermission("quotes.write"), async (req, res) => res.json(await q.acceptQuote(uuidParam(req.params.id), req.auth!, req)));
  r.post("/:id/reject", requirePermission("quotes.write"), async (req, res) => res.json(await q.rejectQuote(uuidParam(req.params.id), q.reasonSchema.parse(req.body).reason, req.auth!, req)));
  r.post("/:id/convert-to-order", requirePermission("orders.write"), async (req, res) => res.json(await q.convertQuote(uuidParam(req.params.id), q.convertSchema.parse(req.body ?? {}).deliveryTerms, req.auth!, req)));
  return r;
}

export function createOrdersRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.get("/", requirePermission("orders.read"), async (req, res) => res.json(await o.listOrders(o.orderListQuery.parse(req.query))));
  r.post("/", requirePermission("orders.write"), async (req, res) => res.status(201).json(await o.createOrder(o.orderCreateSchema.parse(req.body), req.auth!, req)));
  r.get("/:id", requirePermission("orders.read"), async (req, res) => res.json(await o.getOrder(uuidParam(req.params.id))));
  r.patch("/:id/status", requirePermission("orders.confirm"), async (req, res) => res.json(await o.changeOrderStatus(uuidParam(req.params.id), o.orderStatusSchema.parse(req.body), req.auth!, req)));
  return r;
}

export function createPaymentsRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.get("/", requirePermission("payments.read"), async (req, res) => res.json(await p.listPayments(p.paymentListQuery.parse(req.query))));
  r.post("/", requirePermission("payments.write"), async (req, res) => res.status(201).json(await p.createPayment(p.paymentCreateSchema.parse(req.body), req.auth!, req)));
  r.post("/:id/review", requirePermission("payments.write"), async (req, res) => res.json(await p.reviewPayment(uuidParam(req.params.id), req.auth!, req)));
  r.post("/:id/verify", requirePermission("payments.verify"), async (req, res) => res.json(await p.verifyPayment(uuidParam(req.params.id), req.auth!, req)));
  r.post("/:id/reject", requirePermission("payments.verify"), async (req, res) => res.json(await p.rejectPayment(uuidParam(req.params.id), p.paymentReasonSchema.parse(req.body).reason, req.auth!, req)));
  r.post("/:id/refund", requirePermission("payments.verify"), async (req, res) => res.json(await p.refundPayment(uuidParam(req.params.id), p.paymentReasonSchema.parse(req.body).reason, req.auth!, req)));
  return r;
}
