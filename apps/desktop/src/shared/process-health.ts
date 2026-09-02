export const ratePerSecond = (previous: number, current: number, elapsedMillis: number) => {
  if (elapsedMillis <= 0) return 0;
  return (Math.max(0, current - previous) * 1_000) / elapsedMillis;
};

export const kibibytesToBytes = (kibibytes: number) => kibibytes * 1_024;
