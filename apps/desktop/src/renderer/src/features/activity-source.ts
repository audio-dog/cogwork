import type {
  ClassifiedItem,
  DaemonEvent,
  RunId,
  RunStatus,
  RunSummary,
  SchedulerStats,
  WorkItemId,
  WorkspaceId,
  WorkspaceState,
} from "@cogwork/contracts";
import { useAtomSubscribe } from "@effect/atom-react";
import type * as Atom from "effect/unstable/reactivity/Atom";
import { useSyncExternalStore } from "react";
import { daemonEventsAtom } from "../daemon/atoms";
import { type RunActivityPreview, runPreviews } from "./run-activity";
import { type EnginePhase, enginePhase, subscribeEngineStatus } from "./use-engine-status";
import { useLiveEvents } from "./use-live-events";

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

export type ActivityEntity =
  | { type: "run"; id: RunId; workspace: WorkspaceId; workItem: WorkItemId; run: RunSummary }
  | { type: "item"; id: WorkItemId; workspace: WorkspaceId };

export interface ActivityRow {
  id: string;
  kind: ActivityKind;
  atMillis: number;
  label: string;
  summary: string;
  severity: ActivitySeverity;
  entity: ActivityEntity | null;
  raw: string;
  lowSignal: boolean;
}

export interface ActiveRun {
  runId: RunSummary["id"];
  workspace: RunSummary["workspace"];
  workItem: RunSummary["workItem"];
  stage: RunSummary["stage"];
  status: RunStatus;
  preview: RunActivityPreview | null;
}

export interface NowState {
  engine: EnginePhase;
  connection: ConnectionState;
  scheduler: SchedulerStats | null;
  runs: ActiveRun[];
}

