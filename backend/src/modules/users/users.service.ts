import type pg from "pg";
import { z } from "zod";
import { createUserSchema, updateUserSchema } from "@crm/shared";
import { writeAudit } from "../../common/audit.js";
import { AppError } from "../../common/errors.js";
import { getPool, withTransaction } from "../../database/pool.js";
import { hashPassword } from "../auth/auth.service.js";
import { revokeAllRefreshTokens } from "../auth/auth.repository.js";
import type { Request } from "express";

type CreateInput = z.infer<typeof createUserSchema>;
type UpdateInput = z.infer<typeof updateUserSchema>;

export interface UserDto {
  id: string;
  email: string;
  name: string;
  status: string;
  roles: string[];
  lastLoginAt: Date | null;
  createdAt: Date;
}

const SELECT_USERS = `
  SELECT u.id, u.email, u.name, u.status, u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt",
         COALESCE(array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
  FROM users u
  LEFT JOIN user_roles ur ON ur.user_id = u.id
  LEFT JOIN roles r ON r.id = ur.role_id
`;

export async function listUsers(page: number, limit: number) {
  const pool = getPool();
  const [{ rows }, count] = await Promise.all([
    pool.query<UserDto>(`${SELECT_USERS} GROUP BY u.id ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`, [limit, (page - 1) * limit]),
    pool.query<{ n: string }>("SELECT count(*) AS n FROM users"),
  ]);
  return { items: rows, page, limit, total: Number(count.rows[0]?.n ?? 0) };
}

async function getUser(id: string, client: pg.PoolClient | pg.Pool = getPool()): Promise<UserDto | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await client.query<UserDto>(`${SELECT_USERS} WHERE u.id = $1 GROUP BY u.id`, [id]);
  return rows[0] ?? null;
}

async function setRoles(client: pg.PoolClient, userId: string, roleCodes: string[]) {
  const { rows } = await client.query<{ id: string }>("SELECT id FROM roles WHERE code = ANY($1)", [roleCodes]);
  if (rows.length !== new Set(roleCodes).size) throw new AppError(400, "UNKNOWN_ROLE", "Rol inexistente");
  await client.query("DELETE FROM user_roles WHERE user_id = $1", [userId]);
  await client.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, unnest($2::uuid[])", [userId, rows.map((r) => r.id)]);
}

async function assertAnotherActiveAdmin(client: pg.PoolClient, excludingUserId: string) {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM users u
     JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE r.code = 'admin' AND u.status = 'active' AND u.id <> $1`,
    [excludingUserId],
  );
  if (Number(rows[0]?.n ?? 0) === 0) throw new AppError(409, "LAST_ADMIN", "Debe existir al menos un administrador activo");
}

export async function createUser(input: CreateInput, req: Request): Promise<UserDto> {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (client) => {
    let id: string;
    try {
      const r = await client.query<{ id: string }>(
        "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id",
        [input.email, input.name, passwordHash],
      );
      id = r.rows[0]!.id;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new AppError(409, "EMAIL_TAKEN", "El correo ya está registrado");
      throw e;
    }
    await setRoles(client, id, input.roleCodes);
    const created = (await getUser(id, client))!;
    await writeAudit({ action: "user.create", entityType: "user", entityId: id, after: { email: created.email, roles: created.roles } }, req, client);
    return created;
  });
}

export async function updateUser(id: string, input: UpdateInput, req: Request): Promise<UserDto> {
  const passwordHash = input.password ? await hashPassword(input.password) : undefined;
  const result = await withTransaction(async (client) => {
    // Bloquea la fila para serializar cambios concurrentes sobre el mismo usuario.
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, "NOT_FOUND", "Usuario no encontrado");
    const lock = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [id]);
    if (lock.rowCount === 0) throw new AppError(404, "NOT_FOUND", "Usuario no encontrado");
    const before = (await getUser(id, client))!;

    const disabling = input.status === "disabled" && before.status === "active";
    const losingAdmin = input.roleCodes !== undefined && before.roles.includes("admin") && !input.roleCodes.includes("admin");
    if (disabling && req.auth?.id === id) throw new AppError(409, "SELF_DISABLE", "No puede desactivar su propia cuenta");
    if ((disabling || losingAdmin) && before.roles.includes("admin") && before.status === "active") {
      await assertAnotherActiveAdmin(client, id);
    }

    const sets: string[] = [];
    const params: unknown[] = [id];
    if (input.name !== undefined) { params.push(input.name); sets.push(`name = $${params.length}`); }
    if (input.status !== undefined) { params.push(input.status); sets.push(`status = $${params.length}`); }
    if (passwordHash) { params.push(passwordHash); sets.push(`password_hash = $${params.length}`); }
    if (sets.length > 0) await client.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1`, params);
    if (input.roleCodes) await setRoles(client, id, input.roleCodes);

    const after = (await getUser(id, client))!;
    await writeAudit(
      {
        action: "user.update",
        entityType: "user",
        entityId: id,
        before: { name: before.name, status: before.status, roles: before.roles },
        after: { name: after.name, status: after.status, roles: after.roles, passwordChanged: Boolean(passwordHash) },
      },
      req,
      client,
    );
    return { after, revoke: disabling || Boolean(passwordHash) };
  });
  if (result.revoke) await revokeAllRefreshTokens(id);
  return result.after;
}
