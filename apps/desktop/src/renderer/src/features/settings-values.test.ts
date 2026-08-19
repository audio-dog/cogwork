import { describe, expect, it } from "vitest";
import {
  parseBudget,
  parseCount,
  sanitizeBudgetDraft,
  sanitizeCountDraft,
  seededValue,
} from "./settings-values";

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

describe("sanitizeBudgetDraft", () => {
  it("keeps a trailing decimal while the user is typing cents", () => {
    expect(sanitizeBudgetDraft("25.")).toBe("25.");
  });

  it("strips currency formatting and caps cents at two digits", () => {
    expect(sanitizeBudgetDraft("$25.999")).toBe("25.99");
  });
});

describe("parseBudget", () => {
  it("strips currency formatting and keeps whole dollars", () => {
    expect(parseBudget("$25 / day")).toBe(25);
  });

  it("keeps a single decimal point for dollar amounts", () => {
    expect(parseBudget("$25.50")).toBe(25.5);
  });

  it("ignores extra decimal points and caps cents at two digits", () => {
    expect(parseBudget("25.5.5")).toBe(25.55);
    expect(parseBudget("25.999")).toBe(25.99);
  });

  it("reads empty or non-numeric input as zero", () => {
    expect(parseBudget("")).toBe(0);
    expect(parseBudget("$")).toBe(0);
  });
});

describe("seededValue", () => {
  it("prefers a local edit over the seed and fallback", () => {
    expect(seededValue(5, 3, 1)).toBe(5);
  });

  it("uses the seed when there is no local edit", () => {
    expect(seededValue(null, 3, 1)).toBe(3);
  });

  it("falls back when there is neither a local edit nor a seed", () => {
    expect(seededValue(null, null, 1)).toBe(1);
  });

  it("keeps a local zero edit rather than falling through", () => {
    expect(seededValue(0, 3, 1)).toBe(0);
  });
});
