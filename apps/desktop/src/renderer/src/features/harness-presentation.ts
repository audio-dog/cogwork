/**
 * How each registered Harness is named and marked on screen. One table, because the settings
 * section and the operation-settings picker both need it and must not disagree. The engine sends a
 * `HarnessName`; a label and a brand mark are presentation, so they are decided here.
 */
export type HarnessGlyph = "openai" | "cursor" | "claude" | "anthropic" | "sparkle";

const presentation: Record<string, { readonly label: string; readonly glyph: HarnessGlyph }> = {
  codex: { label: "Codex", glyph: "openai" },
  claude: { label: "Claude Code", glyph: "claude" },
  cursor: { label: "Cursor", glyph: "cursor" },
  provider: { label: "Anthropic", glyph: "anthropic" },
};

/** A Harness with no entry reads under its own name, so registering one never hides it. */
export const harnessLabel = (harness: string) => presentation[harness]?.label ?? harness;

export const harnessGlyph = (harness: string): HarnessGlyph => presentation[harness]?.glyph ?? "sparkle";
