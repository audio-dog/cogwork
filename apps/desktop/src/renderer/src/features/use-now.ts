import { useIntervalEffect } from "@react-hookz/web";
import { useState } from "react";

/**
 * A wall-clock that re-renders on a fixed cadence, so live durations (elapsed
 * time on a running run) keep ticking without a per-component `setInterval`.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useIntervalEffect(() => setNow(Date.now()), intervalMs);
  return now;
}