export interface ActivityFeed {
  now: NowState;
  log: ActivityRow[];
  total: number;
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
const runRow = (run: RunSummary): ActivityRow => {
  const raw = pretty(run);
  return {
    id: `run:${raw}`,
    kind: "run",
    atMillis: run.endedAtMillis ?? run.startedAtMillis,
    label: activityLabels.run,
    summary: `${run.workItem} · run ${run.status}`,
    severity: runStatusSeverity[run.status],
    entity: { type: "run", id: run.id, workspace: run.workspace, workItem: run.workItem, run },
    raw,
    lowSignal: false,
  };
};

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

const itemChangedRow = (workspace: WorkspaceId, item: ClassifiedItem, atMillis: number): ActivityRow => {
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

const itemRemovedRow = (workspace: WorkspaceId, id: WorkItemId, atMillis: number): ActivityRow => ({
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
  engine: EnginePhase;
  connection: ConnectionState;
  atMillis: number;
}

export interface LifecycleState {
  engine: EnginePhase | null;
  connection: ConnectionState;
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

export const synthesizeLifecycle = (samples: ReadonlyArray<LifecycleSample>): ActivityRow[] =>
  samples.reduce<{ state: LifecycleState; rows: ActivityRow[] }>(
    (acc, sample) => {
      const step = stepLifecycle(acc.state, sample);
      return { state: step.state, rows: [...acc.rows, ...step.rows] };
    },
    { state: initialLifecycleState, rows: [] },
  ).rows;

interface NowFold {
  runs: Map<string, RunSummary>;
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

export type ActivityCategory = "item" | "run" | "workspace" | "scheduler" | "system";

export const activityCategory = (kind: ActivityKind): ActivityCategory => {
  if (kind === "item" || kind === "item-removed") return "item";
  if (kind === "engine" || kind === "connection" || kind === "stream") return "system";
  return kind;
};

export const boundLog = (
  rows: ReadonlyArray<ActivityRow>,
  limit: number = defaultActivityLimit,
): ActivityRow[] => {
  if (limit <= 0) return [];
  return rows.length <= limit ? [...rows] : rows.slice(rows.length - limit);
};

export interface ActivityInputs {
  events: DaemonEvent[];
  arrivals: number[];
  synthesized: ActivityRow[];
  engine: EnginePhase;
  connection: ConnectionState;
  limit?: number;
}

export interface ActivitySession {
  readonly events: readonly DaemonEvent[];
  readonly eventKeys: readonly string[];
  readonly arrivals: readonly number[];
  readonly synthesized: readonly ActivityRow[];
  readonly lifecycle: LifecycleState;
}

export const initialActivitySession: ActivitySession = {
  events: [],
  eventKeys: [],
  arrivals: [],
  synthesized: [],
  lifecycle: initialLifecycleState,
};

interface ActivitySessionSample {
  readonly events: readonly DaemonEvent[] | null;
  readonly engine: EnginePhase;
  readonly connection: ConnectionState;
  readonly atMillis: number;
}

const eventKey = (event: DaemonEvent) => JSON.stringify(event);

const boundSession = <Value>(values: readonly Value[]) =>
  values.length <= defaultActivityLimit ? [...values] : values.slice(-defaultActivityLimit);

export const recordActivitySession = (session: ActivitySession, sample: ActivitySessionSample) => {
  const incoming = sample.events;
  const knownEvents = new Set(session.eventKeys);
  const addedEvents =
    incoming?.filter((event) => {
      if (event._tag === "RunActivity") return false;
      const key = eventKey(event);
      if (knownEvents.has(key)) return false;
      knownEvents.add(key);
      return true;
    }) ?? [];
  const lifecycle = stepLifecycle(session.lifecycle, sample);
  const lifecycleUnchanged =
    lifecycle.state.engine === session.lifecycle.engine &&
    lifecycle.state.connection === session.lifecycle.connection;
  if (addedEvents.length === 0 && lifecycle.rows.length === 0 && lifecycleUnchanged) return session;

  return {
    events: boundSession([...session.events, ...addedEvents]),
    eventKeys: boundSession([...session.eventKeys, ...addedEvents.map(eventKey)]),
    arrivals: boundSession([...session.arrivals, ...addedEvents.map(() => sample.atMillis)]),
    synthesized: boundSession([...session.synthesized, ...lifecycle.rows]),
    lifecycle: lifecycle.state,
  };
};

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

type EventsResult = typeof daemonEventsAtom extends Atom.Atom<infer Value> ? Value : never;

interface ActivityFeedState {
  readonly session: ActivitySession;
  readonly events: readonly DaemonEvent[];
  readonly engine: EnginePhase;
  readonly connection: ConnectionState;
}

const activityFeedListeners = new Set<() => void>();

let activityFeedState: ActivityFeedState = {
  session: initialActivitySession,
  events: [],
  engine: "off",
  connection: "connecting",
};

let activityFeedSnapshot = deriveActivityFeed({
  events: [],
  arrivals: [],
  synthesized: [],
  engine: "off",
  connection: "connecting",
});

function refreshActivityFeed(
  sessionEvents: readonly DaemonEvent[] | null,
  events: readonly DaemonEvent[],
  engine: EnginePhase,
  connection: ConnectionState,
) {
  const session = recordActivitySession(activityFeedState.session, {
    events: sessionEvents,
    engine,
    connection,
    atMillis: Date.now(),
  });
  const unchanged =
    session === activityFeedState.session &&
    events === activityFeedState.events &&
    engine === activityFeedState.engine &&
    connection === activityFeedState.connection;
  if (unchanged) return;

  activityFeedState = { session, events, engine, connection };
  const sessionFeed = deriveActivityFeed({
    events: [...session.events],
    arrivals: [...session.arrivals],
    synthesized: [...session.synthesized],
    engine,
    connection,
  });
  const liveFeed = deriveActivityFeed({
    events: [...events],
    arrivals: [],
    synthesized: [],
    engine,
    connection,
  });
  activityFeedSnapshot = { ...sessionFeed, now: liveFeed.now };
  for (const listener of activityFeedListeners) listener();
}

function recordLiveEvents(result: EventsResult) {
  const connection: ConnectionState =
    result._tag === "Failure" ? "lost" : result._tag === "Success" ? "live" : "connecting";
  const events = result._tag === "Success" ? result.value.items : [];
  refreshActivityFeed(
    result._tag === "Success" ? events : null,
    events,
    activityFeedState.engine,
    connection,
  );
}

function recordEngineStatus(status: Parameters<typeof enginePhase>[0]) {
  refreshActivityFeed(null, activityFeedState.events, enginePhase(status), activityFeedState.connection);
}

export function subscribeActivityFeed(listener: () => void) {
  const unsubscribeEngine = subscribeEngineStatus(recordEngineStatus);
  activityFeedListeners.add(listener);
  return () => {
    activityFeedListeners.delete(listener);
    unsubscribeEngine();
  };
}

function getActivityFeedSnapshot() {
  return activityFeedSnapshot;
}

export function useActivityFeed() {
  useLiveEvents();
  useAtomSubscribe(daemonEventsAtom, recordLiveEvents, { immediate: true });
  return useSyncExternalStore(subscribeActivityFeed, getActivityFeedSnapshot);
}
