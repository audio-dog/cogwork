import { scheduler } from "node:timers/promises";
import { isDaemonListening } from "./socket-probe";

const PROBE_INTERVAL_MILLIS = 50;

export const waitForDaemonListening = async (socketPath: string, signal: AbortSignal): Promise<boolean> => {
  if (signal.aborted) return false;
  if (await isDaemonListening(socketPath)) return true;

  return scheduler.wait(PROBE_INTERVAL_MILLIS, { signal }).then(
    () => waitForDaemonListening(socketPath, signal),
    () => false,
  );
};
