// PROTOTYPE — throwaway. A lightweight, client-side version of the "single
// unified renderer event source" the Activity-tab build will need (map #7,
// "Not yet specified"): it merges the real daemon WatchEvents stream with
// synthesized app/engine-lifecycle events (engine on/off, connection
// lost/restored, stream errors), decodes a one-line human summary per event
// type, and folds RunActivity into one heartbeat per run for the Now zone.
//
// This exists only so the two-zone layout (ticket #27) can be judged against
// REAL data — no mocks. It is not the production seam; delete it with the rest
// of the prototype once a layout wins. Wired to useLiveEvents / useBoard.

import type {
  ClassifiedItem,
  DaemonEvent,
  RunStatus,
  RunSummary,
  SchedulerStats,
  WorkspaceState,
} from "@cogwork/contracts";
import { useRef, useState } from "react";
import { relativeTime } from "./format";
import { type RunActivityPreview, runPreviews } from "./run-activity";
import { type EnginePhase, enginePhase, useEngineStatus } from "./use-engine-status";
import { useLiveEvents } from "./use-live-events";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type ActivityKind =
  | "item" // ItemChanged
  | "item-removed" // ItemRemoved
  | "run" // RunChanged (run lifecycle milestone)
  | "workspace" // WorkspaceChanged
  | "scheduler" // SchedulerChanged
  | "engine" // synthesized engine on/off
  | "connection" // synthesized connection lost/restored
  | "stream"; // synthesized stream error

export type ActivitySeverity = "info" | "success" | "warn" | "error";

export interface ActivityEntity {
  readonly type: "run" | "item";
  readonly id: string;
  readonly workspace: string | null;
}

export interface ActivityRow {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly atMillis: number;
  readonly label: string; // type indicator label ("Run", "Item", …)
  readonly summary: string; // one-line human summary
  readonly severity: ActivitySeverity;
  readonly entity: ActivityEntity | null;
  readonly raw: string; // pretty-printed payload for expand-to-raw
  readonly lowSignal: boolean; // hidden unless the verbosity toggle is on
}

export interface ActiveRun {
  readonly runId: string;
  readonly workspace: string;
  readonly workItem: string;
  readonly stage: string;
  readonly status: RunStatus;
  readonly preview: RunActivityPreview | null;
}

export type ConnectionState = "live" | "connecting" | "lost";

export interface NowState {
  readonly engine: EnginePhase;
  readonly connection: ConnectionState;
  readonly scheduler: SchedulerStats | null;
  readonly runs: ReadonlyArray<ActiveRun>;
}

export interface ActivityFeed {
  readonly ready: boolean;
  readonly now: NowState;
  readonly log: ReadonlyArray<ActivityRow>; // oldest → newest
  readonly total: number;
}

// ---------------------------------------------------------------------------
// Human-summary decoding
// ---------------------------------------------------------------------------

const classifiedLabel = (item: ClassifiedItem): { text: string; severity: ActivitySeverity } => {
  switch (item._tag) {
    case "Eligible":
      return { text: "eligible", severity: "info" };
    case "Claimed":
      return { text: "claimed", severity: "info" };
    case "Blocked":
      return { text: `blocked · ${item.openBlockers} open`, severity: "warn" };
    case "NeedsHuman":
      return { text: "needs a person", severity: "warn" };
  }
};

const runSeverity: Record<RunStatus, ActivitySeverity> = {
  running: "info",
  succeeded: "success",
  failed: "error",
  exhausted: "warn",
  interrupted: "warn",
  crashed: "error",
};

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

const runRow = (run: RunSummary): ActivityRow => ({
  id: `run:${run.id}:${run.status}:${run.endedAtMillis ?? run.startedAtMillis}`,
  kind: "run",
  atMillis: run.endedAtMillis ?? run.startedAtMillis,
  label: "Run",
  summary: `${run.workItem} · run ${run.status}`,
  severity: runSeverity[run.status],
  entity: { type: "run", id: run.id, workspace: run.workspace },
  raw: pretty(run),
  lowSignal: false,
});

