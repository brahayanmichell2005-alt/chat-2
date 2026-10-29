import { z } from "zod";

const boolFromString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : ["1", "true", "yes"].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria").refine((v) => /^postgres(ql)?:\/\//.test(v), "Debe ser una URL postgresql://"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  APP_TIMEZONE: z.string().default("America/Lima"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET debe tener al menos 32 caracteres"),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().min(1).max(120).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  COOKIE_SECURE: boolFromString,
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  WHATSAPP_SESSION_PATH: z.string().default("./whatsapp-session"),
  // off = no envía nada; allowlist = solo a WHATSAPP_ALLOWED_NUMBERS; all = a cualquier número (solo tras terminar las pruebas)
  WHATSAPP_SEND_MODE: z.enum(["off", "allowlist", "all"]).default("off"),
  WHATSAPP_ALLOWED_NUMBERS: z.string().default("").transform((v) => v.split(",").map((x) => x.replace(/\D/g, "")).filter(Boolean)),
  WHATSAPP_MIN_SEND_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(1500),
  WHATSAPP_MAX_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(20),
  WHATSAPP_AUTOCONNECT: boolFromString,
  // ollama = servidor Ollama en baseUrl; openai = servicio con API compatible OpenAI (Groq/Gemini/OpenRouter, nivel gratuito)
  AI_PROVIDER: z.enum(["ollama", "openai"]).default("ollama"),
  AI_API_KEY: z.string().optional(),
});

export type Env = Omit<z.infer<typeof schema>, "COOKIE_SECURE" | "WHATSAPP_AUTOCONNECT"> & { COOKIE_SECURE: boolean; WHATSAPP_AUTOCONNECT: boolean };

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new Error(`Configuración inválida. Corrija las variables de entorno:\n${lines.join("\n")}`);
  }
  const v = parsed.data;
  const cookieSecure = v.COOKIE_SECURE ?? v.NODE_ENV === "production";
  if (v.NODE_ENV === "production" && !cookieSecure) {
    throw new Error("Configuración inválida: COOKIE_SECURE no puede ser false en producción.");
  }
  if (v.WHATSAPP_SEND_MODE === "allowlist" && v.WHATSAPP_ALLOWED_NUMBERS.length === 0) {
    throw new Error("Configuración inválida: WHATSAPP_SEND_MODE=allowlist requiere WHATSAPP_ALLOWED_NUMBERS.");
  }
  return { ...v, COOKIE_SECURE: cookieSecure, WHATSAPP_AUTOCONNECT: v.WHATSAPP_AUTOCONNECT ?? false };
}

let cached: Env | undefined;
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}
export function resetEnvForTests(): void {
  cached = undefined;
}
