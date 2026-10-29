import { Router } from "express";
import { getPool } from "../../database/pool.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";

export function createRolesRouter(): Router {
  const router = Router();
  router.get("/", requireAuth, requirePermission("roles.read"), async (_req, res) => {
    const { rows } = await getPool().query(
      `SELECT r.code, r.name,
              COALESCE(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       GROUP BY r.id ORDER BY r.code`,
    );
    res.json({ items: rows });
  });
  return router;
}
