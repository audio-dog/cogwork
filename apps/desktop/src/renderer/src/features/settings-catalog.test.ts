import { describe, expect, it } from "vitest";
import { findSection, isSettingsSectionId, searchSettings, settingsForSection } from "./settings-catalog";

describe("searchSettings", () => {
  it("returns nothing for an empty or whitespace query", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
  });

  it("matches on the setting title", () => {
    const ids = searchSettings("close to hide").map((entry) => entry.id);
    expect(ids).toContain("close-to-hide");
  });

  it("matches on a keyword that is not in the title", () => {
    const ids = searchSettings("tray").map((entry) => entry.id);
    expect(ids).toEqual(["close-to-hide"]);
  });

  it("matches case-insensitively", () => {
    const lower = searchSettings("theme").map((entry) => entry.id);
    const upper = searchSettings("THEME").map((entry) => entry.id);
    expect(upper).toEqual(lower);
    expect(lower).toContain("theme");
  });

  it("does not match on the description", () => {
    const ids = searchSettings("engine").map((entry) => entry.id);
    expect(ids).not.toContain("close-to-hide");
  });

  it("returns an empty list when nothing matches", () => {
    expect(searchSettings("nonexistent-xyz")).toEqual([]);
  });

  it("groups each result under the correct section", () => {
    const results = searchSettings("concurrency");
    expect(results.length).toBeGreaterThan(1);
    for (const entry of results) {
      expect(entry.sectionId).toBe("engine");
      expect(findSection(entry.sectionId)?.label).toBe("Engine");
    }
  });
});

describe("catalog helpers", () => {
  it("recognizes real section ids and rejects unknown ones", () => {
    expect(isSettingsSectionId("general")).toBe(true);
    expect(isSettingsSectionId("appearance")).toBe(true);
    expect(isSettingsSectionId("engine")).toBe(true);
    expect(isSettingsSectionId("nope")).toBe(false);
  });

  it("lists the settings that belong to a section", () => {
    const ids = settingsForSection("general").map((entry) => entry.id);
    expect(ids).toEqual(["close-to-hide"]);
  });
});
