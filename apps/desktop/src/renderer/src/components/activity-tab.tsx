import { Button } from "@cogwork/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { Input } from "@cogwork/ui/components/input";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiDashboard3Line,
  RiDeleteBinLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFileList2Line,
  RiFlashlightLine,
  RiFolder3Line,
  RiPauseLine,
  RiPlayMiniLine,
  RiPulseLine,
  RiRobot2Line,
  RiSearchLine,
  RiWifiLine,
} from "@remixicon/react";
import type { ComponentType, KeyboardEvent, ReactNode } from "react";
import { useState } from "react";
import {
  type ActivityCategory,
  type ActivityKind,
  type ActivityRow,
  activityCategory,
  activityLabels,
  type NowState,
  useActivityFeed,
} from "../features/activity-source";
import { relativeTime } from "../features/format";
import { useNow } from "../features/use-now";
import { useRightPanelStore } from "../store/right-panel";
import { FunnelFilter, funnelSelectionMatches, useFunnelSelection } from "./funnel-filter";

const categoryOptions: ReadonlyArray<{ key: ActivityCategory; label: string }> = [
  { key: "run", label: "Runs" },
  { key: "item", label: "Items" },
  { key: "scheduler", label: "Scheduler" },
  { key: "workspace", label: "Workspaces" },
  { key: "system", label: "System" },
];

const kindIcons: Record<ActivityKind, ComponentType<{ className?: string }>> = {
  item: RiFileList2Line,
  "item-removed": RiDeleteBinLine,
  run: RiRobot2Line,
  workspace: RiFolder3Line,
  scheduler: RiDashboard3Line,
  engine: RiFlashlightLine,
  connection: RiWifiLine,
  stream: RiPulseLine,
};

const engineCopy: Record<NowState["engine"], string> = {
  up: "Engine on",
  starting: "Engine starting",
  off: "Engine off",
  failed: "Engine failed",
};

const connectionCopy: Record<NowState["connection"], string> = {
  live: "Connected",
  connecting: "Connecting",
  lost: "Disconnected",
};

const engineTone: Record<NowState["engine"], string> = {
  up: "bg-primary",
  starting: "bg-muted-foreground",
  off: "bg-muted-foreground/40",
  failed: "bg-destructive",
};

const groupRows = (rows: readonly ActivityRow[]) =>
  rows.reduce<ActivityRow[][]>((groups, row) => {
    const group = groups.at(-1);
    if (group?.[0]?.kind === row.kind) group.push(row);
    else groups.push([row]);
    return groups;
  }, []);

