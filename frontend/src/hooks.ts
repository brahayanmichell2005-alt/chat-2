import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./services/api";

/** Carga datos y expone estado de carga/error y recarga manual. */
export function useFetch<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    load().then(setData).catch((e) => setError(errorMessage(e))).finally(() => setLoading(false));
  }, deps);
  useEffect(run, [run]);
  return { data, error, loading, reload: run };
}

export const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN" }).format(n);
export const dateTime = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("es-PE") : "—");

/** Ejecuta fn cada ms milisegundos (recarga periódica sin SSE). */
export function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) ref.current(); }, ms);
    return () => clearInterval(t);
  }, [ms]);
}
