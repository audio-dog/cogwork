import { Button } from "@cogwork/ui/components/button";
import { Item, ItemMedia } from "@cogwork/ui/components/item";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowDownSLine } from "@remixicon/react";
import { type ReactNode, useState } from "react";

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

export function ListSectionRows({ children }: { children: readonly ReactNode[] }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = children.length - collapseAt;
  const shown = hidden > 0 && !expanded ? children.slice(0, collapseAt) : children;

  return (
    <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg bg-muted/40">
      {shown}
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

const dotColor: Record<Exclude<RowStatus, "ok">, string> = {
  error: "bg-destructive",
  attention: "bg-primary",
};

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
            dotColor[status],
          )}
          aria-hidden
        />
      )}
    </ItemMedia>
  );
}

export function ListRow({ children }: { children: ReactNode }) {
  return (
    <Item size="sm" className="rounded-none border-transparent">
      {children}
    </Item>
  );
}

export function ListRowButton({
  onOpen,
  muted,
  children,
}: {
  onOpen: () => void;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <Item
      size="sm"
      render={<button type="button" onClick={onOpen} />}
      className={cn(
        "cursor-pointer rounded-none border-transparent text-left hover:bg-muted",
        muted && "opacity-60",
      )}
    >
      {children}
    </Item>
  );
}
