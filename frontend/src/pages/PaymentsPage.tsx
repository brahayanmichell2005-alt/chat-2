import { useState } from "react";
import { dateTime, money, useFetch } from "../hooks";
import { Empty, Err, Pager } from "../ui";
import { request, type Page } from "../services/api";
import { PAY_STATUS, PaymentActions } from "./OrdersPage";

interface Row { id: string; code: string; orderCode: string; customerName: string; amount: number; method: string; reference: string | null; evidenceRef: string | null; status: string; registeredBy: string | null; createdAt: string }

export default function PaymentsPage() {
  const [status, setStatus] = useState("pending");
  const [page, setPage] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const list = useFetch(() => request<Page<Row>>(`/payments?page=${page}&limit=20${status ? `&status=${status}` : ""}`), [status, page]);
  return (
    <section>
      <h1>Pagos por verificar</h1>
      <div className="row"><select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
        <option value="">Todos</option>{Object.entries(PAY_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
      <Err msg={err ?? list.error} />
      {list.data && list.data.items.length === 0 ? <Empty text="No hay pagos en este estado." /> : (
        <div className="scroll"><table><thead><tr><th>Pago</th><th>Pedido</th><th>Cliente</th><th>Monto</th><th>Método / referencia</th><th>Comprobante</th><th>Registró</th><th>Fecha</th><th>Estado</th><th /></tr></thead>
          <tbody>{list.data?.items.map((p) => (
            <tr key={p.id}><td>{p.code}</td><td>{p.orderCode}</td><td>{p.customerName}</td><td>{money(p.amount)}</td><td>{p.method}{p.reference ? ` · ${p.reference}` : ""}</td><td>{p.evidenceRef ?? "—"}</td>
              <td>{p.registeredBy ?? "—"}</td><td>{dateTime(p.createdAt)}</td><td>{PAY_STATUS[p.status]}</td>
              <td className="actions"><PaymentActions p={p} onDone={list.reload} setErr={setErr} /></td></tr>))}</tbody></table></div>
      )}
      {list.data && <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />}
    </section>
  );
}
