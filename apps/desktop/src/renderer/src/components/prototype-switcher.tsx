import { Button } from "@cogwork/ui/components/button";
import { Separator } from "@cogwork/ui/components/separator";
import { useKeyboardEvent } from "@react-hookz/web";
import { RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react";
import type { ReactNode } from "react";

/**
 * PROTOTYPE — the floating variant bar from the `prototype` skill's UI branch.
 * Delete this along with the variants it switches between.
 */

export interface PrototypeVariant {
  readonly key: string;
  readonly name: string;
}

const isTextEntry = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA";
};

export function PrototypeSwitcher({
  variants,
  current,
  onSelect,
  children,
}: {
  readonly variants: readonly PrototypeVariant[];
  readonly current: string;
  readonly onSelect: (key: string) => void;
  readonly children?: ReactNode;
}) {
  const index = Math.max(
    variants.findIndex((variant) => variant.key === current),
    0,
  );
  const step = (offset: number) => {
    const next = variants[(index + offset + variants.length) % variants.length];
    if (next) onSelect(next.key);
  };

  useKeyboardEvent(
    (event) => (event.key === "ArrowLeft" || event.key === "ArrowRight") && !isTextEntry(event.target),
    (event) => step(event.key === "ArrowLeft" ? -1 : 1),
    [index, variants],
  );

  if (import.meta.env.PROD) return null;

  const active = variants[index];

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border bg-popover p-1 shadow-lg">
        <Button aria-label="Previous variant" size="icon-sm" variant="ghost" onClick={() => step(-1)}>
          <RiArrowLeftSLine />
        </Button>
        <Separator orientation="vertical" className="h-5" />
        <span className="px-2 text-xs font-medium">
          {active?.key} — {active?.name}
        </span>
        <Separator orientation="vertical" className="h-5" />
        <Button aria-label="Next variant" size="icon-sm" variant="ghost" onClick={() => step(1)}>
          <RiArrowRightSLine />
        </Button>
        {children}
      </div>
    </div>
  );
}
