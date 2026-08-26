// PROTOTYPE — row anatomy for the place menu.
//
// One shape for a navigation row and one for a selectable place, so both panes align the same way:
// leading control or icon, then the name with its hint stacked under it, then the count trailing.
// The earlier version left-aligned one pane and centred the other, which read as two designs.

import { Badge } from "@cogwork/ui/components/badge";
import { Checkbox } from "@cogwork/ui/components/checkbox";
import { Label } from "@cogwork/ui/components/label";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowRightSLine } from "@remixicon/react";
import type { ComponentType, ReactNode } from "react";

/** Counts are tabular and fixed-width so a row never changes size when the selection changes. */
export function CountBadge({ count, muted }: { count: number; muted?: boolean }) {
  return (
    <Badge
      variant={muted || count === 0 ? "ghost" : "outline"}
      className="w-6 shrink-0 justify-center px-0 tabular-nums"
    >
      {count}
    </Badge>
  );
}

/** A left-pane row. Navigation, not selection: pointing at it is enough to reveal its places. */
export function MenuNavRow({
  icon: Icon,
  title,
  meta,
  active,
  onHover,
}: {
  icon?: ComponentType;
  title: string;
  meta?: ReactNode;
  active: boolean;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onFocus={onHover}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start",
        active ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      {Icon ? (
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <Icon />
        </span>
      ) : null}
      {/* One line only: the checkout path belongs to the right pane, and once. */}
      <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
      {meta}
      <RiArrowRightSLine className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** A right-pane row. The checkbox leads, so the thing you click is the thing you read first. */
export function MenuPlaceRow({
  name,
  hint,
  count,
  checked,
  onToggle,
}: {
  name: string;
  hint: string;
  count: number;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 hover:bg-accent">
      <Checkbox checked={checked} onCheckedChange={onToggle} className="mt-0.5 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{name}</span>
        <span className="text-xs font-normal text-muted-foreground">{hint}</span>
      </span>
      <CountBadge count={count} />
    </Label>
  );
}
