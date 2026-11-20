import { useSyncExternalStore } from "react";

import type { WindowPreferences } from "../../../shared/ipc";

const cache: { current: WindowPreferences | null } = { current: null };
const writes: { current: Promise<unknown> } = { current: Promise.resolve() };
const listeners = new Set<() => void>();

function emit(next: WindowPreferences) {
  if (cache.current?.closeToHide === next.closeToHide && cache.current.profiling === next.profiling) return;
  cache.current = next;
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (cache.current === null) {
    window.cogwork.getWindowPreferences().then(emit);
  }
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): WindowPreferences | null {
  return cache.current;
}

const persistPreferences = (next: Partial<WindowPreferences>) => {
  const write = writes.current.then(() => window.cogwork.setWindowPreferences(next));
  writes.current = write.catch(() => undefined);
  return write.then((preferences) => {
    emit(preferences);
    return preferences;
  });
};

export function useWindowPreferences() {
  const preferences = useSyncExternalStore(subscribe, getSnapshot);

  const setPreferences = (next: Partial<WindowPreferences>) => {
    if (!preferences) return Promise.reject(new Error("Desktop preferences are not loaded"));
    return persistPreferences(next);
  };

  return {
    preferences,
    setCloseToHide: (closeToHide: boolean) => setPreferences({ closeToHide }),
    setProfiling: (profiling: boolean) => setPreferences({ profiling }),
  };
}
