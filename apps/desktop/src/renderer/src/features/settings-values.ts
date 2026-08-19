function normalizeBudgetRaw(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const dotIndex = cleaned.indexOf(".");
  if (dotIndex === -1) return cleaned;
  return `${cleaned.slice(0, dotIndex)}.${cleaned
    .slice(dotIndex + 1)
    .replace(/\./g, "")
    .slice(0, 2)}`;
}

export function parseCount(raw: string, min: number): number {
  const digits = raw.replace(/\D/g, "");
  return Math.max(min, Number(digits) || min);
}

export function sanitizeBudgetDraft(raw: string): string {
  return normalizeBudgetRaw(raw);
}

export function parseBudget(raw: string): number {
  const normalized = normalizeBudgetRaw(raw);
  if (normalized === "" || normalized === ".") return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function seededValue(override: number | null, seed: number | null, fallback: number): number {
  return override ?? seed ?? fallback;
}
