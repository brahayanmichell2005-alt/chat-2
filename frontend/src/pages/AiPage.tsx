import { useEffect, useState, type FormEvent } from "react";
import { dateTime, useFetch } from "../hooks";
import { Err, Field } from "../ui";
import { errorMessage, json, request } from "../services/api";

interface Settings {
  enabled: boolean; baseUrl: string; model: string; temperature: number; maxOutputTokens: number; numCtx: number; timeoutMs: number;
  historyMessages: number; debounceMs: number; maxToolSteps: number; greetingPauseMinutes: number; contingencyMessage: string; extraInstructions: string; promptVersion: string;
}
interface Health { ok: boolean; models: string[]; modelAvailable: boolean; error?: string; model: string }
interface TestOk { kind: "reply"; reply: string; needsHuman: boolean; handoffReason?: string; intents: string[]; tools: string[]; latencyMs: number; problems: string[] }
interface TestFail { kind: "contingency"; reason: string; detail: string; tools: string[]; latencyMs: number; problems: string[] }
interface Turn { role: "user" | "assistant"; text: string }
interface Usage { id: number; model: string | null; outcome: string; detail: string | null; latencyMs: number | null; tools: string[]; intents: string[]; createdAt: string }

export default function AiPage() {
  const st = useFetch(() => request<Settings>("/ai/settings"), []);
  const usage = useFetch(() => request<{ items: Usage[] }>("/ai/usage"), []);
  const [form, setForm] = useState<Settings | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [last, setLast] = useState<TestOk | TestFail | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (st.data) setForm(st.data); }, [st.data]);

  async function save(e: FormEvent) {
    e.preventDefault(); if (!form) return;
    if (form.enabled && !st.data?.enabled && !window.confirm("Al activar la IA, responderá sola a los números permitidos por WHATSAPP_SEND_MODE. ¿Activar?")) return;
    setMsg(null); setErr(null);
    const { promptVersion: _pv, ...body } = form;
    try { await request("/ai/settings", { method: "PATCH", ...json(body) }); setMsg("Guardado."); st.reload(); } catch (x) { setErr(errorMessage(x)); }
  }
  async function checkHealth() { setErr(null); try { setHealth(await request<Health>("/ai/health")); } catch (x) { setErr(errorMessage(x)); } }
  async function send(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const next: Turn[] = [...turns, { role: "user", text }];
    setTurns(next); setText("");
    try {
      const r = await request<TestOk | TestFail>("/ai/test", { method: "POST", ...json({ messages: next }) });
      setLast(r);
      if (r.kind === "reply") setTurns([...next, { role: "assistant", text: r.reply }]);
      usage.reload();
    } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  }
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm(form ? { ...form, [k]: v } : form);
  const num = (k: keyof Settings) => (e: { target: { value: string } }) => set(k, Number(e.target.value) as never);

  return (
    <section className="split">
      <div>
        <h1>Asistente de IA</h1>
        <Err msg={st.error ?? err} />
        {form && (
          <form className="card wide" onSubmit={save}>
            <label className="inline"><input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} /> IA activa (responde sola a los clientes)</label>
            <Field label="Dirección del servicio de IA (baseUrl)"><input value={form.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} required /></Field>
            <Field label="Modelo"><input value={form.model} onChange={(e) => set("model", e.target.value)} required /></Field>
            <Field label="Temperatura (0 a 2)"><input type="number" step="0.1" min="0" max="2" value={form.temperature} onChange={num("temperature")} /></Field>
            <Field label="Máx. tokens de respuesta"><input type="number" min="50" max="4000" value={form.maxOutputTokens} onChange={num("maxOutputTokens")} /></Field>
            <Field label="Contexto (tokens)"><input type="number" min="1024" max="65536" value={form.numCtx} onChange={num("numCtx")} /></Field>
            <Field label="Tiempo de espera (ms)"><input type="number" min="5000" max="600000" value={form.timeoutMs} onChange={num("timeoutMs")} /></Field>
            <Field label="Mensajes de historial"><input type="number" min="2" max="50" value={form.historyMessages} onChange={num("historyMessages")} /></Field>
            <Field label="Espera antes de responder (ms)"><input type="number" min="0" max="30000" value={form.debounceMs} onChange={num("debounceMs")} /></Field>
            <Field label="Mensaje si la IA no está disponible"><textarea rows={2} value={form.contingencyMessage} onChange={(e) => set("contingencyMessage", e.target.value)} maxLength={500} /></Field>
            <Field label="Instrucciones adicionales de tono (opcional)"><textarea rows={3} value={form.extraInstructions} onChange={(e) => set("extraInstructions", e.target.value)} maxLength={2000} /></Field>
            <p className="muted">Versión de reglas internas: {st.data?.promptVersion}. Las reglas de seguridad no se pueden desactivar.</p>
            {msg && <p role="status">{msg}</p>}
            <div className="row"><button type="submit">Guardar</button><button type="button" onClick={() => void checkHealth()}>Probar conexión</button></div>
            {health && <p className={health.ok && health.modelAvailable ? "" : "error"}>{health.ok ? (health.modelAvailable ? `El servicio responde y el modelo "${health.model}" está disponible.` : `El servicio responde, pero no se encontró el modelo "${health.model}". Modelos: ${health.models.join(", ") || "ninguno"}`) : `Sin conexión: ${health.error}`}</p>}
          </form>
        )}
      </div>
      <div>
        <h2>Probador (no envía nada a WhatsApp)</h2>
        <p className="muted">Escribe como si fueras el cliente. Usa tu catálogo y ajustes reales. La primera respuesta del modelo puede tardar.</p>
        <div className="card wide">
          <ul className="msgs">{turns.map((t, i) => <li key={i} className={t.role === "assistant" ? "out" : "in"}><small>{t.role === "assistant" ? "Asistente" : "Cliente"}</small><br />{t.text}</li>)}</ul>
          {busy && <p className="muted">Generando respuesta…</p>}
          {last && (
            <p className="muted">
              {last.kind === "reply" ? `Intención: ${last.intents.join(", ") || "—"} · Herramientas: ${last.tools.join(", ") || "ninguna"} · ${(last.latencyMs / 1000).toFixed(1)} s${last.needsHuman ? ` · DERIVA A PERSONA (${last.handoffReason ?? "sin motivo"})` : ""}`
                : `Contingencia: ${last.reason} — ${last.detail}`}
              {last.problems.length > 0 ? ` · Correcciones: ${last.problems.join("; ")}` : ""}
            </p>
          )}
          <form className="row" onSubmit={send}>
            <input placeholder="Mensaje del cliente" value={text} onChange={(e) => setText(e.target.value)} required maxLength={2000} />
            <button type="submit" disabled={busy}>Enviar</button>
            <button type="button" onClick={() => { setTurns([]); setLast(null); }}>Nueva prueba</button>
          </form>
        </div>
        <h2>Últimos usos</h2>
        <div className="scroll"><table><thead><tr><th>Fecha</th><th>Resultado</th><th>Seg.</th><th>Detalle</th></tr></thead>
          <tbody>{usage.data?.items.slice(0, 15).map((u) => <tr key={u.id}><td>{dateTime(u.createdAt)}</td><td>{u.outcome}</td><td>{u.latencyMs ? (u.latencyMs / 1000).toFixed(1) : "—"}</td><td>{u.detail ?? ""}</td></tr>)}</tbody></table></div>
      </div>
    </section>
  );
}
