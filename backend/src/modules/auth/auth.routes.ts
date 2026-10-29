import { Router, type Response } from "express";
import rateLimit from "express-rate-limit";
import { loginSchema } from "@crm/shared";
import { writeAudit } from "../../common/audit.js";
import { AppError } from "../../common/errors.js";
import { getEnv } from "../../config/env.js";
import { requireAuth, requireCsrfHeader } from "../../middleware/auth.js";
import * as service from "./auth.service.js";

const COOKIE_NAME = "refresh_token";
const COOKIE_PATH = "/api/v1/auth";

function setRefreshCookie(res: Response, token: string, expires: Date) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: getEnv().COOKIE_SECURE,
    sameSite: "strict",
    path: COOKIE_PATH,
    expires,
  });
}

export function createAuthRouter(): Router {
  const router = Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, "RATE_LIMITED", "Demasiadas solicitudes. Intente más tarde.")),
  });

  router.post("/login", loginLimiter, async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    try {
      const s = await service.login(email, password);
      setRefreshCookie(res, s.refreshToken, s.refreshExpiresAt);
      await writeAudit({ userId: s.user.id, action: "auth.login", entityType: "user", entityId: s.user.id }, req);
      res.json({ accessToken: s.accessToken, user: s.user });
    } catch (e) {
      if (e instanceof AppError && e.code === "INVALID_CREDENTIALS") {
        await writeAudit({ action: "auth.login_failed", entityType: "user", after: { email } }, req);
      }
      throw e;
    }
  });

  router.post("/refresh", requireCsrfHeader, async (req, res) => {
    try {
      const s = await service.refresh(req.cookies?.[COOKIE_NAME]);
      setRefreshCookie(res, s.refreshToken, s.refreshExpiresAt);
      res.json({ accessToken: s.accessToken, user: s.user });
    } catch (e) {
      res.clearCookie(COOKIE_NAME, { path: COOKIE_PATH });
      throw e;
    }
  });

  router.post("/logout", requireCsrfHeader, async (req, res) => {
    await service.logout(req.cookies?.[COOKIE_NAME]);
    res.clearCookie(COOKIE_NAME, { path: COOKIE_PATH });
    res.status(204).end();
  });

  router.get("/me", requireAuth, (req, res) => {
    res.json({ user: req.auth });
  });

  return router;
}
