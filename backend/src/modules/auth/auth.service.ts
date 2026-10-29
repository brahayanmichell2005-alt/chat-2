import crypto from "node:crypto";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import type { AuthUser } from "@crm/shared";
import { AppError } from "../../common/errors.js";
import { getEnv } from "../../config/env.js";
import * as repo from "./auth.repository.js";

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

let dummyHash: Promise<string> | undefined;

function signAccessToken(userId: string): string {
  const env = getEnv();
  return jwt.sign({}, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    subject: userId,
    expiresIn: env.ACCESS_TOKEN_TTL_MIN * 60,
    jwtid: crypto.randomUUID(),
  });
}

async function issueSession(userId: string): Promise<{ accessToken: string; refreshToken: string; refreshExpiresAt: Date; user: AuthUser }> {
  const user = await repo.loadAuthUser(userId);
  if (!user) throw new AppError(401, "INVALID_TOKEN", "Sesión inválida o vencida");
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const refreshExpiresAt = new Date(Date.now() + getEnv().REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await repo.insertRefreshToken(userId, hashRefreshToken(refreshToken), refreshExpiresAt);
  return { accessToken: signAccessToken(userId), refreshToken, refreshExpiresAt, user };
}

export async function login(email: string, password: string) {
  const row = await repo.findLoginRow(email);
  if (!row) {
    // Igualar tiempos de respuesta cuando el usuario no existe.
    dummyHash ??= hashPassword("dummy-password-for-timing");
    await argon2.verify(await dummyHash, password).catch(() => false);
    throw new AppError(401, "INVALID_CREDENTIALS", "Credenciales inválidas");
  }
  if (row.locked_until && row.locked_until.getTime() > Date.now()) {
    throw new AppError(429, "ACCOUNT_LOCKED", "Demasiados intentos fallidos. Intente más tarde.");
  }
  const ok = await argon2.verify(row.password_hash, password).catch(() => false);
  if (!ok || row.status !== "active") {
    if (row.status === "active") await repo.registerFailedLogin(row.id, MAX_FAILED_ATTEMPTS, LOCK_MINUTES);
    throw new AppError(401, "INVALID_CREDENTIALS", "Credenciales inválidas");
  }
  await repo.registerSuccessfulLogin(row.id);
  return issueSession(row.id);
}

/** Rotación de refresh token. Si se presenta uno ya revocado se asume robo y se cierran todas las sesiones. */
export async function refresh(token: string | undefined) {
  if (!token) throw new AppError(401, "NO_REFRESH_TOKEN", "Sesión no iniciada");
  const row = await repo.findRefreshToken(hashRefreshToken(token));
  if (!row) throw new AppError(401, "INVALID_TOKEN", "Sesión inválida o vencida");
  if (row.revoked_at) {
    await repo.revokeAllRefreshTokens(row.user_id);
    throw new AppError(401, "INVALID_TOKEN", "Sesión inválida o vencida");
  }
  if (row.expires_at.getTime() <= Date.now()) throw new AppError(401, "INVALID_TOKEN", "Sesión inválida o vencida");
  if (!(await repo.revokeRefreshToken(row.id))) throw new AppError(401, "INVALID_TOKEN", "Sesión inválida o vencida");
  return issueSession(row.user_id);
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  const row = await repo.findRefreshToken(hashRefreshToken(token));
  if (row && !row.revoked_at) await repo.revokeRefreshToken(row.id);
}
