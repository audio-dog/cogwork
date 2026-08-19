import { useSyncExternalStore } from "react";
import type { WindowPreferences } from "../../../shared/ipc";

// The main process owns window behavior and persists it. The renderer seeds from it on first read and
// writes through on change — there is no local copy that can drift from what the window actually does.
let current: WindowPreferences | null = null;
const listeners = new Set<() => void>();

function emit(next: WindowPreferences) {
  if (current !== null && current.closeToHide === next.closeToHide) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (current === null) {
    window.cogwork.getWindowPreferences().then(emit);
  }
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): WindowPreferences | null {
  return current;
}

export function useWindowPreferences() {
  const preferences = useSyncExternalStore(subscribe, getSnapshot);

  const setCloseToHide = (closeToHide: boolean) => {
    window.cogwork.setWindowPreferences({ closeToHide }).then(emit);
  };

  return { preferences, setCloseToHide };
}
