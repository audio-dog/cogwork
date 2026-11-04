import { Button } from "@cogwork/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiArrowRightUpLine,
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
import type { ComponentType, ReactNode } from "react";
import { createContext, use, useState } from "react";
import {
  type ActivityKind,
  type ActivityRow,
  activityLabels,
  type NowState,
  useOperationName,
} from "../features/activity-session";
import { runTitle } from "../features/feed";
import { relativeTime } from "../features/format";
import { useNow } from "../features/use-now";
import { useActivityView } from "./activity-view";
import { FunnelFilter } from "./funnel-filter";

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

const TimestampClockContext = createContext<number | null>(null);

function TimestampClockProvider({ children }: { children: ReactNode }) {
  const now = useNow();
  return <TimestampClockContext value={now}>{children}</TimestampClockContext>;
}

function EnginePulse({ engine }: { engine: NowState["engine"] }) {
  return (
    <span className="relative flex size-2 items-center justify-center">
      {engine === "up" && (
        <span className="absolute size-2 animate-ping rounded-full bg-primary opacity-60" />
      )}
      <span
        className={cn(
          "relative size-2 rounded-full",
          engine === "up" && "bg-primary",
          (engine === "starting" || engine === "off") && "bg-muted-foreground",
          engine === "failed" && "bg-destructive",
        )}
      />
    </span>
  );
}

function PulseDots() {
  return (
    <>
      <span className="inline-flex items-center gap-0.5" aria-hidden>
        <span className="size-1 animate-pulse rounded-full bg-primary" />
        <span className="size-1 animate-pulse rounded-full bg-primary [animation-delay:150ms]" />
        <span className="size-1 animate-pulse rounded-full bg-primary [animation-delay:300ms]" />
      </span>
      <span className="sr-only">Run active</span>
    </>
  );
}

function StatusSummary({ now }: { now: NowState }) {
  return (
    <div className="ml-auto flex min-w-0 items-center gap-2.5 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1 whitespace-nowrap">
        <RiFlashlightLine className="size-3.5" />
        {engineCopy[now.engine]}
      </span>
      <span className="flex items-center gap-1 whitespace-nowrap">
        <RiWifiLine className="size-3.5" />
        {connectionCopy[now.connection]}
      </span>
    </div>
  );
}

function SchedulerStrip({ scheduler }: { scheduler: NonNullable<NowState["scheduler"]> }) {
  return (
    <div className="mt-2.5 flex items-center rounded-md bg-muted/50 px-3 py-2 text-xs">
      <RiDashboard3Line className="mr-1.5 size-4 text-muted-foreground" />
      <span className="font-medium tabular-nums">
        {scheduler.globalInFlight}/{scheduler.globalLimit}
      </span>
      <span className="ml-1 text-muted-foreground">in flight</span>
      <span className="ml-auto tabular-nums text-muted-foreground">
        budget {scheduler.dailyBudgetUsed}/{scheduler.dailyBudgetLimit}
      </span>
    </div>
  );
}

function runPreview(run: NowState["runs"][number], operationName: string) {
  if (!run.preview) return operationName;
  if (!run.preview.text) return run.preview.label;
  return `${run.preview.label} · ${run.preview.text}`;
}

function RunRow({ run }: { run: NowState["runs"][number] }) {
  const { actions } = useActivityView();
  const operationName = useOperationName();
  return (
    <button
      type="button"
      onClick={() => actions.openRun(run)}
      className="flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-2 text-start outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <RiRobot2Line className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{runTitle(run)}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {runPreview(run, operationName(run))}
        </span>
      </span>
      <PulseDots />
    </button>
  );
}

function NowPanel() {
  const { state } = useActivityView();
  return (
    <section className="shrink-0 border-b bg-muted/20 px-3 py-3">
      <div className="flex items-center gap-2">
        <EnginePulse engine={state.now.engine} />
        <h3 className="text-sm font-semibold">Now</h3>
        <StatusSummary now={state.now} />
      </div>
      {state.now.scheduler && <SchedulerStrip scheduler={state.now.scheduler} />}
      {state.now.runs.length === 0 ? (
        <p className="mt-2.5 px-0.5 text-xs text-muted-foreground">No runs in flight.</p>
      ) : (
        <div className="mt-2.5 flex flex-col gap-1">
          {state.now.runs.map((run) => (
            <RunRow key={run.runId} run={run} />
          ))}
        </div>
      )}
    </section>
  );
}

function ToolbarAction({
  label,
  onClick,
  icon,
  pressed,
}: {
  label: string;
  onClick: () => void;
  icon: ReactNode;
  pressed: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={pressed}
            size="icon-sm"
            variant={pressed ? "secondary" : "ghost"}
            onClick={onClick}
          >
            {icon}
          </Button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function ToolbarActions() {
  const { state, actions } = useActivityView();
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <FunnelFilter.Control />
      {state.verbose ? (
        <ToolbarAction
          label="Hide minor events"
          onClick={actions.toggleVerbose}
          icon={<RiEyeLine data-icon="inline-start" />}
          pressed
        />
      ) : (
        <ToolbarAction
          label="Show minor events"
          onClick={actions.toggleVerbose}
          icon={<RiEyeOffLine data-icon="inline-start" />}
          pressed={false}
        />
      )}
      {state.frozen ? (
        <ToolbarAction
          label="Resume new events"
          onClick={actions.toggleFrozen}
          icon={<RiPlayMiniLine data-icon="inline-start" />}
          pressed
        />
      ) : (
        <ToolbarAction
          label="Pause new events"
          onClick={actions.toggleFrozen}
          icon={<RiPauseLine data-icon="inline-start" />}
          pressed={false}
        />
      )}
    </div>
  );
}

function Toolbar() {
  const { state, actions } = useActivityView();
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
      <InputGroup className="h-8 min-w-0 flex-1">
        <InputGroupInput
          value={state.query}
          onChange={(event) => actions.setQuery(event.target.value)}
          placeholder="Filter events…"
        />
        <InputGroupAddon>
          <RiSearchLine />
        </InputGroupAddon>
      </InputGroup>
      <ToolbarActions />
    </div>
  );
}

