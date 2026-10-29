import { AppError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Valida un parámetro de ruta UUID; si no es válido responde 404 (no filtra información). */
export function uuidParam(v: unknown): string {
  if (!isUuid(v)) throw new AppError(404, "NOT_FOUND", "Recurso no encontrado");
  return v;
}

export function pgCode(e: unknown): string | undefined {
  return (e as { code?: string })?.code;
}

/** Escapa comodines de LIKE/ILIKE. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
