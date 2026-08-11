import { useEffect, useState } from "react";
import type { EngineStatus } from "../../../shared/ipc";

export type EngineStatusValue = EngineStatus | "unknown";

export function useEngineStatus() {
  const [status, setStatus] = useState<EngineStatusValue>("unknown");

  useEffect(() => {
    window.clankerForge.getEngineStatus().then(setStatus);
    return window.clankerForge.onEngineStatus(setStatus);
  }, []);

  const setEnabled = (enabled: boolean) => {
    window.clankerForge.setEngineEnabled(enabled).then(setStatus);
  };

  return { status, setEnabled };
}

export type EnginePhase = "off" | "starting" | "up" | "failed";

export const engineIsOn = (status: EngineStatusValue) =>
  status === "running" || status === "starting" || status === "adopted";

const enginePhaseByStatus: Record<EngineStatusValue, EnginePhase> = {
  unknown: "off",
  stopped: "off",
  starting: "starting",
  running: "up",
  adopted: "up",
  failed: "failed",
};

export const enginePhase = (status: EngineStatusValue): EnginePhase => enginePhaseByStatus[status];
