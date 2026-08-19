import type { TokenUsage } from "@cogwork/contracts";
import { describe, expect, it } from "vitest";
import { tokenCountLabel } from "./token-usage";

const usage = (fields: Partial<TokenUsage>) => fields;

describe("tokenCountLabel", () => {
  it("returns null when there is no total", () => {
    expect(tokenCountLabel(null)).toBeNull();
    expect(tokenCountLabel(usage({ inputTokens: 10 }))).toBeNull();
  });

  it("labels a metered total plainly", () => {
    expect(tokenCountLabel(usage({ totalTokens: 1234 }))).toEqual({
      text: "1234",
      estimated: false,
    });
  });

  it("prefixes an estimated total with a tilde", () => {
    expect(tokenCountLabel(usage({ totalTokens: 1234, estimated: true }))).toEqual({
      text: "~1234",
      estimated: true,
    });
  });

  it("treats a zero total as present", () => {
    expect(tokenCountLabel(usage({ totalTokens: 0 }))).toEqual({
      text: "0",
      estimated: false,
    });
  });
});