const workspaceRow = (workspace: WorkspaceState, atMillis: number): ActivityRow => {
  if (workspace._tag === "Registered") {
    return {
      id: `ws:${workspace.name}:${atMillis}`,
      kind: "workspace",
      atMillis,
      label: "Workspace",
      summary: `${workspace.name} registered · ${workspace.issueTracker}`,
      severity: "info",
      entity: null,
      raw: pretty(workspace),
      lowSignal: false,
    };
  }
  return {
    id: `ws:${workspace.source}:${atMillis}`,
    kind: "workspace",
    atMillis,
    label: "Workspace",
    summary: `${workspace.source} failed · ${workspace.message}`,
    severity: "error",
    entity: null,
    raw: pretty(workspace),
    lowSignal: false,
  };
};

const schedulerRow = (scheduler: SchedulerStats, atMillis: number): ActivityRow => {
  const paused = scheduler.scheduling === "paused";
  return {
    id: `sched:${atMillis}`,
    kind: "scheduler",
    atMillis,
    label: "Scheduler",
    summary: paused
      ? `paused · ${scheduler.globalInFlight}/${scheduler.globalLimit} in flight`
      : `${scheduler.globalInFlight}/${scheduler.globalLimit} in flight · budget ${scheduler.dailyBudgetUsed}/${scheduler.dailyBudgetLimit}`,
    severity: paused ? "warn" : "info",
    entity: null,
    raw: pretty(scheduler),
    lowSignal: !paused,
  };
};

// Decode a single daemon event into a log row. Returns null for RunActivity —
// those feed the Now-zone heartbeat (runPreviews), never a per-delta log row.
const decode = (event: DaemonEvent, atMillis: number): ActivityRow | null => {
  switch (event._tag) {
    case "RunActivity":
      return null;
    case "ItemChanged": {
      const label = classifiedLabel(event.item);
      return {
        id: `item:${event.workspace}:${event.item.id}:${atMillis}`,
        kind: "item",
        atMillis,
        label: "Item",
        summary: `${event.item.title} → ${label.text}`,
        severity: label.severity,
        entity: { type: "item", id: event.item.id, workspace: event.workspace },
        raw: pretty(event.item),
        lowSignal: event.item._tag === "Eligible",
      };
    }
    case "ItemRemoved":
      return {
        id: `rm:${event.workspace}:${event.id}:${atMillis}`,
        kind: "item-removed",
        atMillis,
        label: "Item",
        summary: `${event.id} removed`,
        severity: "info",
        entity: { type: "item", id: event.id, workspace: event.workspace },
        raw: pretty({ workspace: event.workspace, id: event.id }),
        lowSignal: true,
      };
    case "RunChanged":
      return runRow(event.run);
    case "WorkspaceChanged":
      return workspaceRow(event.workspace, atMillis);
    case "SchedulerChanged":
      return schedulerRow(event.scheduler, atMillis);
  }
};

// ---------------------------------------------------------------------------
// Now-zone derivation
// ---------------------------------------------------------------------------

const activeRuns = (
  runs: ReadonlyMap<string, RunSummary>,
  previews: ReadonlyMap<string, RunActivityPreview>,
): ReadonlyArray<ActiveRun> =>
  [...runs.values()]
    .filter((run) => run.status === "running")
    .sort((a, b) => b.startedAtMillis - a.startedAtMillis)
    .map((run) => ({
      runId: run.id,
      workspace: run.workspace,
      workItem: run.workItem,
      stage: run.stage,
      status: run.status,
      preview: previews.get(run.id) ?? null,
    }));

// ---------------------------------------------------------------------------
// The hook: real data + arrival stamping + synthesized lifecycle
// ---------------------------------------------------------------------------

interface SynthRow extends ActivityRow {}

const engineSummary: Record<EnginePhase, { summary: string; severity: ActivitySeverity }> = {
  up: { summary: "Engine started", severity: "success" },
  starting: { summary: "Engine starting", severity: "info" },
  off: { summary: "Engine stopped", severity: "warn" },
  failed: { summary: "Engine failed", severity: "error" },
};

