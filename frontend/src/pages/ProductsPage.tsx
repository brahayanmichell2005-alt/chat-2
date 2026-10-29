import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useFetch, money } from "../hooks";
import { Empty, Err, Field, Pager } from "../ui";
import { download, errorMessage, json, request, type Page } from "../services/api";

interface Category { id: string; name: string }
interface Product {
  id: string; sku: string; name: string; categoryId: string; categoryName: string; brand: string | null; model: string | null;
  price: number; cost: number | null; stockOnHand: number; stockMin: number; warrantyMonths: number; status: string;
}
const empty = { sku: "", name: "", categoryId: "", brand: "", model: "", price: "", cost: "", stockOnHand: "0", stockMin: "0", warrantyMonths: "0" };

export default function ProductsPage() {
  const { can } = useAuth();
  const canWrite = can("catalog.write");
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [lowStock, setLowStock] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [form, setForm] = useState(empty);
  const [formError, setFormError] = useState<string | null>(null);

  const cats = useFetch(() => request<{ items: Category[] }>("/catalog/categories"), []);
  const list = useFetch(() => {
    const p = new URLSearchParams({ page: String(page), limit: "20" });
    if (q) p.set("q", q);
    if (categoryId) p.set("categoryId", categoryId);
    if (lowStock) p.set("lowStock", "true");
    return request<Page<Product>>(`/catalog/products?${p}`);
  }, [q, categoryId, lowStock, page]);

  function open(p: Product | "new") {
    setFormError(null);
    setEditing(p);
    setForm(p === "new" ? { ...empty, categoryId: cats.data?.items[0]?.id ?? "" } : {
      sku: p.sku, name: p.name, categoryId: p.categoryId, brand: p.brand ?? "", model: p.model ?? "", price: String(p.price),
      cost: p.cost === null ? "" : String(p.cost), stockOnHand: "0", stockMin: String(p.stockMin), warrantyMonths: String(p.warrantyMonths),
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const body: Record<string, unknown> = {
      name: form.name, categoryId: form.categoryId, price: Number(form.price), stockMin: Number(form.stockMin), warrantyMonths: Number(form.warrantyMonths),
      brand: form.brand || undefined, model: form.model || undefined,
    };
    try {
      if (editing === "new") {
        await request("/catalog/products", { method: "POST", ...json({ ...body, sku: form.sku, cost: form.cost === "" ? undefined : Number(form.cost), stockOnHand: Number(form.stockOnHand) }) });
      } else if (editing) {
        await request(`/catalog/products/${editing.id}`, { method: "PATCH", ...json({ ...body, cost: form.cost === "" ? null : Number(form.cost) }) });
      }
      setEditing(null);
      list.reload();
    } catch (err) { setFormError(errorMessage(err)); }
  }

  async function adjust(p: Product) {
    const raw = window.prompt(`Ajuste de stock para ${p.sku} (use negativo para restar). Stock actual: ${p.stockOnHand}`);
    if (raw === null) return;
    const delta = Number(raw);
    const reason = window.prompt("Motivo del ajuste (obligatorio)");
    if (!Number.isInteger(delta) || delta === 0 || !reason) { window.alert("Ingrese un entero distinto de 0 y un motivo."); return; }
    try { await request(`/catalog/products/${p.id}/stock-adjustments`, { method: "POST", ...json({ delta, reason }) }); list.reload(); }
    catch (err) { window.alert(errorMessage(err)); }
  }

  async function toggle(p: Product) {
    if (!window.confirm(`${p.status === "active" ? "Desactivar" : "Activar"} ${p.name}?`)) return;
    try { await request(`/catalog/products/${p.id}`, { method: "PATCH", ...json({ status: p.status === "active" ? "inactive" : "active" }) }); list.reload(); }
    catch (err) { window.alert(errorMessage(err)); }
  }

  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <section>
      <h1>Productos</h1>
      <div className="row">
        <input placeholder="Buscar SKU, nombre, marca…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setPage(1); }}>
          <option value="">Todas las categorías</option>
          {cats.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="inline"><input type="checkbox" checked={lowStock} onChange={(e) => { setLowStock(e.target.checked); setPage(1); }} /> Stock bajo</label>
        <button onClick={() => void download("/catalog/products/export", "productos.csv").catch((e) => window.alert(errorMessage(e)))}>Exportar CSV</button>
        {canWrite && <><button onClick={() => open("new")}>Nuevo producto</button><Link to="/productos/importar">Importar</Link></>}
      </div>
      <Err msg={list.error} />
      {list.loading && !list.data ? <p>Cargando…</p> : list.data && list.data.items.length === 0 ? <Empty text="No hay productos. Cree uno o importe un archivo CSV/Excel." /> : (
        <div className="scroll"><table>
          <thead><tr><th>SKU</th><th>Nombre</th><th>Categoría</th><th>Precio</th><th>Stock</th><th>Mín.</th><th>Estado</th>{canWrite && <th />}</tr></thead>
          <tbody>{list.data?.items.map((p) => (
            <tr key={p.id} className={p.stockOnHand <= p.stockMin ? "low" : ""}>
              <td>{p.sku}</td><td>{p.name}<br /><small>{[p.brand, p.model].filter(Boolean).join(" · ")}</small></td><td>{p.categoryName}</td>
              <td>{money(p.price)}</td><td>{p.stockOnHand}</td><td>{p.stockMin}</td><td>{p.status === "active" ? "Activo" : "Inactivo"}</td>
              {canWrite && <td className="actions"><button onClick={() => open(p)}>Editar</button><button onClick={() => void adjust(p)}>Stock</button><button onClick={() => void toggle(p)}>{p.status === "active" ? "Desactivar" : "Activar"}</button></td>}
            </tr>))}</tbody>
        </table></div>
      )}
      {list.data && <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />}

      {editing && (
        <form className="card wide" onSubmit={save}>
          <h2>{editing === "new" ? "Nuevo producto" : `Editar ${editing.sku}`}</h2>
          <Field label="SKU"><input value={form.sku} onChange={set("sku")} required disabled={editing !== "new"} maxLength={64} /></Field>
          <Field label="Nombre"><input value={form.name} onChange={set("name")} required maxLength={200} /></Field>
          <Field label="Categoría"><select value={form.categoryId} onChange={set("categoryId")} required>{cats.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Marca"><input value={form.brand} onChange={set("brand")} maxLength={80} /></Field>
          <Field label="Modelo"><input value={form.model} onChange={set("model")} maxLength={80} /></Field>
          <Field label="Precio de venta (PEN)"><input type="number" min="0" step="0.01" value={form.price} onChange={set("price")} required /></Field>
          <Field label="Costo (opcional)"><input type="number" min="0" step="0.01" value={form.cost} onChange={set("cost")} /></Field>
          {editing === "new" && <Field label="Stock inicial"><input type="number" min="0" step="1" value={form.stockOnHand} onChange={set("stockOnHand")} /></Field>}
          <Field label="Stock mínimo"><input type="number" min="0" step="1" value={form.stockMin} onChange={set("stockMin")} /></Field>
          <Field label="Garantía (meses)"><input type="number" min="0" step="1" value={form.warrantyMonths} onChange={set("warrantyMonths")} /></Field>
          <Err msg={formError} />
          <div className="row"><button type="submit">Guardar</button><button type="button" onClick={() => setEditing(null)}>Cancelar</button></div>
        </form>
      )}
    </section>
  );
}
