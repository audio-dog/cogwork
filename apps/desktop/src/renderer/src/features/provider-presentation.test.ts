import { describe, expect, it } from "vitest";

import { providerGlyph, providerLabel } from "./provider-presentation";

describe("provider presentation", () => {
  it("names and marks each registered provider", () => {
    expect(providerLabel("provider")).toBe("Anthropic");
    expect(providerGlyph("provider")).toBe("anthropic");
  });

  it("renders a provider it has no entry for under its own name", () => {
    expect(providerLabel("replay")).toBe("replay");
    expect(providerGlyph("replay")).toBe("sparkle");
  });
});
