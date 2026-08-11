import type { EnginePhase } from "./use-engine-status";

const message: Record<Exclude<EnginePhase, "up">, string> = {
  off: "The engine is off. Turn it on with the switch in the header to connect to the daemon.",
  starting: "Starting the engine…",
  failed: "The engine failed to start. Check the engine switch in the header.",
};

export function EngineOfflineMessage({ phase }: { phase: Exclude<EnginePhase, "up"> }) {
  return <>{message[phase]}</>;
}
