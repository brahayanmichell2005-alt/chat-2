import { useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { useFetch, useInterval, dateTime } from "../hooks";
import { Empty, Err, Pager } from "../ui";
import { errorMessage, json, request, type Page } from "../services/api";

interface Conv {
  id: string; status: string; priority: string; controlMode: string; assignedUserId: string | null; assignedUserName: string | null; phone: string;
  displayName: string | null; customerName: string | null; tags: string[]; lastMessage: string | null; lastMessageAt: string | null; createdAt: string;
}
interface Detail extends Conv { notes: { id: string; body: string; createdAt: string; userName: string | null }[] }
interface Tag { id: string; code: string; name: string }
interface Msg { id: string; direction: string; body: string | null; sentBy: string; status: string; lastError: string | null; createdAt: string }
const MSG_STATUS: Record<string, string> = { queued: "en cola", sending: "enviando", sent: "enviado", blocked: "bloqueado", failed: "falló", uncertain: "incierto (revisar)", cancelled: "cancelado", received: "" };
interface UserItem { id: string; name: string; roles: string[]; status: string }
const STATUS: Record<string, string> = { open: "Abierta", pending_human: "Pendiente de persona", closed: "Cerrada" };

export default function ConversationsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [newPhone, setNewPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const list = useFetch(() => {
    const p = new URLSearchParams({ page: String(page), limit: "20" });
    if (status) p.set("status", status);
    if (q) p.set("q", q);
    return request<Page<Conv>>(`/conversations?${p}`);
  }, [status, q, page]);

  useInterval(list.reload, 5000);

  async function create(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { const c = await request<Conv>("/conversations", { method: "POST", ...json({ phone: newPhone }) }); setNewPhone(""); list.reload(); setSelected(c.id); }
    catch (x) { setErr(errorMessage(x)); }
  }

  return (
    <section className="split">
      <div>
        <h1>Conversaciones</h1>
        <div className="row">
          <input placeholder="Buscar nombre o teléfono…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Todos los estados</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {can("customers.write") && (
          <form className="row" onSubmit={create}>
            <input placeholder="Nueva conversación manual: teléfono" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} required />
            <button type="submit">Crear</button>
          </form>
        )}
        <Err msg={err ?? list.error} />
        {list.data && list.data.items.length === 0 ? <Empty text="No hay conversaciones. Se crearán automáticamente al conectar WhatsApp (Etapa 4)." /> : (
          <ul className="list">{list.data?.items.map((c) => (
            <li key={c.id} className={c.id === selected ? "active" : ""} onClick={() => setSelected(c.id)}>
              <strong>{c.customerName ?? c.displayName ?? c.phone}</strong> <small>{STATUS[c.status]}{c.assignedUserName ? ` · ${c.assignedUserName}` : " · sin asignar"}</small>
              <br /><small>{c.lastMessage ?? "Sin mensajes"}</small>{c.tags.length > 0 && <><br /><small>{c.tags.join(" · ")}</small></>}
            </li>))}</ul>
        )}
        {list.data && <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />}
      </div>
      {selected && <ConversationDetail key={selected} id={selected} onChanged={list.reload} />}
    </section>
  );
}

function ConversationDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { can } = useAuth();
  const d = useFetch(() => request<Detail>(`/conversations/${id}`), [id]);
  const msgs = useFetch(() => request<{ items: Msg[] }>(`/conversations/${id}/messages`), [id]);
  const tags = useFetch(() => request<{ items: Tag[] }>("/conversations/tags"), []);
  const users = useFetch(() => (can("conversations.assign") && can("users.read") ? request<Page<UserItem>>("/users?limit=100") : Promise.resolve(null)), []);
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useInterval(() => { d.reload(); msgs.reload(); }, 5000);
  const canReply = can("conversations.reply");

  async function act(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); d.reload(); onChanged(); } catch (x) { setErr(errorMessage(x)); }
  }
  const c = d.data;
  if (!c) return <aside className="card wide">{d.error ? <Err msg={d.error} /> : "Cargando…"}</aside>;
  const tagIds = new Set(tags.data?.items.filter((t) => c.tags.includes(t.code)).map((t) => t.id));

  return (
    <aside className="card wide">
      <h2>{c.customerName ?? c.displayName ?? c.phone}</h2>
      <p>{c.phone} · {STATUS[c.status]} · IA: {c.controlMode === "ai" ? "activa" : c.controlMode === "human" ? "control humano" : "pausada"}</p>
      <Err msg={err} />
      {canReply && (
        <div className="row">
          <select value={c.status} onChange={(e) => void act(() => request(`/conversations/${id}/status`, { method: "PATCH", ...json({ status: e.target.value }) }))}>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select value={c.priority} onChange={(e) => void act(() => request(`/conversations/${id}/status`, { method: "PATCH", ...json({ priority: e.target.value }) }))}>
            <option value="low">Prioridad baja</option><option value="normal">Prioridad normal</option><option value="high">Prioridad alta</option></select>
        </div>
      )}
      {can("conversations.assign") && users.data && (
        <div className="row"><label className="inline">Asignado a
          <select value={c.assignedUserId ?? ""} onChange={(e) => void act(() => request(`/conversations/${id}/assign`, { method: "POST", ...json({ userId: e.target.value || null }) }))}>
            <option value="">Sin asignar</option>{users.data.items.filter((u) => u.status === "active").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select></label></div>
      )}
      <h3>Etiquetas</h3>
      <div className="row">{tags.data?.items.map((t) => (
        <label key={t.id} className="inline"><input type="checkbox" disabled={!canReply} checked={tagIds.has(t.id)}
          onChange={(e) => { const next = new Set(tagIds); if (e.target.checked) next.add(t.id); else next.delete(t.id); void act(() => request(`/conversations/${id}/tags`, { method: "PUT", ...json({ tagIds: [...next] }) })); }} /> {t.name}</label>))}</div>
      {canReply && (
        <div className="row">
          {c.controlMode !== "human" && <button onClick={() => { const reason = window.prompt("Motivo de la transferencia a una persona", "Atención manual"); if (reason) void act(() => request(`/conversations/${id}/handoff`, { method: "POST", ...json({ reason }) })); }}>Tomar control</button>}
          {c.controlMode !== "ai" && <button onClick={() => void act(() => request(`/conversations/${id}/resume-ai`, { method: "POST" }))}>Devolver a la IA</button>}
        </div>
      )}
      <h3>Mensajes</h3>
      {msgs.data?.items.length ? <ul className="msgs">{msgs.data.items.map((m) => (
        <li key={m.id} className={m.direction}><small>{m.sentBy === "customer" ? "Cliente" : m.sentBy === "ai" ? "IA" : "Equipo"} · {dateTime(m.createdAt)}{MSG_STATUS[m.status] ? ` · ${MSG_STATUS[m.status]}` : ""}</small><br />{m.body}
          {m.lastError && ["blocked", "failed", "uncertain"].includes(m.status) && <><br /><small className="error">{m.lastError}</small></>}</li>))}</ul>
        : <Empty text="Sin mensajes todavía." />}
      {canReply && c.status !== "closed" && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); const key = crypto.randomUUID(); void act(async () => { await request(`/conversations/${id}/messages`, { method: "POST", ...json({ text, idempotencyKey: key }) }); setText(""); msgs.reload(); }); }}>
          <input placeholder="Escribir respuesta (tomará el control de la conversación)" value={text} onChange={(e) => setText(e.target.value)} required maxLength={4000} /><button type="submit">Enviar</button>
        </form>
      )}
      <h3>Notas internas <small>(no se envían al cliente)</small></h3>
      {c.notes.length ? <ul>{c.notes.map((n) => <li key={n.id}>{n.body} <small>— {n.userName ?? "—"}, {dateTime(n.createdAt)}</small></li>)}</ul> : <Empty text="Sin notas." />}
      {canReply && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(async () => { await request(`/conversations/${id}/notes`, { method: "POST", ...json({ body: note }) }); setNote(""); }); }}>
          <input placeholder="Añadir nota interna" value={note} onChange={(e) => setNote(e.target.value)} required maxLength={4000} /><button type="submit">Añadir</button>
        </form>
      )}
    </aside>
  );
}
