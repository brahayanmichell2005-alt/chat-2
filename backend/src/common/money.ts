/** Toda la aritmética de dinero se hace en céntimos enteros (sin errores de coma flotante). */
export const toCents = (n: number): number => Math.round(n * 100);
export const fromCents = (c: number): number => c / 100;
export const formatPen = (cents: number): string => `S/ ${(cents / 100).toFixed(2)}`;
