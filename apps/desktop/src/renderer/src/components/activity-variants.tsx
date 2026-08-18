// PROTOTYPE — throwaway. Three radically different two-zone layouts for the
// Activity tab (wayfinder ticket #27): a Now zone over a reverse-chronological
// event log. Wired to REAL daemon data via useActivityFeed() — no mocks
// (tickets #14/#27). Judged inside a mock side-panel frame so density reads
// true. Delete this file with prototype-switcher.tsx, activity-log.ts and the
// activity-prototype route once a layout wins.
//
// Fixed content/behaviour from #14 (not re-litigated here): two zones (Now over
// log); RunActivity folds to one heartbeat per run in the Now zone (never
// per-delta); the log is newest-at-top with a freeze toggle; rows carry a
// relative time, a type indicator, a one-line human summary, an entity link,
// error emphasis, and expand-to-raw; a verbosity toggle hides low-signal noise;
// filter by type + free-text; design language borrowed from #11 / t3code
// MessagesTimeline. This ticket decides only how the two zones LOOK and FEEL.

import { Button } from "@cogwork/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { Checkbox } from "@cogwork/ui/components/checkbox";
import { Input } from "@cogwork/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@cogwork/ui/components/popover";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiCheckLine,
  RiCloseLine,
  RiCodeLine,
  RiDashboard3Line,
  RiDeleteBinLine,
  RiExpandDiagonalLine,
  RiExternalLinkLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFileList2Line,
  RiFilter3Line,
  RiFlashlightLine,
  RiFolder3Line,
  RiPauseLine,
  RiPlayMiniLine,
  RiPulseLine,
  RiRobot2Line,
  RiSearchLine,
  RiWifiLine,
} from "@remixicon/react";
import {
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useState,
} from "react";
import {
  type ActivityKind,
  type ActivityRow,
  mockActivityFeed,
  type NowState,
  rowTime,
  type ScenarioKey,
  scenarioMeta,
  severityText,
  useActivityFeed,
} from "../features/activity-log";

export { type ScenarioKey, scenarioMeta };

