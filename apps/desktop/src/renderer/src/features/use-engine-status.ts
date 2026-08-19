import { useSyncExternalStore } from "react";
import type { EngineStatus } from "../../../shared/ipc";

export type EngineStatusValue = EngineStatus | "unknown";

let currentStatus: EngineStatusValue = "unknown";
let unsubscribeIpc: (() => void) | null = null;
const listeners = new Set<() => void>();

function setStatus(next: EngineStatusValue) {
  if (next === currentStatus) {
    return;
  }
  currentStatus = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (listeners.size === 1) {
    window.cogwork.getEngineStatus().then(setStatus);
    unsubscribeIpc = window.cogwork.onEngineStatus(setStatus);
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && unsubscribeIpc) {
      unsubscribeIpc();
      unsubscribeIpc = null;
    }
  };
}

function getSnapshot(): EngineStatusValue {
  return currentStatus;
}

export function useEngineStatus() {
  const status = useSyncExternalStore(subscribe, getSnapshot);

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
