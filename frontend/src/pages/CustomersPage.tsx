import { useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { useFetch, dateTime } from "../hooks";
import { Empty, Err, Field, Pager } from "../ui";
import { HttpError, errorMessage, json, request, type Page } from "../services/api";

interface Customer { id: string; name: string; email: string | null; status: string; phones: string[]; createdAt: string }
interface Address { id: string; label: string | null; address: string; reference: string | null }
interface Dup { id: string; name: string; email: string | null }

export default function CustomersPage() {
  const { can } = useAuth();
  const canWrite = can("customers.write");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "" });
  const [error, setError] = useState<string | null>(null);
  const [dups, setDups] = useState<Dup[] | null>(null);
  const [selected, setSelected] = useState<Customer | null>(null);

  const list = useFetch(() => request<Page<Customer>>(`/customers?page=${page}&limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`), [q, page]);

  async function create(e: FormEvent, allowDuplicate = false) {
    e.preventDefault();
    setError(null);
    try {
      await request("/customers", { method: "POST", ...json({ name: form.name, phone: form.phone || undefined, email: form.email || undefined, allowDuplicate }) });
      setCreating(false); setDups(null); setForm({ name: "", phone: "", email: "" }); list.reload();
    } catch (err) {
      if (err instanceof HttpError && err.body?.code === "DUPLICATE_CUSTOMER") setDups(((err.body.details as { matches?: Dup[] })?.matches) ?? []);
      setError(errorMessage(err));
    }
  }

  return (
    <section>
      <h1>Clientes</h1>
      <div className="row">
        <input placeholder="Buscar nombre, correo o teléfono…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        {canWrite && <button onClick={() => { setCreating(true); setError(null); setDups(null); }}>Nuevo cliente</button>}
      </div>
      <Err msg={list.error} />
      {list.data && list.data.items.length === 0 ? <Empty text="Aún no hay clientes." /> : (
        <div className="scroll"><table>
          <thead><tr><th>Nombre</th><th>Teléfono</th><th>Correo</th><th>Estado</th><th>Alta</th></tr></thead>
          <tbody>{list.data?.items.map((c) => (
            <tr key={c.id} onClick={() => setSelected(c)} className="clickable">
              <td>{c.name}</td><td>{c.phones.join(", ") || "—"}</td><td>{c.email ?? "—"}</td><td>{c.status === "active" ? "Activo" : "Inactivo"}</td><td>{dateTime(c.createdAt)}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      {list.data && <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />}

      {creating && (
        <form className="card wide" onSubmit={(e) => void create(e)}>
          <h2>Nuevo cliente</h2>
          <Field label="Nombre"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} /></Field>
          <Field label="Teléfono / WhatsApp"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="910 000 000" /></Field>
          <Field label="Correo (opcional)"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Err msg={error} />
          {dups && dups.length > 0 && (
            <div><p>Posibles duplicados:</p><ul>{dups.map((d) => <li key={d.id}>{d.name} {d.email ? `(${d.email})` : ""}</li>)}</ul>
              <button type="button" onClick={(e) => void create(e as unknown as FormEvent, true)}>Crear de todos modos</button></div>
          )}
          <div className="row"><button type="submit">Guardar</button><button type="button" onClick={() => setCreating(false)}>Cancelar</button></div>
        </form>
      )}
      {selected && <CustomerDetail customer={selected} canWrite={canWrite} onClose={() => setSelected(null)} />}
    </section>
  );
}

function CustomerDetail({ customer, canWrite, onClose }: { customer: Customer; canWrite: boolean; onClose: () => void }) {
  const [addr, setAddr] = useState({ label: "", address: "", reference: "" });
  const [error, setError] = useState<string | null>(null);
  const addresses = useFetch(() => request<{ items: Address[] }>(`/customers/${customer.id}/addresses`), [customer.id]);
  const history = useFetch(() => request<{ conversations: { id: string; status: string; createdAt: string }[] }>(`/customers/${customer.id}/history`), [customer.id]);

  async function add(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await request(`/customers/${customer.id}/addresses`, { method: "POST", ...json({ label: addr.label || undefined, address: addr.address, reference: addr.reference || undefined }) });
      setAddr({ label: "", address: "", reference: "" }); addresses.reload();
    } catch (err) { setError(errorMessage(err)); }
  }

  return (
    <aside className="card wide">
      <div className="row"><h2>{customer.name}</h2><button onClick={onClose}>Cerrar</button></div>
      <p>{customer.phones.join(", ") || "Sin teléfono"} · {customer.email ?? "Sin correo"}</p>
      <h3>Direcciones</h3>
      {addresses.data?.items.length ? <ul>{addresses.data.items.map((a) => <li key={a.id}>{a.label ? `${a.label}: ` : ""}{a.address}{a.reference ? ` (${a.reference})` : ""}</li>)}</ul> : <Empty text="Sin direcciones registradas." />}
      {canWrite && (
        <form onSubmit={add} className="row">
          <input placeholder="Etiqueta (casa, oficina)" value={addr.label} onChange={(e) => setAddr({ ...addr, label: e.target.value })} />
          <input placeholder="Dirección" value={addr.address} onChange={(e) => setAddr({ ...addr, address: e.target.value })} required minLength={3} />
          <input placeholder="Referencia" value={addr.reference} onChange={(e) => setAddr({ ...addr, reference: e.target.value })} />
          <button type="submit">Añadir</button>
        </form>
      )}
      <Err msg={error} />
      <h3>Conversaciones</h3>
      {history.data?.conversations.length ? <ul>{history.data.conversations.map((c) => <li key={c.id}>{dateTime(c.createdAt)} · {c.status}</li>)}</ul> : <Empty text="Sin conversaciones." />}
      <p className="muted">Cotizaciones, pedidos, servicios y garantías aparecerán aquí en etapas posteriores.</p>
    </aside>
  );
}