export function useActivityFeed(): ActivityFeed {
  const events = useLiveEvents();
  const { status } = useEngineStatus();
  const engine = enginePhase(status);

  // Arrival stamping: the daemon stream carries a real timestamp only on
  // RunActivity, so stamp every accumulated event on first sight (throwaway,
  // session-only). Index is stable because the atom only appends.
  const stamps = useRef<number[]>([]);
  const items = events._tag === "Success" ? events.value.items : [];
  if (stamps.current.length < items.length) {
    const now = Date.now();
    for (let i = stamps.current.length; i < items.length; i++) stamps.current.push(now);
  }

  // Synthesized lifecycle rows, appended on transition (effect-free: the
  // React-blessed "adjust state while rendering" pattern via a prev ref).
  const [synth, setSynth] = useState<ReadonlyArray<SynthRow>>([]);
  const prev = useRef<{ engine: EnginePhase | null; connection: ConnectionState }>({
    engine: null,
    connection: "connecting",
  });

  const connection: ConnectionState =
    events._tag === "Failure" ? "lost" : events._tag === "Success" ? "live" : "connecting";

  if (prev.current.engine !== engine || prev.current.connection !== connection) {
    const now = Date.now();
    const added: SynthRow[] = [];
    if (prev.current.engine !== engine) {
      const meta = engineSummary[engine];
      added.push({
        id: `engine:${engine}:${now}`,
        kind: "engine",
        atMillis: now,
        label: "Engine",
        summary: meta.summary,
        severity: meta.severity,
        entity: null,
        raw: pretty({ engine, status }),
        lowSignal: false,
      });
    }
    if (prev.current.connection !== connection) {
      const isLost = connection === "lost";
      added.push({
        id: `conn:${connection}:${now}`,
        kind: connection === "lost" ? "stream" : "connection",
        atMillis: now,
        label: connection === "lost" ? "Stream" : "Connection",
        summary:
          connection === "lost"
            ? "Event stream disconnected"
            : connection === "live"
              ? "Connection restored"
              : "Connecting…",
        severity: isLost ? "error" : "info",
        entity: null,
        raw: pretty({ connection }),
        lowSignal: connection === "connecting",
      });
    }
    prev.current = { engine, connection };
    if (added.length > 0) setSynth((rows) => [...rows, ...added]);
  }

  const board = items.reduce((acc, event) => applyToNow(acc, event), {
    runs: new Map<string, RunSummary>(),
    scheduler: null as SchedulerStats | null,
  });
  const previews = runPreviews(items);

  const daemonRows: ActivityRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const row = decode(items[i], stamps.current[i] ?? Date.now());
    if (row) daemonRows.push(row);
  }

  const log = [...daemonRows, ...synth].sort((a, b) => a.atMillis - b.atMillis);

  return {
    ready: events._tag === "Success",
    now: {
      engine,
      connection,
      scheduler: board.scheduler,
      runs: activeRuns(board.runs, previews),
    },
    log,
    total: log.length,
  };
}

// Minimal Now-zone fold — only the run map + scheduler are needed here, so we
// avoid recomputing the full Board.
interface NowFold {
  runs: Map<string, RunSummary>;
  scheduler: SchedulerStats | null;
}
const applyToNow = (fold: NowFold, event: DaemonEvent): NowFold => {
  if (event._tag === "RunChanged") fold.runs.set(event.run.id, event.run);
  if (event._tag === "SchedulerChanged") fold.scheduler = event.scheduler;
  return fold;
};

export const severityText: Record<ActivitySeverity, string> = {
  info: "text-muted-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
};

export const rowTime = (atMillis: number) => relativeTime(atMillis);

// ---------------------------------------------------------------------------
// Mock scenarios (DEV ONLY)
//
// The daemon has no live events while the engine is off, so these seed the
// layouts with a realistic feed purely so the two-zone density can be judged
// (ticket #27). They never ship — the whole prototype is throwaway — and the
// switcher keeps a "Live daemon" scenario for when the engine is running.
// ---------------------------------------------------------------------------

export type ScenarioKey = "busy" | "calm" | "errors" | "live";

