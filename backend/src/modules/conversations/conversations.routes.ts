import { Router } from "express";
import { uuidParam } from "../../common/http.js";
import { requireAnyPermission, requireAuth, requirePermission } from "../../middleware/auth.js";
import { z } from "zod";
import { enqueueHumanMessage } from "../whatsapp/outbox.service.js";
import * as s from "./conversations.service.js";
import * as h from "./handoff.service.js";

export function createConversationsRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  const view = requireAnyPermission("conversations.read_all", "conversations.read_assigned");

  r.get("/tags", view, async (_req, res) => res.json(await s.listTags()));
  r.post("/tags", requirePermission("settings.write"), async (req, res) => res.status(201).json(await s.createTag(s.tagCreateSchema.parse(req.body), req)));

  r.get("/", view, async (req, res) => res.json(await s.listConversations(s.listQuery.parse(req.query), req.auth!)));
  r.post("/", requirePermission("customers.write"), view, async (req, res) => res.status(201).json(await s.createConversation(s.createSchema.parse(req.body), req.auth!, req)));
  r.get("/:id", view, async (req, res) => res.json(await s.getConversationDetail(uuidParam(req.params.id), req.auth!)));
  r.get("/:id/messages", view, async (req, res) => res.json(await s.listMessages(uuidParam(req.params.id), s.messagesQuery.parse(req.query), req.auth!)));
  r.post("/:id/assign", requirePermission("conversations.assign"), async (req, res) => res.json(await s.assignConversation(uuidParam(req.params.id), s.assignSchema.parse(req.body).userId, req.auth!, req)));
  r.patch("/:id/status", requirePermission("conversations.reply"), view, async (req, res) => res.json(await s.updateConversation(uuidParam(req.params.id), s.updateSchema.parse(req.body), req.auth!, req)));
  r.post("/:id/notes", requirePermission("conversations.reply"), view, async (req, res) => res.status(201).json(await s.addNote(uuidParam(req.params.id), s.noteSchema.parse(req.body).body, req.auth!, req)));
  r.put("/:id/tags", requirePermission("conversations.reply"), view, async (req, res) => res.json(await s.setTags(uuidParam(req.params.id), s.tagsSchema.parse(req.body).tagIds, req.auth!, req)));
  r.post("/:id/handoff", requirePermission("conversations.reply"), view, async (req, res) =>
    res.json(await h.requestHandoff(uuidParam(req.params.id), z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body).reason, req.auth!, req)));
  r.post("/:id/resume-ai", requirePermission("conversations.reply"), view, async (req, res) => res.json(await h.resumeAi(uuidParam(req.params.id), req.auth!, req)));
  r.post("/:id/messages", requirePermission("conversations.reply"), view, async (req, res) => {
    const body = z.object({ text: z.string().trim().min(1).max(4000), idempotencyKey: z.string().trim().min(8).max(100).optional() }).parse(req.body);
    res.status(202).json(await enqueueHumanMessage(uuidParam(req.params.id), body.text, req.auth!, req, body.idempotencyKey));
  });
  return r;
}
