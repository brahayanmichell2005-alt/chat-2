import { NavLink, Outlet } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { dateTime, useFetch, useInterval } from "../hooks";
import { request } from "../services/api";

const LABEL: Record<string, string> = {
  handoff_pending: "Conversación pendiente de persona", handoff_assigned: "Conversación transferida a usted", new_message: "Nuevo mensaje del cliente",
  ai_paused_external: "IA pausada: se escribió desde el celular", whatsapp_error: "WhatsApp: conexión con errores", whatsapp_logged_out: "WhatsApp: sesión cerrada",
};
interface Notif { id: string; type: string; readAt: string | null; createdAt: string }

export default function Layout() {
  const { user, logout, can } = useAuth();
  const [open, setOpen] = useState(false);
  const n = useFetch(() => request<{ items: Notif[]; unread: number }>("/notifications"), []);
  useInterval(n.reload, 10000);
  const links: [string, string, boolean][] = [
    ["/conversaciones", "Conversaciones", can("conversations.read_all") || can("conversations.read_assigned")],
    ["/clientes", "Clientes", can("customers.read")],
    ["/productos", "Productos", can("catalog.read")],
    ["/cotizaciones", "Cotizaciones", can("quotes.read")],
    ["/pedidos", "Pedidos", can("orders.read")],
    ["/pagos", "Pagos", can("payments.read")],
    ["/servicios", "Servicios", can("catalog.read")],
    ["/whatsapp", "WhatsApp", can("whatsapp.read")],
    ["/ia", "IA", can("ai.manage")],
    ["/ajustes", "Ajustes", can("settings.read")],
  ];
  return (
    <>
      <header className="bar">
        <nav>
          <NavLink to="/" end>Inicio</NavLink>
          {links.filter((l) => l[2]).map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}
        </nav>
        <span className="row">
          <button onClick={() => setOpen(!open)} aria-label="Avisos">Avisos{n.data && n.data.unread > 0 ? ` (${n.data.unread})` : ""}</button>
          {user?.name} <button onClick={() => void logout()}>Salir</button>
        </span>
      </header>
      {open && (
        <div className="card wide notif">
          {n.data?.items.length ? <ul>{n.data.items.map((x) => <li key={x.id} style={{ fontWeight: x.readAt ? 400 : 700 }}>{LABEL[x.type] ?? x.type} <small>{dateTime(x.createdAt)}</small></li>)}</ul> : <p className="muted">Sin avisos.</p>}
          <button onClick={() => void request("/notifications/read-all", { method: "POST" }).then(n.reload)}>Marcar como leídos</button>
        </div>
      )}
      <main className="page"><Outlet /></main>
    </>
  );
}