export const scenarioMeta: ReadonlyArray<{ key: ScenarioKey; name: string }> = [
  { key: "busy", name: "Busy · all event kinds" },
  { key: "calm", name: "Calm · engine ticking over" },
  { key: "errors", name: "Errors · degraded engine" },
  { key: "live", name: "Live daemon" },
];

const MIN = 60_000;

interface RowSeed {
  readonly agoMin: number;
  readonly kind: ActivityKind;
  readonly label: string;
  readonly summary: string;
  readonly severity: ActivitySeverity;
  readonly entity?: ActivityEntity;
  readonly lowSignal?: boolean;
  readonly raw?: unknown;
}

const seedRows = (now: number, seeds: ReadonlyArray<RowSeed>): ReadonlyArray<ActivityRow> =>
  seeds
    .map((seed, i) => ({
      id: `mock:${i}:${seed.kind}`,
      kind: seed.kind,
      atMillis: now - seed.agoMin * MIN,
      label: seed.label,
      summary: seed.summary,
      severity: seed.severity,
      entity: seed.entity ?? null,
      raw: JSON.stringify(seed.raw ?? { mock: true, kind: seed.kind, summary: seed.summary }, null, 2),
      lowSignal: seed.lowSignal ?? false,
    }))
    .sort((a, b) => a.atMillis - b.atMillis);

const item = (id: string, workspace: string): ActivityEntity => ({ type: "item", id, workspace });
const run = (id: string, workspace: string): ActivityEntity => ({ type: "run", id, workspace });

const busyNow = (): NowState => ({
  engine: "up",
  connection: "live",
  scheduler: {
    scheduling: "running",
    globalInFlight: 2,
    globalLimit: 4,
    dailyBudgetUsed: 37,
    dailyBudgetLimit: 100,
    perWorkspace: [],
  } as SchedulerStats,
  runs: [
    {
      runId: "run_8f2a",
      workspace: "api",
      workItem: "api#412",
      stage: "implement",
      status: "running",
      preview: { label: "edit", text: "packages/contracts/src/run.ts" },
    },
    {
      runId: "run_1c7d",
      workspace: "web",
      workItem: "web#88",
      stage: "triage",
      status: "running",
      preview: { label: "responding", text: "Looking at the failing snapshot test in the composer…" },
    },
  ],
});

const busySeeds: ReadonlyArray<RowSeed> = [
  { agoMin: 44, kind: "engine", label: "Engine", summary: "Engine started", severity: "success" },
  { agoMin: 43, kind: "workspace", label: "Workspace", summary: "api registered · github", severity: "info" },
  { agoMin: 43, kind: "workspace", label: "Workspace", summary: "web registered · github", severity: "info" },
  {
    agoMin: 40,
    kind: "scheduler",
    label: "Scheduler",
    summary: "0/4 in flight · budget 0/100",
    severity: "info",
    lowSignal: true,
  },
  {
    agoMin: 31,
    kind: "item",
    label: "Item",
    summary: "Add rate limiting to the public API → claimed",
    severity: "info",
    entity: item("api#412", "api"),
  },
  {
    agoMin: 28,
    kind: "run",
    label: "Run",
    summary: "api#412 · run running",
    severity: "info",
    entity: run("run_8f2a", "api"),
  },
  // A burst of consecutive Item events to exercise Variant A's "+N previous" fold.
  {
    agoMin: 19,
    kind: "item",
    label: "Item",
    summary: "Fix flaky auth test → claimed",
    severity: "info",
    entity: item("api#409", "api"),
  },
  {
    agoMin: 18,
    kind: "item",
    label: "Item",
    summary: "Upgrade Effect to v4 → blocked · 2 open",
    severity: "warn",
    entity: item("api#377", "api"),
  },
  {
    agoMin: 18,
    kind: "item",
    label: "Item",
    summary: "Composer emoji picker → needs a person",
    severity: "warn",
    entity: item("web#88", "web"),
  },
  {
    agoMin: 12,
    kind: "scheduler",
    label: "Scheduler",
    summary: "2/4 in flight · budget 21/100",
    severity: "info",
    lowSignal: true,
  },
  {
    agoMin: 9,
    kind: "run",
    label: "Run",
    summary: "web#88 · run succeeded",
    severity: "success",
    entity: run("run_0b41", "web"),
  },
  { agoMin: 6, kind: "stream", label: "Stream", summary: "Event stream disconnected", severity: "error" },
  { agoMin: 6, kind: "connection", label: "Connection", summary: "Connection restored", severity: "info" },
  {
    agoMin: 4,
    kind: "run",
    label: "Run",
    summary: "api#377 · run failed",
    severity: "error",
    entity: run("run_9d02", "api"),
  },
  {
    agoMin: 2,
    kind: "item-removed",
    label: "Item",
    summary: "api#360 removed",
    severity: "info",
    entity: item("api#360", "api"),
    lowSignal: true,
  },
  {
    agoMin: 1,
    kind: "run",
    label: "Run",
    summary: "api#412 · run running",
    severity: "info",
    entity: run("run_8f2a", "api"),
  },
  {
    agoMin: 0,
    kind: "scheduler",
    label: "Scheduler",
    summary: "2/4 in flight · budget 37/100",
    severity: "info",
    lowSignal: true,
  },
];

