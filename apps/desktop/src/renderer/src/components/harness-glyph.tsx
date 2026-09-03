import {
  RiAnthropicFill,
  RiClaudeFill,
  RiCursorAiFill,
  RiOpenaiFill,
  RiSparklingFill,
} from "@remixicon/react";
import type { HarnessGlyph } from "../features/harness-presentation";

/**
 * `RiCursorFill` is a mouse pointer, not Cursor. The brand marks are `RiCursorAiFill` and
 * `RiClaudeFill`, both shipped by @remixicon/react 4.9.0.
 */
export function HarnessGlyphIcon({
  glyph,
  className,
}: {
  readonly glyph: HarnessGlyph;
  readonly className?: string;
}) {
  if (glyph === "openai") return <RiOpenaiFill className={className} />;
  if (glyph === "cursor") return <RiCursorAiFill className={className} />;
  if (glyph === "claude") return <RiClaudeFill className={className} />;
  if (glyph === "anthropic") return <RiAnthropicFill className={className} />;
  return <RiSparklingFill className={className} />;
}
