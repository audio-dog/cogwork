import {
  RiAnthropicFill,
  RiClaudeFill,
  RiCursorAiFill,
  RiOpenaiFill,
  RiSparklingFill,
} from "@remixicon/react";

import type { ProviderGlyph } from "../features/provider-presentation";

const glyphIcons: Record<ProviderGlyph, typeof RiSparklingFill> = {
  openai: RiOpenaiFill,
  cursor: RiCursorAiFill,
  claude: RiClaudeFill,
  anthropic: RiAnthropicFill,
  sparkle: RiSparklingFill,
};

/**
 * `RiCursorFill` is a mouse pointer, not Cursor. The brand marks are `RiCursorAiFill` and
 * `RiClaudeFill`, both shipped by @remixicon/react 4.9.0.
 */
export function ProviderGlyphIcon({
  glyph,
  className,
  "data-icon": dataIcon,
}: {
  readonly glyph: ProviderGlyph;
  readonly className?: string;
  readonly "data-icon"?: "inline-start" | "inline-end";
}) {
  const Icon = glyphIcons[glyph];
  return <Icon className={className} data-icon={dataIcon} />;
}
