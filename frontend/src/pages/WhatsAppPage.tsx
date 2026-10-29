import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { dateTime, useFetch, useInterval } from "../hooks";
import { Err } from "../ui";
import { errorMessage, json, request } from "../services/api";

interface Status { status: string; hasQr: boolean; reconnectAttempts: number; lastConnectedAt: string | null; lastError: string | null; sendMode: string; allowedNumbers: number }
const LABEL: Record<string, string> = { disconnected: "Desconectado", connecting: "Conectando…", qr: "Esperando escaneo del QR", connected: "Conectado", error: "Error de conexión" };
const MODE: Record<string, string> = { off: "APAGADO (no se envía ningún mensaje)", allowlist: "Solo a números de prueba permitidos", all: "A cualquier número" };

export default function WhatsAppPage() {
  const { can } = useAuth();
  const manage = can("whatsapp.manage");
  const st = useFetch(() => request<Status>("/whatsapp/status"), []);
  const qr = useFetch(() => (manage ? request<{ qr: string | null }>("/whatsapp/qr") : Promise.resolve({ qr: null })), []);
  const [err, setErr] = useState<string | null>(null);
  useInterval(() => { st.reload(); qr.reload(); }, 3000);

  async function act(path: string, body?: unknown) {
    setErr(null);
    try { await request(path, { method: "POST", ...(body ? json(body) : {}) }); st.reload(); qr.reload(); } catch (e) { setErr(errorMessage(e)); }
  }
  const s = st.data;
  return (
    <section>
      <h1>Conexión de WhatsApp</h1>
      <p className="muted">Integración no oficial (Baileys): puede desconectarse o la cuenta ser restringida por WhatsApp. Use un número de pruebas.</p>
      <Err msg={st.error ?? err} />
      {s && (
        <div className="card wide">
          <p><strong>Estado:</strong> {LABEL[s.status] ?? s.status}{s.reconnectAttempts > 0 ? ` (reintento ${s.reconnectAttempts})` : ""}</p>
          <p><strong>Última conexión:</strong> {dateTime(s.lastConnectedAt)}</p>
          <p><strong>Envío de mensajes:</strong> {MODE[s.sendMode] ?? s.sendMode}{s.sendMode === "allowlist" ? ` (${s.allowedNumbers} números)` : ""}</p>
          {s.lastError && <p className="error">Último error: {s.lastError}</p>}
          {qr.data?.qr && <div><p>Escanee con WhatsApp → Dispositivos vinculados:</p><img src={qr.data.qr} alt="Código QR de WhatsApp" width={280} height={280} /></div>}
          {manage ? (
            <div className="row">
              <button onClick={() => void act("/whatsapp/connect")} disabled={["connecting", "qr", "connected"].includes(s.status)}>Conectar</button>
              <button onClick={() => void act("/whatsapp/reconnect")}>Reiniciar conexión</button>
              <button onClick={() => void act("/whatsapp/disconnect", { logout: false })} disabled={s.status === "disconnected"}>Desconectar</button>
              <button onClick={() => { if (window.confirm("Se desvinculará el dispositivo y habrá que escanear un QR nuevo. ¿Continuar?")) void act("/whatsapp/disconnect", { logout: true }); }}>Desvincular dispositivo</button>
            </div>
          ) : <p className="muted">Solo un administrador puede conectar o desconectar.</p>}
        </div>
      )}
    </section>
  );
}
