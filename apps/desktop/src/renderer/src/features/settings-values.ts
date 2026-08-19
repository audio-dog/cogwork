export function parseCount(raw: string, min: number): number {
  const digits = raw.replace(/\D/g, "");
  return Math.max(min, Number(digits) || min);
}

export function parseBudget(raw: string): number {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const dotIndex = cleaned.indexOf(".");
  const normalized =
    dotIndex === -1
      ? cleaned
      : `${cleaned.slice(0, dotIndex)}.${cleaned
          .slice(dotIndex + 1)
          .replace(/\./g, "")
          .slice(0, 2)}`;
  if (normalized === "" || normalized === ".") return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function seededValue(override: number | null, seed: number | null, fallback: number): number {
  return override ?? seed ?? fallback;
}
