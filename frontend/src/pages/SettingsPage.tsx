import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { useFetch } from "../hooks";
import { Err, Field } from "../ui";
import { errorMessage, json, request } from "../services/api";

type Group = Record<string, string>;
interface Settings { company: Group; policies: Group }
const COMPANY: [string, string][] = [["name", "Nombre de la empresa"], ["phone", "Teléfono de contacto"], ["address", "Dirección"], ["hours", "Horarios de atención"], ["coverage", "Zonas de cobertura de instalación"]];
const POLICIES: [string, string][] = [["warranty", "Política de garantía"], ["payment", "Métodos de pago aceptados"], ["delivery", "Entregas y recojo"]];

export default function SettingsPage() {
  const { can } = useAuth();
  const canWrite = can("settings.write");
  const { data, error, reload } = useFetch(() => request<Settings>("/settings"), []);
  const [form, setForm] = useState<Settings>({ company: {}, policies: {} });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (data) setForm(data); }, [data]);

  async function save(e: FormEvent) {
    e.preventDefault(); setMsg(null); setErr(null);
    try { await request("/settings", { method: "PATCH", ...json(form) }); setMsg("Ajustes guardados."); reload(); }
    catch (x) { setErr(errorMessage(x)); }
  }
  const input = (g: keyof Settings, k: string, long: boolean) => long
    ? <textarea rows={3} maxLength={2000} disabled={!canWrite} value={form[g][k] ?? ""} onChange={(e) => setForm({ ...form, [g]: { ...form[g], [k]: e.target.value } })} />
    : <input maxLength={2000} disabled={!canWrite} value={form[g][k] ?? ""} onChange={(e) => setForm({ ...form, [g]: { ...form[g], [k]: e.target.value } })} />;

  return (
    <section>
      <h1>Ajustes de la empresa</h1>
      <p className="muted">Estos datos los usará el asistente como única fuente de verdad. Lo que quede vacío, el asistente no lo afirmará.</p>
      <Err msg={error} />
      <form className="card wide" onSubmit={save}>
        <h2>Empresa</h2>
        {COMPANY.map(([k, l]) => <Field key={k} label={l}>{input("company", k, k === "hours" || k === "coverage" || k === "address")}</Field>)}
        <h2>Políticas</h2>
        {POLICIES.map(([k, l]) => <Field key={k} label={l}>{input("policies", k, true)}</Field>)}
        <Err msg={err} />
        {msg && <p role="status">{msg}</p>}
        {canWrite && <button type="submit">Guardar</button>}
      </form>
    </section>
  );
}
