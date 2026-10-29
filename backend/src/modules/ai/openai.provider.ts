import { getEnv } from "../../config/env.js";
import { AiError, type AIProvider, type ChatRequest, type ChatResult } from "./provider.js";

/**
 * Proveedor universal compatible con la API de OpenAI (POST /chat/completions).
 * Sirve para servicios con nivel gratuito: Groq, Gemini (endpoint OpenAI), OpenRouter, etc.
 * La clave se toma de la variable AI_API_KEY — nunca se guarda en la base de datos.
 */
export class OpenAiCompatProvider implements AIProvider {
  private key(): string | undefined {
    const k = getEnv().AI_API_KEY;
    return k && k.trim() ? k.trim() : undefined;
  }

  private headers() {
    const key = this.key();
    if (!key) throw new AiError("unavailable", "Falta AI_API_KEY en el .env del servidor (AI_PROVIDER=openai).");
    return { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    try {
      const headers = this.headers();
      const res = await fetch(`${req.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        signal: ctrl.signal,
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
        }),
      });
      if (res.status === 404) throw new AiError("model_missing", `El modelo "${req.model}" no existe o no está disponible en el servicio`);
      if (res.status === 401 || res.status === 403) throw new AiError("unavailable", "AI_API_KEY inválida o sin permisos (revise la clave en el .env)");
      if (res.status === 429) throw new AiError("unavailable", "Se alcanzó el límite del nivel gratuito (429). Esperará al próximo mensaje del cliente.");
      if (!res.ok) throw new AiError("http", `El servicio de IA respondió con estado ${res.status}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const content = data.choices?.[0]?.message?.content?.trim() ?? "";
      if (!content) throw new AiError("empty", "El servicio de IA devolvió una respuesta vacía");
      return { content, tokensIn: data.usage?.prompt_tokens, tokensOut: data.usage?.completion_tokens };
    } catch (e) {
      if (e instanceof AiError) throw e;
      if ((e as Error).name === "AbortError") throw new AiError("timeout", "El servicio de IA tardó demasiado en responder");
      throw new AiError("unavailable", "No se pudo conectar con el servicio de IA (revise baseUrl/AI_API_KEY)");
    } finally {
      clearTimeout(timer);
    }
  }

  async health(baseUrl: string, model: string, timeoutMs = 5000) {
    try {
      const headers = this.headers();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { headers, signal: ctrl.signal });
        if (!res.ok) return { ok: false, models: [], modelAvailable: false, error: `Estado ${res.status}` };
        const data = (await res.json()) as { data?: { id: string }[]; models?: { id?: string; name?: string }[] };
        const list = data.data ?? data.models ?? [];
        const models = list.map((m) => ("id" in m ? m.id : (m as { name: string }).name)).filter((m): m is string => Boolean(m));
        return { ok: true, models, modelAvailable: models.includes(model) };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      if (e instanceof AiError) return { ok: false, models: [], modelAvailable: false, error: e.message };
      return { ok: false, models: [], modelAvailable: false, error: "No se pudo conectar con el servicio de IA" };
    }
  }
}
