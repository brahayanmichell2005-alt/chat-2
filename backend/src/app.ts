import crypto from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { errorHandler, notFoundHandler } from "./common/errors.js";
import { getLogger } from "./common/logger.js";
import { getEnv } from "./config/env.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import { createOrdersRouter, createPaymentsRouter, createQuotesRouter } from "./modules/sales/sales.routes.js";
import { createAiRouter } from "./modules/ai/ai.routes.js";
import { createCatalogRouter } from "./modules/catalog/catalog.routes.js";
import { createConversationsRouter } from "./modules/conversations/conversations.routes.js";
import { createCustomersRouter } from "./modules/customers/customers.routes.js";
import { createServicesRouter } from "./modules/services/services.routes.js";
import { createSettingsRouter } from "./modules/settings/settings.routes.js";
import { createNotificationsRouter } from "./modules/notifications/notifications.routes.js";
import { createWhatsAppRouter } from "./modules/whatsapp/whatsapp.routes.js";
import { createHealthRouter } from "./modules/health/health.routes.js";
import { createRolesRouter } from "./modules/roles/roles.routes.js";
import { createUsersRouter } from "./modules/users/users.routes.js";

export function createApp() {
  const env = getEnv();
  const app = express();
  app.disable("x-powered-by");
  if (env.TRUST_PROXY > 0) app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger: getLogger(),
      genReqId: (req, res) => {
        const id = String(req.headers["x-correlation-id"] ?? "").slice(0, 64) || crypto.randomUUID();
        res.setHeader("x-correlation-id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/api/v1/health" },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true, methods: ["GET", "POST", "PATCH", "DELETE"] }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  const api = express.Router();
  api.use(createHealthRouter());
  api.use("/auth", createAuthRouter());
  api.use("/users", createUsersRouter());
  api.use("/roles", createRolesRouter());
  api.use("/customers", createCustomersRouter());
  api.use("/catalog", createCatalogRouter());
  api.use("/services", createServicesRouter());
  api.use("/conversations", createConversationsRouter());
  api.use("/settings", createSettingsRouter());
  api.use("/whatsapp", createWhatsAppRouter());
  api.use("/ai", createAiRouter());
  api.use("/quotes", createQuotesRouter());
  api.use("/orders", createOrdersRouter());
  api.use("/payments", createPaymentsRouter());
  api.use("/notifications", createNotificationsRouter());
  app.use("/api/v1", api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
