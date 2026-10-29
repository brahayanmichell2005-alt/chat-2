import type { AuthUser } from "@crm/shared";
import { getPool } from "../../database/pool.js";

interface UserRow {
  id: string;
  email: string;
  name: string;
  status: string;
  roles: string[];
  permissions: string[];
}

const USER_WITH_ACCESS_SQL = `
  SELECT u.id, u.email, u.name, u.status,
         COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
         COALESCE(array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
  FROM users u
  LEFT JOIN user_roles ur ON ur.user_id = u.id
  LEFT JOIN roles r ON r.id = ur.role_id
  LEFT JOIN role_permissions rp ON rp.role_id = r.id
  LEFT JOIN permissions p ON p.id = rp.permission_id
`;

/** Devuelve el usuario activo con roles y permisos; null si no existe o está desactivado. */
export async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const { rows } = await getPool().query<UserRow>(`${USER_WITH_ACCESS_SQL} WHERE u.id = $1 GROUP BY u.id`, [userId]);
  const row = rows[0];
  if (!row || row.status !== "active") return null;
  return { id: row.id, email: row.email, name: row.name, roles: row.roles, permissions: row.permissions };
}

export interface LoginRow {
  id: string;
  password_hash: string;
  status: string;
  failed_attempts: number;
  locked_until: Date | null;
}

export async function findLoginRow(email: string): Promise<LoginRow | null> {
  const { rows } = await getPool().query<LoginRow>(
    "SELECT id, password_hash, status, failed_attempts, locked_until FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  return rows[0] ?? null;
}

export async function registerFailedLogin(userId: string, maxAttempts: number, lockMinutes: number): Promise<void> {
  await getPool().query(
    `UPDATE users SET
       failed_attempts = failed_attempts + 1,
       locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
     WHERE id = $1`,
    [userId, maxAttempts, lockMinutes],
  );
}

export async function registerSuccessfulLogin(userId: string): Promise<void> {
  await getPool().query(
    "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1",
    [userId],
  );
}

export async function insertRefreshToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
  await getPool().query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [
    userId,
    tokenHash,
    expiresAt,
  ]);
}

export interface RefreshRow {
  id: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export async function findRefreshToken(tokenHash: string): Promise<RefreshRow | null> {
  const { rows } = await getPool().query<RefreshRow>(
    "SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1",
    [tokenHash],
  );
  return rows[0] ?? null;
}

/** Revoca el token solo si seguía vigente; devuelve true si este llamado lo revocó (evita doble rotación concurrente). */
export async function revokeRefreshToken(id: string): Promise<boolean> {
  const r = await getPool().query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await getPool().query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
}
