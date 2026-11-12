export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export const relativeTime = (atMillis: number, now = Date.now()): string => {
  const mins = Math.floor(Math.max(0, now - atMillis) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export const elapsed = (fromMillis: number, now = Date.now()): string => {
  const mins = Math.floor(Math.max(0, now - fromMillis) / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
};

export const duration = (fromMillis: number, toMillis: number) => {
  const total = Math.floor(Math.max(0, toMillis - fromMillis) / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
};
