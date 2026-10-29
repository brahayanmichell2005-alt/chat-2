import { AiError, type AIProvider, type ChatRequest, type ChatResult } from "./provider.js";
import { MODEL_OUTPUT_SCHEMA } from "./parse.js";

export class OllamaProvider implements AIProvider {
  async chat(req: ChatRequest): Promise<ChatResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    try {
      const res = await fetch(`${req.baseUrl.replace(/\/+$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: false,
          ...(req.json ? { format: MODEL_OUTPUT_SCHEMA } : {}),
          keep_alive: "10m",
          options: { temperature: req.temperature, num_predict: req.maxTokens, num_ctx: req.numCtx },
        }),
      });
      if (res.status === 404) throw new AiError("model_missing", `El modelo "${req.model}" no está disponible en Ollama`);
      if (!res.ok) throw new AiError("http", `Ollama respondió con estado ${res.status}`);
      const data = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
      const content = data.message?.content?.trim() ?? "";
      if (!content) throw new AiError("empty", "Ollama devolvió una respuesta vacía");
      return { content, tokensIn: data.prompt_eval_count, tokensOut: data.eval_count };
    } catch (e) {
      if (e instanceof AiError) throw e;
      if ((e as Error).name === "AbortError") throw new AiError("timeout", "Ollama tardó demasiado en responder");
      throw new AiError("unavailable", "No se pudo conectar con Ollama (¿está encendido?)");
    } finally {
      clearTimeout(timer);
    }
  }

  async health(baseUrl: string, model: string, timeoutMs = 5000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) return { ok: false, models: [], modelAvailable: false, error: `Estado ${res.status}` };
      const data = (await res.json()) as { models?: { name: string }[] };
      const models = (data.models ?? []).map((m) => m.name);
      return { ok: true, models, modelAvailable: models.includes(model) };
    } catch {
      return { ok: false, models: [], modelAvailable: false, error: "No se pudo conectar con Ollama" };
    } finally {
      clearTimeout(timer);
    }
  }
}
