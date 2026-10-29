import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { dateTime, money, useFetch } from "../hooks";
import { Empty, Err, Field, Pager } from "../ui";
import { errorMessage, json, request, type Page } from "../services/api";

interface Quote { id: string; code: string; status: string; customerName: string; total: number; validUntil: string; sendStatus: string | null; orderId: string | null; orderCode: string | null; createdAt: string }
interface QuoteDetail extends Quote { subtotal: number; discountTotal: number; extraTotal: number; notes: string | null; conditions: string | null; rejectReason: string | null; sendError: string | null;
  items: { lineNo: number; description: string; qty: number; unitPrice: number; discount: number; lineTotal: number }[] }
interface Cust { id: string; name: string; phones: string[] }
interface Prod { id: string; sku: string; name: string; price: number }
interface Serv { id: string; code: string; name: string; priceType: string; baseRate: number | null }
interface Line { type: "product" | "service"; id: string; qty: string; unitPrice: string; discount: string }
interface Preview { code: string; total: number; text: string; destinationPhone: string | null }

const STATUS: Record<string, string> = { draft: "Borrador", pending_send: "Pendiente de envío", sent: "Enviada", accepted: "Aceptada", rejected: "Rechazada", expired: "Vencida", converted: "Convertida en pedido" };

export default function QuotesPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useFetch(() => request<Page<Quote>>(`/quotes?page=${page}&limit=20${status ? `&status=${status}` : ""}`), [status, page]);
  return (
    <section className="split">
      <div>
        <h1>Cotizaciones</h1>
        <div className="row">
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Todos los estados</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          {can("quotes.write") && <button onClick={() => { setCreating(true); setSelected(null); }}>Nueva cotización</button>}
        </div>
        <Err msg={list.error} />
        {list.data && list.data.items.length === 0 ? <Empty text="No hay cotizaciones." /> : (
          <ul className="list">{list.data?.items.map((q) => (
            <li key={q.id} className={q.id === selected ? "active" : ""} onClick={() => { setSelected(q.id); setCreating(false); }}>
              <strong>{q.code}</strong> · {q.customerName}<br /><small>{STATUS[q.status]} · {money(q.total)} · vence {dateTime(q.validUntil)}</small></li>))}</ul>
        )}
        {list.data && <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />}
      </div>
      {creating && <QuoteForm onDone={(id) => { setCreating(false); list.reload(); setSelected(id); }} onCancel={() => setCreating(false)} />}
      {selected && !creating && <QuoteDetailPanel key={selected} id={selected} onChanged={list.reload} />}
    </section>
  );
}

function QuoteForm({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const { can } = useAuth();
  const custs = useFetch(() => request<Page<Cust>>("/customers?limit=100&status=active"), []);
  const prods = useFetch(() => request<Page<Prod>>("/catalog/products?limit=100&status=active"), []);
  const servs = useFetch(() => request<Page<Serv>>("/services?limit=100&status=active"), []);
  const [customerId, setCustomerId] = useState("");
  const [lines, setLines] = useState<Line[]>([{ type: "product", id: "", qty: "1", unitPrice: "", discount: "" }]);
  const [extra, setExtra] = useState("");
  const [days, setDays] = useState("7");
  const [notes, setNotes] = useState("");
  const [conditions, setConditions] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const upd = (i: number, patch: Partial<Line>) => setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  async function save(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      const body = {
        customerId, validDays: Number(days), notes: notes || undefined, conditions: conditions || undefined, extraCost: extra ? Number(extra) : undefined,
        items: lines.map((l) => ({ type: l.type, id: l.id, qty: Number(l.qty), unitPrice: l.unitPrice ? Number(l.unitPrice) : undefined, discount: l.discount ? Number(l.discount) : undefined })),
      };
      const q = await request<{ id: string }>("/quotes", { method: "POST", ...json(body) });
      onDone(q.id);
    } catch (x) { setErr(errorMessage(x)); }
  }
  return (
    <form className="card wide" onSubmit={save}>
      <h2>Nueva cotización</h2>
      <Field label="Cliente"><select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
        <option value="">Seleccione…</option>{custs.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name} {c.phones[0] ?? ""}</option>)}</select></Field>
      {lines.map((l, i) => {
        const serv = servs.data?.items.find((s) => s.id === l.id);
        const needsPrice = l.type === "service" && serv && serv.priceType !== "fixed";
        return (
          <div className="row" key={i}>
            <select value={l.type} onChange={(e) => upd(i, { type: e.target.value as Line["type"], id: "", unitPrice: "" })}><option value="product">Producto</option><option value="service">Servicio</option></select>
            <select value={l.id} onChange={(e) => upd(i, { id: e.target.value })} required>
              <option value="">Seleccione…</option>
              {l.type === "product" ? prods.data?.items.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name} · {money(p.price)}</option>)
                : servs.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.priceType === "fixed" ? money(s.baseRate) : "a cotizar"}</option>)}
            </select>
            <input type="number" min="1" step="1" value={l.qty} onChange={(e) => upd(i, { qty: e.target.value })} style={{ width: "5rem" }} aria-label="Cantidad" required />
            {needsPrice && <input type="number" min="0" step="0.01" placeholder="Precio S/" value={l.unitPrice} onChange={(e) => upd(i, { unitPrice: e.target.value })} required style={{ width: "7rem" }} />}
            {can("quotes.discount") && <input type="number" min="0" step="0.01" placeholder="Desc. S/" value={l.discount} onChange={(e) => upd(i, { discount: e.target.value })} style={{ width: "6rem" }} />}
            {lines.length > 1 && <button type="button" onClick={() => setLines(lines.filter((_, n) => n !== i))}>Quitar</button>}
          </div>);
      })}
      <button type="button" onClick={() => setLines([...lines, { type: "product", id: "", qty: "1", unitPrice: "", discount: "" }])}>Añadir línea</button>
      <Field label="Costos adicionales S/ (opcional)"><input type="number" min="0" step="0.01" value={extra} onChange={(e) => setExtra(e.target.value)} /></Field>
      <Field label="Vigencia (días)"><input type="number" min="1" max="60" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
      <Field label="Condiciones"><textarea rows={2} maxLength={1000} value={conditions} onChange={(e) => setConditions(e.target.value)} /></Field>
      <Field label="Observaciones"><textarea rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <p className="muted">Los precios salen del catálogo y los totales los calcula el servidor al guardar.</p>
      <Err msg={err} />
      <div className="row"><button type="submit">Guardar borrador</button><button type="button" onClick={onCancel}>Cancelar</button></div>
    </form>
  );
}

function QuoteDetailPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { can } = useAuth();
  const d = useFetch(() => request<QuoteDetail>(`/quotes/${id}`), [id]);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const q = d.data;
  async function act(fn: () => Promise<unknown>) { setErr(null); try { await fn(); d.reload(); onChanged(); } catch (x) { setErr(errorMessage(x)); } }
  async function showPreview() { setErr(null); try { setPreview(await request<Preview>(`/quotes/${id}/preview`)); } catch (x) { setErr(errorMessage(x)); } }
  if (!q) return <aside className="card wide">{d.error ?? "Cargando…"}</aside>;
  const w = can("quotes.write");
  return (
    <aside className="card wide">
      <h2>{q.code} · {STATUS[q.status]}</h2>
      <p>{q.customerName} · vence {dateTime(q.validUntil)}</p>
      <div className="scroll"><table><thead><tr><th>#</th><th>Detalle</th><th>Cant.</th><th>Precio</th><th>Desc.</th><th>Total</th></tr></thead>
        <tbody>{q.items.map((i) => <tr key={i.lineNo}><td>{i.lineNo}</td><td>{i.description}</td><td>{i.qty}</td><td>{money(i.unitPrice)}</td><td>{money(i.discount)}</td><td>{money(i.lineTotal)}</td></tr>)}</tbody></table></div>
      <p>Subtotal {money(q.subtotal)} · Descuento {money(q.discountTotal)} · Adicionales {money(q.extraTotal)} · <strong>Total {money(q.total)}</strong></p>
      {q.conditions && <p className="muted">Condiciones: {q.conditions}</p>}
      {q.sendStatus && <p className="muted">Mensaje de envío: {q.sendStatus}{q.sendError ? ` — ${q.sendError}` : ""}</p>}
      {q.rejectReason && <p className="muted">Rechazada: {q.rejectReason}</p>}
      {q.orderId && <p>Pedido: <Link to="/pedidos">{q.orderCode}</Link></p>}
      <Err msg={err} />
      <div className="row">
        {w && q.status === "draft" && <button onClick={() => void act(() => request(`/quotes/${id}/submit`, { method: "POST" }))}>Marcar lista para enviar</button>}
        {w && ["draft", "pending_send"].includes(q.status) && <button onClick={() => void showPreview()}>Vista previa y envío</button>}
        {w && q.status === "sent" && <button onClick={() => { if (window.confirm("¿El cliente aceptó esta cotización?")) void act(() => request(`/quotes/${id}/accept`, { method: "POST" })); }}>Registrar aceptación</button>}
        {w && ["draft", "pending_send", "sent"].includes(q.status) && <button onClick={() => { const reason = window.prompt("Motivo del rechazo"); if (reason) void act(() => request(`/quotes/${id}/reject`, { method: "POST", ...json({ reason }) })); }}>Rechazar</button>}
        {can("orders.write") && q.status === "accepted" && <button onClick={() => void act(() => request(`/quotes/${id}/convert-to-order`, { method: "POST", ...json({}) }))}>Convertir en pedido</button>}
      </div>
      {preview && (
        <div className="card wide">
          <h3>Se enviará a: {preview.destinationPhone ?? "— sin conversación abierta —"}</h3>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{preview.text}</pre>
          <div className="row">
            <button disabled={!preview.destinationPhone} onClick={() => { void act(() => request(`/quotes/${id}/send`, { method: "POST" })); setPreview(null); }}>Confirmar y enviar</button>
            <button onClick={() => setPreview(null)}>Cancelar</button>
          </div>
        </div>
      )}
    </aside>
  );
}
