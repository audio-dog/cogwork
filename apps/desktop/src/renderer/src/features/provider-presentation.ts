export type ProviderGlyph = "openai" | "cursor" | "claude" | "sparkle";

const presentation: Record<string, { readonly label: string; readonly glyph: ProviderGlyph }> = {
  codex: { label: "Codex", glyph: "openai" },
  claude: { label: "Claude Code", glyph: "claude" },
  cursor: { label: "Cursor", glyph: "cursor" },
  provider: { label: "Cogwork", glyph: "sparkle" },
};

export const providerLabel = (provider: string) => presentation[provider]?.label ?? provider;

export const providerGlyph = (provider: string): ProviderGlyph => presentation[provider]?.glyph ?? "sparkle";
