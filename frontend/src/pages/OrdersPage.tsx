import { useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { dateTime, money, useFetch } from "../hooks";
import { Empty, Err, Field, Pager } from "../ui";
import { errorMessage, json, request, type Page } from "../services/api";

interface Order { id: string; code: string; status: string; customerName: string; total: number; paidTotal: number; createdAt: string }
interface Pay { id: string; code: string; amount: number; method: string; reference: string | null; status: string; reason: string | null }
interface OrderDetail extends Order { subtotal: number; discountTotal: number; extraTotal: number; deliveryTerms: string | null; cancelReason: string | null;
  items: { lineNo: number; description: string; qty: number; unitPrice: number; discount: number; lineTotal: number }[]; payments: Pay[];
  paymentSummary: { total: number; verified: number; open: number; balance: number; registrable: number } }

export const ORDER_STATUS: Record<string, string> = { requested: "Solicitado", confirmed: "Confirmado", preparing: "En preparación", completed: "Completado", cancelled: "Cancelado" };
export const PAY_STATUS: Record<string, string> = { pending: "Pendiente", in_review: "En revisión", verified: "Verificado", rejected: "Rechazado", refunded: "Reembolsado" };
const NEXT: Record<string, [string, string][]> = {
  requested: [["confirmed", "Confirmar (reserva stock)"]], confirmed: [["preparing", "En preparación"], ["completed", "Completar (descuenta stock)"]], preparing: [["completed", "Completar (descuenta stock)"]],
};

export default function OrdersPage() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useFetch(() => request<Page<Order>>(`/orders?page=${page}&limit=20${status ? `&status=${status}` : ""}`), [status, page]);
  return (
    <section className="split">
      <div>
        <h1>Pedidos</h1>
        <div className="row"><select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">Todos los estados</option>{Object.entries(ORDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <Err msg={list.error} />
        {list.data && list.data.items.length === 0 ? <Empty text="No hay pedidos. Se crean al convertir una cotización aceptada." /> : (
          <ul className="list">{list.data?.items.map((o) => (
            <li key={o.id} className={o.id === selected ? "active" : ""} onClick={() => setSelected(o.id)}>
              <strong>{o.code}</strong> · {o.customerName}<br /><small>{ORDER_STATUS[o.status]} · {money(o.total)} · pagado {money(o.paidTotal)}</small></li>))}</ul>
        )}
        {list.data && <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />}
      </div>
      {selected && <OrderPanel key={selected} id={selected} onChanged={list.reload} />}
    </section>
  );
}

function OrderPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { can } = useAuth();
  const d = useFetch(() => request<OrderDetail>(`/orders/${id}`), [id]);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ amount: "", method: "yape", reference: "", evidenceRef: "" });
  const o = d.data;
  async function act(fn: () => Promise<unknown>) { setErr(null); try { await fn(); d.reload(); onChanged(); } catch (x) { setErr(errorMessage(x)); } }
  if (!o) return <aside className="card wide">{d.error ?? "Cargando…"}</aside>;
  const s = o.paymentSummary;
  function addPayment(e: FormEvent) {
    e.preventDefault();
    void act(async () => { await request("/payments", { method: "POST", ...json({ orderId: id, amount: Number(form.amount), method: form.method, reference: form.reference || undefined, evidenceRef: form.evidenceRef || undefined }) }); setForm({ amount: "", method: "yape", reference: "", evidenceRef: "" }); });
  }
  return (
    <aside className="card wide">
      <h2>{o.code} · {ORDER_STATUS[o.status]}</h2>
      <p>{o.customerName}{o.deliveryTerms ? ` · Entrega: ${o.deliveryTerms}` : ""}</p>
      <div className="scroll"><table><thead><tr><th>#</th><th>Detalle</th><th>Cant.</th><th>Precio</th><th>Desc.</th><th>Total</th></tr></thead>
        <tbody>{o.items.map((i) => <tr key={i.lineNo}><td>{i.lineNo}</td><td>{i.description}</td><td>{i.qty}</td><td>{money(i.unitPrice)}</td><td>{money(i.discount)}</td><td>{money(i.lineTotal)}</td></tr>)}</tbody></table></div>
      <p><strong>Total {money(o.total)}</strong> · Verificado {money(s.verified)} · En trámite {money(s.open)} · <strong>Saldo {money(s.balance)}</strong></p>
      {o.cancelReason && <p className="muted">Cancelado: {o.cancelReason}</p>}
      <Err msg={err} />
      {can("orders.confirm") && (
        <div className="row">
          {(NEXT[o.status] ?? []).map(([to, label]) => (
            <button key={to} onClick={() => { if (to === "completed" && s.balance > 0 && !window.confirm(`Aún hay un saldo de ${money(s.balance)} sin verificar. ¿Completar de todos modos?`)) return; void act(() => request(`/orders/${id}/status`, { method: "PATCH", ...json({ status: to }) })); }}>{label}</button>))}
          {["requested", "confirmed", "preparing"].includes(o.status) && <button onClick={() => { const reason = window.prompt("Motivo de la cancelación"); if (reason) void act(() => request(`/orders/${id}/status`, { method: "PATCH", ...json({ status: "cancelled", reason }) })); }}>Cancelar pedido</button>}
        </div>
      )}
      <h3>Pagos</h3>
      {o.payments.length === 0 ? <Empty text="Sin pagos registrados." /> : (
        <div className="scroll"><table><thead><tr><th>Código</th><th>Monto</th><th>Método</th><th>Estado</th><th /></tr></thead>
          <tbody>{o.payments.map((p) => (
            <tr key={p.id}><td>{p.code}</td><td>{money(p.amount)}</td><td>{p.method}{p.reference ? ` · ${p.reference}` : ""}</td><td>{PAY_STATUS[p.status]}{p.reason ? ` (${p.reason})` : ""}</td>
              <td className="actions"><PaymentActions p={p} onDone={() => { d.reload(); onChanged(); }} setErr={setErr} /></td></tr>))}</tbody></table></div>
      )}
      {can("payments.write") && !["cancelled"].includes(o.status) && s.registrable > 0 && (
        <form onSubmit={addPayment} className="row">
          <input type="number" min="0.01" step="0.01" max={s.registrable} placeholder={`Monto (máx. ${s.registrable.toFixed(2)})`} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
          <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{["efectivo", "transferencia", "yape", "plin", "tarjeta_pos", "otro"].map((m) => <option key={m}>{m}</option>)}</select>
          <input placeholder="Referencia / operación" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          <input placeholder="Dónde está el comprobante" value={form.evidenceRef} onChange={(e) => setForm({ ...form, evidenceRef: e.target.value })} />
          <button type="submit">Registrar pago (pendiente de verificación)</button>
        </form>
      )}
      <p className="muted">Creado {dateTime(o.createdAt)}. Un pago solo cuenta cuando otra persona autorizada lo verifica.</p>
    </aside>
  );
}

export function PaymentActions({ p, onDone, setErr }: { p: { id: string; status: string }; onDone: () => void; setErr: (m: string | null) => void }) {
  const { can } = useAuth();
  const run = async (path: string, body?: object) => { setErr(null); try { await request(`/payments/${p.id}/${path}`, { method: "POST", ...(body ? json(body) : {}) }); onDone(); } catch (x) { setErr(errorMessage(x)); } };
  const ask = (path: string, label: string) => { const reason = window.prompt(label); if (reason) void run(path, { reason }); };
  return (
    <>
      {can("payments.write") && p.status === "pending" && <button onClick={() => void run("review")}>En revisión</button>}
      {can("payments.verify") && ["pending", "in_review"].includes(p.status) && <><button onClick={() => void run("verify")}>Verificar</button><button onClick={() => ask("reject", "Motivo del rechazo")}>Rechazar</button></>}
      {can("payments.verify") && p.status === "verified" && <button onClick={() => ask("refund", "Motivo del reembolso")}>Reembolsar</button>}
    </>
  );
}
