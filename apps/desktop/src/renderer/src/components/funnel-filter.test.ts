import { describe, expect, it } from "vitest";

import { funnelSelectionMatches, toggleFunnelKey } from "./funnel-filter";

describe("funnelSelectionMatches", () => {
  it("treats an empty selection as 'all' — every key passes", () => {
    const empty = new Set<string>();
    expect(funnelSelectionMatches(empty, "acme")).toBe(true);
    expect(funnelSelectionMatches(empty, "widgets")).toBe(true);
  });

  it("passes only the selected keys once a filter is applied", () => {
    const selected = new Set(["acme"]);
    expect(funnelSelectionMatches(selected, "acme")).toBe(true);
    expect(funnelSelectionMatches(selected, "widgets")).toBe(false);
  });
});

describe("toggleFunnelKey", () => {
  it("adds a key without mutating the input set", () => {
    const before = new Set<string>();
    const after = toggleFunnelKey(before, "acme");
    expect([...after]).toEqual(["acme"]);
    expect(before.size).toBe(0);
  });

  it("removes a key that was already selected", () => {
    const after = toggleFunnelKey(new Set(["acme", "widgets"]), "acme");
    expect([...after]).toEqual(["widgets"]);
  });

  it("returns to the 'all' reset state when the last key is removed", () => {
    const after = toggleFunnelKey(new Set(["acme"]), "acme");
    expect(after.size).toBe(0);
    expect(funnelSelectionMatches(after, "anything")).toBe(true);
  });
});