const calmNow = (): NowState => ({
  engine: "up",
  connection: "live",
  scheduler: {
    scheduling: "running",
    globalInFlight: 1,
    globalLimit: 4,
    dailyBudgetUsed: 8,
    dailyBudgetLimit: 100,
    perWorkspace: [],
  } as SchedulerStats,
  runs: [
    {
      runId: "run_5a10",
      workspace: "api",
      workItem: "api#420",
      stage: "implement",
      status: "running",
      preview: { label: "read", text: "apps/desktop/src/renderer/src/components/right-panel.tsx" },
    },
  ],
});

const calmSeeds: ReadonlyArray<RowSeed> = [
  { agoMin: 15, kind: "engine", label: "Engine", summary: "Engine started", severity: "success" },
  { agoMin: 14, kind: "workspace", label: "Workspace", summary: "api registered · github", severity: "info" },
  {
    agoMin: 6,
    kind: "item",
    label: "Item",
    summary: "Tidy the run-activity fold → claimed",
    severity: "info",
    entity: item("api#420", "api"),
  },
  {
    agoMin: 5,
    kind: "run",
    label: "Run",
    summary: "api#420 · run running",
    severity: "info",
    entity: run("run_5a10", "api"),
  },
];

const errorsNow = (): NowState => ({
  engine: "failed",
  connection: "lost",
  scheduler: {
    scheduling: "paused",
    globalInFlight: 0,
    globalLimit: 4,
    dailyBudgetUsed: 96,
    dailyBudgetLimit: 100,
    perWorkspace: [],
  } as SchedulerStats,
  runs: [],
});

const errorsSeeds: ReadonlyArray<RowSeed> = [
  { agoMin: 20, kind: "engine", label: "Engine", summary: "Engine started", severity: "success" },
  {
    agoMin: 12,
    kind: "workspace",
    label: "Workspace",
    summary: "web failed · clone timed out after 30s",
    severity: "error",
  },
  { agoMin: 8, kind: "scheduler", label: "Scheduler", summary: "paused · 0/4 in flight", severity: "warn" },
  {
    agoMin: 6,
    kind: "run",
    label: "Run",
    summary: "api#377 · run crashed",
    severity: "error",
    entity: run("run_9d02", "api"),
  },
  { agoMin: 4, kind: "stream", label: "Stream", summary: "Event stream disconnected", severity: "error" },
  { agoMin: 2, kind: "engine", label: "Engine", summary: "Engine failed", severity: "error" },
];

const scenarios: Record<
  Exclude<ScenarioKey, "live">,
  { now: () => NowState; seeds: ReadonlyArray<RowSeed> }
> = {
  busy: { now: busyNow, seeds: busySeeds },
  calm: { now: calmNow, seeds: calmSeeds },
  errors: { now: errorsNow, seeds: errorsSeeds },
};

export function mockActivityFeed(scenario: Exclude<ScenarioKey, "live">): ActivityFeed {
  const { now, seeds } = scenarios[scenario];
  const log = seedRows(Date.now(), seeds);
  return { ready: true, now: now(), log, total: log.length };
}
