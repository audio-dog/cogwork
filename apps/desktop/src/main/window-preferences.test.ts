import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWindowPreferencesStore } from "./window-preferences";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("window preferences", () => {
  it("keeps continuous profiling off until explicitly enabled", () => {
    const directory = mkdtempSync(join(tmpdir(), "cogwork-preferences-"));
    directories.push(directory);
    const path = join(directory, "preferences.json");
    const store = createWindowPreferencesStore(path);

    expect(store.get()).toEqual({ closeToHide: true, profiling: false });
    expect(store.set({ closeToHide: true, profiling: true })).toEqual({
      closeToHide: true,
      profiling: true,
    });
    expect(createWindowPreferencesStore(path).get()).toEqual({
      closeToHide: true,
      profiling: true,
    });
  });
});
