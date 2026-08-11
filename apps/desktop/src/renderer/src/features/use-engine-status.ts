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
