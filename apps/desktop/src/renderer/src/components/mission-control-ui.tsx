import type { ClassifiedItem } from "@clanker-forge/contracts";
import { Badge } from "@clanker-forge/ui/components/badge";
import type { ReactNode } from "react";
import { boardColumnOf, boardColumnOrder } from "../features/board-view";
import type { FeedItem } from "../features/feed";

export function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <div className="mt-1 flex items-center gap-2 text-xs font-medium tracking-widest text-muted-foreground uppercase first:mt-0">
      <span>{title}</span>
      <Badge variant="secondary" className="rounded-full px-2 py-0 text-[11px] tracking-normal normal-case">
        {count}
      </Badge>
    </div>
  );
}

export function WorkspaceChip({ workspace }: { workspace: string }) {
  return (
    <Badge variant="outline" className="rounded-full font-normal">
      {workspace}
    </Badge>
  );
}

export function ItemBadges({ item }: { item: ClassifiedItem }) {
  return (
    <>
      {item._tag === "NeedsHuman" && <Badge variant="outline">needs human</Badge>}
      {item._tag === "Blocked" && <Badge variant="outline">blocked</Badge>}
      {item.pr && <Badge variant="secondary">PR #{item.pr.number}</Badge>}
    </>
  );
}

export function ColumnHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-1 pb-2.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
      <span>{label}</span>
      <Badge
        variant="secondary"
        className="ms-auto rounded-full px-2 py-0 text-[11px] tracking-normal normal-case"
      >
        {count}
      </Badge>
    </div>
  );
}

export function KanbanCard({ entry }: { entry: FeedItem }) {
  const { workspace, item } = entry;
  const stage = item._tag === "Eligible" ? item.stage : item._tag === "Claimed" ? item.claim.stage : null;

  return (
    <div className="rounded-[11px] border bg-card p-3 transition-colors hover:border-foreground/30">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{item.id}</span>
        <ItemBadges item={item} />
      </div>
      <p className="text-sm leading-snug">{item.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <WorkspaceChip workspace={workspace} />
        {stage && <Badge variant="secondary">{stage}</Badge>}
      </div>
      {item._tag === "Claimed" && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-primary">
          <span className="size-1.5 animate-pulse rounded-full bg-primary" />
          running · {item.claim.by}
        </p>
      )}
    </div>
  );
}

const columnLabel = (id: ReturnType<typeof boardColumnOf>) =>
  boardColumnOrder.find((column) => column.id === id)?.label ?? id;

export function itemContext(entry: FeedItem): string | null {
  const { item } = entry;
  if (item._tag === "NeedsHuman") return item.proposal;
  if (item.pr) return `Checks ${item.pr.checks} · awaiting merge`;
  if (item._tag === "Claimed") return `running · ${item.claim.by}`;
  if (item._tag === "Eligible") return item.stage;
  return null;
}

export function InboxRow({
  entry,
  accent,
  side,
}: {
  entry: FeedItem;
  accent?: "human" | "pr" | "run";
  side?: ReactNode;
}) {
  const { item } = entry;
  const accentClass =
    accent === "human"
      ? "border-l-[3px] border-l-amber-500"
      : accent === "pr"
        ? "border-l-[3px] border-l-emerald-500"
        : accent === "run"
          ? "border-l-[3px] border-l-primary"
          : "";

  return (
    <div className={`flex items-start gap-3 rounded-[11px] border bg-card p-3.5 ${accentClass}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{item.id}</span>
          <ItemBadges item={item} />
          <span className="text-sm">{item.title}</span>
        </div>
        {itemContext(entry) && <p className="mt-1.5 text-xs text-muted-foreground">{itemContext(entry)}</p>}
      </div>
      <div className="shrink-0 text-right text-xs text-muted-foreground">
        <WorkspaceChip workspace={entry.workspace} />
        <div className="mt-1.5">{side ?? columnLabel(boardColumnOf(item))}</div>
      </div>
    </div>
  );
}

export function LaneMiniCard({ entry, running }: { entry: FeedItem; running?: boolean }) {
  const { item } = entry;
  return (
    <div className={`mb-1.5 w-[194px] rounded-lg border bg-card p-2 ${running ? "border-primary/40" : ""}`}>
      <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        {item.id}
        {running && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
      </div>
      <p className="mt-0.5 text-xs leading-snug">{item.title}</p>
      <div className="mt-1.5">
        <ItemBadges item={item} />
      </div>
    </div>
  );
}
