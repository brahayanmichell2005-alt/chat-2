import type { Request } from "express";
import type pg from "pg";
import { getPool } from "../database/pool.js";

export interface AuditEntry {
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

export async function writeAudit(entry: AuditEntry, req?: Request, client?: pg.PoolClient): Promise<void> {
  const db = client ?? getPool();
  await db.query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, before_data, after_data, ip, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.userId ?? req?.auth?.id ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      req?.ip ?? null,
      req ? String(req.id ?? "") : null,
    ],
  );
}
