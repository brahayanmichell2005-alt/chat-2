import { describe, expect, it } from "vitest";
import { normalizeHeader, parseNumber, readRawRows, validateRows } from "../../src/modules/catalog/import.parser.js";
import { normalizePhone } from "../../src/common/phone.js";

describe("parseNumber", () => {
  it.each([
    ["1234.5", 1234.5], ["S/ 1,234.50", 1234.5], ["12,5", 12.5], ["0", 0], ["", undefined],
  ])("%s → %s", (input, expected) => expect(parseNumber(input)).toBe(expected));
  it("devuelve NaN si no es numérico", () => expect(parseNumber("-")).toBeNaN());
});

describe("normalizeHeader / normalizePhone", () => {
  it("quita tildes y espacios", () => {
    expect(normalizeHeader(" Categoría ")).toBe("categoria");
    expect(normalizeHeader("Stock Mínimo")).toBe("stock_minimo");
  });
  it("normaliza teléfonos de Perú y rechaza inválidos", () => {
    expect(normalizePhone("910 989 309")).toBe("+51910989309");
    expect(normalizePhone("+51 910-989-309")).toBe("+51910989309");
    expect(normalizePhone("123")).toBeNull();
  });
});

const csv = (body: string) => Buffer.from(`sku,nombre,categoria,marca,modelo,precio,costo,stock,stock_minimo,garantia_meses\n${body}`);
const cats = new Set(["routers y conectividad", "videovigilancia"]);

describe("importación: lectura y validación (sin base de datos)", () => {
  it("lee CSV con coma y con punto y coma", async () => {
    const a = await readRawRows(csv("r1,Router X,Routers y conectividad,TP,AX10,199.90,150,5,2,12"), "a.csv");
    expect(a.rows[0]!.values.sku).toBe("r1");
    const b = await readRawRows(Buffer.from("sku;nombre;categoria;precio\nr1;Router;Routers y conectividad;100"), "b.csv");
    expect(b.rows[0]!.values.price).toBe("100");
  });

  it("rechaza formatos no admitidos y archivos sin datos", async () => {
    await expect(readRawRows(Buffer.from("x"), "a.txt")).rejects.toThrow(/Formato no admitido/);
    await expect(readRawRows(Buffer.from("sku,nombre\n"), "a.csv")).rejects.toThrow(/filas de datos/);
  });

  it("valida filas, normaliza SKU a mayúsculas y aplica valores por defecto", async () => {
    const { rows } = await readRawRows(csv("r1,Router X,routers y conectividad,TP,AX10,199.90,,,,"), "a.csv");
    const { valid, errors } = validateRows(rows, cats);
    expect(errors).toEqual([]);
    expect(valid[0]!.data).toMatchObject({ sku: "R1", price: 199.9, stock: 0, stock_min: 0, warranty_months: 0 });
  });

  it("reporta errores por fila y columna", async () => {
    const { rows } = await readRawRows(csv(",Sin sku,Videovigilancia,,,10,,,,\nr2,Precio malo,Videovigilancia,,,abc,,,,\nr3,Categoria mala,Inexistente,,,10,,,,\nr4,Stock decimal,Videovigilancia,,,10,,1.5,,"), "a.csv");
    const { valid, errors } = validateRows(rows, cats);
    expect(valid).toHaveLength(0);
    expect(errors.map((e) => e.row).sort()).toEqual([2, 3, 4, 5]);
    expect(errors.find((e) => e.row === 4)?.message).toMatch(/Categoría desconocida/);
  });

  it("detecta SKU repetidos dentro del archivo", async () => {
    const { rows } = await readRawRows(csv("a1,Uno,Videovigilancia,,,10,,,,\nA1,Dos,Videovigilancia,,,20,,,,"), "a.csv");
    const { valid, errors } = validateRows(rows, cats);
    expect(valid).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 3, column: "sku" });
  });
});
