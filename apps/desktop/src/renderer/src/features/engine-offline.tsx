import type { EnginePhase } from "./use-engine-status";

const message: Record<Exclude<EnginePhase, "up">, string> = {
  off: "The engine is off. The app starts the engine at launch. Wait a moment. If the engine does not start, close the app and open it again.",
  starting: "The engine is starting…",
  failed: "The engine stopped and did not restart. Close the app and open it again.",
};

export function EngineOfflineMessage({ phase }: { phase: Exclude<EnginePhase, "up"> }) {
  return <>{message[phase]}</>;
}
