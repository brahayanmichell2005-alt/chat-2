export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

export interface ChatRequest {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  json: boolean;
  temperature: number;
  maxTokens: number;
  numCtx: number;
  timeoutMs: number;
}
export interface ChatResult { content: string; tokensIn?: number; tokensOut?: number }

export type AiErrorKind = "unavailable" | "timeout" | "model_missing" | "http" | "empty";
export class AiError extends Error {
  kind: AiErrorKind;
  constructor(kind: AiErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Contrato que aísla al proveedor de IA (Ollama hoy; otro mañana). */
export interface AIProvider {
  chat(req: ChatRequest): Promise<ChatResult>;
  health(baseUrl: string, model: string, timeoutMs?: number): Promise<{ ok: boolean; models: string[]; modelAvailable: boolean; error?: string }>;
}
