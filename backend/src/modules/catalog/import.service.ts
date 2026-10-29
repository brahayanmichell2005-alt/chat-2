import type { Request } from "express";
import { writeAudit } from "../../common/audit.js";
import { AppError } from "../../common/errors.js";
import { uuidParam } from "../../common/http.js";
import { getPool, withTransaction } from "../../database/pool.js";
import { readRawRows, validateRows, type ProductRow } from "./import.parser.js";

export type ImportMode = "insert_only" | "upsert";
interface PlanItem { row: number; action: "create" | "update"; productId?: string; data: ProductRow; categoryId: string }

/** Analiza el archivo y guarda una vista previa. NO modifica productos ni inventario. */
export async function previewImport(buffer: Buffer, filename: string, mode: ImportMode, req: Request) {
  let raw;
  try {
    raw = await readRawRows(buffer, filename);
  } catch (e) {
    throw new AppError(400, "INVALID_FILE", (e as Error).message);
  }
  const pool = getPool();
  const cats = await pool.query<{ id: string; name: string }>("SELECT id, name FROM product_categories WHERE active");
  const catByName = new Map(cats.rows.map((c) => [c.name.toLowerCase(), c.id]));
  const { valid, errors } = validateRows(raw.rows, new Set(catByName.keys()));

  const existing = await pool.query<{ id: string; sku: string; name: string; category_id: string; brand: string | null; model: string | null; price: string; cost: string | null; stock_min: number; warranty_months: number }>(
    "SELECT id, upper(sku) AS sku, name, category_id, brand, model, price, cost, stock_min, warranty_months FROM products WHERE upper(sku) = ANY($1)",
    [valid.map((v) => v.data.sku)],
  );
  const bySku = new Map(existing.rows.map((p) => [p.sku, p]));

  const plan: PlanItem[] = [];
  let unchanged = 0;
  let skippedExisting = 0;
  const preview: { row: number; action: string; sku: string; name: string; price: number }[] = [];
  for (const { row, data } of valid) {
    const categoryId = catByName.get(data.category.toLowerCase())!;
    const cur = bySku.get(data.sku);
    if (!cur) {
      plan.push({ row, action: "create", data, categoryId });
      preview.push({ row, action: "create", sku: data.sku, name: data.name, price: data.price });
    } else if (mode === "insert_only") {
      skippedExisting++;
      preview.push({ row, action: "skip_existing", sku: data.sku, name: data.name, price: data.price });
    } else {
      const same =
        cur.name === data.name && cur.category_id === categoryId && (cur.brand ?? undefined) === data.brand && (cur.model ?? undefined) === data.model &&
        Number(cur.price) === data.price && (cur.cost === null ? undefined : Number(cur.cost)) === data.cost &&
        cur.stock_min === data.stock_min && cur.warranty_months === data.warranty_months;
      if (same) { unchanged++; preview.push({ row, action: "unchanged", sku: data.sku, name: data.name, price: data.price }); }
      else {
        plan.push({ row, action: "update", productId: cur.id, data, categoryId });
        preview.push({ row, action: "update", sku: data.sku, name: data.name, price: data.price });
      }
    }
  }

  const summary = {
    totalRows: raw.rows.length,
    validRows: valid.length,
    errorRows: new Set(errors.map((e) => e.row)).size,
    toCreate: plan.filter((p) => p.action === "create").length,
    toUpdate: plan.filter((p) => p.action === "update").length,
    unchanged, skippedExisting,
    unknownColumns: raw.unknownColumns,
  };

  const job = await withTransaction(async (client) => {
    const r = await client.query<{ id: string }>(
      "INSERT INTO import_jobs (entity, status, mode, filename, summary, payload, created_by) VALUES ('products','previewed',$1,$2,$3,$4,$5) RETURNING id",
      [mode, filename.slice(0, 200), JSON.stringify(summary), JSON.stringify(plan), req.auth?.id ?? null],
    );
    const id = r.rows[0]!.id;
    if (errors.length) {
      await client.query(
        "INSERT INTO import_errors (job_id, row_number, column_name, message) SELECT $1::uuid, * FROM unnest($2::int[], $3::text[], $4::text[])",
        [id, errors.map((e) => e.row), errors.map((e) => e.column ?? null), errors.map((e) => e.message)],
      );
    }
    await writeAudit({ action: "import.preview", entityType: "import_job", entityId: id, after: summary }, req, client);
    return id;
  });

  return { id: job, status: "previewed", mode, summary, errors: errors.slice(0, 200), errorsTruncated: errors.length > 200, preview: preview.slice(0, 100) };
}

