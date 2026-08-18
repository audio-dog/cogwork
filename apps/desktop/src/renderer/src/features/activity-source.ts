import type {
  ClassifiedItem,
  DaemonEvent,
  RunStatus,
  RunSummary,
  SchedulerStats,
  WorkspaceState,
} from "@cogwork/contracts";
import { type RunActivityPreview, runPreviews } from "./run-activity";
import type { EnginePhase } from "./use-engine-status";

export type ActivityKind =
  | "item"
  | "item-removed"
  | "run"
  | "workspace"
  | "scheduler"
  | "engine"
  | "connection"
  | "stream";

export type ActivitySeverity = "info" | "success" | "warn" | "error";

export type ConnectionState = "live" | "connecting" | "lost";

export interface ActivityEntity {
  readonly type: "run" | "item";
  readonly id: string;
  readonly workspace: string;
}

export interface ActivityRow {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly atMillis: number;
  readonly label: string;
  readonly summary: string;
  readonly severity: ActivitySeverity;
  readonly entity: ActivityEntity | null;
  readonly raw: string;
  readonly lowSignal: boolean;
}

export interface ActiveRun {
  readonly runId: RunSummary["id"];
  readonly workspace: RunSummary["workspace"];
  readonly workItem: RunSummary["workItem"];
  readonly stage: RunSummary["stage"];
  readonly status: RunStatus;
  readonly preview: RunActivityPreview | null;
}

export interface NowState {
  readonly engine: EnginePhase;
  readonly connection: ConnectionState;
  readonly scheduler: SchedulerStats | null;
  readonly runs: ReadonlyArray<ActiveRun>;
}

export interface ActivityFeed {
  readonly now: NowState;
  readonly log: ReadonlyArray<ActivityRow>;
  readonly total: number;
}

export const activityLabels: Record<ActivityKind, string> = {
  item: "Item",
  "item-removed": "Item",
  run: "Run",
  workspace: "Workspace",
  scheduler: "Scheduler",
  engine: "Engine",
  connection: "Connection",
  stream: "Stream",
};

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

