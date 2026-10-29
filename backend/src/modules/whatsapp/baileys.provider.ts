import fs from "node:fs/promises";
import path from "node:path";
import { pino } from "pino";
import makeWASocket, {
  DisconnectReason, fetchLatestBaileysVersion, generateMessageID, normalizeMessageContent, useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import { NotConnectedError, type ProviderHandlers, type WhatsAppProvider } from "./provider.js";

const IGNORED_TYPES = new Set(["protocolMessage", "reactionMessage", "editedMessage", "senderKeyDistributionMessage", "messageContextInfo", "pollUpdateMessage"]);

/**
 * Integración NO OFICIAL con WhatsApp Web (Baileys). Puede dejar de funcionar sin aviso y la cuenta puede ser restringida
 * por WhatsApp. Úsese con un número de pruebas y volumen bajo. No contiene técnicas anti-detección.
 */
export class BaileysProvider implements WhatsAppProvider {
  private sock: WASocket | null = null;
  private open = false;
  private generation = 0;
  private warnedNoAlt = false;

  constructor(private readonly sessionDir: string) {}

  async hasSavedSession(): Promise<boolean> {
    try { return (await fs.readdir(this.sessionDir)).includes("creds.json"); } catch { return false; }
  }

  generateMessageId(): string { return generateMessageID(); }

  async start(h: ProviderHandlers): Promise<void> {
    await this.stop();
    const gen = ++this.generation;
    await fs.mkdir(path.resolve(this.sessionDir), { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(path.resolve(this.sessionDir));
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: pino({ level: "silent" }) as never,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: ["whatsapp-tech-crm", "Chrome", "1.0.0"],
    });
    this.sock = sock;
    h.onConnecting();

    sock.ev.on("creds.update", () => { void saveCreds(); });
    sock.ev.on("connection.update", (u) => {
      if (gen !== this.generation) return; // evento de un socket anterior
      if (u.qr) h.onQr(u.qr);
      if (u.connection === "open") { this.open = true; h.onOpen(); }
      if (u.connection === "close") {
        this.open = false;
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        h.onClose({ reason: code === DisconnectReason.loggedOut ? "logged_out" : "other", error: (u.lastDisconnect?.error as Error | undefined)?.message });
      }
    });
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (gen !== this.generation) return;
      for (const m of messages) {
        // "notify" = mensajes nuevos. "append" = historial o mensajes propios escritos desde el teléfono: solo se aceptan
        // los propios y recientes (para no importar historial antiguo).
        const sentAt = Number(m.messageTimestamp ?? Date.now() / 1000) * 1000;
        const recentOwn = type === "append" && !!m.key.fromMe && Date.now() - sentAt < 120_000;
        if (type !== "notify" && !recentOwn) continue;
        if (m.key.fromMe || type !== "notify") {
          // Diagnóstico sin contenido ni números: tipo de evento, si es propio, tipo de identificador y antigüedad.
          console.info(`[whatsapp] evento tipo=${type} propio=${!!m.key.fromMe} contacto=${m.key.remoteJid?.endsWith("@lid") ? "lid" : m.key.remoteJid?.endsWith("@g.us") ? "grupo" : "numero"} edad_s=${Math.round((Date.now() - sentAt) / 1000)} aceptado=${type === "notify" || recentOwn}`);
        }
        const jid = m.key.remoteJid;
        const id = m.key.id;
        const content = normalizeMessageContent(m.message);
        if (!jid || !id || !content) continue;
        const keys = Object.keys(content).filter((k) => !IGNORED_TYPES.has(k));
        if (keys.length === 0) continue;
        const c = content as Record<string, { caption?: string; text?: string } | string | undefined>;
        const text =
          (typeof c.conversation === "string" ? c.conversation : undefined) ??
          (c.extendedTextMessage as { text?: string } | undefined)?.text ??
          (c.imageMessage as { caption?: string } | undefined)?.caption ??
          (c.videoMessage as { caption?: string } | undefined)?.caption ??
          (c.documentMessage as { caption?: string } | undefined)?.caption ??
          `[${keys[0]}]`;
        const k = m.key as unknown as Record<string, unknown>;
        const altJid = [k.senderPn, k.remoteJidAlt, k.participantPn].find((v): v is string => typeof v === "string" && v.endsWith("@s.whatsapp.net"));
        if (jid.endsWith("@lid") && !altJid && !this.warnedNoAlt) {
          this.warnedNoAlt = true;
          console.info("[whatsapp] Contacto con identificador oculto (@lid) sin número alterno. Campos de la clave:", Object.keys(k).join(","));
        }
        const ts = Number(m.messageTimestamp ?? Date.now() / 1000);
        h.onMessage({ waMessageId: id, jid, altJid, pushName: m.pushName ?? undefined, text, timestamp: new Date(ts * 1000), fromMe: !!m.key.fromMe });
      }
    });
  }

  async stop(): Promise<void> {
    this.generation++;
    this.open = false;
    const s = this.sock;
    this.sock = null;
    if (s) { try { s.ev.removeAllListeners("connection.update"); s.end(undefined); } catch { /* ya cerrado */ } }
  }

  async logout(): Promise<void> {
    try { await this.sock?.logout(); } catch { /* sin conexión: se borra igualmente la sesión local */ }
    await this.stop();
    await fs.rm(path.resolve(this.sessionDir), { recursive: true, force: true });
  }

  async sendText(jid: string, text: string, messageId: string): Promise<void> {
    if (!this.sock || !this.open) throw new NotConnectedError();
    await this.sock.sendMessage(jid, { text }, { messageId });
  }
}
