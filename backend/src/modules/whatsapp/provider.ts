/** Contrato que aísla a Baileys. Para migrar a la API oficial solo hay que escribir otro proveedor. */
export interface IncomingMessage {
  waMessageId: string;
  jid: string;
  /** Número real (…@s.whatsapp.net) cuando WhatsApp entrega un identificador oculto (@lid) y además informa el número. */
  altJid?: string;
  pushName?: string;
  text: string;
  timestamp: Date;
  fromMe: boolean;
}

export type CloseReason = "logged_out" | "other";

export interface ProviderHandlers {
  onQr(qr: string): void;
  onConnecting(): void;
  onOpen(): void;
  onClose(info: { reason: CloseReason; error?: string }): void;
  onMessage(m: IncomingMessage): void;
}

/** Se lanza cuando el mensaje seguro NO salió (no hay conexión): es reintentable sin riesgo de duplicar. */
export class NotConnectedError extends Error {
  constructor() {
    super("WhatsApp no está conectado");
  }
}

export interface WhatsAppProvider {
  start(handlers: ProviderHandlers): Promise<void>;
  /** Cierra el socket sin borrar la sesión guardada. */
  stop(): Promise<void>;
  /** Cierra la sesión en WhatsApp y borra las credenciales locales. */
  logout(): Promise<void>;
  generateMessageId(): string;
  sendText(jid: string, text: string, messageId: string): Promise<void>;
  hasSavedSession(): Promise<boolean>;
}