const classifiedState = (item: ClassifiedItem): { text: string; severity: ActivitySeverity } => {
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

export const runStatusSeverity: Record<RunStatus, ActivitySeverity> = {
  running: "info",
  succeeded: "success",
  failed: "error",
  exhausted: "warn",
  interrupted: "warn",
  crashed: "error",
};

// The daemon stream carries a real timestamp only on run events; everything
// else is stamped on arrival, so a run row must prefer its own time.
const runRow = (run: RunSummary): ActivityRow => ({
  id: `run:${run.id}:${run.status}:${run.endedAtMillis ?? run.startedAtMillis}`,
  kind: "run",
  atMillis: run.endedAtMillis ?? run.startedAtMillis,
  label: activityLabels.run,
  summary: `${run.workItem} · run ${run.status}`,
  severity: runStatusSeverity[run.status],
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
      label: activityLabels.workspace,
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
    label: activityLabels.workspace,
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
    label: activityLabels.scheduler,
    summary: paused
      ? `paused · ${scheduler.globalInFlight}/${scheduler.globalLimit} in flight`
      : `${scheduler.globalInFlight}/${scheduler.globalLimit} in flight · budget ${scheduler.dailyBudgetUsed}/${scheduler.dailyBudgetLimit}`,
    severity: paused ? "warn" : "info",
    entity: null,
    raw: pretty(scheduler),
    lowSignal: !paused,
  };
};

const itemChangedRow = (workspace: string, item: ClassifiedItem, atMillis: number): ActivityRow => {
  const state = classifiedState(item);
  return {
    id: `item:${workspace}:${item.id}:${atMillis}`,
    kind: "item",
    atMillis,
    label: activityLabels.item,
    summary: `${item.title} → ${state.text}`,
    severity: state.severity,
    entity: { type: "item", id: item.id, workspace },
    raw: pretty(item),
    lowSignal: item._tag === "Eligible",
  };
};

const itemRemovedRow = (workspace: string, id: string, atMillis: number): ActivityRow => ({
  id: `rm:${workspace}:${id}:${atMillis}`,
  kind: "item-removed",
  atMillis,
  label: activityLabels["item-removed"],
  summary: `${id} removed`,
  severity: "info",
  entity: { type: "item", id, workspace },
  raw: pretty({ workspace, id }),
  lowSignal: true,
});

// Run activity feeds the Now-zone heartbeat, not a per-delta log row, so it
// decodes to null here.
export const decodeEvent = (event: DaemonEvent, atMillis: number): ActivityRow | null => {
  switch (event._tag) {
    case "RunActivity":
      return null;
    case "ItemChanged":
      return itemChangedRow(event.workspace, event.item, atMillis);
    case "ItemRemoved":
      return itemRemovedRow(event.workspace, event.id, atMillis);
    case "RunChanged":
      return runRow(event.run);
    case "WorkspaceChanged":
      return workspaceRow(event.workspace, atMillis);
    case "SchedulerChanged":
      return schedulerRow(event.scheduler, atMillis);
  }
};

const engineSynth: Record<EnginePhase, { summary: string; severity: ActivitySeverity }> = {
  up: { summary: "Engine started", severity: "success" },
  starting: { summary: "Engine starting", severity: "info" },
  off: { summary: "Engine stopped", severity: "warn" },
  failed: { summary: "Engine failed", severity: "error" },
};

const engineRow = (engine: EnginePhase, atMillis: number): ActivityRow => ({
  id: `engine:${engine}:${atMillis}`,
  kind: "engine",
  atMillis,
  label: activityLabels.engine,
  summary: engineSynth[engine].summary,
  severity: engineSynth[engine].severity,
  entity: null,
  raw: pretty({ engine }),
  lowSignal: false,
});

const connectionSummary: Record<ConnectionState, string> = {
  live: "Connection restored",
  connecting: "Connecting…",
  lost: "Event stream disconnected",
};

const connectionRow = (connection: ConnectionState, atMillis: number): ActivityRow => {
  const lost = connection === "lost";
  return {
    id: `conn:${connection}:${atMillis}`,
    kind: lost ? "stream" : "connection",
    atMillis,
    label: lost ? activityLabels.stream : activityLabels.connection,
    summary: connectionSummary[connection],
    severity: lost ? "error" : "info",
    entity: null,
    raw: pretty({ connection }),
    lowSignal: connection === "connecting",
  };
};

export interface LifecycleSample {
  readonly engine: EnginePhase;
  readonly connection: ConnectionState;
  readonly atMillis: number;
}

export interface LifecycleState {
  readonly engine: EnginePhase | null;
  readonly connection: ConnectionState;
}

// A fresh session has not seen an engine phase and starts out connecting, so
// the first sample only synthesizes what differs from this.
export const initialLifecycleState: LifecycleState = { engine: null, connection: "connecting" };

export const stepLifecycle = (prev: LifecycleState, sample: LifecycleSample) => {
  const engineRows =
    prev.engine !== null && prev.engine !== sample.engine ? [engineRow(sample.engine, sample.atMillis)] : [];
  const connectionRows =
    prev.connection === sample.connection ? [] : [connectionRow(sample.connection, sample.atMillis)];
  return {
    state: { engine: sample.engine, connection: sample.connection },
    rows: [...engineRows, ...connectionRows],
  };
};

export const synthesizeLifecycle = (samples: ReadonlyArray<LifecycleSample>) =>
  samples.reduce<{ state: LifecycleState; rows: ReadonlyArray<ActivityRow> }>(
    (acc, sample) => {
      const step = stepLifecycle(acc.state, sample);
      return { state: step.state, rows: [...acc.rows, ...step.rows] };
    },
    { state: initialLifecycleState, rows: [] },
  ).rows;

interface NowFold {
  readonly runs: Map<string, RunSummary>;
  scheduler: SchedulerStats | null;
}

const foldNow = (events: ReadonlyArray<DaemonEvent>): NowFold => {
  const fold: NowFold = { runs: new Map(), scheduler: null };
  for (const event of events) {
    if (event._tag === "RunChanged") fold.runs.set(event.run.id, event.run);
    if (event._tag === "SchedulerChanged") fold.scheduler = event.scheduler;
  }
  return fold;
};

export const activeRuns = (events: ReadonlyArray<DaemonEvent>) => {
  const { runs } = foldNow(events);
  const previews = runPreviews(events);
  return [...runs.values()]
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
};

export const defaultActivityLimit = 500;

export const boundLog = (rows: ReadonlyArray<ActivityRow>, limit: number = defaultActivityLimit) => {
  if (limit <= 0) return [];
  return rows.length <= limit ? rows : rows.slice(rows.length - limit);
};

export interface ActivityInputs {
  readonly events: ReadonlyArray<DaemonEvent>;
  readonly arrivals: ReadonlyArray<number>;
  readonly synthesized: ReadonlyArray<ActivityRow>;
  readonly engine: EnginePhase;
  readonly connection: ConnectionState;
  readonly limit?: number;
}

export const deriveActivityFeed = (inputs: ActivityInputs): ActivityFeed => {
  const daemonRows = inputs.events
    .map((event, i) => decodeEvent(event, inputs.arrivals[i] ?? 0))
    .filter((row): row is ActivityRow => row !== null);

  const merged = [...daemonRows, ...inputs.synthesized].sort((a, b) => a.atMillis - b.atMillis);

  return {
    now: {
      engine: inputs.engine,
      connection: inputs.connection,
      scheduler: foldNow(inputs.events).scheduler,
      runs: activeRuns(inputs.events),
    },
    log: boundLog(merged, inputs.limit ?? defaultActivityLimit),
    total: merged.length,
  };
};
