import {
  applyDaemonEvent,
  type Board,
  ClassifiedItem,
  DaemonEvent,
  initialBoard,
  type RunId,
  type RunStatus,
  type RunSummary,
  type SchedulerStats,
  type WorkflowId,
  type WorkflowRecord,
  type WorkItemId,
  type WorkspaceId,
  WorkspaceState,
} from "@cogwork/contracts";
import { useAtomRefresh, useAtomSet, useAtomSubscribe } from "@effect/atom-react";
import * as Data from "effect/Data";
import type * as Atom from "effect/unstable/reactivity/Atom";
import { createContext, type ReactNode, use, useCallback, useRef, useState } from "react";
import { daemonEventAtom } from "../daemon/atoms";
import { recordDaemonEventsApplied } from "../daemon/process-health";
import {
  applyRunPreview,
  previewMap,
  type RunActivityPreview,
  type RunPreviewState,
  withoutRunPreview,
} from "./run-activity";
import { type EnginePhase, enginePhase, useEngineStatus } from "./use-engine-status";

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
export type ActivityCategory = "item" | "run" | "workspace" | "scheduler" | "system";
export type ActivityEntity =
  | {
      readonly type: "run";
      readonly id: RunId;
      readonly workspace: WorkspaceId;
      readonly workItem: WorkItemId;
    }
  | { readonly type: "item"; readonly id: WorkItemId; readonly workspace: WorkspaceId };

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
  readonly runId: RunId;
  readonly workspace: WorkspaceId;
  readonly workItem: WorkItemId;
  readonly stage: RunSummary["stage"];
  readonly status: RunStatus;
  readonly preview: RunActivityPreview | null;
}

export interface NowState {
  readonly engine: EnginePhase;
  readonly connection: ConnectionState;
  readonly scheduler: SchedulerStats | null;
  readonly runs: readonly ActiveRun[];
}

export interface ActivitySession {
  readonly board: Board;
  readonly workflows: ReadonlyMap<WorkflowId, WorkflowRecord>;
  readonly previews: RunPreviewState;
  readonly log: readonly ActivityRow[];
  readonly engine: EnginePhase;
  readonly hasEngineSample: boolean;
  readonly connection: ConnectionState;
  readonly seed: boolean;
  readonly workflowInputsRevision: number;
  readonly ordinal: number;
}

export const defaultActivityLimit = 500;

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

export const activityCategory = (kind: ActivityKind): ActivityCategory => {
  if (kind === "item" || kind === "item-removed") return "item";
  if (kind === "engine" || kind === "connection" || kind === "stream") return "system";
  return kind;
};

const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const rowId = (ordinal: number) => `activity:${ordinal}`;
const bound = <Value,>(values: readonly Value[]) =>
  values.length <= defaultActivityLimit ? values : values.slice(-defaultActivityLimit);
const terminal = (status: RunStatus) => status !== "running";
const settledRun = (board: Board, runId: RunId) => {
  const run = board.runs.get(runId);
  return run !== undefined && terminal(run.status);
};
const stamp = (event: DaemonEvent, arrival: number) => event.emittedAtMillis ?? arrival;

const classifiedState = (item: ClassifiedItem) =>
  ClassifiedItem.match<{ readonly text: string; readonly severity: ActivitySeverity }>(item, {
    Eligible: () => ({ text: "eligible", severity: "info" }),
    Claimed: () => ({ text: "claimed", severity: "info" }),
    Blocked: ({ openBlockers }) => ({ text: `blocked · ${openBlockers} open`, severity: "warn" }),
    NeedsHuman: () => ({ text: "needs a person", severity: "warn" }),
    ReadyToMerge: () => ({ text: "ready to merge", severity: "warn" }),
  });

export const runStatusSeverity: Record<RunStatus, ActivitySeverity> = {
  running: "info",
  succeeded: "success",
  declined: "warn",
  failed: "error",
  exhausted: "warn",
  interrupted: "warn",
  crashed: "error",
};

