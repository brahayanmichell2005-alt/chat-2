import dotenv from "dotenv";
dotenv.config({ path: [".env", "../.env"] });

import { passwordSchema } from "@crm/shared";
import { z } from "zod";

const email = z.string().trim().toLowerCase().email().parse(process.env.ADMIN_EMAIL);
const name = (process.env.ADMIN_NAME ?? "Administrador").trim() || "Administrador";
const password = passwordSchema.parse(process.env.ADMIN_PASSWORD);

const { closePool, withTransaction } = await import("../src/database/pool.js");
const { hashPassword } = await import("../src/modules/auth/auth.service.js");

try {
  const hash = await hashPassword(password);
  const created = await withTransaction(async (client) => {
    const exists = await client.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [email]);
    if (exists.rowCount) return false;
    const u = await client.query<{ id: string }>("INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id", [email, name, hash]);
    await client.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'admin'", [u.rows[0]!.id]);
    await client.query("INSERT INTO audit_logs (action, entity_type, entity_id) VALUES ('user.seed_admin', 'user', $1)", [u.rows[0]!.id]);
    return true;
  });
  console.log(created ? `Administrador creado: ${email}` : `Ya existe un usuario con ${email}; no se modificó nada.`);
} catch (e) {
  console.error("No se pudo crear el administrador:", (e as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
