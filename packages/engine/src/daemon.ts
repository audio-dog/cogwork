import {
  AgUiEvent,
  agUiIsTerminal,
  DaemonRpcs,
  type RunActivity,
  type RunEvent,
  type RunId,
  type RunRecord,
} from "@clanker-forge/contracts";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { RegisteredWorkspace } from "./projector";
import { type ReconcileSnapshot, ReconcileWorker, type WorkspaceReconcileState } from "./reconcile";
import { WorkspaceRegistry } from "./registry";
import { activityOf, RunEventBus } from "./run-event-bus";
import { RunLedger } from "./run-ledger";
import { type DrainOptions, Scheduler, type SchedulerConfig, type SchedulerState } from "./scheduler";
import { ticketSlug, WorktreeManager } from "./worktree";

export class DaemonInfo extends Context.Service<DaemonInfo, { readonly startedAtMillis: number }>()(
  "@clanker-forge/engine/daemon/DaemonInfo",
) {}

export const daemonInfoLayer = Layer.effect(
  DaemonInfo,
  Effect.map(Clock.currentTimeMillis, (startedAtMillis) => ({ startedAtMillis })),
);

const okPoll = { status: "ok" as const };

const decodeAgUiEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(AgUiEvent));

const activityFromEvent = (run: RunRecord, event: RunEvent) =>
  decodeAgUiEvent(event.data).pipe(
    Effect.map((agUiEvent) => activityOf(run, event.seq, event.atMillis, agUiEvent)),
  );

const activitiesFromLedger = (run: RunRecord, events: ReadonlyArray<RunEvent>) =>
  Effect.forEach(events, (event) => activityFromEvent(run, event).pipe(Effect.option)).pipe(
    Effect.map(Arr.getSomes),
  );

const isTerminalActivity = (activity: RunActivity) => agUiIsTerminal(activity.event);

export const watchActivity = Effect.fn("Daemon.watchActivity")(function* (id: RunId | undefined) {
  const bus = yield* RunEventBus;
  if (id === undefined) return bus.activity;

  const ledger = yield* RunLedger;
  const subscription = yield* bus.subscribe();
  const run = yield* ledger.getRun(id);
  if (run === null) return Stream.empty;
  const history = yield* activitiesFromLedger(run, yield* ledger.events(id));
  const lastSeq = history.at(-1)?.seq ?? -1;
  const live = Stream.fromSubscription(subscription).pipe(
    Stream.filter((item) => item.runId === id && item.seq > lastSeq),
  );
  const settled = run.status !== "running";
  const base = settled ? Stream.fromIterable(history) : Stream.concat(Stream.fromIterable(history), live);
  return base.pipe(Stream.takeUntil(isTerminalActivity));
});

const statesByName = (snapshot: ReconcileSnapshot) =>
  new Map(snapshot.workspaces.map((state) => [state.name, state]));

const schedulerStats = (config: SchedulerConfig, state: SchedulerState) => ({
  globalInFlight: state.global,
  globalLimit: config.globalLimit,
  dailyBudgetUsed: state.budgetUsed,
  dailyBudgetLimit: config.dailyBudget,
  perWorkspace: [...state.perWorkspace].map(([name, inFlight]) => ({ name, inFlight })),
});

const workspaceInfo = (workspace: RegisteredWorkspace, state: WorkspaceReconcileState | undefined) => ({
  name: workspace.config.name,
  checkoutPath: workspace.config.checkoutPath,
  issueTracker: workspace.config.issueTracker.type,
  harness: workspace.config.harness.preferred,
  poll: state?.poll ?? okPoll,
  eligible: (state?.eligible ?? []).map((work) => ({ id: work.id, title: work.title, stage: work.stage })),
  claimed: state?.claimed ?? [],
  blocked: state?.blocked ?? [],
  needsHuman: state?.needsHuman ?? [],
});