const decodeEvent = (event: DaemonEvent, arrival: number, ordinal: number): ActivityRow | null => {
  const atMillis = stamp(event, arrival);
  return DaemonEvent.match<ActivityRow | null>(event, {
    SeedEnd: () => null,
    RunActivity: () => null,
    ControlStoreChanged: () => null,
    PluginsChanged: () => null,
    ConnectionsChanged: () => null,
    HarnessesChanged: () => null,
    WorkflowChanged: () => null,
    WorkflowDeleted: () => null,
    ItemChanged: ({ item, workspace }) => {
      const state = classifiedState(item);
      return {
        id: rowId(ordinal),
        kind: "item",
        atMillis,
        label: activityLabels.item,
        summary: `${item.title} → ${state.text}`,
        severity: state.severity,
        entity: { type: "item", id: item.id, workspace },
        raw: pretty(item),
        lowSignal: ClassifiedItem.guards.Eligible(item),
      };
    },
    ItemRemoved: ({ workspace, id }) => ({
      id: rowId(ordinal),
      kind: "item-removed",
      atMillis,
      label: activityLabels["item-removed"],
      summary: `${id} removed`,
      severity: "info",
      entity: { type: "item", id, workspace },
      raw: pretty({ workspace, id }),
      lowSignal: true,
    }),
    RunChanged: ({ run }) => ({
      id: rowId(ordinal),
      kind: "run",
      atMillis,
      label: activityLabels.run,
      summary: `${run.workItem} · run ${run.status}`,
      severity: runStatusSeverity[run.status],
      entity: { type: "run", id: run.id, workspace: run.workspace, workItem: run.workItem },
      raw: pretty(run),
      lowSignal: false,
    }),
    WorkspaceRemoved: ({ workspace }) => ({
      id: rowId(ordinal),
      kind: "workspace",
      atMillis,
      label: activityLabels.workspace,
      summary: `${workspace} deregistered`,
      severity: "info",
      entity: null,
      raw: pretty({ workspace }),
      lowSignal: false,
    }),
    WorkspaceChanged: ({ workspace }) => {
      const change = WorkspaceState.match<Pick<ActivityRow, "summary" | "severity">>(workspace, {
        Failed: ({ source, message }) => ({
          summary: `${source} failed · ${message}`,
          severity: "error",
        }),
        Registered: ({ name, issueTracker }) => ({
          summary: `${name} registered · ${issueTracker}`,
          severity: "info",
        }),
      });
      return {
        id: rowId(ordinal),
        kind: "workspace",
        atMillis,
        label: activityLabels.workspace,
        ...change,
        entity: null,
        raw: pretty(workspace),
        lowSignal: false,
      };
    },
    SchedulerChanged: ({ scheduler }) => {
      const paused = scheduler.scheduling === "paused";
      return {
        id: rowId(ordinal),
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
    },
  });
};

export const initialActivitySession: ActivitySession = {
  board: initialBoard,
  workflows: new Map(),
  previews: new Map(),
  log: [],
  engine: "off",
  hasEngineSample: false,
  connection: "connecting",
  seed: true,
  workflowInputsRevision: 0,
  ordinal: 0,
};

export const resetActivityFolds = (session: ActivitySession): ActivitySession => ({
  ...session,
  board: initialBoard,
  workflows: new Map(),
  previews: new Map(),
  seed: true,
  workflowInputsRevision: session.workflowInputsRevision + 1,
});

const workflowInputEventTags: ReadonlyArray<DaemonEvent["_tag"]> = [
  "WorkspaceChanged",
  "WorkspaceRemoved",
  "ConnectionsChanged",
  "HarnessesChanged",
];

export const ingestDaemonEvent = (
  session: ActivitySession,
  event: DaemonEvent,
  arrival: number,
): ActivitySession => {
  if (DaemonEvent.guards.SeedEnd(event)) return { ...session, seed: false };
  const nextOrdinal = session.ordinal + 1;
  const row = session.seed ? null : decodeEvent(event, arrival, nextOrdinal);
  const board = applyDaemonEvent(session.board, event);
  const updatedPreviews =
    DaemonEvent.guards.RunActivity(event) && !settledRun(board, event.activity.runId)
      ? applyRunPreview(session.previews, event.activity)
      : session.previews;
  const previews =
    DaemonEvent.guards.RunChanged(event) && terminal(event.run.status)
      ? withoutRunPreview(updatedPreviews, event.run.id)
      : updatedPreviews;
  const workflows = DaemonEvent.match(event, {
    SeedEnd: () => session.workflows,
    RunActivity: () => session.workflows,
    ItemChanged: () => session.workflows,
    ItemRemoved: () => session.workflows,
    RunChanged: () => session.workflows,
    WorkspaceChanged: () => session.workflows,
    WorkspaceRemoved: () => session.workflows,
    ControlStoreChanged: () => session.workflows,
    PluginsChanged: () => session.workflows,
    ConnectionsChanged: () => session.workflows,
    HarnessesChanged: () => session.workflows,
    SchedulerChanged: () => session.workflows,
    WorkflowChanged: ({ workflow }) => new Map(session.workflows).set(workflow.id, workflow),
    WorkflowDeleted: ({ id }) => {
      const next = new Map(session.workflows);
      next.delete(id);
      return next;
    },
  });
  const workflowInputsChanged = !session.seed && workflowInputEventTags.some((tag) => tag === event._tag);
  return {
    ...session,
    board,
    previews,
    workflows,
    workflowInputsRevision: session.workflowInputsRevision + Number(workflowInputsChanged),
    log: row ? bound([...session.log, row]) : session.log,
    ordinal: row ? nextOrdinal : session.ordinal,
  };
};

export const unprocessedDaemonEvents = (
  processed: readonly DaemonEvent[] | null,
  current: readonly DaemonEvent[],
) => (processed === current ? null : current);

const lifecycleRow = (
  kind: "engine" | "connection" | "stream",
  atMillis: number,
  ordinal: number,
  summary: string,
  severity: ActivitySeverity,
  lowSignal: boolean,
): ActivityRow => ({
  id: rowId(ordinal),
  kind,
  atMillis,
  label: activityLabels[kind],
  summary,
  severity,
  entity: null,
  raw: pretty({ kind }),
  lowSignal,
});

const engineChange = (engine: EnginePhase) => {
  if (engine === "up") return { summary: "Engine started", severity: "success" as const };
  if (engine === "starting") return { summary: "Engine starting", severity: "info" as const };
  if (engine === "failed") return { summary: "Engine failed", severity: "error" as const };
  return { summary: "Engine stopped", severity: "warn" as const };
};

const connectionChange = (connection: ConnectionState) => {
  if (connection === "live")
    return {
      kind: "connection" as const,
      summary: "Connection restored",
      severity: "info" as const,
      lowSignal: false,
    };
  if (connection === "lost")
    return {
      kind: "stream" as const,
      summary: "Event stream disconnected",
      severity: "error" as const,
      lowSignal: false,
    };
  return { kind: "connection" as const, summary: "Connecting…", severity: "info" as const, lowSignal: true };
};

const updateLifecycle = (
  session: ActivitySession,
  engine: EnginePhase,
  connection: ConnectionState,
  atMillis: number,
): ActivitySession => {
  const engineRow =
    session.hasEngineSample && session.engine !== engine
      ? lifecycleRow(
          "engine",
          atMillis,
          session.ordinal + 1,
          engineChange(engine).summary,
          engineChange(engine).severity,
          false,
        )
      : null;
  const nextConnection = session.connection === connection ? null : connectionChange(connection);
  const connectionRow = nextConnection
    ? lifecycleRow(
        nextConnection.kind,
        atMillis,
        session.ordinal + (engineRow ? 2 : 1),
        nextConnection.summary,
        nextConnection.severity,
        nextConnection.lowSignal,
      )
    : null;
  const rows = [engineRow, connectionRow].filter((row): row is ActivityRow => row !== null);
  if (rows.length === 0 && session.engine === engine && session.hasEngineSample) return session;
  return {
    ...session,
    engine,
    connection,
    hasEngineSample: true,
    log: bound([...session.log, ...rows]),
    ordinal: session.ordinal + rows.length,
  };
};

const activeRuns = (board: Board, previews: RunPreviewState): readonly ActiveRun[] =>
  [...board.runs.values()]
    .filter((run) => run.status === "running")
    .sort((left, right) => right.startedAtMillis - left.startedAtMillis)
    .map((run) => ({ ...run, runId: run.id, preview: previewMap(previews).get(run.id) ?? null }));

export const activityNow = (session: ActivitySession): NowState => ({
  engine: session.engine,
  connection: session.connection,
  scheduler: session.board.scheduler,
  runs: activeRuns(session.board, session.previews),
});

type EventResult = typeof daemonEventAtom extends Atom.Atom<infer Value> ? Value : never;

// One live wiring per provider mount. The cell is the provider's mutable scratch state, so
// consecutive subscription callbacks compose synchronously between renders.
interface SessionCell {
  session: ActivitySession;
  lastResult: EventResult | null;
  lastPumpedResult: EventResult | null;
  processedDaemonEvents: readonly DaemonEvent[] | null;
}

const makeSessionCell = (): SessionCell => ({
  session: initialActivitySession,
  lastResult: null,
  lastPumpedResult: null,
  processedDaemonEvents: null,
});

type Publish = (next: ActivitySession) => void;

const recordDaemonResult = (
  cell: SessionCell,
  publish: Publish,
  result: EventResult,
  clock: () => number,
) => {
  if (result === cell.lastResult) return;
  cell.lastResult = result;
  if (result._tag === "Initial") {
    cell.processedDaemonEvents = null;
    return publish(
      updateLifecycle(resetActivityFolds(cell.session), cell.session.engine, "connecting", clock()),
    );
  }
  if (result._tag === "Failure") {
    cell.processedDaemonEvents = null;
    return publish(updateLifecycle(resetActivityFolds(cell.session), cell.session.engine, "lost", clock()));
  }
  const events = unprocessedDaemonEvents(cell.processedDaemonEvents, result.value.items);
  if (!events) return;
  cell.processedDaemonEvents = events;
  const next = events.reduce((current, event) => ingestDaemonEvent(current, event, clock()), cell.session);
  recordDaemonEventsApplied(events.length);
  publish(updateLifecycle(next, next.engine, "live", clock()));
};

const recordEngineStatus = (
  cell: SessionCell,
  publish: Publish,
  status: Parameters<typeof enginePhase>[0],
  clock: () => number,
) => publish(updateLifecycle(cell.session, enginePhase(status), cell.session.connection, clock()));

const pumpDaemonResult = (
  cell: SessionCell,
  current: EventResult,
  pull: () => void,
  resubscribe: () => void,
) => {
  if (current.waiting) return;
  if (current === cell.lastPumpedResult) return;
  cell.lastPumpedResult = current;
  if (current._tag === "Failure") return resubscribe();
  if (current._tag === "Success" && !current.value.done) pull();
};

// The seam: consumers read the session value, and only the live provider knows it comes from the
// daemon event atom. A test renders this context with a literal session instead.
export const ActivitySessionContext = createContext<ActivitySession | null>(null);

export function ActivitySessionProvider({
  children,
  clock = Date.now,
}: {
  readonly children: ReactNode;
  readonly clock?: () => number;
}) {
  const cellRef = useRef<SessionCell | null>(null);
  cellRef.current ??= makeSessionCell();
  const cell = cellRef.current;
  const [session, setSession] = useState(cell.session);
  const publish = useCallback<Publish>(
    (next) => {
      if (next === cell.session) return;
      cell.session = next;
      setSession(next);
    },
    [cell],
  );
  const record = useCallback(
    (result: EventResult) => recordDaemonResult(cell, publish, result, clock),
    [cell, publish, clock],
  );
  const pull = useAtomSet(daemonEventAtom);
  const resubscribe = useAtomRefresh(daemonEventAtom);
  const pump = useCallback(
    (current: EventResult) => pumpDaemonResult(cell, current, pull, resubscribe),
    [cell, pull, resubscribe],
  );
  useAtomSubscribe(daemonEventAtom, record, { immediate: true });
  useAtomSubscribe(daemonEventAtom, pump, { immediate: true });
  // Engine transitions fold during render: a status change re-renders via useEngineStatus's store
  // read, updateLifecycle returns the identical session when the phase is unchanged, and publish
  // skips identical sessions — so this cannot loop.
  const { status } = useEngineStatus();
  recordEngineStatus(cell, publish, status, clock);
  return <ActivitySessionContext value={session}>{children}</ActivitySessionContext>;
}

export function useActivitySession(): ActivitySession {
  const session = use(ActivitySessionContext);
  if (session === null) throw new Error("useActivitySession must render inside ActivitySessionProvider.");
  return session;
}

export type BoardResult = Data.TaggedEnum<{
  Initial: Record<never, never>;
  Failure: Record<never, never>;
  Success: {
    readonly board: Board;
    readonly previews: ReadonlyMap<string, RunActivityPreview>;
  };
}>;

export const BoardResult = Data.taggedEnum<BoardResult>();

export function useBoard(): BoardResult {
  const session = useActivitySession();
  if (session.connection === "lost") return BoardResult.Failure();
  if (session.connection === "connecting") return BoardResult.Initial();
  return BoardResult.Success({ board: session.board, previews: previewMap(session.previews) });
}
