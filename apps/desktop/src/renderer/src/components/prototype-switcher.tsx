// PROTOTYPE — throwaway. Floating variant switcher for the Attention tab
// card-anatomy / list-treatment prototype (wayfinder ticket #26). Hidden in
// production builds. Delete this file together with attention-variants.tsx and
// the attention-prototype route once a treatment wins.

import { Button } from "@cogwork/ui/components/button";
import { RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react";
import { useEffect } from "react";

interface Cycler<K extends string> {
  readonly label: string;
  readonly variants: ReadonlyArray<{ key: K; name: string }>;
  readonly current: K;
  readonly onSelect: (key: K) => void;
}

interface Toggle {
  readonly label: string;
  readonly on: boolean;
  readonly onToggle: () => void;
}

interface PrototypeSwitcherProps<K extends string, C extends string> {
  readonly variants: ReadonlyArray<{ key: K; name: string }>;
  readonly current: K;
  readonly onSelect: (key: K) => void;
  readonly secondary?: Cycler<C>;
  readonly toggle?: Toggle;
}

function stepIn<K extends string>(cycler: Cycler<K>, delta: number) {
  const index = Math.max(
    0,
    cycler.variants.findIndex((v) => v.key === cycler.current),
  );
  const next = (index + delta + cycler.variants.length) % cycler.variants.length;
  cycler.onSelect(cycler.variants[next].key);
}

function CyclerControl<K extends string>({ cycler }: { cycler: Cycler<K> }) {
  const active = cycler.variants.find((v) => v.key === cycler.current) ?? cycler.variants[0];
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Previous ${cycler.label}`}
        onClick={() => stepIn(cycler, -1)}
      >
        <RiArrowLeftSLine />
      </Button>
      <span className="px-2 text-xs font-medium whitespace-nowrap">
        <span className="text-muted-foreground">{cycler.label} </span>
        <span className="text-primary">{active.key}</span>
        <span className="mx-1.5 text-muted-foreground">·</span>
        {active.name}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Next ${cycler.label}`}
        onClick={() => stepIn(cycler, 1)}
      >
        <RiArrowRightSLine />
      </Button>
    </>
  );
}

export function PrototypeSwitcher<K extends string, C extends string>({
  variants,
  current,
  onSelect,
  secondary,
  toggle,
}: PrototypeSwitcherProps<K, C>) {
  if (import.meta.env.PROD) return null;

  const primary: Cycler<K> = { label: "Treatment", variants, current, onSelect };

  // Arrow keys cycle the primary variants, but never while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.key === "ArrowLeft") stepIn(primary, -1);
      if (event.key === "ArrowRight") stepIn(primary, 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex justify-center [-webkit-app-region:no-drag]">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-primary/40 bg-popover px-1.5 py-1 text-popover-foreground shadow-lg">
        <CyclerControl cycler={primary} />
        {secondary && (
          <>
            <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
            <CyclerControl cycler={secondary} />
          </>
        )}
        {toggle && (
          <>
            <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
            <Button
              size="sm"
              variant={toggle.on ? "secondary" : "ghost"}
              aria-pressed={toggle.on}
              onClick={toggle.onToggle}
            >
              {toggle.label}: {toggle.on ? "on" : "off"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
