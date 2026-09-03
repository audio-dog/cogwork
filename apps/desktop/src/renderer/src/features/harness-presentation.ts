export type HarnessGlyph = "openai" | "cursor" | "claude" | "anthropic" | "sparkle";

const presentation: Record<string, { readonly label: string; readonly glyph: HarnessGlyph }> = {
  codex: { label: "Codex", glyph: "openai" },
  claude: { label: "Claude Code", glyph: "claude" },
  cursor: { label: "Cursor", glyph: "cursor" },
  provider: { label: "Anthropic", glyph: "anthropic" },
};

export const harnessLabel = (harness: string) => presentation[harness]?.label ?? harness;

export const harnessGlyph = (harness: string): HarnessGlyph => presentation[harness]?.glyph ?? "sparkle";