// Make a non-button element behave like a toggle for keyboard users. Rows can't
// be real <button>s because they contain a nested entity-link button.
function toggleProps(onToggle: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onToggle,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onToggle();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared visual vocabulary
// ---------------------------------------------------------------------------

const kindIcon: Record<ActivityKind, ComponentType<{ className?: string }>> = {
  item: RiFileList2Line,
  "item-removed": RiDeleteBinLine,
  run: RiRobot2Line,
  workspace: RiFolder3Line,
  scheduler: RiDashboard3Line,
  engine: RiFlashlightLine,
  connection: RiWifiLine,
  stream: RiPulseLine,
};

// Category filter — groups the eight kinds into the handful a human reasons
// about ("show me runs", "show me system events"). Multi-select, so an empty
// selection means "all" (there is no explicit All chip — see #26 F5).
type TypeCategory = "run" | "item" | "workspace" | "scheduler" | "system";

const categoryMeta: ReadonlyArray<{ key: TypeCategory; label: string }> = [
  { key: "run", label: "Runs" },
  { key: "item", label: "Items" },
  { key: "scheduler", label: "Scheduler" },
  { key: "workspace", label: "Workspaces" },
  { key: "system", label: "System" },
];

const categoryLabel: Record<TypeCategory, string> = {
  run: "Runs",
  item: "Items",
  scheduler: "Scheduler",
  workspace: "Workspaces",
  system: "System",
};

const categoryOf = (kind: ActivityKind): TypeCategory => {
  if (kind === "item" || kind === "item-removed") return "item";
  if (kind === "engine" || kind === "connection" || kind === "stream") return "system";
  return kind;
};

const inSelected = (kind: ActivityKind, selected: ReadonlySet<TypeCategory>): boolean =>
  selected.size === 0 || selected.has(categoryOf(kind));

// The type filter is dependency-injected as state + actions + counts, so every
// variant renders the same selection with its own chrome.
interface TypeFilterState {
  readonly selected: ReadonlySet<TypeCategory>;
  readonly toggle: (c: TypeCategory) => void;
  readonly set: (next: ReadonlyArray<TypeCategory>) => void;
  readonly clear: () => void;
  readonly counts: Record<TypeCategory, number>;
}

// ---------------------------------------------------------------------------
// Shared props (composed differently by each variant)
// ---------------------------------------------------------------------------

interface VariantProps {
  readonly now: NowState;
  readonly log: ReadonlyArray<ActivityRow>; // filtered + newest-first
  readonly shown: number;
  readonly total: number;
  readonly types: TypeFilterState;
  readonly search: string;
  readonly setSearch: (v: string) => void;
  readonly verbose: boolean;
  readonly setVerbose: (v: boolean) => void;
  readonly frozen: boolean;
  readonly setFrozen: (v: boolean) => void;
  readonly onOpen: (row: ActivityRow) => void;
}

// ---------------------------------------------------------------------------
// Shared type filter — funnel + multi-select popover + summary banner. Reuses
// the Attention-tab filter design language (#26 F5): a funnel icon with an
// active dot, a fixed-width checkbox menu with an "All" reset, and a slim
// summary banner with Clear so the header never grows.
// ---------------------------------------------------------------------------

function TypeFunnel({ types }: { types: TypeFilterState }) {
  const active = types.selected.size > 0;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label="Filter event types" className="relative">
            <RiFilter3Line />
            {active && (
              <span className="absolute end-0.5 top-0.5 size-2 rounded-full bg-primary" aria-hidden />
            )}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-56">
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={types.clear}
            className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-start text-sm hover:bg-accent"
          >
            <span>All event types</span>
            {types.selected.size === 0 && <RiCheckLine className="size-4 text-muted-foreground" />}
          </button>
          <span className="my-0.5 h-px bg-border" aria-hidden />
          {categoryMeta.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => types.toggle(opt.key)}
              className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-start text-sm hover:bg-accent"
            >
              <Checkbox checked={types.selected.has(opt.key)} tabIndex={-1} className="pointer-events-none" />
              <span className="flex-1 truncate">{opt.label}</span>
              <span className="text-xs text-muted-foreground">{types.counts[opt.key]}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TypeBanner({ types }: { types: TypeFilterState }) {
  if (types.selected.size === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
      <RiFilter3Line className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {[...types.selected].map((c) => categoryLabel[c]).join(", ")}
      </span>
      <button type="button" onClick={types.clear} className="shrink-0 hover:text-foreground">
        Clear
      </button>
    </div>
  );
}

// An icon-only toggle with a real tooltip (verbose / freeze live here).
function IconToggle({
  on,
  onToggle,
  onIcon,
  offIcon,
  onLabel,
  offLabel,
}: {
  on: boolean;
  onToggle: () => void;
  onIcon: ReactNode;
  offIcon: ReactNode;
  onLabel: string;
  offLabel: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant={on ? "secondary" : "ghost"}
            aria-pressed={on}
            aria-label={on ? onLabel : offLabel}
            onClick={onToggle}
          >
            {on ? onIcon : offIcon}
          </Button>
        }
      />
      <TooltipContent side="bottom">{on ? onLabel : offLabel}</TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Now-zone atoms
// ---------------------------------------------------------------------------

const connectionTone: Record<NowState["connection"], string> = {
  live: "bg-emerald-500",
  connecting: "bg-amber-500",
  lost: "bg-destructive",
};

const engineTone: Record<NowState["engine"], string> = {
  up: "bg-emerald-500",
  starting: "bg-amber-500",
  off: "bg-muted-foreground/40",
  failed: "bg-destructive",
};

function StatusDot({ tone, pulse }: { tone: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2 items-center justify-center">
      {pulse && (
        <span className={cn("absolute inline-flex size-2 animate-ping rounded-full opacity-60", tone)} />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", tone)} />
    </span>
  );
}

function PulseDots() {
  return (
    <span className="inline-flex items-center gap-[3px]">
      <span className="size-1 animate-status-pulse rounded-full bg-muted-foreground/40" />
      <span className="size-1 animate-status-pulse rounded-full bg-muted-foreground/40 [animation-delay:200ms]" />
      <span className="size-1 animate-status-pulse rounded-full bg-muted-foreground/40 [animation-delay:400ms]" />
    </span>
  );
}

const engineLabel: Record<NowState["engine"], string> = {
  up: "Engine on",
  starting: "Engine starting",
  off: "Engine off",
  failed: "Engine failed",
};

const connectionLabel: Record<NowState["connection"], string> = {
  live: "Connected",
  connecting: "Connecting",
  lost: "Disconnected",
};

// ---------------------------------------------------------------------------
// Shared expand-to-raw block
// ---------------------------------------------------------------------------

function RawBlock({ raw }: { raw: string }) {
  return (
    <pre className="mt-1 ms-7 max-h-64 cursor-text overflow-auto border-s border-border/45 ps-3 pt-0.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground select-text">
      {raw}
    </pre>
  );
}

function EntityLink({ row, onOpen }: { row: ActivityRow; onOpen: (row: ActivityRow) => void }) {
  if (!row.entity) return null;
  const label = row.entity.type === "run" ? "run" : "item";
  return (
    <button
      type="button"
      className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(row);
      }}
      title={`Open ${label} → ${row.entity.id}`}
    >
      {row.entity.id}
      <RiExternalLinkLine className="size-3" />
    </button>
  );
}

// ===========================================================================
// VARIANT A — Transcript
// A faithful echo of the t3code MessagesTimeline language: an ultra-dense
// one-line-per-event stream, consecutive same-type rows folding behind a
// "+N previous" toggle, over a slim pinned "Now" band. Reads like a log tail.
// ===========================================================================

function TranscriptRow({ row, onOpen }: { row: ActivityRow; onOpen: (row: ActivityRow) => void }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = kindIcon[row.kind];
  return (
    <div
      className="flex cursor-pointer flex-col rounded-md px-0.5 py-0.5 transition-colors hover:bg-accent/20"
      {...toggleProps(() => setExpanded((v) => !v))}
    >
      <div className="flex select-none items-center gap-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <Icon className={cn("block size-3.5 shrink-0 opacity-80", severityText[row.severity])} />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <p className="flex w-full min-w-0 items-baseline gap-1.5 text-[12px] leading-5">
            <span
              className={cn(
                "min-w-0 shrink truncate font-medium",
                row.severity === "error" ? "text-destructive" : "text-foreground",
              )}
            >
              {row.summary}
            </span>
          </p>
          <EntityLink row={row} onOpen={onOpen} />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
            {rowTime(row.atMillis)}
          </span>
        </div>
      </div>
      {expanded && <RawBlock raw={row.raw} />}
    </div>
  );
}

// Fold consecutive same-kind rows, keeping the newest visible; the rest hide
// behind a "+N previous …" toggle (the MessagesTimeline signature).
interface FoldGroup {
  readonly kind: ActivityKind;
  readonly rows: ReadonlyArray<ActivityRow>;
}

function groupConsecutive(rows: ReadonlyArray<ActivityRow>): ReadonlyArray<FoldGroup> {
  const groups: FoldGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.kind === row.kind) (last.rows as ActivityRow[]).push(row);
    else groups.push({ kind: row.kind, rows: [row] });
  }
  return groups;
}

function TranscriptFold({ group, onOpen }: { group: FoldGroup; onOpen: (row: ActivityRow) => void }) {
  const [open, setOpen] = useState(false);
  if (group.rows.length === 1) return <TranscriptRow row={group.rows[0]} onOpen={onOpen} />;
  const [newest, ...rest] = group.rows;
  return (
    <div className="space-y-px">
      <TranscriptRow row={newest} onOpen={onOpen} />
      {open ? rest.map((row) => <TranscriptRow key={row.id} row={row} onOpen={onOpen} />) : null}
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <RiPlayMiniLine className={cn("size-3.5 opacity-70 transition-transform", open && "rotate-90")} />
        </span>
        <span className="font-medium">
          {open ? "Show fewer" : `+${rest.length} previous ${group.kind.replace("-", " ")} events`}
        </span>
      </button>
    </div>
  );
}

// The Now zone, brought over from Layout C but tightened: prominent enough to
// parse at a glance (engine / connection / scheduler gauge / heartbeat run
// rows), without the full Card weight so it still reads as a pinned header.
function NowPanel({ now }: { now: NowState }) {
  return (
    <div className="shrink-0 border-b bg-muted/20 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <StatusDot tone={engineTone[now.engine]} pulse={now.engine === "up"} />
        <span className="text-sm font-semibold">Now</span>
        <div className="ml-auto flex items-center gap-2.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <RiFlashlightLine className="size-3.5" />
            {engineLabel[now.engine]}
          </span>
          <span className="inline-flex items-center gap-1">
            <RiWifiLine className="size-3.5" />
            {connectionLabel[now.connection]}
          </span>
        </div>
      </div>
      {now.scheduler && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
          <RiDashboard3Line className="size-4 text-muted-foreground" />
          <span className="font-medium tabular-nums">
            {now.scheduler.globalInFlight}/{now.scheduler.globalLimit}
          </span>
          <span className="text-muted-foreground">in flight</span>
          <span className="ml-auto text-muted-foreground tabular-nums">
            budget {now.scheduler.dailyBudgetUsed}/{now.scheduler.dailyBudgetLimit}
          </span>
        </div>
      )}
      {now.runs.length > 0 ? (
        <div className="mt-2 space-y-1">
          {now.runs.map((run) => (
            <div
              key={run.runId}
              className="flex items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 py-1.5"
            >
              <RiRobot2Line className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{run.workItem}</p>
                {run.preview && (
                  <p className="truncate text-[11px] text-muted-foreground">
                    {run.preview.label}
                    {run.preview.text ? ` · ${run.preview.text}` : ""}
                  </p>
                )}
              </div>
              <PulseDots />
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 px-0.5 text-xs text-muted-foreground">No runs in flight.</p>
      )}
    </div>
  );
}

function VariantA(props: VariantProps) {
  const groups = groupConsecutive(props.log);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <NowPanel now={props.now} />
      <TranscriptToolbar {...props} />
      <TypeBanner types={props.types} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="-mx-1 space-y-px px-3 py-1">
          {groups.length === 0 ? (
            <EmptyLog />
          ) : (
            groups.map((group, i) => (
              <TranscriptFold key={`${group.kind}:${i}`} group={group} onOpen={props.onOpen} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function TranscriptToolbar(props: VariantProps) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
      <div className="relative min-w-0 flex-1">
        <RiSearchLine className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={props.search}
          onChange={(e) => props.setSearch(e.target.value)}
          placeholder="Filter events…"
          className="h-7 ps-7 text-xs"
        />
      </div>
      <TypeFunnel types={props.types} />
      <TooltipProvider>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconToggle
            on={props.verbose}
            onToggle={() => props.setVerbose(!props.verbose)}
            onIcon={<RiEyeLine />}
            offIcon={<RiEyeOffLine />}
            onLabel="Hide minor events"
            offLabel="Show minor events"
          />
          <IconToggle
            on={props.frozen}
            onToggle={() => props.setFrozen(!props.frozen)}
            onIcon={<RiPlayMiniLine />}
            offIcon={<RiPauseLine />}
            onLabel="Resume new events"
            offLabel="Pause new events"
          />
        </div>
      </TooltipProvider>
    </div>
  );
}

function EmptyLog() {
  return (
    <p className="px-1 py-8 text-center text-xs text-muted-foreground">
      No events match. The log is session-only and starts fresh each launch.
    </p>
  );
}

// ===========================================================================
// VARIANT B — Console ledger
// A debug-console aesthetic: a dense status band on top, then a monospace
// tabular log — [time · TYPE · summary · entity] — with a left accent bar for
// errors. Prominent Freeze. For the operator who wants the firehose.
// ===========================================================================

function ConsoleStatusBand({ now }: { now: NowState }) {
  return (
    <div className="shrink-0 border-b bg-background px-3 py-2 font-mono text-[11px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={engineTone[now.engine]} pulse={now.engine === "up"} />
          <span className="text-muted-foreground">engine</span>
          <span className="text-foreground">{now.engine}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={connectionTone[now.connection]} />
          <span className="text-muted-foreground">conn</span>
          <span className="text-foreground">{now.connection}</span>
        </span>
        {now.scheduler && (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground">sched</span>
            <span className="text-foreground">
              {now.scheduler.globalInFlight}/{now.scheduler.globalLimit}
            </span>
            <span className="text-muted-foreground">
              · budget {now.scheduler.dailyBudgetUsed}/{now.scheduler.dailyBudgetLimit}
            </span>
          </span>
        )}
      </div>
      {now.runs.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {now.runs.map((run) => (
            <span
              key={run.runId}
              className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-border/60 bg-muted/40 px-1.5 py-0.5"
              title={run.preview ? `${run.preview.label} · ${run.preview.text}` : run.workItem}
            >
              <PulseDots />
              <span className="truncate text-foreground">{run.workItem}</span>
              {run.preview && <span className="truncate text-muted-foreground">{run.preview.label}</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ConsoleRow({ row, onOpen }: { row: ActivityRow; onOpen: (row: ActivityRow) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={cn(
        "cursor-pointer border-s-2 pl-2 font-mono text-[11px] transition-colors hover:bg-accent/20",
        row.severity === "error"
          ? "border-destructive"
          : row.severity === "warn"
            ? "border-amber-500/70"
            : "border-transparent",
      )}
      {...toggleProps(() => setExpanded((v) => !v))}
    >
      <div className="flex items-baseline gap-2 py-0.5">
        <span className="w-12 shrink-0 tabular-nums text-muted-foreground/70">{rowTime(row.atMillis)}</span>
        <span
          className={cn(
            "w-16 shrink-0 truncate uppercase",
            row.severity === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {row.label}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", row.severity === "error" && "text-destructive")}>
          {row.summary}
        </span>
        {row.entity && <EntityLink row={row} onOpen={onOpen} />}
      </div>
      {expanded && (
        <pre className="mb-1 max-h-64 overflow-auto rounded-sm bg-muted/50 p-2 text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground select-text">
          {row.raw}
        </pre>
      )}
    </div>
  );
}

function VariantB(props: VariantProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ConsoleStatusBand now={props.now} />
      {/* Toolbar — console style */}
      <div className="flex shrink-0 items-center gap-1.5 border-b bg-muted/20 px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <RiCodeLine className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={props.search}
            onChange={(e) => props.setSearch(e.target.value)}
            placeholder="grep the log…"
            className="h-7 ps-7 font-mono text-xs"
          />
        </div>
        <Button
          size="sm"
          variant={props.frozen ? "secondary" : "outline"}
          onClick={() => props.setFrozen(!props.frozen)}
          className="gap-1.5"
        >
          {props.frozen ? <RiPlayMiniLine /> : <RiPauseLine />}
          {props.frozen ? "Frozen" : "Freeze"}
        </Button>
        <TooltipProvider>
          <IconToggle
            on={props.verbose}
            onToggle={() => props.setVerbose(!props.verbose)}
            onIcon={<RiEyeLine />}
            offIcon={<RiEyeOffLine />}
            onLabel="Hide minor events"
            offLabel="Show minor events"
          />
        </TooltipProvider>
      </div>
      <div className="flex shrink-0 gap-1 border-b bg-muted/10 px-2 py-1">
        <button
          type="button"
          onClick={props.types.clear}
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors",
            props.types.selected.size === 0
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
          )}
        >
          all
        </button>
        {categoryMeta.map((opt) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => props.types.toggle(opt.key)}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors",
              props.types.selected.has(opt.key)
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
            )}
          >
            {opt.label.toLowerCase()}
          </button>
        ))}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 py-1">
          {props.log.length === 0 ? (
            <EmptyLog />
          ) : (
            props.log.map((row) => <ConsoleRow key={row.id} row={row} onOpen={props.onOpen} />)
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ===========================================================================
// VARIANT C — Grouped cards
// The calm "engine works, events flow" default: a prominent Now card with
// heartbeat cards for active runs, then the log grouped under relative-time
// section headers with roomy, icon-welled rows. For glance-and-move-on.
// ===========================================================================

function timeBucket(atMillis: number, now = Date.now()): string {
  const mins = Math.floor(Math.max(0, now - atMillis) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 5) return "Last few minutes";
  if (mins < 60) return "Earlier this hour";
  return "Older";
}

function NowCard({ now }: { now: NowState }) {
  return (
    <Card className="gap-0 border-primary/30 py-0">
      <CardHeader className="flex-row items-center gap-2 px-3 py-2.5">
        <StatusDot tone={engineTone[now.engine]} pulse={now.engine === "up"} />
        <CardTitle className="text-sm">Now</CardTitle>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <RiFlashlightLine className="size-3.5" />
            {engineLabel[now.engine]}
          </span>
          <span className="inline-flex items-center gap-1">
            <RiWifiLine className="size-3.5" />
            {connectionLabel[now.connection]}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 px-3 pb-3">
        {now.scheduler && (
          <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
            <RiDashboard3Line className="size-4 text-muted-foreground" />
            <span className="font-medium tabular-nums">
              {now.scheduler.globalInFlight}/{now.scheduler.globalLimit}
            </span>
            <span className="text-muted-foreground">in flight</span>
            <span className="ml-auto text-muted-foreground tabular-nums">
              budget {now.scheduler.dailyBudgetUsed}/{now.scheduler.dailyBudgetLimit}
            </span>
          </div>
        )}
        {now.runs.length === 0 ? (
          <p className="px-0.5 py-1 text-xs text-muted-foreground">No runs in flight.</p>
        ) : (
          now.runs.map((run) => (
            <div
              key={run.runId}
              className="flex items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 py-2"
            >
              <RiRobot2Line className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{run.workItem}</p>
                {run.preview && (
                  <p className="truncate text-[11px] text-muted-foreground">
                    {run.preview.label}
                    {run.preview.text ? ` · ${run.preview.text}` : ""}
                  </p>
                )}
              </div>
              <PulseDots />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function CardRow({ row, onOpen }: { row: ActivityRow; onOpen: (row: ActivityRow) => void }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = kindIcon[row.kind];
  return (
    <div
      className={cn(
        "cursor-pointer rounded-lg border px-3 py-2 transition-colors hover:bg-accent/30",
        row.severity === "error" ? "border-destructive/40 bg-destructive/5" : "border-border/60 bg-card",
      )}
      {...toggleProps(() => setExpanded((v) => !v))}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md",
            row.severity === "error" ? "bg-destructive/10" : "bg-muted",
          )}
        >
          <Icon className={cn("size-4", severityText[row.severity])} />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "truncate text-sm",
              row.severity === "error" ? "font-medium text-destructive" : "text-foreground",
            )}
          >
            {row.summary}
          </p>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{row.label}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{rowTime(row.atMillis)}</span>
          </p>
        </div>
        {row.entity && <EntityLink row={row} onOpen={onOpen} />}
      </div>
      {expanded && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/50 p-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground select-text">
          {row.raw}
        </pre>
      )}
    </div>
  );
}

function VariantC(props: VariantProps) {
  // Group newest-first log into relative-time buckets, preserving order.
  const buckets: Array<{ label: string; rows: ActivityRow[] }> = [];
  for (const row of props.log) {
    const label = timeBucket(row.atMillis);
    const last = buckets[buckets.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else buckets.push({ label, rows: [row] });
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          <NowCard now={props.now} />
          {/* Toolbar — inline, calm */}
          <div className="space-y-2">
            <div className="relative">
              <RiSearchLine className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={props.search}
                onChange={(e) => props.setSearch(e.target.value)}
                placeholder="Search the event log…"
                className="h-8 ps-8 text-xs"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <ToggleGroup
                multiple
                spacing={0}
                value={[...props.types.selected]}
                onValueChange={(v) => props.types.set(v as ReadonlyArray<TypeCategory>)}
              >
                {categoryMeta.map((opt) => (
                  <ToggleGroupItem
                    key={opt.key}
                    value={opt.key}
                    variant="outline"
                    size="sm"
                    className="text-xs"
                  >
                    {opt.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  size="sm"
                  variant={props.verbose ? "secondary" : "ghost"}
                  onClick={() => props.setVerbose(!props.verbose)}
                  className="gap-1.5"
                >
                  {props.verbose ? <RiEyeLine /> : <RiEyeOffLine />}
                  Verbose
                </Button>
                <Button
                  size="sm"
                  variant={props.frozen ? "secondary" : "ghost"}
                  onClick={() => props.setFrozen(!props.frozen)}
                  className="gap-1.5"
                >
                  {props.frozen ? <RiPlayMiniLine /> : <RiPauseLine />}
                  {props.frozen ? "Frozen" : "Freeze"}
                </Button>
              </div>
            </div>
          </div>
          {buckets.length === 0 ? (
            <EmptyLog />
          ) : (
            buckets.map((bucket) => (
              <section key={bucket.label} className="space-y-1.5">
                <h4 className="px-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {bucket.label}
                </h4>
                <div className="space-y-1.5">
                  {bucket.rows.map((row) => (
                    <CardRow key={row.id} row={row} onOpen={props.onOpen} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ===========================================================================
// Stage + harness chrome
// ===========================================================================

export type VariantKey = "a" | "b" | "c";

export const variantMeta: ReadonlyArray<{ key: VariantKey; name: string }> = [
  { key: "a", name: "Transcript" },
  { key: "b", name: "Console ledger" },
  { key: "c", name: "Grouped cards" },
];

function VariantBody({ variant, props }: { variant: VariantKey; props: VariantProps }) {
  if (variant === "a") return <VariantA {...props} />;
  if (variant === "b") return <VariantB {...props} />;
  return <VariantC {...props} />;
}

// Mimics the RightPanel tab strip so the variant is judged in context.
export function PanelFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col border-l bg-background">
      <div className="flex h-11 min-h-11 shrink-0 items-center gap-1 border-b px-2">
        <div className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground">
          Attention
        </div>
        <div className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2 text-xs text-foreground">
          <RiPulseLine className="size-3.5" />
          Activity
        </div>
        <div className="ml-auto flex items-center gap-1 text-muted-foreground">
          <RiExpandDiagonalLine className="size-4" />
          <RiCloseLine className="size-4" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function FakeMainColumn() {
  return (
    <div className="flex h-full flex-col gap-3 p-6 opacity-40 select-none" aria-hidden>
      <div className="h-6 w-32 rounded bg-muted" />
      <div className="mt-2 h-24 rounded-lg border bg-card" />
      <div className="h-9 w-full rounded bg-muted/60" />
      <div className="h-9 w-full rounded bg-muted/60" />
      <div className="h-9 w-full rounded bg-muted/60" />
    </div>
  );
}

function LastOpened({ row }: { row: ActivityRow | null }) {
  return (
    <div className="border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
      {row?.entity ? (
        <span>
          Would open {row.entity.type === "run" ? "run transcript" : "item tab"} →{" "}
          <span className="font-mono text-foreground">{row.entity.id}</span>
        </span>
      ) : (
        <span>Click an entity link to see where it navigates.</span>
      )}
    </div>
  );
}

export function ActivityStage({
  variant,
  scenario,
  full,
}: {
  variant: VariantKey;
  scenario: ScenarioKey;
  full: boolean;
}) {
  // Always call the hook (rules of hooks); use it only for the Live scenario.
  const live = useActivityFeed();
  const feed = scenario === "live" ? live : mockActivityFeed(scenario);
  const [selectedTypes, setSelectedTypes] = useState<ReadonlySet<TypeCategory>>(new Set());
  const [search, setSearch] = useState("");
  const [verbose, setVerbose] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [lastOpened, setLastOpened] = useState<ActivityRow | null>(null);

  // Freeze: snapshot the raw log at the moment freeze turns on (effect-free).
  const [frozenLog, setFrozenLog] = useState<ReadonlyArray<ActivityRow> | null>(null);
  if (frozen && frozenLog === null) setFrozenLog(feed.log);
  if (!frozen && frozenLog !== null) setFrozenLog(null);

  const source = frozen && frozenLog ? frozenLog : feed.log;

  // Counts reflect the verbosity-filtered log, before the type filter narrows.
  const visibleForCounts = source.filter((row) => verbose || !row.lowSignal);
  const counts: Record<TypeCategory, number> = { run: 0, item: 0, scheduler: 0, workspace: 0, system: 0 };
  for (const row of visibleForCounts) counts[categoryOf(row.kind)] += 1;

  const needle = search.trim().toLowerCase();
  const filtered = source.filter((row) => {
    if (!verbose && row.lowSignal) return false;
    if (!inSelected(row.kind, selectedTypes)) return false;
    if (needle && !`${row.summary} ${row.label} ${row.entity?.id ?? ""}`.toLowerCase().includes(needle))
      return false;
    return true;
  });
  const newestFirst = [...filtered].reverse();

  const types: TypeFilterState = {
    selected: selectedTypes,
    toggle: (c) =>
      setSelectedTypes((prev) => {
        const next = new Set(prev);
        if (next.has(c)) next.delete(c);
        else next.add(c);
        return next;
      }),
    set: (nextCategories) => setSelectedTypes(new Set(nextCategories)),
    clear: () => setSelectedTypes(new Set()),
    counts,
  };

  const props: VariantProps = {
    now: feed.now,
    log: newestFirst,
    shown: newestFirst.length,
    total: feed.total,
    types,
    search,
    setSearch,
    verbose,
    setVerbose,
    frozen,
    setFrozen,
    onOpen: setLastOpened,
  };

  const panel = (
    <div className="flex h-full min-h-0 flex-col">
      <PanelFrame>
        {!feed.ready && feed.log.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">Waiting for the daemon…</p>
        ) : (
          <VariantBody variant={variant} props={props} />
        )}
      </PanelFrame>
      <LastOpened row={lastOpened} />
    </div>
  );

  if (full) return <div className="h-full">{panel}</div>;
  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1">
        <FakeMainColumn />
      </div>
      <div className="w-[440px] shrink-0">{panel}</div>
    </div>
  );
}
