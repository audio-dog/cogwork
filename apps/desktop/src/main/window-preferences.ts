import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { app } from "electron";

import type { WindowPreferences } from "../shared/ipc";
import { mainLogger } from "./logger";

const defaults: WindowPreferences = { closeToHide: true, profiling: false };

export interface WindowPreferencesStore {
  readonly get: () => WindowPreferences;
  readonly set: (preferences: Partial<WindowPreferences>) => WindowPreferences;
}

const defaultPath = () => join(app.getPath("userData"), "window-preferences.json");

const booleanProperty = (value: unknown, key: keyof WindowPreferences, fallback: boolean) => {
  if (typeof value !== "object" || value === null) return fallback;
  if (!(key in value)) return fallback;
  const property = Reflect.get(value, key);
  return typeof property === "boolean" ? property : fallback;
};

const normalizePreferences = (value: unknown, fallback = defaults): WindowPreferences => ({
  closeToHide: booleanProperty(value, "closeToHide", fallback.closeToHide),
  profiling: booleanProperty(value, "profiling", fallback.profiling),
});

const readFromDisk = (path: string): WindowPreferences => {
  try {
    return normalizePreferences(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return defaults;
  }
};

export const createWindowPreferencesStore = (path = defaultPath()): WindowPreferencesStore => {
  const cache = { current: readFromDisk(path) };
  return {
    get: () => cache.current,
    set: (preferences) => {
      cache.current = normalizePreferences(preferences, cache.current);
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(cache.current), "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        mainLogger.warn(`Failed to persist window preferences: ${message}`);
      }
      return cache.current;
    },
  };
};
