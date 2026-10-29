import type { ApiError, AuthUser } from "@crm/shared";

const BASE = "/api/v1";
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export class HttpError extends Error {
  status: number;
  body: ApiError | undefined;
  constructor(status: number, body?: ApiError) {
    super(body?.message ?? `Error ${status}`);
    this.status = status;
    this.body = body;
  }
}

export function setAccessToken(t: string | null) {
  accessToken = t;
}

async function raw(path: string, init: RequestInit = {}, withAuth = true): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Requested-With", "crm");
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (withAuth && accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  return fetch(`${BASE}${path}`, { ...init, headers, credentials: "same-origin" });
}

export interface Session {
  accessToken: string;
  user: AuthUser;
}

async function refreshSession(): Promise<Session | null> {
  const res = await raw("/auth/refresh", { method: "POST" }, false);
  if (!res.ok) return null;
  const s = (await res.json()) as Session;
  accessToken = s.accessToken;
  return s;
}

/** Refresco compartido: varias solicitudes simultáneas comparten una sola rotación. */
async function tryRefresh(): Promise<boolean> {
  refreshing ??= refreshSession().then((s) => !!s).finally(() => { refreshing = null; });
  return refreshing;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await raw(path, init);
  if (res.status === 401 && (await tryRefresh())) res = await raw(path, init);
  if (!res.ok) throw new HttpError(res.status, (await res.json().catch(() => undefined)) as ApiError | undefined);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export async function login(email: string, password: string): Promise<Session> {
  const res = await raw("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }, false);
  if (!res.ok) throw new HttpError(res.status, (await res.json().catch(() => undefined)) as ApiError | undefined);
  const s = (await res.json()) as Session;
  accessToken = s.accessToken;
  return s;
}

export async function restoreSession(): Promise<Session | null> {
  return refreshSession();
}

export async function logout(): Promise<void> {
  await raw("/auth/logout", { method: "POST" }, false).catch(() => undefined);
  accessToken = null;
}

export async function download(path: string, filename: string): Promise<void> {
  let res = await raw(path);
  if (res.status === 401 && (await tryRefresh())) res = await raw(path);
  if (!res.ok) throw new HttpError(res.status, (await res.json().catch(() => undefined)) as ApiError | undefined);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface Page<T> { items: T[]; page: number; limit: number; total: number }
export const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
export const errorMessage = (e: unknown): string => (e instanceof HttpError ? e.message : "No se pudo conectar con el servidor");
