import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { z } from "zod";

export const MAX_IMPORT_ROWS = 5000;

export function normalizeHeader(h: string): string {
  return h.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

const HEADER_ALIASES: Record<string, string> = {
  sku: "sku", codigo: "sku", codigo_interno: "sku",
  nombre: "name", name: "name", producto: "name",
  categoria: "category", category: "category",
  marca: "brand", brand: "brand",
  modelo: "model", model: "model",
  precio: "price", price: "price", precio_venta: "price",
  costo: "cost", cost: "cost",
  stock: "stock", existencias: "stock", cantidad: "stock",
  stock_minimo: "stock_min", stock_min: "stock_min",
  garantia_meses: "warranty_months", garantia: "warranty_months", warranty_months: "warranty_months",
};

/** "S/ 1,234.50" → 1234.5 ; "12,5" → 12.5 ; vacío → undefined ; inválido → NaN */
export function parseNumber(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  let s = v.replace(/[^\d.,-]/g, "");
  if (s === "") return undefined;
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

const num = (label: string, opts: { int?: boolean; optional?: boolean; def?: number } = {}) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const n = parseNumber(v);
      if (n === undefined) {
        if (opts.optional) return undefined;
        if (opts.def !== undefined) return opts.def;
        ctx.addIssue({ code: "custom", message: `${label} es obligatorio` });
        return z.NEVER;
      }
      if (Number.isNaN(n) || n < 0 || (opts.int && !Number.isInteger(n))) {
        ctx.addIssue({ code: "custom", message: `${label} inválido${opts.int ? " (entero ≥ 0)" : " (número ≥ 0)"}` });
        return z.NEVER;
      }
      return n;
    });

const text = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

export const productRowSchema = z.object({
  sku: z.string({ required_error: "SKU es obligatorio" }).trim().min(1, "SKU es obligatorio").max(64).transform((v) => v.toUpperCase()),
  name: z.string({ required_error: "nombre es obligatorio" }).trim().min(1, "nombre es obligatorio").max(200),
  category: z.string({ required_error: "categoría es obligatoria" }).trim().min(1, "categoría es obligatoria"),
  brand: text(80),
  model: text(80),
  price: num("precio"),
  cost: num("costo", { optional: true }),
  stock: num("stock", { int: true, def: 0 }),
  stock_min: num("stock_minimo", { int: true, def: 0 }),
  warranty_months: num("garantia_meses", { int: true, def: 0 }),
});
/** Tipo explícito: tras la validación todos los números obligatorios están presentes. */
export interface ProductRow {
  sku: string; name: string; category: string; brand?: string; model?: string;
  price: number; cost?: number; stock: number; stock_min: number; warranty_months: number;
}

export interface RowError { row: number; column?: string; message: string }
export interface ParsedRow { row: number; data: ProductRow }

/** Convierte el archivo en filas {columna_normalizada: texto}. Fila 1 = encabezados. */
export async function readRawRows(buffer: Buffer, filename: string): Promise<{ rows: { row: number; values: Record<string, string> }[]; unknownColumns: string[] }> {
  const ext = filename.toLowerCase().split(".").pop();
  let matrix: string[][];
  if (ext === "csv") {
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
    matrix = parseCsv(text, { delimiter, skip_empty_lines: true, relax_column_count: true, trim: true }) as string[][];
  } else if (ext === "xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error("El archivo Excel no tiene hojas");
    matrix = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const cells: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const v = r.getCell(c).value;
        cells.push(v == null ? "" : typeof v === "object" && "result" in v ? String(v.result ?? "") : typeof v === "object" && "text" in v ? String(v.text) : String(v));
      }
      matrix.push(cells.map((x) => x.trim()));
    });
  } else {
    throw new Error("Formato no admitido: use .csv o .xlsx");
  }
  if (matrix.length < 2) throw new Error("El archivo no tiene filas de datos");
  if (matrix.length - 1 > MAX_IMPORT_ROWS) throw new Error(`Máximo ${MAX_IMPORT_ROWS} filas por importación`);

  const header = matrix[0]!.map((h) => normalizeHeader(h));
  const unknownColumns = matrix[0]!.filter((h, i) => h && !HEADER_ALIASES[header[i]!]);
  const mapped = header.map((h) => HEADER_ALIASES[h]);
  const rows = matrix.slice(1).map((cells, i) => {
    const values: Record<string, string> = {};
    mapped.forEach((key, idx) => { if (key && cells[idx] !== undefined && cells[idx] !== "") values[key] = cells[idx]!; });
    return { row: i + 2, values };
  });
  return { rows, unknownColumns };
}

/** Valida cada fila y marca SKU repetidos dentro del archivo. No toca la base de datos. */
export function validateRows(rows: { row: number; values: Record<string, string> }[], categoryNames: Set<string>) {
  const valid: ParsedRow[] = [];
  const errors: RowError[] = [];
  const seen = new Map<string, number>();
  for (const { row, values } of rows) {
    const parsed = productRowSchema.safeParse(values);
    if (!parsed.success) {
      for (const i of parsed.error.issues) errors.push({ row, column: String(i.path[0] ?? ""), message: i.message });
      continue;
    }
    const d = parsed.data as ProductRow;
    if (!categoryNames.has(d.category.toLowerCase())) {
      errors.push({ row, column: "category", message: `Categoría desconocida: "${d.category}"` });
      continue;
    }
    const first = seen.get(d.sku);
    if (first !== undefined) {
      errors.push({ row, column: "sku", message: `SKU repetido en el archivo (primera aparición: fila ${first})` });
      continue;
    }
    seen.set(d.sku, row);
    valid.push({ row, data: d });
  }
  return { valid, errors };
}
