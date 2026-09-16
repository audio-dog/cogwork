import { describe, expect, it } from "vitest";
import { providerGlyph, providerLabel } from "./provider-presentation";

describe("provider presentation", () => {
  it("names and marks each registered provider", () => {
    expect(providerLabel("cursor")).toBe("Cursor");
    expect(providerGlyph("cursor")).toBe("cursor");
    expect(providerLabel("claude")).toBe("Claude Code");
    expect(providerGlyph("claude")).toBe("claude");
    expect(providerLabel("codex")).toBe("Codex");
    expect(providerGlyph("codex")).toBe("openai");
  });

  it("claims no vendor for the owned runner, which serves three of them", () => {
    expect(providerLabel("provider")).toBe("Cogwork");
    expect(providerGlyph("provider")).toBe("sparkle");
  });

  it("renders a provider it has no entry for under its own name", () => {
    expect(providerLabel("replay")).toBe("replay");
    expect(providerGlyph("replay")).toBe("sparkle");
  });
});
