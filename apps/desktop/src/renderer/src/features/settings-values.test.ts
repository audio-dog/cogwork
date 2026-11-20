import { describe, expect, it } from "vitest";

import { parseCount, sanitizeCountDraft } from "./settings-values";

describe("parseCount", () => {
  it("strips non-numeric characters", () => {
    expect(parseCount("1a2b", 1)).toBe(12);
  });

  it("clamps below-minimum input up to the minimum", () => {
    expect(parseCount("0", 1)).toBe(1);
  });

  it("falls back to the minimum for empty or non-numeric input", () => {
    expect(parseCount("", 1)).toBe(1);
    expect(parseCount("abc", 1)).toBe(1);
  });
});

describe("sanitizeCountDraft", () => {
  it("strips non-numeric characters", () => {
    expect(sanitizeCountDraft("1a2b")).toBe("12");
  });

  it("allows an empty draft while the user is replacing the value", () => {
    expect(sanitizeCountDraft("")).toBe("");
  });
});
