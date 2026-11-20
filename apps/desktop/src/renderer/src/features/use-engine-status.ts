import { useSyncExternalStore } from "react";

import type { EngineStatus } from "../../../shared/ipc";
import { reportRendererError } from "./report-error";

export type EngineStatusValue = EngineStatus | "unknown";

let currentStatus: EngineStatusValue = "unknown";
let restarting = false;
let unsubscribeIpc: (() => void) | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

function setStatus(next: EngineStatusValue) {
  if (restarting && (next === "stopped" || next === "unknown")) {
    return;
  }
  if (next === currentStatus) {
    return;
  }
  currentStatus = next;
  notifyListeners();
}

function setRestarting(next: boolean) {
  if (next === restarting) {
    return;
  }
  restarting = next;
  notifyListeners();
}

function syncStatus() {
  return window.cogwork.getEngineStatus().then(setStatus);
}

function startStatusSubscription() {
  if (!unsubscribeIpc) {
    window.cogwork.getEngineStatus().then(setStatus);
    unsubscribeIpc = window.cogwork.onEngineStatus(setStatus);
  }
}

function stopStatusSubscription() {
  if (listeners.size === 0 && unsubscribeIpc) {
    unsubscribeIpc();
    unsubscribeIpc = null;
  }
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  startStatusSubscription();
  return () => {
    listeners.delete(onStoreChange);
    stopStatusSubscription();
  };
}

function getSnapshot(): EngineStatusValue {
  return currentStatus;
}

function getRestartingSnapshot(): boolean {
  return restarting;
}

export function useEngineStatus() {
  const status = useSyncExternalStore(subscribe, getSnapshot);
  const isRestarting = useSyncExternalStore(subscribe, getRestartingSnapshot);

  const applyStatus = (transition: Promise<EngineStatus>) =>
    transition.then(setStatus).catch((error) => {
      reportRendererError(error, "engine-toggle");
      return syncStatus();
    });

  const setEnabled = (enabled: boolean) => {
    if (restarting) return;
    return applyStatus(window.cogwork.setEngineEnabled(enabled));
  };

  const restart = () => {
    if (restarting) return;
    setRestarting(true);
    let failed = false;
    return window.cogwork
      .setEngineEnabled(false)
      .then(() => window.cogwork.setEngineEnabled(true))
      .then(setStatus)
      .catch((error) => {
        failed = true;
        reportRendererError(error, "engine-restart");
      })
      .finally(() => {
        setRestarting(false);
      })
      .then(() => {
        if (failed) return syncStatus();
      });
  };

  return { status, isRestarting, setEnabled, restart };
}

export type EnginePhase = "off" | "starting" | "up" | "failed";

const enginePhaseByStatus: Record<EngineStatusValue, EnginePhase> = {
  unknown: "off",
  stopped: "off",
  starting: "starting",
  running: "up",
  adopted: "up",
  failed: "failed",
};

export const enginePhase = (status: EngineStatusValue): EnginePhase => enginePhaseByStatus[status];
