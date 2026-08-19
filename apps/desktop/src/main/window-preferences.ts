import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { WindowPreferences } from "../shared/ipc";
import { mainLogger } from "./logger";

const defaults: WindowPreferences = { closeToHide: true };

export interface WindowPreferencesStore {
  readonly get: () => WindowPreferences;
  readonly set: (preferences: WindowPreferences) => WindowPreferences;
}

const filePath = () => join(app.getPath("userData"), "window-preferences.json");

// A hand-edited or partial file must not crash startup, so anything that isn't a clean boolean
// falls back to the default.
const readFromDisk = (): WindowPreferences => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath(), "utf8"));
    if (typeof parsed === "object" && parsed !== null && "closeToHide" in parsed) {
      const value = parsed.closeToHide;
      if (typeof value === "boolean") return { closeToHide: value };
    }
    return defaults;
  } catch {
    return defaults;
  }
};

// The main process owns the value and caches it in memory so the window close handler can read it
// synchronously, then writes through to disk so the choice survives a restart.
export const createWindowPreferencesStore = (): WindowPreferencesStore => {
  let current = readFromDisk();
  return {
    get: () => current,
    set: (preferences) => {
      // The renderer is a trust boundary, so keep the value only when it is really a boolean.
      const closeToHide =
        typeof preferences.closeToHide === "boolean" ? preferences.closeToHide : current.closeToHide;
      current = { closeToHide };
      try {
        const path = filePath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(current), "utf8");
      } catch (error) {
        mainLogger.warn(`Failed to persist window preferences: ${(error as Error).message}`);
      }
      return current;
    },
  };
};
