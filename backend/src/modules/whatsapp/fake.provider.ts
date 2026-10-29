import crypto from "node:crypto";
import { NotConnectedError, type IncomingMessage, type ProviderHandlers, type WhatsAppProvider } from "./provider.js";

/** Proveedor simulado para pruebas: no abre ninguna conexión real. */
export class FakeProvider implements WhatsAppProvider {
  handlers: ProviderHandlers | null = null;
  connected = false;
  saved = false;
  sent: { jid: string; text: string; messageId: string }[] = [];
  failWith: Error | null = null;

  async start(h: ProviderHandlers) { this.handlers = h; h.onConnecting(); }
  async stop() { this.connected = false; }
  async logout() { this.connected = false; this.saved = false; }
  async hasSavedSession() { return this.saved; }
  generateMessageId() { return `FAKE${crypto.randomBytes(8).toString("hex")}`; }
  async sendText(jid: string, text: string, messageId: string) {
    if (!this.connected) throw new NotConnectedError();
    if (this.failWith) { const e = this.failWith; this.failWith = null; throw e; }
    this.sent.push({ jid, text, messageId });
  }

  // Helpers de prueba
  open() { this.connected = true; this.saved = true; this.handlers?.onOpen(); }
  qr(code = "QR-TEST") { this.handlers?.onQr(code); }
  close(reason: "logged_out" | "other" = "other") { this.connected = false; this.handlers?.onClose({ reason, error: "test" }); }
  receive(m: Partial<IncomingMessage> & { jid: string; text: string }) {
    this.handlers?.onMessage({ waMessageId: `IN${crypto.randomBytes(6).toString("hex")}`, timestamp: new Date(), fromMe: false, ...m });
  }
}
