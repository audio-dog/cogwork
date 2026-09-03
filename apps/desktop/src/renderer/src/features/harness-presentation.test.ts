import { describe, expect, it } from "vitest";
import { harnessGlyph, harnessLabel } from "./harness-presentation";

describe("harness presentation", () => {
  it("names and marks each registered harness", () => {
    expect(harnessLabel("provider")).toBe("Anthropic");
    expect(harnessGlyph("provider")).toBe("anthropic");
  });

  it("renders a harness it has no entry for under its own name", () => {
    expect(harnessLabel("replay")).toBe("replay");
    expect(harnessGlyph("replay")).toBe("sparkle");
  });
});
