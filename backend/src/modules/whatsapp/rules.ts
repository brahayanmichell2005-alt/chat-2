/** Reglas puras (sin E/S) del módulo de WhatsApp; fáciles de probar. */

export function shouldIgnoreJid(jid: string): boolean {
  return jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter");
}

/** Clave de contacto: "+<número>" para números normales; "lid:<id>" para identificadores ocultos de WhatsApp. */
export function contactKeyFromJid(jid: string): string | null {
  const [user, server] = jid.split("@");
  if (!user || !server) return null;
  const id = user.split(":")[0]!;
  if (server === "s.whatsapp.net" && /^\d{8,15}$/.test(id)) return `+${id}`;
  if (server === "lid" && /^\d+$/.test(id)) return `lid:${id}`;
  return null;
}

/** JID de envío a partir de la clave de contacto (o del JID guardado). */
export function jidForContact(phoneKey: string, savedJid: string | null): string | null {
  if (savedJid) return savedJid;
  return /^\+\d{8,15}$/.test(phoneKey) ? `${phoneKey.slice(1)}@s.whatsapp.net` : null;
}

export type SendMode = "off" | "allowlist" | "all";

export function sendGate(mode: SendMode, allowed: string[], phoneKey: string): { ok: true } | { ok: false; reason: string } {
  if (mode === "off") return { ok: false, reason: "Envío deshabilitado (WHATSAPP_SEND_MODE=off)" };
  if (mode === "all") return { ok: true };
  const digits = phoneKey.replace(/\D/g, "");
  return allowed.includes(digits) ? { ok: true } : { ok: false, reason: "Número fuera de la lista de pruebas permitida" };
}

/** Espera antes del reintento n (1, 2, 3…). */
export function retryDelayMs(attempt: number): number {
  return [2_000, 10_000, 30_000][Math.min(attempt, 3) - 1] ?? 30_000;
}

export const MAX_SEND_ATTEMPTS = 3;

/** Espera antes de reintentar la conexión (backoff exponencial con tope). */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, attempt - 1), 60_000);
}
export const MAX_RECONNECT_ATTEMPTS = 5;

/** La IA solo puede responder si nadie más tiene el control y la conversación no está cerrada. */
export function aiMayRespond(c: { controlMode: string; status: string }): boolean {
  return c.controlMode === "ai" && c.status !== "closed";
}

/** En modo "allowlist" solo se registran conversaciones de los números de prueba (evita volcar chats personales al CRM). */
export function ingestAllowed(mode: SendMode, allowed: string[], ...keys: (string | null | undefined)[]): boolean {
  if (mode !== "allowlist") return true;
  return keys.some((k) => !!k && allowed.includes(k.replace(/\D/g, "")));
}
