import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import type { AuthUser } from "@crm/shared";
import { AppError } from "../common/errors.js";
import { getEnv } from "../config/env.js";
import { loadAuthUser } from "../modules/auth/auth.repository.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthUser;
    }
  }
}

/** Valida el access token (Bearer) y carga usuario, roles y permisos desde la BD en cada solicitud. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) throw new AppError(401, "UNAUTHENTICATED", "Autenticación requerida");
  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(header.slice(7), getEnv().JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
    if (typeof decoded === "string") throw new Error("payload inválido");
    payload = decoded;
  } catch {
    throw new AppError(401, "INVALID_TOKEN", "Sesión inválida o vencida");
  }
  const user = payload.sub ? await loadAuthUser(payload.sub) : null;
  if (!user) throw new AppError(401, "INVALID_TOKEN", "Sesión inválida o vencida");
  req.auth = user;
  next();
};

/** Exige que el usuario autenticado tenga TODOS los permisos indicados. */
export function requirePermission(...codes: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Autenticación requerida");
    const missing = codes.filter((c) => !req.auth!.permissions.includes(c));
    if (missing.length > 0) throw new AppError(403, "FORBIDDEN", "No tiene permisos para esta acción");
    next();
  };
}

/** Exige al menos UNO de los permisos indicados. */
export function requireAnyPermission(...codes: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Autenticación requerida");
    if (!codes.some((c) => req.auth!.permissions.includes(c))) throw new AppError(403, "FORBIDDEN", "No tiene permisos para esta acción");
    next();
  };
}

/** Defensa CSRF para endpoints que usan cookie (refresh/logout): exige cabecera personalizada. */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (req.header("x-requested-with") !== "crm") throw new AppError(403, "CSRF", "Solicitud no permitida");
  next();
};
