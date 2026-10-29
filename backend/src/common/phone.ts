/** Normaliza un teléfono a formato +<código><número>. Un número de 9 dígitos se asume de Perú (+51). */
export function normalizePhone(input: string, defaultCountry = "51"): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 9) return `+${defaultCountry}${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}
