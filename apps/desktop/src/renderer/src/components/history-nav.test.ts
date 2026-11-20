import { describe, expect, it } from "vitest";

import { canGoForward } from "./history-nav";

describe("canGoForward", () => {
  it("is false at the newest entry", () => {
    expect(canGoForward({ index: 2, length: 3 })).toBe(false);
  });

  it("is true when entries sit ahead of the current one", () => {
    expect(canGoForward({ index: 0, length: 3 })).toBe(true);
    expect(canGoForward({ index: 1, length: 3 })).toBe(true);
  });

  it("is false for a single-entry history", () => {
    expect(canGoForward({ index: 0, length: 1 })).toBe(false);
  });
});
