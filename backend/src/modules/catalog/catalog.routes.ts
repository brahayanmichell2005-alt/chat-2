import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { AppError } from "../../common/errors.js";
import { uuidParam } from "../../common/http.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import * as imp from "./import.service.js";
import * as p from "./products.service.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const modeSchema = z.enum(["insert_only", "upsert"]).default("insert_only");

export function createCatalogRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get("/categories", requirePermission("catalog.read"), async (_req, res) => res.json(await p.listCategories()));
  r.post("/categories", requirePermission("catalog.write"), async (req, res) => res.status(201).json(await p.createCategory(p.categorySchema.parse(req.body), req)));

  r.get("/products", requirePermission("catalog.read"), async (req, res) => res.json(await p.listProducts(p.productListQuery.parse(req.query))));
  r.post("/products", requirePermission("catalog.write"), async (req, res) => res.status(201).json(await p.createProduct(p.productCreateSchema.parse(req.body), req)));

  // Rutas fijas antes de /products/:id
  r.get("/products/export", requirePermission("catalog.read"), async (_req, res) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="productos.csv"');
    res.send(await p.exportProductsCsv());
  });
  r.get("/products/import/template", requirePermission("catalog.write"), (_req, res) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="plantilla-productos.csv"');
    res.send(imp.IMPORT_TEMPLATE_CSV);
  });
  r.post("/products/import", requirePermission("catalog.write"), upload.single("file"), async (req, res) => {
    if (!req.file) throw new AppError(400, "FILE_REQUIRED", "Adjunte un archivo .csv o .xlsx en el campo 'file'");
    const mode = modeSchema.parse(req.body?.mode);
    res.status(201).json(await imp.previewImport(req.file.buffer, req.file.originalname, mode, req));
  });
  r.get("/products/import/:id", requirePermission("catalog.write"), async (req, res) => res.json(await imp.getImport(uuidParam(req.params.id))));
  r.post("/products/import/:id/confirm", requirePermission("catalog.write"), async (req, res) => res.json(await imp.confirmImport(String(req.params.id), req)));
  r.delete("/products/import/:id", requirePermission("catalog.write"), async (req, res) => res.json(await imp.cancelImport(String(req.params.id), req)));

  r.get("/products/:id", requirePermission("catalog.read"), async (req, res) => res.json(await p.getProduct(uuidParam(req.params.id))));
  r.patch("/products/:id", requirePermission("catalog.write"), async (req, res) => res.json(await p.updateProduct(String(req.params.id), p.productUpdateSchema.parse(req.body), req)));
  r.post("/products/:id/stock-adjustments", requirePermission("catalog.write"), async (req, res) => res.json(await p.adjustStock(String(req.params.id), p.stockAdjustSchema.parse(req.body), req)));
  r.get("/products/:id/movements", requirePermission("catalog.read"), async (req, res) => res.json(await p.listMovements(uuidParam(req.params.id))));
  return r;
}
