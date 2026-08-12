import {
  AgUiEvent,
  agUiIsTerminal,
  DaemonRpcs,
  localOwner,
  Principal,
  PrincipalMiddleware,
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
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { cancelRun, reclassify, setScheduling } from "./commands";
import type { CredentialStore } from "./credential-store";
import {
  activityOf,
  DaemonEventBus,
  layer as daemonEventBusLayer,
  runActivityStream,
} from "./daemon-event-bus";
import { DaemonEventPublisher, layer as eventPublisherLayer } from "./event-publisher";
import * as Executor from "./executor";
import * as GitHub from "./github";
import * as Harness from "./harness";
import { routedLayer as issueTrackerRoutedLayer } from "./issue-tracker-router";
import * as Linear from "./linear";
import * as McpSkill from "./mcp-skill";
import type { RegisteredWorkspace } from "./projector";
import { classifiedItemsOf, schedulerStatsOf, workspaceInfoOf, workspaceStatesOf } from "./read-model";
import {
  type ReconcileSnapshot,
  ReconcileWorker,
  layer as reconcileLayer,
  type WorkspaceReconcileState,
} from "./reconcile";
import { Recovery, layer as recoveryLayer } from "./recovery";
import { WorkspaceRegistry } from "./registry";
import { layer as runControlLayer } from "./run-control";
import { type CoreRunLedger, RunLedger, publishingLayer as runLedgerPublishingLayer } from "./run-ledger";
import { type DrainOptions, Scheduler, type SchedulerConfig, layer as schedulerLayer } from "./scheduler";
import * as SessionStore from "./session-store";
import { ticketSlug, WorktreeManager } from "./worktree";

export class DaemonInfo extends Context.Service<DaemonInfo, { readonly startedAtMillis: number }>()(
  "@clanker-forge/engine/daemon/DaemonInfo",
) {}

export const daemonInfoLayer = Layer.effect(
  DaemonInfo,
  Effect.map(Clock.currentTimeMillis, (startedAtMillis) => ({ startedAtMillis })),
);

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
  const bus = yield* DaemonEventBus;
  if (id === undefined) return bus.activity;

  const ledger = yield* RunLedger;
  const subscription = yield* bus.subscribe();
  const run = yield* ledger.getRun(id);
  if (run === null) return Stream.empty;
  const history = yield* activitiesFromLedger(run, yield* ledger.events(id));
  const lastSeq = history.at(-1)?.seq ?? -1;
  const live = runActivityStream(Stream.fromSubscription(subscription)).pipe(
    Stream.filter((item) => item.runId === id && item.seq > lastSeq),
  );
  const settled = run.status !== "running";
  const base = settled ? Stream.fromIterable(history) : Stream.concat(Stream.fromIterable(history), live);
  return base.pipe(Stream.takeUntil(isTerminalActivity));
});

const seedEvents = Effect.fn("Daemon.seedEvents")(function* () {
  const registry = yield* WorkspaceRegistry;
  const worker = yield* ReconcileWorker;
  const scheduler = yield* Scheduler;
  const ledger = yield* RunLedger;
  const snapshot = yield* worker.snapshot;
  const stats = yield* scheduler.stats;
  const running = yield* ledger.runningRuns;
  const items = snapshot.workspaces.flatMap((state) =>
    classifiedItemsOf(state).map((item) => ({ _tag: "ItemChanged", workspace: state.name, item }) as const),
  );
  const workspaces = workspaceStatesOf(registry, snapshot).map(
    (workspace) => ({ _tag: "WorkspaceChanged", workspace }) as const,
  );
  const runs = running.map((run) => ({ _tag: "RunChanged", run }) as const);
  const scheduling = {
    _tag: "SchedulerChanged",
    scheduler: schedulerStatsOf(scheduler.config, stats),
  } as const;
  return [...items, ...workspaces, ...runs, scheduling];
});

// Subscribe before reading the seed so an event published between the two is not lost.
export const watchEvents = Effect.fn("Daemon.watchEvents")(function* () {
  const bus = yield* DaemonEventBus;
  const subscription = yield* bus.subscribe();
  const seed = yield* seedEvents();
  return Stream.concat(Stream.fromIterable(seed), Stream.fromSubscription(subscription));
});

const statesByName = (snapshot: ReconcileSnapshot) =>
  new Map(snapshot.workspaces.map((state) => [state.name, state]));

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
      scheduler: schedulerStatsOf(scheduler.config, stats),
      workspaces: registry.workspaces.map((w) => workspaceInfoOf(w, stateByName.get(w.config.name))),
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
  ResolveWatchTarget: Effect.fn("Daemon.ResolveWatchTarget")(function* (payload) {
    const ledger = yield* RunLedger;
    const run = yield* ledger.resolveWatchTarget(payload.workItem);
    return run?.id ?? null;
  }),
  WatchActivity: (payload) => Stream.unwrap(watchActivity(payload.id)),
  WatchEvents: () => Stream.unwrap(watchEvents()),
  CancelRun: cancelRun,
  Reclassify: reclassify,
  SetScheduling: setScheduling,
});

