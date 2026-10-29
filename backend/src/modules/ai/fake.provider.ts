import { AiError, type AIProvider, type ChatRequest, type ChatResult } from "./provider.js";

/** Proveedor simulado para pruebas: devuelve respuestas guionadas en orden. */
export class FakeAiProvider implements AIProvider {
  script: (string | AiError)[] = [];
  calls: ChatRequest[] = [];
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls.push(req);
    const next = this.script.shift();
    if (next === undefined) throw new AiError("empty", "sin guion");
    if (next instanceof AiError) throw next;
    return { content: next, tokensIn: 10, tokensOut: 10 };
  }
  async health() { return { ok: true, models: ["fake"], modelAvailable: true }; }
}
