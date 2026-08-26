import { Button } from "@cogwork/ui/components/button";
import { Item, ItemActions, ItemMedia } from "@cogwork/ui/components/item";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowDownSLine } from "@remixicon/react";
import { type ComponentProps, Fragment, type ReactNode, useState } from "react";

const collapseAt = 5;

export function ListSection({ children }: { children: ReactNode }) {
  return <section className="flex flex-col gap-2">{children}</section>;
}

export function ListSectionHeader({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {count === undefined ? null : (
        <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
      )}
      {children ? <div className="ms-auto flex items-center gap-1.5">{children}</div> : null}
    </div>
  );
}

function ShowMore({ hidden, onExpand }: { hidden: number; onExpand: () => void }) {
  return (
    <div className="bg-background/40 px-1 py-0.5">
      <Button variant="ghost" size="sm" className="w-full justify-center" onClick={onExpand}>
        Show {hidden} more
        <RiArrowDownSLine data-icon="inline-end" />
      </Button>
    </div>
  );
}

function ShowLess({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className="bg-background/40 px-1 py-0.5">
      <Button variant="ghost" size="sm" className="w-full justify-center" onClick={onCollapse}>
        Show less
      </Button>
    </div>
  );
}

/**
 * Takes the rows as data rather than reading `children`. Counting nodes counted a Fragment, a
 * conditional and an adjacent element as rows, so "Show 3 more" could disagree with the list.
 */
export function ListSectionRows<T>({
  items,
  keyOf,
  children,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  children: (item: T) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = items.length - collapseAt;
  const shown = hidden > 0 && !expanded ? items.slice(0, collapseAt) : items;

  return (
    <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg bg-muted/40">
      {shown.map((item) => (
        <Fragment key={keyOf(item)}>{children(item)}</Fragment>
      ))}
      {hidden > 0 &&
        (expanded ? (
          <ShowLess onCollapse={() => setExpanded(false)} />
        ) : (
          <ShowMore hidden={hidden} onExpand={() => setExpanded(true)} />
        ))}
    </div>
  );
}

export function ListSectionBody({ children }: { children: ReactNode }) {
  return <div className="flex flex-col overflow-hidden rounded-lg bg-muted/40">{children}</div>;
}

export type RowStatus = "ok" | "attention" | "error";

export function ListRowMedia({ status = "ok", children }: { status?: RowStatus; children: ReactNode }) {
  return (
    <ItemMedia className="relative">
      <span className="flex size-7 items-center justify-center rounded-md bg-background text-muted-foreground [&_svg]:size-4">
        {children}
      </span>
      {status === "ok" ? null : (
        <span
          className={cn(
            "absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-muted",
            status === "error" && "bg-destructive",
            status === "attention" && "bg-primary",
          )}
          aria-hidden
        />
      )}
    </ItemMedia>
  );
}

export function ListRow({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <Item
      size="sm"
      className={cn(
        "relative rounded-none border-transparent",
        // The overlay is transparent, so the row itself carries the hover tint. Keying it to the
        // overlay leaves a row without one — a setup step, say — unhighlighted, as before.
        "has-[[data-slot=list-row-open]:hover]:bg-muted",
        muted && "opacity-60",
      )}
    >
      {children}
    </Item>
  );
}

/**
 * A transparent button covering the row, so the whole row opens without a `<button>` wrapping the
 * controls inside it. Interactive siblings need {@link ListRowActions} to sit above it.
 */
export function ListRowOpen({ label, className, ...props }: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      data-slot="list-row-open"
      type="button"
      {...props}
      className={cn(
        "absolute inset-0 cursor-pointer rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        className,
      )}
    >
      <span className="sr-only">{label}</span>
    </button>
  );
}

export function ListRowActions({ children }: { children: ReactNode }) {
  return <ItemActions className="relative">{children}</ItemActions>;
}
