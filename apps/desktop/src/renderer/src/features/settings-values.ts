export function parseCount(raw: string, min: number): number {
  const digits = raw.replace(/\D/g, "");
  return Math.max(min, Number(digits) || min);
}

export function parseBudget(raw: string): number {
  const digits = raw.replace(/\D/g, "");
  return Number(digits) || 0;
}

export function seededValue(override: number | null, seed: number | null, fallback: number): number {
  return override ?? seed ?? fallback;
}
