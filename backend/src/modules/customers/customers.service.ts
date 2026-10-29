import type { Request } from "express";
import type pg from "pg";
import { z } from "zod";
import { writeAudit } from "../../common/audit.js";
import { AppError } from "../../common/errors.js";
import { likePattern, uuidParam } from "../../common/http.js";
import { normalizePhone } from "../../common/phone.js";
import { getPool, withTransaction } from "../../database/pool.js";

export const createCustomerSchema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  phone: z.string().trim().min(6).max(30).optional(),
  allowDuplicate: z.boolean().optional(),
});
export const updateCustomerSchema = z
  .object({
    name: z.string().trim().min(2).max(160).optional(),
    email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Sin cambios" });
export const addressSchema = z.object({
  label: z.string().trim().max(60).optional(),
  address: z.string().trim().min(3).max(300),
  reference: z.string().trim().max(300).optional(),
});
export const customerListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const SELECT = `
  SELECT c.id, c.name, c.email, c.status, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
         COALESCE(array_agg(DISTINCT ct.phone_e164) FILTER (WHERE ct.phone_e164 IS NOT NULL), '{}') AS phones
  FROM customers c LEFT JOIN contacts ct ON ct.customer_id = c.id`;

export async function listCustomers(q: z.infer<typeof customerListQuery>) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) { params.push(q.status); where.push(`c.status = $${params.length}`); }
  if (q.q) {
    params.push(likePattern(q.q));
    const p = `$${params.length}`;
    where.push(`(c.name ILIKE ${p} OR c.email ILIKE ${p} OR EXISTS (SELECT 1 FROM contacts x WHERE x.customer_id = c.id AND x.phone_e164 LIKE ${p}))`);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM customers c ${w}`, params);
  params.push(q.limit, (q.page - 1) * q.limit);
  const { rows } = await getPool().query(
    `${SELECT} ${w} GROUP BY c.id ORDER BY c.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows, page: q.page, limit: q.limit, total: Number(total.rows[0]?.n ?? 0) };
}

export async function getCustomer(id: string, client: pg.Pool | pg.PoolClient = getPool()) {
  const { rows } = await client.query(`${SELECT} WHERE c.id = $1 GROUP BY c.id`, [uuidParam(id)]);
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Cliente no encontrado");
  return rows[0];
}

/** Clientes que podrían ser el mismo (mismo teléfono o mismo correo). */
export async function findDuplicates(phone: string | null, email: string | undefined, client: pg.Pool | pg.PoolClient = getPool()) {
  const { rows } = await client.query(
    `SELECT DISTINCT c.id, c.name, c.email FROM customers c
     LEFT JOIN contacts ct ON ct.customer_id = c.id
     WHERE ($1::text IS NOT NULL AND ct.phone_e164 = $1) OR ($2::text IS NOT NULL AND lower(c.email) = lower($2))`,
    [phone, email ?? null],
  );
  return rows;
}

export async function createCustomer(input: z.infer<typeof createCustomerSchema>, req: Request) {
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (input.phone && !phone) throw new AppError(400, "INVALID_PHONE", "Teléfono inválido");
  return withTransaction(async (client) => {
    if (!input.allowDuplicate) {
      const dups = await findDuplicates(phone, input.email, client);
      if (dups.length) throw new AppError(409, "DUPLICATE_CUSTOMER", "Ya existe un cliente con ese teléfono o correo", { matches: dups });
    }
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO customers (name, email, created_by) VALUES ($1, $2, $3) RETURNING id",
      [input.name, input.email ?? null, req.auth?.id ?? null],
    );
    const id = rows[0]!.id;
    if (phone) {
      // Si el contacto ya existe (p. ej. por una conversación) sin cliente, se vincula; si ya tiene otro cliente, es duplicado.
      const existing = await client.query<{ id: string; customer_id: string | null }>("SELECT id, customer_id FROM contacts WHERE phone_e164 = $1 FOR UPDATE", [phone]);
      if (existing.rows[0]) {
        if (existing.rows[0].customer_id) throw new AppError(409, "DUPLICATE_CUSTOMER", "Ese teléfono ya pertenece a otro cliente");
        await client.query("UPDATE contacts SET customer_id = $1 WHERE id = $2", [id, existing.rows[0].id]);
        await client.query("UPDATE conversations SET customer_id = $1 WHERE contact_id = $2 AND customer_id IS NULL", [id, existing.rows[0].id]);
      } else {
        await client.query("INSERT INTO contacts (phone_e164, display_name, customer_id) VALUES ($1, $2, $3)", [phone, input.name, id]);
      }
    }
    await writeAudit({ action: "customer.create", entityType: "customer", entityId: id, after: { name: input.name } }, req, client);
    return getCustomer(id, client);
  });
}

export async function updateCustomer(id: string, input: z.infer<typeof updateCustomerSchema>, req: Request) {
  uuidParam(id);
  return withTransaction(async (client) => {
    const before = await getCustomer(id, client);
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [col, val] of Object.entries(input)) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    await client.query(`UPDATE customers SET ${sets.join(", ")} WHERE id = $1`, params);
    const after = await getCustomer(id, client);
    await writeAudit({ action: "customer.update", entityType: "customer", entityId: id, before: { name: before.name, email: before.email, status: before.status }, after: { name: after.name, email: after.email, status: after.status } }, req, client);
    return after;
  });
}

export async function listAddresses(customerId: string) {
  await getCustomer(customerId);
  const { rows } = await getPool().query("SELECT id, label, address, reference, created_at AS \"createdAt\" FROM customer_addresses WHERE customer_id = $1 ORDER BY created_at", [customerId]);
  return { items: rows };
}

export async function addAddress(customerId: string, input: z.infer<typeof addressSchema>, req: Request) {
  await getCustomer(customerId);
  const { rows } = await getPool().query(
    "INSERT INTO customer_addresses (customer_id, label, address, reference) VALUES ($1, $2, $3, $4) RETURNING id, label, address, reference",
    [customerId, input.label ?? null, input.address, input.reference ?? null],
  );
  await writeAudit({ action: "customer.address_add", entityType: "customer", entityId: customerId }, req);
  return rows[0];
}

/** Historial del cliente. En la Etapa 3 incluye conversaciones; cotizaciones, pedidos y casos se suman en la Etapa 6. */
export async function customerHistory(customerId: string) {
  await getCustomer(customerId);
  const { rows } = await getPool().query(
    `SELECT id, status, priority, last_message_at AS "lastMessageAt", created_at AS "createdAt"
     FROM conversations WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [customerId],
  );
  return { conversations: rows };
}
