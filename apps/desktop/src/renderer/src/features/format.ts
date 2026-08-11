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