export const handlersLayer = DaemonRpcs.toLayer({
  GetStatus: Effect.fn("Daemon.GetStatus")(function* () {
    const registry = yield* WorkspaceRegistry;
    const info = yield* DaemonInfo;
    const worker = yield* ReconcileWorker;
    const scheduler = yield* Scheduler;
    const snapshot = yield* worker.snapshot;
    const stats = yield* scheduler.stats;
    const now = yield* Clock.currentTimeMillis;
    const stateByName = statesByName(snapshot);
    return {
      health: "running" as const,
      startedAtMillis: info.startedAtMillis,
      uptimeMillis: now - info.startedAtMillis,
      scheduler: schedulerStats(scheduler.config, stats),
      workspaces: registry.workspaces.map((w) => workspaceInfo(w, stateByName.get(w.config.name))),
      failures: registry.failures.map((f) => ({ source: f.source, message: f.message })),
    };
  }),
  ListRuns: Effect.fn("Daemon.ListRuns")(function* () {
    const ledger = yield* RunLedger;
    return yield* ledger.listRuns(50);
  }),
  GetRunEvents: Effect.fn("Daemon.GetRunEvents")(function* (payload) {
    const ledger = yield* RunLedger;
    return yield* ledger.events(payload.id);
  }),
  WatchActivity: (payload) => Stream.unwrap(watchActivity(payload.id)),
});

interface ReconcilableWorkspace {
  readonly workspace: RegisteredWorkspace;
  readonly state: WorkspaceReconcileState;
}

const activeTicketKeys = (state: WorkspaceReconcileState) =>
  state.observed.map((item) => ticketSlug(item.id));

const maintainWorktrees = Effect.fn("Daemon.maintainWorktrees")(function* () {
  const registry = yield* WorkspaceRegistry;
  const manager = yield* WorktreeManager;
  const worker = yield* ReconcileWorker;
  const snapshot = yield* worker.snapshot;
  const now = yield* Clock.currentTimeMillis;
  const stateByName = statesByName(snapshot);
  const reconcilable = registry.workspaces
    .map((workspace) => ({ workspace, state: stateByName.get(workspace.config.name) }))
    .filter(
      (entry): entry is ReconcilableWorkspace =>
        entry.workspace.config.worktrees !== undefined && entry.state?.poll.status === "ok",
    );
  yield* Effect.forEach(
    reconcilable,
    ({ workspace, state }) =>
      manager.reconcile(workspace, activeTicketKeys(state), now).pipe(
        Effect.tap((outcome) =>
          Effect.logInfo("worktree maintenance", { workspace: workspace.config.name, ...outcome }),
        ),
        Effect.catchTag("GitError", (error) =>
          Effect.logWarning("worktree maintenance failed", {
            workspace: workspace.config.name,
            message: error.message,
          }),
        ),
      ),
    { discard: true },
  );
});

const reconcileHeartbeat = (pollIntervalMillis: number) =>
  Effect.gen(function* () {
    const worker = yield* ReconcileWorker;
    const receipt = yield* worker.submit();
    yield* Effect.logInfo("reconcile tick", receipt);
    yield* maintainWorktrees();
  }).pipe(Effect.repeat(Schedule.spaced(pollIntervalMillis)));

export const bootstrap = Effect.gen(function* () {
  const worker = yield* ReconcileWorker;
  const scheduler = yield* Scheduler;
  yield* worker.submit();
  yield* scheduler.recover();
});

const executeHeartbeat = () =>
  Effect.flatMap(Scheduler, (scheduler) => scheduler.tick()).pipe(
    Effect.repeat(Schedule.spaced("5 seconds")),
  );

export interface HeartbeatOptions {
  readonly pollIntervalMillis: number;
  readonly drain: DrainOptions;
}

export const heartbeats = (options: HeartbeatOptions) =>
  Effect.all([reconcileHeartbeat(options.pollIntervalMillis), executeHeartbeat()], {
    concurrency: "unbounded",
  }).pipe(Effect.onInterrupt(() => Effect.flatMap(Scheduler, (scheduler) => scheduler.drain(options.drain))));