function IconToggle({
  active,
  onClick,
  activeIcon,
  inactiveIcon,
  activeLabel,
  inactiveLabel,
}: {
  active: boolean;
  onClick: () => void;
  activeIcon: ReactNode;
  inactiveIcon: ReactNode;
  activeLabel: string;
  inactiveLabel: string;
}) {
  const label = active ? activeLabel : inactiveLabel;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={active}
            size="icon-sm"
            variant={active ? "secondary" : "ghost"}
            onClick={onClick}
          >
            {active ? activeIcon : inactiveIcon}
          </Button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function NowPanel({ now }: { now: NowState }) {
  const openSurface = useRightPanelStore((state) => state.openSurface);
  return (
    <section className="shrink-0 border-b bg-muted/20 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="relative flex size-2 items-center justify-center">
          {now.engine === "up" && (
            <span
              className={cn("absolute size-2 animate-ping rounded-full opacity-60", engineTone[now.engine])}
            />
          )}
          <span className={cn("relative size-2 rounded-full", engineTone[now.engine])} />
        </span>
        <span className="text-sm font-semibold">Now</span>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{engineCopy[now.engine]}</span>
          <span>{connectionCopy[now.connection]}</span>
        </div>
      </div>
      {now.scheduler && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
          <RiDashboard3Line className="shrink-0 text-muted-foreground" />
          <span className="font-medium tabular-nums">
            {now.scheduler.globalInFlight}/{now.scheduler.globalLimit} in flight
          </span>
          <span className="ml-auto text-muted-foreground tabular-nums">
            budget {now.scheduler.dailyBudgetUsed}/{now.scheduler.dailyBudgetLimit}
          </span>
        </div>
      )}
      {now.runs.length === 0 ? (
        <p className="mt-2 px-0.5 text-xs text-muted-foreground">No runs in flight.</p>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {now.runs.map((run) => (
            <button
              key={run.runId}
              type="button"
              className="flex cursor-pointer items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left hover:bg-accent"
              onClick={() =>
                openSurface({
                  kind: "item",
                  workspace: run.workspace,
                  workItem: run.workItem,
                  runId: run.runId,
                })
              }
            >
              <RiRobot2Line className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{run.workItem}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {run.preview
                    ? `${run.preview.label}${run.preview.text ? ` · ${run.preview.text}` : ""}`
                    : run.stage}
                </span>
              </span>
              <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function EventRow({ row }: { row: ActivityRow }) {
  const [expanded, setExpanded] = useState(false);
  const openSurface = useRightPanelStore((state) => state.openSurface);
  const Icon = kindIcons[row.kind];
  const entity = row.entity;
  const toggle = () => setExpanded((current) => !current);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  };
  const entityLabel = entity?.type === "run" ? "Open run" : "Open item";
  return (
    // biome-ignore lint/a11y/useSemanticElements: the row owns a nested entity button, so it cannot be a button itself.
    <div
      role="button"
      tabIndex={0}
      className="flex cursor-pointer flex-col rounded-md px-0.5 py-0.5 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={toggle}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <Icon
            className={cn("shrink-0 text-muted-foreground", row.severity === "error" && "text-destructive")}
          />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            row.severity === "error" && "font-medium text-destructive",
          )}
        >
          {row.summary}
        </span>
        {entity && (
          <button
            type="button"
            className="shrink-0 rounded px-1 font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
            title={`${entityLabel} → ${entity.id}`}
            onClick={(event) => {
              event.stopPropagation();
              openSurface({
                kind: "item",
                workspace: entity.workspace,
                workItem: entity.type === "run" ? entity.workItem : entity.id,
                ...(entity.type === "run" ? { runId: entity.id } : {}),
              });
            }}
          >
            {entityLabel} → {entity.id}
          </button>
        )}
        <time
          className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
          title={new Date(row.atMillis).toLocaleString()}
        >
          {relativeTime(row.atMillis)}
        </time>
      </div>
      {expanded && (
        <pre className="mt-1 ms-7 max-h-64 overflow-auto border-s ps-3 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap">
          {row.raw}
        </pre>
      )}
    </div>
  );
}

function EventGroup({ rows }: { rows: readonly ActivityRow[] }) {
  const [open, setOpen] = useState(false);
  const [newest, ...previous] = rows;
  if (!newest) return null;
  return (
    <div>
      <EventRow row={newest} />
      {open && previous.map((row) => <EventRow key={row.id} row={row} />)}
      {previous.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground">
            <RiPlayMiniLine className={cn("shrink-0 transition-transform", open && "rotate-90")} />
            {open
              ? "Show fewer"
              : `+${previous.length} previous ${activityLabels[newest.kind].toLowerCase()} events`}
          </CollapsibleTrigger>
          <CollapsibleContent />
        </Collapsible>
      )}
    </div>
  );
}

function ActivityLog() {
  const feed = useActivityFeed();
  const now = useNow();
  const [query, setQuery] = useState("");
  const [verbose, setVerbose] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [snapshot, setSnapshot] = useState<readonly ActivityRow[]>([]);
  const selection = useFunnelSelection();
  const source = frozen ? snapshot : feed.log;
  const visible = source.filter((row) => verbose || !row.lowSignal);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searched = visible.filter((row) => {
    const content = `${row.summary} ${row.label} ${row.entity?.id ?? ""}`.toLocaleLowerCase();
    return content.includes(normalizedQuery);
  });
  const rows = searched
    .filter((row) => funnelSelectionMatches(selection.selected, activityCategory(row.kind)))
    .toReversed();
  const options = categoryOptions.map((option) => ({
    ...option,
    count: visible.filter((row) => activityCategory(row.kind) === option.key).length,
  }));
  const setFreeze = () => {
    if (frozen) setFrozen(false);
    else {
      setSnapshot(feed.log);
      setFrozen(true);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <NowPanel now={feed.now} />
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <RiSearchLine className="absolute start-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter events…"
            className="h-7 ps-7 text-xs"
          />
        </div>
        <FunnelFilter.Provider
          value={{
            state: { options, selected: selection.selected },
            actions: selection,
            meta: { ariaLabel: "Filter event types", resetLabel: "All event types" },
          }}
        >
          <FunnelFilter.Control />
        </FunnelFilter.Provider>
        <IconToggle
          active={verbose}
          onClick={() => setVerbose((current) => !current)}
          activeIcon={<RiEyeLine />}
          inactiveIcon={<RiEyeOffLine />}
          activeLabel="Hide minor events"
          inactiveLabel="Show minor events"
        />
        <IconToggle
          active={frozen}
          onClick={setFreeze}
          activeIcon={<RiPlayMiniLine />}
          inactiveIcon={<RiPauseLine />}
          activeLabel="Resume new events"
          inactiveLabel="Pause new events"
        />
      </div>
      <FunnelFilter.Provider
        value={{
          state: { options, selected: selection.selected },
          actions: selection,
          meta: { ariaLabel: "Filter event types", resetLabel: "All event types" },
        }}
      >
        <FunnelFilter.Banner />
      </FunnelFilter.Provider>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-px px-3 py-1">
          {rows.length === 0 ? (
            <Empty className="py-12">
              <EmptyHeader>
                <EmptyTitle>No events match.</EmptyTitle>
                <EmptyDescription>The log is session-only and starts fresh each launch.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            groupRows(rows).map((group) => <EventGroup key={group[0]?.id} rows={group} />)
          )}
        </div>
      </ScrollArea>
      <span className="sr-only">{now}</span>
    </div>
  );
}

export function ActivityTab() {
  return <ActivityLog />;
}
