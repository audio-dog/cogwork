import { describe, expect, it } from "vitest";

import {
  findSection,
  searchSettings,
  settingsForSection,
  settingsIndex,
  settingsSections,
} from "./settings-catalog";

describe("searchSettings", () => {
  it("returns nothing for an empty or whitespace query", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
  });

  it("matches on the setting title", () => {
    const ids = searchSettings("close to hide").map((entry) => entry.id);
    expect(ids).toContain("close-to-hide");
  });

  it("finds process diagnostics settings", () => {
    const ids = searchSettings("cpu profile").map((entry) => entry.id);
    expect(ids).toContain("profiling");
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
});

describe("catalog helpers", () => {
  it("gives every section a route of its own, so the router does the dispatch", () => {
    expect(settingsSections.map((section) => section.link.to)).toEqual([
      "/settings/general",
      "/settings/scheduling",
      "/settings/appearance",
      "/settings/providers",
    ]);
  });

  it("files every setting under a section that exists", () => {
    for (const entry of settingsIndex) expect(findSection(entry.sectionId)).toBeDefined();
  });

  it("files the provider section's setting under it, so search can reach the section", () => {
    expect(settingsForSection("providers").map((entry) => entry.id)).toEqual(["harness-state"]);
  });

  it("lists the settings that belong to a section", () => {
    const ids = settingsForSection("general").map((entry) => entry.id);
    expect(ids).toEqual(["close-to-hide", "profiling", "process-captures"]);
  });
});
