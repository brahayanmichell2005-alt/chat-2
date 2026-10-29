import type pg from "pg";
import QRCode from "qrcode";
import { AppError } from "../../common/errors.js";
import { getLogger } from "../../common/logger.js";
import { getEnv } from "../../config/env.js";
import { getPool } from "../../database/pool.js";
import { notifyByPermission } from "../notifications/notifications.service.js";
import { BaileysProvider } from "./baileys.provider.js";
import { handleIncoming } from "./ingest.service.js";
import type { ProviderHandlers, WhatsAppProvider } from "./provider.js";
import { MAX_RECONNECT_ATTEMPTS, reconnectDelayMs } from "./rules.js";

export type SessionStatus = "disconnected" | "connecting" | "qr" | "connected" | "error";
const SESSION_LOCK_KEY = 727002;

export class WhatsAppManager {
  status: SessionStatus = "disconnected";
  private qr: string | null = null;
  private attempts = 0;
  private timer: NodeJS.Timeout | null = null;
  private lockClient: pg.PoolClient | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private stopping = false;
  readonly provider: WhatsAppProvider;

  constructor(provider: WhatsAppProvider) {
    this.provider = provider;
  }

  /** Serializa connect/disconnect/reconnect para evitar operaciones simultáneas. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async persist(error?: string | null) {
    await getPool().query(
      `UPDATE whatsapp_sessions SET status = $1, last_error = $2, updated_at = now(),
         last_connected_at = CASE WHEN $1 = 'connected' THEN now() ELSE last_connected_at END WHERE id = 'main'`,
      [this.status, error ?? null]).catch((e) => getLogger().error({ err: e }, "No se pudo guardar el estado de WhatsApp"));
  }

  private setStatus(s: SessionStatus, error?: string | null) {
    this.status = s;
    void this.persist(error);
  }

  private handlers(): ProviderHandlers {
    return {
      onQr: (qr) => { this.qr = qr; this.setStatus("qr"); },
      onConnecting: () => { if (this.status !== "qr") this.setStatus("connecting"); },
      onOpen: () => { this.qr = null; this.attempts = 0; this.setStatus("connected"); },
      onClose: ({ reason, error }) => void this.onClose(reason, error),
      onMessage: (m) => { void handleIncoming(m).catch((e) => getLogger().error({ err: e }, "Error al procesar mensaje entrante")); },
    };
  }

  private async onClose(reason: "logged_out" | "other", error?: string) {
    this.qr = null;
    if (this.stopping) { this.setStatus("disconnected"); return; }
    if (reason === "logged_out") {
      await this.provider.logout().catch(() => undefined);
      await this.releaseLock();
      this.setStatus("disconnected", "Sesión cerrada desde el teléfono");
      await notifyByPermission(["whatsapp.manage"], "whatsapp_logged_out", {}).catch(() => undefined);
      return;
    }
    this.attempts++;
    if (this.attempts > MAX_RECONNECT_ATTEMPTS) {
      this.setStatus("error", error ?? "Se agotaron los reintentos de conexión");
      await notifyByPermission(["whatsapp.manage"], "whatsapp_error", { error: error ?? null }).catch(() => undefined);
      return;
    }
    this.setStatus("connecting", error ?? null);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.provider.start(this.handlers()).catch((e) => void this.onClose("other", (e as Error).message));
    }, reconnectDelayMs(this.attempts));
  }

  private async acquireLock() {
    if (this.lockClient) return;
    const client = await getPool().connect();
    const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [SESSION_LOCK_KEY]);
    if (!r.rows[0]?.ok) {
      client.release();
      throw new AppError(409, "SESSION_IN_USE", "Otra instancia del backend ya tiene la sesión de WhatsApp");
    }
    this.lockClient = client;
  }

  private async releaseLock() {
    const c = this.lockClient;
    this.lockClient = null;
    if (c) { await c.query("SELECT pg_advisory_unlock($1)", [SESSION_LOCK_KEY]).catch(() => undefined); c.release(); }
  }

  connect() {
    return this.exclusive(async () => {
      if (["connecting", "qr", "connected"].includes(this.status)) return this.snapshot();
      await this.acquireLock();
      this.stopping = false;
      this.attempts = 0;
      this.setStatus("connecting");
      try { await this.provider.start(this.handlers()); }
      catch (e) { await this.releaseLock(); this.setStatus("error", (e as Error).message); throw new AppError(500, "WHATSAPP_START_FAILED", "No se pudo iniciar la conexión con WhatsApp"); }
      return this.snapshot();
    });
  }

  /** logout=true desvincula el dispositivo y borra la sesión (habrá que escanear un QR nuevo). */
  disconnect(logout = false) {
    return this.exclusive(async () => {
      this.stopping = true;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (logout) await this.provider.logout(); else await this.provider.stop();
      this.qr = null;
      await this.releaseLock();
      this.setStatus("disconnected");
      return this.snapshot();
    });
  }

  async reconnect() {
    await this.disconnect(false);
    return this.connect();
  }

  snapshot() {
    return { status: this.status, hasQr: this.status === "qr" && this.qr !== null, reconnectAttempts: this.attempts };
  }

  async getQrDataUrl(): Promise<string | null> {
    if (this.status !== "qr" || !this.qr) return null;
    return QRCode.toDataURL(this.qr, { margin: 1, width: 320 });
  }

  async autoConnectIfConfigured() {
    if (getEnv().WHATSAPP_AUTOCONNECT && (await this.provider.hasSavedSession())) await this.connect().catch((e) => getLogger().error({ err: e }, "Autoconexión fallida"));
  }

  async shutdown() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.provider.stop().catch(() => undefined);
    await this.releaseLock();
  }
}

let manager: WhatsAppManager | undefined;
export function getManager(): WhatsAppManager {
  manager ??= new WhatsAppManager(new BaileysProvider(getEnv().WHATSAPP_SESSION_PATH));
  return manager;
}
/** Solo para pruebas: inyecta un proveedor simulado. */
export function setManagerForTests(m: WhatsAppManager | undefined) {
  manager = m;
}
