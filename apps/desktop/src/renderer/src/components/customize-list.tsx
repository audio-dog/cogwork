// The list shape shared by every Customize facet.
//
// Grouped sections, each with a count and its own action, holding flat rows in one rounded
// container. The grouping axis is chosen per facet for whatever matters there — status for the
// things that break, place for the things that are merely somewhere — which is why the section is a
// component and the axis is not baked into it.
//
// Long groups collapse to five with a "Show n more", so a facet with eleven Subagents does not bury
// the facet below it.

import { Button } from "@cogwork/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowDownSLine } from "@remixicon/react";
import { type ReactNode, useState } from "react";

const collapseAt = 5;

export function ListSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-8 items-center gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {count === undefined ? null : (
          <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
        )}
        {action ? <div className="ms-auto flex items-center gap-1.5">{action}</div> : null}
      </div>
      <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg bg-muted/40">
        {children}
      </div>
    </section>
  );
}

/** Shows the first five, then offers the rest. Nothing is hidden without saying how much. */
export function ListRows({ children }: { children: readonly ReactNode[] }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = children.length - collapseAt;

  if (hidden <= 0 || expanded) {
    return (
      <>
        {children}
        {hidden > 0 ? (
          <div className="bg-background/40 px-1 py-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-center"
              onClick={() => setExpanded(false)}
            >
              Show less
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      {children.slice(0, collapseAt)}
      <div className="bg-background/40 px-1 py-0.5">
        <Button variant="ghost" size="sm" className="w-full justify-center" onClick={() => setExpanded(true)}>
          Show {hidden} more
          <RiArrowDownSLine data-icon="inline-end" />
        </Button>
      </div>
    </>
  );
}

export type RowStatus = "ok" | "attention" | "error";

export function ListRow({
  icon,
  status,
  title,
  badge,
  detail,
  trailing,
  onOpen,
}: {
  icon: ReactNode;
  status?: RowStatus;
  title: string;
  badge?: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  /** When a row leads somewhere, the whole row is the way in. */
  onOpen?: () => void;
}) {
  return (
    <Item
      size="sm"
      render={onOpen ? <button type="button" onClick={onOpen} /> : undefined}
      className={cn("rounded-none border-transparent text-left", onOpen && "cursor-pointer hover:bg-muted")}
    >
      <ItemMedia className="relative">
        <span className="flex size-7 items-center justify-center rounded-md bg-background text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        {status === undefined || status === "ok" ? null : (
          <span
            className={cn(
              "absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-muted",
              status === "error" ? "bg-destructive" : "bg-primary",
            )}
            aria-hidden
          />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="gap-1.5">
          {title}
          {badge}
        </ItemTitle>
        {detail ? <ItemDescription>{detail}</ItemDescription> : null}
      </ItemContent>
      {trailing ? <ItemActions>{trailing}</ItemActions> : null}
    </Item>
  );
}
