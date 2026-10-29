import type pg from "pg";
import { getPool } from "../../database/pool.js";

type Db = pg.Pool | pg.PoolClient;

/** Crea un aviso para cada usuario activo que tenga alguno de los permisos indicados. */
export async function notifyByPermission(permissions: string[], type: string, payload: Record<string, unknown>, db: Db = getPool()) {
  await db.query(
    `INSERT INTO notification_events (user_id, type, payload)
     SELECT DISTINCT u.id, $2, $3::jsonb FROM users u
     JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE u.status = 'active' AND p.code = ANY($1)`,
    [permissions, type, JSON.stringify(payload)],
  );
}

export async function notifyUser(userId: string, type: string, payload: Record<string, unknown>, db: Db = getPool()) {
  await db.query("INSERT INTO notification_events (user_id, type, payload) SELECT id, $2, $3::jsonb FROM users WHERE id = $1 AND status = 'active'", [userId, type, JSON.stringify(payload)]);
}

export async function listNotifications(userId: string, unreadOnly: boolean) {
  const { rows } = await getPool().query(
    `SELECT id, type, payload, read_at AS "readAt", created_at AS "createdAt" FROM notification_events
     WHERE user_id = $1 ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT 50`, [userId]);
  const unread = await getPool().query<{ n: string }>("SELECT count(*) AS n FROM notification_events WHERE user_id = $1 AND read_at IS NULL", [userId]);
  return { items: rows, unread: Number(unread.rows[0]?.n ?? 0) };
}

export async function markAllRead(userId: string) {
  await getPool().query("UPDATE notification_events SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [userId]);
}
