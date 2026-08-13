import { useEffect, useState } from "react";
import type { EngineStatus } from "../../../shared/ipc";

export type EngineStatusValue = EngineStatus | "unknown";

export function useEngineStatus() {
  const [status, setStatus] = useState<EngineStatusValue>("unknown");

  useEffect(() => {
    window.cogwork.getEngineStatus().then(setStatus);
    return window.cogwork.onEngineStatus(setStatus);
  }, []);

  const setEnabled = (enabled: boolean) => {
    window.cogwork.setEngineEnabled(enabled).then(setStatus);
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