function EventEntityAction({ row }: { row: ActivityRow }) {
  const { actions } = useActivityView();
  const entity = row.entity;
  if (!entity) return null;
  const label = entity.type === "run" ? "Open run" : "Open item";
  return (
    <button
      type="button"
      title={`${label} ${entity.id}`}
      aria-label={`${label} ${entity.id}`}
      onClick={() => actions.openRow(row)}
      className="flex min-w-0 shrink items-center gap-1 rounded-sm font-mono text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="max-w-24 truncate">{entity.id}</span>
      <RiArrowRightUpLine className="size-3 shrink-0" />
    </button>
  );
}

function RawPayload({ raw }: { raw: string }) {
  return (
    <pre className="max-h-64 w-full overflow-auto rounded-md bg-muted p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground select-text">
      {raw}
    </pre>
  );
}

function groupRows(rows: readonly ActivityRow[]) {
  const groups: ActivityRow[][] = [];
  for (const row of rows) {
    const previous = groups.at(-1);
    if (previous?.[0]?.kind === row.kind) {
      previous.push(row);
      continue;
    }
    groups.push([row]);
  }
  return groups;
}

function historyDescription(kind: ActivityKind, count: number) {
  const eventLabel = activityLabels[kind].toLowerCase();
  const suffix = count === 1 ? "event" : "events";
  return `${count} earlier ${eventLabel} ${suffix}`;
}

function EmptyEvents() {
  return (
    <Empty className="py-12">
      <EmptyHeader>
        <EmptyTitle>No events match.</EmptyTitle>
        <EmptyDescription>The log is session-only and starts fresh each launch.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function RelativeTimestamp({ atMillis }: { atMillis: number }) {
  const now = use(TimestampClockContext);
  if (now === null) throw new Error("RelativeTimestamp must render inside TimestampClockProvider.");
  return (
    <time
      className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
      title={new Date(atMillis).toLocaleString()}
    >
      {relativeTime(atMillis, now)}
    </time>
  );
}

function TranscriptEvent({ row }: { row: ActivityRow }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = kindIcons[row.kind];
  return (
    <div className="flex flex-col rounded-md px-1 py-1 hover:bg-accent/20">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-start text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <Icon
              className={cn("size-3.5 text-muted-foreground", row.severity === "error" && "text-destructive")}
            />
          </span>
          <span
            className={cn("min-w-0 truncate font-medium", row.severity === "error" && "text-destructive")}
          >
            {row.summary}
          </span>
        </button>
        <EventEntityAction row={row} />
        <RelativeTimestamp atMillis={row.atMillis} />
      </div>
      {expanded && <RawPayload raw={row.raw} />}
    </div>
  );
}

function EventStack({ rows }: { rows: readonly ActivityRow[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      {rows.map((row) => (
        <TranscriptEvent key={row.id} row={row} />
      ))}
    </div>
  );
}

function InlineDisclosure({ newest, previous }: { newest: ActivityRow; previous: readonly ActivityRow[] }) {
  const [open, setOpen] = useState(false);
  if (previous.length === 0) return <TranscriptEvent row={newest} />;
  return (
    <div className="flex flex-col gap-0.5">
      <TranscriptEvent row={newest} />
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger render={<Button className="w-full justify-start" size="xs" variant="ghost" />}>
          {open ? (
            <RiArrowDownSLine data-icon="inline-start" />
          ) : (
            <RiArrowRightSLine data-icon="inline-start" />
          )}
          {open ? "Hide earlier events" : historyDescription(newest.kind, previous.length)}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <EventStack rows={previous} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function TranscriptGroup({ rows }: { rows: readonly ActivityRow[] }) {
  const [newest, ...previous] = rows;
  if (!newest) return null;
  return <InlineDisclosure newest={newest} previous={previous} />;
}

export function ActivityTranscript() {
  const { state, meta } = useActivityView();
  const groups = groupRows(state.rows);
  return (
    <TimestampClockProvider>
      <FunnelFilter.Provider value={meta.filter}>
        <div className="flex h-full min-h-0 flex-col">
          <NowPanel />
          <Toolbar />
          <FunnelFilter.Banner />
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-1 px-3 py-2">
              {groups.length === 0 ? (
                <EmptyEvents />
              ) : (
                groups.map((group) => <TranscriptGroup key={group[0]?.id} rows={group} />)
              )}
            </div>
          </ScrollArea>
        </div>
      </FunnelFilter.Provider>
    </TimestampClockProvider>
  );
}
