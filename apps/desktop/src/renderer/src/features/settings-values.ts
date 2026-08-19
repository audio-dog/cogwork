export function parseCount(raw: string, min: number): number {
  const digits = raw.replace(/\D/g, "");
  return Math.max(min, Number(digits) || min);
}

export function sanitizeCountDraft(raw: string): string {
  return raw.replace(/\D/g, "");
}