export const serializationLayer = RpcSerialization.layerNdjson;

export const principalMiddlewareLayer = Layer.succeed(PrincipalMiddleware)(
  PrincipalMiddleware.of((effect) => Effect.provideService(effect, Principal, localOwner)),
);

export interface HostAdapters<E = never, R = never> {
  readonly transport: Layer.Layer<RpcServer.Protocol, E, RpcSerialization.RpcSerialization | R>;
  readonly credentials: Layer.Layer<CredentialStore, E, HttpClient.HttpClient | R>;
  readonly runLedger: Layer.Layer<CoreRunLedger, E, R>;
  readonly registry: Layer.Layer<WorkspaceRegistry, E, R>;
  readonly worktrees: Layer.Layer<WorktreeManager, E, R>;
  readonly harnessRunners: ReadonlyArray<Harness.HarnessRunner>;
  readonly scheduler: SchedulerConfig;
}

const engineLayer = <E, R>(adapters: HostAdapters<E, R>) => {
  // The credential store is stateful — its refresh gate and its minted-token cache only coordinate
  // within one instance — so the issue-tracker reads and the MCP-skill bearer must draw from the same
  // one, or they would mint and rotate the app-actor token independently.
  const credentials = adapters.credentials;
  const issueTracker = Layer.mergeAll(issueTrackerRoutedLayer, GitHub.providerLayer).pipe(
    Layer.provide(GitHub.clientLayer),
    Layer.provide(Linear.clientLayer),
    Layer.provide(credentials),
  );
  const runLedger = runLedgerPublishingLayer.pipe(
    Layer.provide(adapters.runLedger),
    Layer.provide(daemonEventBusLayer),
  );
  const sessionStore = SessionStore.layer.pipe(Layer.provide(runLedger));
  const base = Layer.mergeAll(
    adapters.registry,
    daemonInfoLayer,
    issueTracker,
    runLedger,
    Harness.layer(adapters.harnessRunners).pipe(Layer.provide(sessionStore)),
    McpSkill.layer.pipe(Layer.provide(credentials)),
    daemonEventBusLayer,
    runControlLayer,
  );
  const services = Layer.mergeAll(reconcileLayer, Executor.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(base, adapters.worktrees)),
  );
  const scheduler = schedulerLayer(adapters.scheduler).pipe(Layer.provideMerge(services));
  const withRecovery = recoveryLayer.pipe(Layer.provideMerge(scheduler));
  return eventPublisherLayer.pipe(Layer.provideMerge(withRecovery));
};

export const serverLayer = <E, R>(adapters: HostAdapters<E, R>) =>
  RpcServer.layer(DaemonRpcs).pipe(
    Layer.provide(handlersLayer),
    Layer.provide(principalMiddlewareLayer),
    Layer.provide(adapters.transport),
    Layer.provide(serializationLayer),
    Layer.provideMerge(engineLayer(adapters)),
    Layer.provide(FetchHttpClient.layer),
  );

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

const reconcileTick = Effect.fn("Daemon.reconcileHeartbeat")(function* () {
  const worker = yield* ReconcileWorker;
  const publisher = yield* DaemonEventPublisher;
  const receipt = yield* worker.submit();
  yield* Effect.logInfo("reconcile tick", receipt);
  yield* publisher.publishItems();
  yield* publisher.publishWorkspaces();
  yield* maintainWorktrees();
});

const reconcileHeartbeat = (pollIntervalMillis: number) =>
  reconcileTick().pipe(Effect.repeat(Schedule.spaced(pollIntervalMillis)));

export const bootstrap = Effect.gen(function* () {
  const worker = yield* ReconcileWorker;
  const recovery = yield* Recovery;
  const ledger = yield* RunLedger;
  // Captured before recover() so the runs it re-admits (started after) survive the sweep below.
  const orphanCutoffMillis = yield* Clock.currentTimeMillis;
  yield* worker.submit();
  yield* recovery.recover();
  yield* ledger.interruptRunningBefore(orphanCutoffMillis, yield* Clock.currentTimeMillis);
});

const executeTick = Effect.fn("Daemon.executeHeartbeat")(function* () {
  const scheduler = yield* Scheduler;
  const publisher = yield* DaemonEventPublisher;
  yield* scheduler.tick();
  yield* publisher.publishScheduler();
});

const executeHeartbeat = () => executeTick().pipe(Effect.repeat(Schedule.spaced("5 seconds")));

export interface HeartbeatOptions {
  readonly pollIntervalMillis: number;
  readonly drain: DrainOptions;
}

export const heartbeats = (options: HeartbeatOptions) =>
  Effect.all([reconcileHeartbeat(options.pollIntervalMillis), executeHeartbeat()], {
    concurrency: "unbounded",
  }).pipe(Effect.onInterrupt(() => Effect.flatMap(Scheduler, (scheduler) => scheduler.drain(options.drain))));
