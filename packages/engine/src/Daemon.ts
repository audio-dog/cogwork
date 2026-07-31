import {
  DaemonRpcs,
  HarnessEvent,
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
import { type ReconcileSnapshot, ReconcileWorker, type WorkspaceReconcileState } from "./Reconcile";
import { WorkspaceRegistry } from "./Registry";
import { activityOf, RunEventBus } from "./RunEventBus";
import { RunLedger } from "./RunLedger";
import { Scheduler, type SchedulerConfig, type SchedulerState } from "./Scheduler";
import { ticketSlug, WorktreeManager } from "./Worktree";

export class DaemonInfo extends Context.Service<DaemonInfo, { readonly startedAtMillis: number }>()(
  "@clanker-forge/engine/Daemon/DaemonInfo",
) {}

export const daemonInfoLayer = Layer.effect(
  DaemonInfo,
  Effect.map(Clock.currentTimeMillis, (startedAtMillis) => ({ startedAtMillis })),
);

const okPoll = { status: "ok" as const };

const decodeHarnessEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(HarnessEvent));

const activityFromEvent = (run: RunRecord, event: RunEvent) =>
  decodeHarnessEvent(event.data).pipe(
    Effect.map((harnessEvent) => activityOf(run, event.seq, event.atMillis, harnessEvent)),
  );

const activitiesFromLedger = (run: RunRecord, events: ReadonlyArray<RunEvent>) =>
  Effect.forEach(events, (event) => activityFromEvent(run, event).pipe(Effect.option)).pipe(
    Effect.map(Arr.getSomes),
  );

export const watchActivity = Effect.fn("Daemon.watchActivity")(function* (id: RunId | undefined) {
  const bus = yield* RunEventBus;
  if (id === undefined) return bus.activity;

  const ledger = yield* RunLedger;
  const subscription = yield* bus.subscribe();
  const run = yield* ledger.getRun(id);
  const history = run === null ? [] : yield* activitiesFromLedger(run, yield* ledger.events(id));
  const lastSeq = history.at(-1)?.seq ?? -1;
  return Stream.concat(
    Stream.fromIterable(history),
    Stream.fromSubscription(subscription).pipe(
      Stream.filter((item) => item.runId === id && item.seq > lastSeq),
    ),
  );
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
  workSource: workspace.config.workSource.type,
  harness: workspace.config.harness.preferred,
  poll: state?.poll ?? okPoll,
  eligible: (state?.eligible ?? []).map((work) => ({ id: work.id, title: work.title, stage: work.stage })),
  claimed: state?.claimed ?? [],
  blocked: state?.blocked ?? [],
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

export const reconcileHeartbeat = (pollIntervalMillis: number) =>
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

export const executeHeartbeat = Effect.gen(function* () {
  const scheduler = yield* Scheduler;
  yield* scheduler.tick();
}).pipe(Effect.repeat(Schedule.spaced("5 seconds")));
