import {
  agUiIsTerminal,
  DaemonRpcs,
  localOwner,
  Principal,
  PrincipalMiddleware,
  type RunActivity,
  type RunId,
} from "@cogwork/contracts";
import type * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { cancelRun, reclassify, setSchedulerConfig, setScheduling } from "./commands";
import type { ContextAssembler } from "./context-assembler";
import { bootControlStoreLayer, ControlStore, controlStoreClientLayer } from "./control-store";
import type { CredentialStore } from "./credential-store";
import { DaemonEventBus, layer as daemonEventBusLayer, runActivityStream } from "./daemon-event-bus";
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
import {
  type CoreRunLedger,
  layerMemoryCore as memoryRunLedgerLayer,
  RunLedger,
  publishingLayer as runLedgerPublishingLayer,
} from "./run-ledger";
import { RunRecorder, layer as runRecorderLayer } from "./run-recorder";
import { type DrainOptions, Scheduler, type SchedulerConfig, layer as schedulerLayer } from "./scheduler";
import * as SessionStore from "./session-store";
import { ticketSlug, WorktreeManager } from "./worktree";

export class DaemonInfo extends Context.Service<DaemonInfo, { readonly startedAtMillis: number }>()(
  "@cogwork/engine/daemon/DaemonInfo",
) {}

export const daemonInfoLayer = Layer.effect(
  DaemonInfo,
  Effect.map(Clock.currentTimeMillis, (startedAtMillis) => ({ startedAtMillis })),
);

const isTerminalActivity = (activity: RunActivity) => agUiIsTerminal(activity.event);

export const watchActivity = Effect.fn("Daemon.watchActivity")(function* (id: RunId | undefined) {
  const bus = yield* DaemonEventBus;
  if (id === undefined) return bus.activity;

  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const subscription = yield* bus.subscribe();
  const run = yield* ledger.getRun(id);
  if (run === null) return Stream.empty;
  const history = yield* recorder.replay(run);
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
  const emittedAtMillis = yield* Clock.currentTimeMillis;
  const snapshot = yield* worker.snapshot;
  const config = yield* scheduler.config;
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
    scheduler: schedulerStatsOf(config, stats),
  } as const;
  return [...items, ...workspaces, ...runs, scheduling].map((event) => ({ ...event, emittedAtMillis }));
});

