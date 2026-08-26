// PROTOTYPE — the filling card, minus the checkbox.
//
// The card already has a border, a fill, a name, a hint and a count. A checkbox on top of that is a
// second thing saying what the fill already says, which is why it read as busy. Each treatment
// below removes it a different way, and all three keep the whole card as the target — a card you
// can press is a bigger, more forgiving hit area than the box in its corner.

import { Badge } from "@cogwork/ui/components/badge";
import { cn } from "@cogwork/ui/lib/utils";
import { RiCheckLine, RiEyeLine, RiEyeOffLine } from "@remixicon/react";
import { type ScopeKind, scopeCopy } from "../features/configuration-model";
import { scopeIcons } from "./configuration-atoms";

interface CardProps {
  readonly kind: ScopeKind;
  readonly count: number;
  readonly selected: boolean;
  readonly onToggle: () => void;
}

function CardBody({ kind, count, muted }: { kind: ScopeKind; count: number; muted?: boolean }) {
  const Icon = scopeIcons[kind];
  return (
    <>
      <span className="flex items-center gap-2">
        <span className="text-muted-foreground">
          <Icon />
        </span>
        <span className="flex-1 text-sm font-medium">{scopeCopy[kind].name}</span>
        <Badge
          variant={muted || count === 0 ? "ghost" : "outline"}
          className="w-6 shrink-0 justify-center px-0 tabular-nums"
        >
          {count}
        </Badge>
      </span>
      <span className="text-start text-xs font-normal text-muted-foreground">{scopeCopy[kind].hint}</span>
    </>
  );
}

const base = "flex flex-1 cursor-pointer flex-col gap-1.5 rounded-lg border p-3 text-start transition-colors";

/**
 * Pressed tile. The card *is* the control, the way the theme tiles in Settings already work, with a
 * check appearing only when it is on — one glyph, and only in the state that needs confirming.
 */
export function PressedCard({ kind, count, selected, onToggle }: CardProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        base,
        "relative",
        selected ? "border-primary bg-primary/5 ring-1 ring-primary/40" : "border-border hover:bg-accent",
      )}
    >
      {selected ? <RiCheckLine className="absolute end-2 top-2 size-3.5 text-primary" aria-hidden /> : null}
      <CardBody kind={kind} count={count} muted={!selected} />
    </button>
  );
}

/**
 * No glyph at all. A selected card is simply present and an unselected one recedes, so the state is
 * the card's own appearance. The quietest of the three, and the one that relies on a reader noticing
 * contrast rather than reading a mark.
 */
export function DimmedCard({ kind, count, selected, onToggle }: CardProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        base,
        selected
          ? "border-border bg-card hover:bg-accent"
          : "border-dashed border-border/60 opacity-45 hover:opacity-70",
      )}
    >
      <CardBody kind={kind} count={count} muted={!selected} />
      {selected ? null : (
        <span className="text-start text-[11px] font-normal text-muted-foreground">Hidden</span>
      )}
    </button>
  );
}

/**
 * Show / hide. This menu is a filter, so hiding is the honest verb — a checkbox says "selected",
 * which is not what unchecking one does. The eye is smaller than a checkbox and says more.
 */
export function VisibilityCard({ kind, count, selected, onToggle }: CardProps) {
  const Eye = selected ? RiEyeLine : RiEyeOffLine;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={selected ? `Hide ${scopeCopy[kind].name}` : `Show ${scopeCopy[kind].name}`}
      onClick={onToggle}
      className={cn(
        base,
        "relative",
        "pe-9",
        selected ? "border-border bg-card hover:bg-accent" : "border-border/60 bg-muted/30 hover:bg-accent",
      )}
    >
      <Eye
        className={cn(
          "absolute end-2.5 top-3 size-4",
          selected ? "text-foreground" : "text-muted-foreground/70",
        )}
        aria-hidden
      />
      <CardBody kind={kind} count={count} muted={!selected} />
    </button>
  );
}
