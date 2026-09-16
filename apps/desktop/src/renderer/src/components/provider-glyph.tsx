import { RiClaudeFill, RiCursorAiFill, RiOpenaiFill, RiSparklingFill } from "@remixicon/react";
import type { ComponentType } from "react";
import type { ProviderGlyph } from "../features/provider-presentation";

// `RiCursorFill` is a mouse pointer, not Cursor. The brand mark is `RiCursorAiFill`.
const glyphIcons = {
  openai: RiOpenaiFill,
  cursor: RiCursorAiFill,
  claude: RiClaudeFill,
  sparkle: RiSparklingFill,
} satisfies { [T in ProviderGlyph]: ComponentType<{ readonly className?: string }> };

export function ProviderGlyphIcon({
  glyph,
  className,
}: {
  readonly glyph: ProviderGlyph;
  readonly className?: string;
}) {
  const Icon = glyphIcons[glyph];
  return <Icon className={className} />;
}