// Subscribe before reading the seed so an event published between the two is not lost.
export const watchEvents = Effect.fn("Daemon.watchEvents")(function* () {
  const bus = yield* DaemonEventBus;
  const subscription = yield* bus.subscribe();
  const seed = yield* seedEvents();
  const emittedAtMillis = yield* Clock.currentTimeMillis;
  return Stream.concat(
    Stream.concat(Stream.fromIterable(seed), Stream.make({ _tag: "SeedEnd", emittedAtMillis })),
    Stream.fromSubscription(subscription),
  );
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
    const config = yield* scheduler.config;
    const stats = yield* scheduler.stats;
    const now = yield* Clock.currentTimeMillis;
    const controlStore = yield* ControlStore;
    const stateByName = statesByName(snapshot);
    return {
      health: controlStore.health === "available" ? "running" : "store-unavailable",
      startedAtMillis: info.startedAtMillis,
      uptimeMillis: now - info.startedAtMillis,
      scheduler: schedulerStatsOf(config, stats),
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
  SetSchedulerConfig: setSchedulerConfig,
});

export const serializationLayer = RpcSerialization.layerNdjson;

export const principalMiddlewareLayer = Layer.succeed(PrincipalMiddleware)(
  PrincipalMiddleware.of((effect) => Effect.provideService(effect, Principal, localOwner)),
);

export interface HostAdapters<E = never, R = never> {
  readonly transport: Layer.Layer<RpcServer.Protocol, E, RpcSerialization.RpcSerialization | R>;
  readonly credentials: Layer.Layer<CredentialStore, E, HttpClient.HttpClient | R>;
  readonly contextAssembler: Layer.Layer<ContextAssembler, E, R>;
  readonly runLedger: Layer.Layer<CoreRunLedger, E, SqliteClient.SqliteClient | R>;
  readonly controlStorePath: string;
  readonly registry: Layer.Layer<WorkspaceRegistry, E, R>;
  readonly worktrees: Layer.Layer<WorktreeManager, E, R>;
  readonly harnessRunners: ReadonlyArray<Harness.HarnessRunner>;
  readonly scheduler: SchedulerConfig;
}

function engineLayer<E, R>(adapters: HostAdapters<E, R>) {
  // The credential store is stateful — its refresh gate and its minted-token cache only coordinate
  // within one instance — so the issue-tracker reads and the MCP-skill bearer must draw from the same
  // one, or they would mint and rotate the app-actor token independently.
  const credentials = adapters.credentials;
  const issueTracker = Layer.mergeAll(issueTrackerRoutedLayer, GitHub.providerLayer).pipe(
    Layer.provide(GitHub.clientLayer),
    Layer.provide(Linear.clientLayer),
    Layer.provide(credentials),
  );
  // One store means one connection: the boot loop and the run ledger share this client, so they
  // share its write lock rather than racing each other for the same file.
  const storeClient = controlStoreClientLayer(adapters.controlStorePath);
  const controlStore = bootControlStoreLayer(adapters.controlStorePath).pipe(Layer.provide(storeClient));
  // Booting the store reaches the filesystem, so the ledger built on top of it carries that
  // requirement outward to whichever host provides the platform services.
  const runLedger: Layer.Layer<RunLedger, E | PlatformError, R | FileSystem.FileSystem | Path.Path> =
    runLedgerPublishingLayer.pipe(
      Layer.provide(
        Layer.unwrap(
          Effect.map(ControlStore, (store) =>
            store.health === "available" ? adapters.runLedger : memoryRunLedgerLayer,
          ),
        ).pipe(Layer.provide(controlStore), Layer.provide(storeClient)),
      ),
      Layer.provide(daemonEventBusLayer),
    );
  const runRecorder = runRecorderLayer.pipe(Layer.provide(runLedger), Layer.provide(daemonEventBusLayer));
  const sessionStore = SessionStore.layer.pipe(Layer.provide(runLedger), Layer.provide(runRecorder));
  const base = Layer.mergeAll(
    adapters.registry,
    controlStore,
    daemonInfoLayer,
    issueTracker,
    runLedger,
    runRecorder,
    // The executor mints through the session store, so it is exposed here too;
    // layer memoization keeps it the same instance the harness runners pull from.
    sessionStore,
    Harness.layer(adapters.harnessRunners).pipe(
      Layer.provide(sessionStore),
      Layer.provide(adapters.contextAssembler),
      Layer.provide(credentials),
    ),
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
}

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
  state.observed.flatMap((item) => [ticketSlug(item.id), ...(item.pr?.followable ? [item.pr.headRef] : [])]);

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
  const controlStore = yield* ControlStore;
  if (controlStore.health === "unavailable") return;
  const worker = yield* ReconcileWorker;
  const recovery = yield* Recovery;
  yield* worker.submit();
  yield* recovery.recoverWhenLive();
});

const executeTick = Effect.fn("Daemon.executeHeartbeat")(function* () {
  const recovery = yield* Recovery;
  const scheduler = yield* Scheduler;
  const publisher = yield* DaemonEventPublisher;
  yield* recovery.recoverWhenLive();
  yield* scheduler.tick();
  yield* publisher.publishScheduler();
});

const executeHeartbeat = () => executeTick().pipe(Effect.repeat(Schedule.spaced("5 seconds")));

export interface HeartbeatOptions {
  readonly pollIntervalMillis: number;
  readonly drain: DrainOptions;
}

const activeHeartbeats = (options: HeartbeatOptions) =>
  Effect.all([reconcileHeartbeat(options.pollIntervalMillis), executeHeartbeat()], {
    concurrency: "unbounded",
  }).pipe(Effect.onInterrupt(() => Effect.flatMap(Scheduler, (scheduler) => scheduler.drain(options.drain))));

export const heartbeats = (options: HeartbeatOptions) =>
  Effect.flatMap(ControlStore, (controlStore) => {
    if (controlStore.health === "unavailable") return Effect.never;
    return activeHeartbeats(options);
  });
