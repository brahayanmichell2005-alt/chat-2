import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Err } from "../ui";
import { download, errorMessage, request } from "../services/api";

interface Preview {
  id: string;
  summary: { totalRows: number; validRows: number; errorRows: number; toCreate: number; toUpdate: number; unchanged: number; skippedExisting: number; unknownColumns: string[] };
  errors: { row: number; column?: string; message: string }[];
  errorsTruncated: boolean;
  preview: { row: number; action: string; sku: string; name: string; price: number }[];
}
const ACTION: Record<string, string> = { create: "Crear", update: "Actualizar", unchanged: "Sin cambios", skip_existing: "Omitir (ya existe)" };

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"insert_only" | "upsert">("insert_only");
  const [prev, setPrev] = useState<Preview | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function analyze(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setError(null); setResult(null); setPrev(null);
    const fd = new FormData();
    fd.append("mode", mode);
    fd.append("file", file);
    try { setPrev(await request<Preview>("/catalog/products/import", { method: "POST", body: fd })); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!prev || !window.confirm(`Se aplicarán ${prev.summary.toCreate} altas y ${prev.summary.toUpdate} actualizaciones. ¿Confirmar?`)) return;
    setBusy(true); setError(null);
    try {
      const r = await request<{ created: number; updated: number }>(`/catalog/products/import/${prev.id}/confirm`, { method: "POST" });
      setResult(`Importación aplicada: ${r.created} creados, ${r.updated} actualizados.`);
      setPrev(null); setFile(null);
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!prev) return;
    try { await request(`/catalog/products/import/${prev.id}`, { method: "DELETE" }); setPrev(null); setResult("Importación cancelada. No se modificó ningún producto."); }
    catch (err) { setError(errorMessage(err)); }
  }

  const s = prev?.summary;
  return (
    <section>
      <p><Link to="/productos">← Productos</Link></p>
      <h1>Importar productos</h1>
      <p className="muted">Formatos: .csv o .xlsx (máx. 5 MB, 5000 filas). Columnas: sku, nombre, categoria, marca, modelo, precio, costo, stock, stock_minimo, garantia_meses. Las categorías deben existir. Nada se guarda hasta que confirme.</p>
      <p><button onClick={() => void download("/catalog/products/import/template", "plantilla-productos.csv").catch((e) => setError(errorMessage(e)))}>Descargar plantilla CSV</button></p>
      <form className="row" onSubmit={analyze}>
        <input type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="insert_only">Solo crear nuevos (omitir SKU existentes)</option>
          <option value="upsert">Crear y actualizar por SKU (el stock del archivo no se aplica a existentes)</option>
        </select>
        <button type="submit" disabled={busy || !file}>{busy ? "Procesando…" : "Analizar archivo"}</button>
      </form>
      <Err msg={error} />
      {result && <p role="status">{result}</p>}
      {prev && s && (
        <div>
          <h2>Vista previa</h2>
          <p>{s.totalRows} filas · {s.validRows} válidas · {s.errorRows} con error · {s.toCreate} por crear · {s.toUpdate} por actualizar · {s.unchanged} sin cambios · {s.skippedExisting} omitidas</p>
          {s.unknownColumns.length > 0 && <p className="muted">Columnas ignoradas: {s.unknownColumns.join(", ")}</p>}
          {prev.errors.length > 0 && (
            <div className="scroll"><table><thead><tr><th>Fila</th><th>Columna</th><th>Error</th></tr></thead>
              <tbody>{prev.errors.map((e, i) => <tr key={i}><td>{e.row}</td><td>{e.column}</td><td>{e.message}</td></tr>)}</tbody></table>
              {prev.errorsTruncated && <p className="muted">Se muestran los primeros 200 errores.</p>}</div>
          )}
          <div className="scroll"><table><thead><tr><th>Fila</th><th>Acción</th><th>SKU</th><th>Nombre</th><th>Precio</th></tr></thead>
            <tbody>{prev.preview.map((p) => <tr key={p.row}><td>{p.row}</td><td>{ACTION[p.action] ?? p.action}</td><td>{p.sku}</td><td>{p.name}</td><td>{p.price}</td></tr>)}</tbody></table></div>
          <div className="row">
            <button onClick={() => void confirm()} disabled={busy || s.toCreate + s.toUpdate === 0}>Confirmar importación</button>
            <button onClick={() => void cancel()} disabled={busy}>Cancelar</button>
          </div>
          {s.errorRows > 0 && <p className="muted">Las filas con error no se importarán; corrija el archivo y vuelva a cargarlo si las necesita.</p>}
        </div>
      )}
    </section>
  );
}
