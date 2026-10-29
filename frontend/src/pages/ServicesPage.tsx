import { useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { useFetch, money } from "../hooks";
import { Empty, Err, Field, Pager } from "../ui";
import { errorMessage, json, request, type Page } from "../services/api";

interface Category { id: string; name: string }
interface Service {
  id: string; code: string; name: string; categoryId: string; categoryName: string; priceType: "fixed" | "quote" | "inspection";
  baseRate: number | null; requiresInspection: boolean; estMinutes: number | null; warrantyDays: number; status: string; conditions: string | null;
}
const PRICE_LABEL = { fixed: "Precio fijo", quote: "A cotizar", inspection: "Requiere inspección" } as const;
const empty = { code: "", name: "", categoryId: "", priceType: "quote", baseRate: "", requiresInspection: false, estMinutes: "", warrantyDays: "0", conditions: "" };

export default function ServicesPage() {
  const { can } = useAuth();
  const canWrite = can("catalog.write");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const cats = useFetch(() => request<{ items: Category[] }>("/services/categories"), []);
  const list = useFetch(() => request<Page<Service>>(`/services?page=${page}&limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`), [q, page]);

  function open(s: Service | "new") {
    setError(null); setEditing(s);
    setForm(s === "new" ? { ...empty, categoryId: cats.data?.items[0]?.id ?? "" } : {
      code: s.code, name: s.name, categoryId: s.categoryId, priceType: s.priceType, baseRate: s.baseRate === null ? "" : String(s.baseRate),
      requiresInspection: s.requiresInspection, estMinutes: s.estMinutes === null ? "" : String(s.estMinutes), warrantyDays: String(s.warrantyDays), conditions: s.conditions ?? "",
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault(); setError(null);
    const body = {
      name: form.name, categoryId: form.categoryId, priceType: form.priceType, baseRate: form.baseRate === "" ? null : Number(form.baseRate),
      requiresInspection: form.requiresInspection, estMinutes: form.estMinutes === "" ? null : Number(form.estMinutes),
      warrantyDays: Number(form.warrantyDays), conditions: form.conditions || undefined,
    };
    try {
      if (editing === "new") await request("/services", { method: "POST", ...json({ ...body, code: form.code }) });
      else if (editing) await request(`/services/${editing.id}`, { method: "PATCH", ...json(body) });
      setEditing(null); list.reload();
    } catch (err) { setError(errorMessage(err)); }
  }

  async function toggle(s: Service) {
    if (!window.confirm(`${s.status === "active" ? "Desactivar" : "Activar"} ${s.name}?`)) return;
    try { await request(`/services/${s.id}`, { method: "PATCH", ...json({ status: s.status === "active" ? "inactive" : "active" }) }); list.reload(); }
    catch (err) { window.alert(errorMessage(err)); }
  }

  return (
    <section>
      <h1>Servicios técnicos</h1>
      <div className="row">
        <input placeholder="Buscar servicio…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        {canWrite && <button onClick={() => open("new")}>Nuevo servicio</button>}
      </div>
      <Err msg={list.error} />
      {list.data && list.data.items.length === 0 ? <Empty text="No hay servicios. Cree el primero con sus tarifas reales." /> : (
        <div className="scroll"><table>
          <thead><tr><th>Código</th><th>Servicio</th><th>Categoría</th><th>Precio</th><th>Duración</th><th>Estado</th>{canWrite && <th />}</tr></thead>
          <tbody>{list.data?.items.map((s) => (
            <tr key={s.id}><td>{s.code}</td><td>{s.name}</td><td>{s.categoryName}</td>
              <td>{s.priceType === "fixed" ? money(s.baseRate) : PRICE_LABEL[s.priceType]}</td><td>{s.estMinutes ? `${s.estMinutes} min` : "—"}</td><td>{s.status === "active" ? "Activo" : "Inactivo"}</td>
              {canWrite && <td className="actions"><button onClick={() => open(s)}>Editar</button><button onClick={() => void toggle(s)}>{s.status === "active" ? "Desactivar" : "Activar"}</button></td>}
            </tr>))}</tbody>
        </table></div>
      )}
      {list.data && <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />}
      {editing && (
        <form className="card wide" onSubmit={save}>
          <h2>{editing === "new" ? "Nuevo servicio" : `Editar ${editing.code}`}</h2>
          <Field label="Código"><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required disabled={editing !== "new"} maxLength={40} /></Field>
          <Field label="Nombre"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} /></Field>
          <Field label="Categoría"><select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })} required>{cats.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Tipo de precio"><select value={form.priceType} onChange={(e) => setForm({ ...form, priceType: e.target.value })}>
            <option value="fixed">Precio fijo</option><option value="quote">A cotizar</option><option value="inspection">Requiere inspección previa</option></select></Field>
          <Field label="Tarifa base (PEN)"><input type="number" min="0" step="0.01" value={form.baseRate} onChange={(e) => setForm({ ...form, baseRate: e.target.value })} required={form.priceType === "fixed"} /></Field>
          <Field label="Duración estimada (min)"><input type="number" min="1" step="1" value={form.estMinutes} onChange={(e) => setForm({ ...form, estMinutes: e.target.value })} /></Field>
          <Field label="Garantía del servicio (días)"><input type="number" min="0" step="1" value={form.warrantyDays} onChange={(e) => setForm({ ...form, warrantyDays: e.target.value })} /></Field>
          <label className="inline"><input type="checkbox" checked={form.requiresInspection} onChange={(e) => setForm({ ...form, requiresInspection: e.target.checked })} /> Requiere inspección</label>
          <Field label="Condiciones"><textarea value={form.conditions} onChange={(e) => setForm({ ...form, conditions: e.target.value })} maxLength={4000} rows={3} /></Field>
          <Err msg={error} />
          <div className="row"><button type="submit">Guardar</button><button type="button" onClick={() => setEditing(null)}>Cancelar</button></div>
        </form>
      )}
    </section>
  );
}
