// PROTOTYPE SWITCHER — flips between the #131 Customize variants. Delete with the losing variants.
//
// Hidden in a production build, so a stray merge cannot ship the bar.

import { Button } from "@cogwork/ui/components/button";
import { useKeyboardEvent } from "@react-hookz/web";
import { RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react";
import { useNavigate } from "@tanstack/react-router";
import { findVariant, nextVariant, type VariantKey } from "../features/configuration-variants";
import { useVariantKey } from "../features/use-variant";

/** Arrow keys move the variant, except while a text field has focus. */
function typingInAField(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || active.hasAttribute("contenteditable");
}

export function PrototypeSwitcher() {
  const navigate = useNavigate();
  const variant = useVariantKey();

  const go = (key: VariantKey) => navigate({ to: "/customize", search: { variant: key } });

  useKeyboardEvent("ArrowLeft", () => {
    if (!typingInAField()) go(nextVariant(variant, -1));
  }, [variant]);

  useKeyboardEvent("ArrowRight", () => {
    if (!typingInAField()) go(nextVariant(variant, 1));
  }, [variant]);

  if (import.meta.env.PROD) return null;

  const definition = findVariant(variant);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center">
      <div className="pointer-events-auto flex max-w-xl items-center gap-1 rounded-full border border-primary/40 bg-popover/95 p-1 shadow-lg backdrop-blur">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous variant"
          onClick={() => go(nextVariant(variant, -1))}
        >
          <RiArrowLeftSLine />
        </Button>
        <div className="flex min-w-0 flex-col px-2 py-0.5">
          <span className="truncate text-xs font-medium">
            Variant {definition.key} — {definition.name}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">{definition.claim}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next variant"
          onClick={() => go(nextVariant(variant, 1))}
        >
          <RiArrowRightSLine />
        </Button>
      </div>
    </div>
  );
}