export async function getImport(id: string) {
  const { rows } = await getPool().query('SELECT id, status, mode, filename, summary, created_at AS "createdAt", applied_at AS "appliedAt" FROM import_jobs WHERE id = $1', [uuidParam(id)]);
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Importación no encontrada");
  const errs = await getPool().query('SELECT row_number AS "row", column_name AS "column", message FROM import_errors WHERE job_id = $1 ORDER BY row_number LIMIT 500', [id]);
  return { ...rows[0], errors: errs.rows };
}

/** Aplica la importación en una sola transacción: o se aplica todo o nada. */
export async function confirmImport(id: string, req: Request) {
  uuidParam(id);
  return withTransaction(async (client) => {
    const job = await client.query<{ status: string; payload: PlanItem[]; summary: { errorRows: number } }>("SELECT status, payload, summary FROM import_jobs WHERE id = $1 FOR UPDATE", [id]);
    const j = job.rows[0];
    if (!j) throw new AppError(404, "NOT_FOUND", "Importación no encontrada");
    if (j.status !== "previewed") throw new AppError(409, "IMPORT_NOT_PENDING", `La importación ya está ${j.status === "applied" ? "aplicada" : "cancelada"}`);

    let created = 0, updated = 0;
    for (const item of j.payload) {
      const d = item.data;
      if (item.action === "create") {
        try {
          const r = await client.query<{ id: string }>(
            `INSERT INTO products (sku, name, category_id, brand, model, price, cost, stock_on_hand, stock_min, warranty_months)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [d.sku, d.name, item.categoryId, d.brand ?? null, d.model ?? null, d.price, d.cost ?? null, d.stock, d.stock_min, d.warranty_months],
          );
          if (d.stock > 0) {
            await client.query(
              "INSERT INTO inventory_movements (product_id, type, qty, balance_after, ref_type, ref_id, reason, created_by) VALUES ($1,'import',$2,$2,'import_job',$3,'Stock inicial por importación',$4)",
              [r.rows[0]!.id, d.stock, id, req.auth?.id ?? null],
            );
          }
          created++;
        } catch (e) {
          if ((e as { code?: string }).code === "23505") throw new AppError(409, "SKU_CONFLICT", `El SKU ${d.sku} (fila ${item.row}) fue creado por otra persona después de la vista previa. Vuelva a cargar el archivo.`);
          throw e;
        }
      } else {
        // En actualizaciones el stock del archivo se ignora: las existencias solo cambian con ajustes registrados.
        await client.query(
          `UPDATE products SET name=$2, category_id=$3, brand=$4, model=$5, price=$6, cost=$7, stock_min=$8, warranty_months=$9 WHERE id=$1`,
          [item.productId, d.name, item.categoryId, d.brand ?? null, d.model ?? null, d.price, d.cost ?? null, d.stock_min, d.warranty_months],
        );
        updated++;
      }
    }
    await client.query("UPDATE import_jobs SET status='applied', applied_at=now(), payload='[]'::jsonb WHERE id=$1", [id]);
    await writeAudit({ action: "import.apply", entityType: "import_job", entityId: id, after: { created, updated } }, req, client);
    return { id, status: "applied", created, updated };
  });
}

export async function cancelImport(id: string, req: Request) {
  uuidParam(id);
  const r = await getPool().query("UPDATE import_jobs SET status='cancelled', payload='[]'::jsonb WHERE id=$1 AND status='previewed' RETURNING id", [id]);
  if (!r.rowCount) throw new AppError(409, "IMPORT_NOT_PENDING", "La importación no está pendiente o no existe");
  await writeAudit({ action: "import.cancel", entityType: "import_job", entityId: id }, req);
  return { id, status: "cancelled" };
}

export const IMPORT_TEMPLATE_CSV = "\uFEFFsku,nombre,categoria,marca,modelo,precio,costo,stock,stock_minimo,garantia_meses\r\n";
