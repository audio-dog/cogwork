import { fileURLToPath } from "node:url";
import {
  agUiIsTerminal,
  type ConnectionOverview,
  type DaemonEvent,
  DaemonRpcs,
  defaultControlStore,
  HarnessCatalog,
  localOwner,
  PollState,
  Principal,
  PrincipalMiddleware,
  type RunActivity,
  type RunId,
  type WorkspaceId,
} from "@cogwork/contracts";

import type * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { Availability } from "./availability";
import { clockSource } from "./clock-source";
import {
  cancelRun,
  deregisterWorkspace,
  establishConnection,
  getGitHubPriorityFields,
  handBack,
  installPlugin,
  loginGranola,
  rebindWorkspace,
  reclassify,
  reconnectConnection,
  registerWorkspace,
  removeConnection,
  setContributionSetting,
  setDaemonLimit,
  setHarnessEnabled,
  setOperationSetting,
  setScheduling,
  uninstallPlugin,
  updateWorkspace,
} from "./commands";
import { ConnectionStore, layer as connectionStoreLayer } from "./connection";
import { type ConnectionVerifier, layer as connectionVerifierLayer } from "./connection-verify";
import type { ContextAssembler } from "./context-assembler";
import { bootControlStoreLayer, ControlStore, type ControlStoreService } from "./control-store";
import { Coordination } from "./coordination";
import { makeControlStoreCoordination } from "./coordination-control-store";
import type { CredentialStore } from "./credential-store";
import { DaemonEventBus, layer as daemonEventBusLayer, runActivityStream } from "./daemon-event-bus";
import {
  controlStoreWithDiagnostics,
  DaemonEventPublisher,
  layer as eventPublisherLayer,
} from "./event-publisher";
import * as Executor from "./executor";
import * as GitHub from "./github";
import { makeGranolaSource, makeGranolaSourceAdapters } from "./granola-source";
import * as Harness from "./harness";
import { HarnessReadinessCache, layer as harnessReadinessLayer } from "./harness-readiness";
import { routedLayer as issueTrackerRoutedLayer } from "./issue-tracker-router";
import * as Linear from "./linear";
import * as McpSkill from "./mcp-skill";
import * as OperationResolution from "./operation-resolution";
import { PerformanceHealthSource } from "./performance-health-source";
import { recordProcessHealth, reportDaemonProcessHealth } from "./performance-metrics";
import {
  PerformanceRegressionSensor,
  layer as performanceRegressionSensorLayer,
} from "./performance-regression-sensor";
import { PluginManager, pluginManagerLayer } from "./plugin";
import type { RegisteredWorkspace, RegistryState } from "./projector";
import {
  classifiedItemsOf,
  currentReconcileStatesOf,
  schedulerStatsOf,
  workspaceInfoOf,
  workspaceStatesOf,
} from "./read-model";
import {
  makeRefreshing as makeReconcile,
  type ReconcileSnapshot,
  ReconcileWorker,
  type WorkspaceReconcileState,
} from "./reconcile";
import { Recovery, layer as recoveryLayer } from "./recovery";
import { WorkspaceRegistry, layer as workspaceRegistryLayer } from "./registry";
import { layer as runControlLayer } from "./run-control";
import {
  type CoreRunLedger,
  layerMemoryCore as memoryRunLedgerLayer,
  RunLedger,
  publishingLayer as runLedgerPublishingLayer,
} from "./run-ledger";
import { RunRecorder, layer as runRecorderLayer } from "./run-recorder";
import { configFromControlStore, type DrainOptions, Scheduler, layer as schedulerLayer } from "./scheduler";
import * as SessionStore from "./session-store";
import {
  controlStoreTriggerObservationStoreLayer,
  TriggerObservation,
  layer as triggerObservationLayer,
} from "./trigger-observation";
import { TriggerSources } from "./trigger-source";
import { Workflows, layer as workflowsLayer } from "./workflow";
import { workflowCatalogContributionsLayer } from "./workflow-catalog";
import { layer as machineReadinessLayer } from "./workflow-machine-readiness";
import { WorkflowNotifications, layer as workflowNotificationsLayer } from "./workflow-notification";
import { layer as workflowRunLayer } from "./workflow-run";
import { ticketSlug, WorktreeManager, worktreePathFor, worktreeRoot } from "./worktree";

export class DaemonInfo extends Context.Service<DaemonInfo, { readonly startedAtMillis: number }>()(
  "@cogwork/engine/daemon/DaemonInfo",
) {}

export const daemonInfoLayer = Layer.effect(
  DaemonInfo,
  Effect.map(Clock.currentTimeMillis, (startedAtMillis) => ({ startedAtMillis })),
);

const isTerminalActivity = (activity: RunActivity) => agUiIsTerminal(activity.event);

type ControlStoreSeedEvent = Omit<
  Extract<DaemonEvent, { readonly _tag: "ControlStoreChanged" }>,
  "emittedAtMillis"
>;
type PluginSeedEvent = Omit<Extract<DaemonEvent, { readonly _tag: "PluginsChanged" }>, "emittedAtMillis">;

const controlStoreSeedEvents = Effect.fn("Daemon.controlStoreSeedEvents")(function* (
  store: ControlStoreService,
  registry: RegistryState,
) {
  if (store.health === "unavailable") {
    yield* Effect.logError("Control store seed unavailable", { message: store.message });
    return [];
  }
  return yield* store.picture.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logError("Control store seed failed", { error }).pipe(Effect.map(() => [])),
      onSuccess: (controlStore) =>
        Effect.succeed([
          {
            _tag: "ControlStoreChanged",
            controlStore: controlStoreWithDiagnostics(controlStore, registry),
          } satisfies ControlStoreSeedEvent,
        ]),
    }),
  );
});

const connectionSeedEvent = (connections: ConnectionOverview) =>
  ({
    _tag: "ConnectionsChanged",
    connections,
    danglingWorkspaces: [],
  }) satisfies Omit<Extract<DaemonEvent, { readonly _tag: "ConnectionsChanged" }>, "emittedAtMillis">;

const pluginSeedEvent = (plugins: PluginSeedEvent["plugins"]) =>
  ({ _tag: "PluginsChanged", plugins, notices: [] }) satisfies PluginSeedEvent;

export const watchActivity = Effect.fn("Daemon.watchActivity")(function* (id: RunId | undefined) {
  const bus = yield* DaemonEventBus;
  if (id === undefined) return bus.activity;

  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const subscription = yield* bus.subscribe();
  const run = yield* ledger.getRun(id);
  if (run === null) return Stream.empty;
  const historyHead = (yield* ledger.latestSeq(id)) ?? -1;
  const history = recorder.replay(run).pipe(Stream.takeWhile((item) => item.seq <= historyHead));
  const live = runActivityStream(Stream.fromSubscription(subscription)).pipe(
    Stream.filter((item) => item.runId === id && item.seq > historyHead),
  );
  const settled = run.status !== "running";
  const base = settled ? history : Stream.concat(history, live);
  return base.pipe(Stream.takeUntil(isTerminalActivity));
});

const seedEvents = Effect.fn("Daemon.seedEvents")(function* () {
  const worker = yield* ReconcileWorker;
  const scheduler = yield* Scheduler;
  const controlStore = yield* ControlStore;
  const plugins = yield* PluginManager;
  const connections = yield* ConnectionStore;
  const harnesses = yield* HarnessReadinessCache;
  const workflows = yield* Workflows;
  const ledger = yield* RunLedger;
  const emittedAtMillis = yield* Clock.currentTimeMillis;
  const snapshot = yield* worker.snapshot;
  const config = yield* scheduler.config;
  const stats = yield* scheduler.stats;
  const running = yield* ledger.runningRuns;
  const registry = yield* (yield* WorkspaceRegistry).state;
  const items = currentReconcileStatesOf(registry, snapshot).flatMap((state) =>
    classifiedItemsOf(state).map((item) => ({ _tag: "ItemChanged", workspace: state.name, item }) as const),
  );
  const workspaces = workspaceStatesOf(registry, snapshot).map(
    (workspace) => ({ _tag: "WorkspaceChanged", workspace }) as const,
  );
  const runs = running.map((run) => ({ _tag: "RunChanged", run }) as const);
  const scheduling = {
    _tag: "SchedulerChanged",
    scheduler: schedulerStatsOf(registry, config, stats),
  } as const;
  const controlStoreEvents = yield* controlStoreSeedEvents(controlStore, registry);
  const pluginEvents = yield* plugins.overview.pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.logError("Plugin seed failed", { error }).pipe(Effect.map(() => [])),
      onSuccess: (overview) => Effect.succeed([pluginSeedEvent(overview)]),
    }),
  );
  const connectionEvents = yield* connections.overview.pipe(
    Effect.match({
      onFailure: () => [],
      onSuccess: (overview) => [connectionSeedEvent(overview)],
    }),
  );
  const harnessEvent = {
    _tag: "HarnessesChanged" as const,
    readiness: yield* harnesses.readiness(
      controlStore.health === "available" ? controlStore.seed.harnessSettings : [],
    ),
  };
  const workflowEvents = yield* workflows.list.pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.logError("Workflow seed failed", { error }).pipe(Effect.map(() => [])),
      onSuccess: ({ workflows }) =>
        Effect.succeed(workflows.map((workflow) => ({ _tag: "WorkflowChanged", workflow }) as const)),
    }),
  );
  return [
    ...items,
    ...workspaces,
    ...runs,
    ...controlStoreEvents,
    ...pluginEvents,
    ...connectionEvents,
    ...workflowEvents,
    harnessEvent,
    scheduling,
  ].map((event) => ({
    ...event,
    emittedAtMillis,
  }));
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
    const info = yield* DaemonInfo;
    const worker = yield* ReconcileWorker;
    const scheduler = yield* Scheduler;
    const snapshot = yield* worker.snapshot;
    const config = yield* scheduler.config;
    const stats = yield* scheduler.stats;
    const now = yield* Clock.currentTimeMillis;
    const bus = yield* DaemonEventBus;
    const controlStore = yield* ControlStore;
    const triggerObservation = yield* TriggerObservation;
    const registry = yield* (yield* WorkspaceRegistry).state;
    const stateByName = statesByName(snapshot);
    return {
      health: controlStore.health === "available" ? "running" : "store-unavailable",
      startedAtMillis: info.startedAtMillis,
      uptimeMillis: now - info.startedAtMillis,
      eventBusDroppedEvents: yield* bus.droppedEvents,
      scheduler: schedulerStatsOf(registry, config, stats),
      sources: yield* triggerObservation.health,
      workspaces: registry.workspaces.map((w) => workspaceInfoOf(w, stateByName.get(w.config.name))),
      failures: registry.failures.map(({ name, displayName, source, message }) => ({
        ...(name === undefined ? {} : { name }),
        ...(displayName === undefined ? {} : { displayName }),
        source,
        message,
      })),
    };
  }),
  GetMetrics: Effect.fn("Daemon.GetMetrics")(function* () {
    return yield* Metric.dump;
  }),
  GetControlStore: Effect.fn("Daemon.GetControlStore")(function* () {
    const store = yield* ControlStore;
    const picture = yield* store.picture;
    const registry = yield* (yield* WorkspaceRegistry).state;
    return controlStoreWithDiagnostics(picture, registry);
  }),
  GetPlugins: Effect.fn("Daemon.GetPlugins")(function* () {
    return yield* (yield* PluginManager).overview;
  }),
  GetConnections: Effect.fn("Daemon.GetConnections")(function* () {
    return yield* (yield* ConnectionStore).overview;
  }),
  GetHarnessCatalogs: Effect.fn("Daemon.GetHarnessCatalogs")(function* () {
    const harnesses = yield* Harness.Harness;
    return [...harnesses.catalogs].map(([harness, catalog]) => HarnessCatalog.make({ harness, catalog }));
  }),
  GetHarnessReadiness: Effect.fn("Daemon.GetHarnessReadiness")(function* () {
    const store = yield* ControlStore;
    const picture = yield* store.picture;
    return yield* (yield* HarnessReadinessCache).readiness(picture.harnessSettings);
  }),
  GetGitHubPriorityFields: getGitHubPriorityFields,
  ListRuns: Effect.fn("Daemon.ListRuns")(function* () {
    const ledger = yield* RunLedger;
    return yield* ledger.listRuns(50);
  }),
  GetRunEvents: Effect.fn("Daemon.GetRunEvents")(function* (payload) {
    const ledger = yield* RunLedger;
    return yield* ledger.history(payload.id).pipe(Effect.orDie);
  }),
  ResolveWatchTarget: Effect.fn("Daemon.ResolveWatchTarget")(function* (payload) {
    const ledger = yield* RunLedger;
    const run = yield* ledger.resolveWatchTarget(payload.workItem);
    return run?.id ?? null;
  }),
  WatchActivity: (payload) => Stream.unwrap(watchActivity(payload.id)).pipe(Stream.orDie),
  WatchEvents: () => Stream.unwrap(watchEvents()),
  ListWorkflows: () => Effect.flatMap(Workflows, ({ list }) => list),
  ListWorkflowNotifications: () =>
    Effect.flatMap(WorkflowNotifications, ({ list }) => list).pipe(Effect.orDie),
  GetWorkflow: (payload) => Effect.flatMap(Workflows, ({ get }) => get(payload)),
  ValidateWorkflow: (payload) => Effect.flatMap(Workflows, ({ validate }) => validate(payload)),
  GetWorkflowCatalog: () => Effect.flatMap(Workflows, ({ catalog }) => catalog),
  GetWorkflowTemplates: () => Effect.flatMap(Workflows, ({ templates }) => templates),
  ListWorkflowOptions: (payload) => Effect.flatMap(Workflows, ({ listOptions }) => listOptions(payload)),
  CancelRun: cancelRun,
  HandBack: handBack,
  Reclassify: reclassify,
  SetScheduling: setScheduling,
  ReportProcessHealth: Effect.fn("Daemon.ReportProcessHealth")(function* ({ samples }) {
    yield* Effect.forEach(samples, recordProcessHealth, { discard: true });
  }),
  CheckHarnesses: Effect.fn("Daemon.CheckHarnesses")(function* () {
    yield* (yield* HarnessReadinessCache).requestAll();
  }),
  SetDaemonLimit: setDaemonLimit,
  SetContributionSetting: setContributionSetting,
  SetHarnessEnabled: setHarnessEnabled,
  SetOperationSetting: setOperationSetting,
  RegisterWorkspace: registerWorkspace,
  UpdateWorkspace: updateWorkspace,
  InstallPlugin: installPlugin,
  UninstallPlugin: uninstallPlugin,
  EstablishConnection: establishConnection,
  LoginGranola: loginGranola,
  ReconnectConnection: reconnectConnection,
  RemoveConnection: removeConnection,
  DeregisterWorkspace: deregisterWorkspace,
  RebindWorkspace: rebindWorkspace,
  CreateWorkflow: (payload) => Effect.flatMap(Workflows, ({ create }) => create(payload)),
  EditWorkflow: (payload) => Effect.flatMap(Workflows, ({ edit }) => edit(payload)),
  PublishWorkflow: (payload) => Effect.flatMap(Workflows, ({ publish }) => publish(payload)),
  SwitchWorkflow: (payload) =>
    Effect.flatMap(Workflows, ({ switch: switchWorkflow }) => switchWorkflow(payload)),
  DeleteWorkflow: (payload) =>
    Effect.flatMap(Workflows, ({ delete: deleteWorkflow }) => deleteWorkflow(payload)),
});

export const serializationLayer = RpcSerialization.layerNdjson;

export const principalMiddlewareLayer = Layer.succeed(PrincipalMiddleware)(
  PrincipalMiddleware.of((effect) => Effect.provideService(effect, Principal, localOwner)),
);

export interface HostAdapters<E = never, R = never> {
  readonly transport: Layer.Layer<RpcServer.Protocol, E, RpcSerialization.RpcSerialization | R>;
  readonly credentials: Layer.Layer<CredentialStore, E, HttpClient.HttpClient | R>;
  readonly granolaLogin?: Layer.Layer<never, E, R | Crypto.Crypto>;
  readonly contextAssembler: Layer.Layer<ContextAssembler, E, R>;
  readonly runLedger: Layer.Layer<CoreRunLedger, E, SqliteClient.SqliteClient | R>;
  readonly controlStorePath: string;
  readonly userAgentsDir: string;
  readonly pluginCatalogPath?: string;
  readonly pluginProvisionRoot?: string;
  readonly worktrees: Layer.Layer<WorktreeManager, E, R>;
  readonly harnessRunners: ReadonlyArray<Harness.HarnessRunner>;
  readonly appVersion: string;
  readonly performanceEvidenceRoot: string;
  readonly performanceHealth: Layer.Layer<PerformanceHealthSource, E, R>;
  readonly performanceIssueWorkspace?: WorkspaceId;
}

function engineLayer<E, R>(adapters: HostAdapters<E, R>) {
  // The credential store is stateful — its refresh gate and its minted-token cache only coordinate
  // within one instance — so the issue-tracker reads and the MCP-skill bearer must draw from the same
  // one, or they would mint and rotate the app-actor token independently.
  const credentials = adapters.credentials;
  // One GitHub client, built once: the issue tracker and the establish-time credential check must
  // share it, or the second instance resolves its own credentials and drifts from the first.
  const githubClient = GitHub.clientLayer.pipe(Layer.provide(credentials));
  const issueTracker = Layer.mergeAll(issueTrackerRoutedLayer, GitHub.providerLayer).pipe(
    Layer.provide(githubClient),
    Layer.provide(Linear.clientLayer),
    Layer.provide(credentials),
  );
  const controlStore = bootControlStoreLayer(adapters.controlStorePath);
  const connections = connectionStoreLayer.pipe(
    Layer.provide(controlStore),
    Layer.provide(credentials),
    Layer.provide(connectionVerifierLayer.pipe(Layer.provide(githubClient))),
  );
  const plugins = pluginManagerLayer({
    catalogPath:
      adapters.pluginCatalogPath ?? fileURLToPath(new URL("../plugins/catalog.json", import.meta.url)),
    provisionRoot: adapters.pluginProvisionRoot ?? `${adapters.controlStorePath}.plugins`,
  }).pipe(Layer.provide(controlStore), Layer.provide(connections));
  const registry = workspaceRegistryLayer(adapters.controlStorePath, adapters.userAgentsDir).pipe(
    Layer.provideMerge(controlStore),
  );
  const performanceIssueFiler = GitHub.performanceIssueFilerLayer(adapters.performanceIssueWorkspace).pipe(
    Layer.provide(githubClient),
    Layer.provide(registry),
  );
  const runLedger: Layer.Layer<RunLedger, E | PlatformError, R | FileSystem.FileSystem | Path.Path> =
    runLedgerPublishingLayer.pipe(
      Layer.provide(
        Layer.unwrap(
          Effect.map(ControlStore, (store) =>
            store.health === "available" ? adapters.runLedger : memoryRunLedgerLayer,
          ),
        ).pipe(Layer.provide(controlStore)),
      ),
      Layer.provide(daemonEventBusLayer),
    );
  const runRecorder = runRecorderLayer.pipe(Layer.provide(runLedger), Layer.provide(daemonEventBusLayer));
  const sessionStore = SessionStore.layer.pipe(Layer.provide(runLedger), Layer.provide(runRecorder));
  const runnerRequirements = Layer.mergeAll(
    Layer.effect(FileSystem.FileSystem, FileSystem.FileSystem),
    Layer.effect(Path.Path, Path.Path),
    Layer.effect(HttpClient.HttpClient, HttpClient.HttpClient),
  );
  const harness = Harness.layer(adapters.harnessRunners);
  const harnessRuntime = Layer.mergeAll(
    controlStore,
    credentials,
    runnerRequirements,
    sessionStore,
    adapters.contextAssembler,
    harness,
    daemonEventBusLayer,
  );
  const harnessReadiness = harnessReadinessLayer.pipe(Layer.provideMerge(harnessRuntime));
  const machineReadiness = machineReadinessLayer.pipe(
    Layer.provide(Layer.mergeAll(controlStore, registry, connections, harnessReadiness)),
  );
  const workflows = workflowsLayer.pipe(
    Layer.provide(workflowCatalogContributionsLayer),
    Layer.provide(machineReadiness),
    Layer.provide(Layer.mergeAll(controlStore, daemonEventBusLayer, harness)),
  );
  const coordination = Layer.effect(Coordination, makeControlStoreCoordination).pipe(
    Layer.provide(controlStore),
  );
  const triggerSources: Layer.Layer<
    TriggerSources,
    E | PlatformError,
    R | FileSystem.FileSystem | HttpClient.HttpClient | Path.Path | Exclude<R, ConnectionVerifier>
  > = Layer.effect(
    TriggerSources,
    Effect.gen(function* () {
      const connectionStore = yield* ConnectionStore;
      const http = yield* HttpClient.HttpClient;
      return [clockSource, makeGranolaSource(connectionStore, makeGranolaSourceAdapters(http))];
    }),
  ).pipe(Layer.provide(connections));
  const triggerObservationStore = controlStoreTriggerObservationStoreLayer.pipe(Layer.provide(controlStore));
  const workflowNotifications = workflowNotificationsLayer.pipe(
    Layer.provide(Layer.merge(runLedger, runRecorder)),
  );
  const triggerObservation = triggerObservationLayer.pipe(
    Layer.provide(
      Layer.mergeAll(workflows, coordination, triggerSources, triggerObservationStore, daemonEventBusLayer),
    ),
  );
  const workflowRun = workflowRunLayer.pipe(
    Layer.provide(
      Layer.mergeAll(workflows, coordination, harnessRuntime, runLedger, runRecorder, workflowNotifications),
    ),
  );
  const base = Layer.mergeAll(
    registry,
    plugins,
    connections,
    githubClient,
    ...(adapters.granolaLogin ? [adapters.granolaLogin] : []),
    daemonInfoLayer,
    issueTracker,
    adapters.performanceHealth,
    performanceIssueFiler,
    runLedger,
    runRecorder,
    harnessReadiness,
    workflows,
    coordination,
    triggerSources,
    triggerObservation,
    workflowNotifications,
    workflowRun,
    McpSkill.layer.pipe(Layer.provide(credentials)),
    runControlLayer,
  );
  const availability = Availability.layer;
  const operationResolution = OperationResolution.layer;
  const services = Layer.mergeAll(
    Layer.effect(ReconcileWorker, makeReconcile),
    Layer.effect(Executor.Executor, Executor.make),
  ).pipe(
    Layer.provideMerge(operationResolution),
    Layer.provide(availability),
    Layer.provideMerge(Layer.mergeAll(base, adapters.worktrees)),
  );
  return eventPublisherLayer.pipe(
    Layer.provideMerge(
      performanceRegressionSensorLayer({
        appVersion: adapters.appVersion,
        evidenceRoot: adapters.performanceEvidenceRoot,
      }).pipe(
        Layer.provideMerge(
          recoveryLayer.pipe(
            Layer.provideMerge(
              Layer.unwrap(
                Effect.map(ControlStore, (store) =>
                  schedulerLayer(
                    configFromControlStore(store.health === "available" ? store.seed : defaultControlStore),
                  ),
                ),
              ).pipe(Layer.provideMerge(services)),
            ),
          ),
        ),
      ),
    ),
  );
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

const canonicalWorktreeRoot = Effect.fn("Daemon.canonicalWorktreeRoot")(function* (
  workspace: RegisteredWorkspace,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configuredPath = path.resolve(
    worktreeRoot(workspace.config.checkoutPath, workspace.config.worktrees),
  );
  return yield* fs.realPath(configuredPath).pipe(
    Effect.match({
      onFailure: () => ({ configuredPath, canonicalPath: configuredPath, resolved: false }),
      onSuccess: (canonicalPath) => ({ configuredPath, canonicalPath, resolved: true }),
    }),
  );
});

const reconcileWorkspaceWorktrees = Effect.fn("Daemon.reconcileWorkspaceWorktrees")(function* (
  workspace: RegisteredWorkspace,
  workspaces: ReadonlyArray<RegisteredWorkspace>,
  state: WorkspaceReconcileState,
  now: number,
) {
  const manager = yield* WorktreeManager;
  const ledger = yield* RunLedger;
  const running = yield* ledger.runningRuns;
  const workspaceByName = new Map(workspaces.map((candidate) => [candidate.config.name, candidate]));
  const retainedRuns = running.map((record) => ({
    branch: record.branch,
    owner: workspaceByName.get(record.workspace),
  }));
  const ownershipRoot = yield* canonicalWorktreeRoot(workspace);
  const ownershipPaths = new Set([ownershipRoot.configuredPath, ownershipRoot.canonicalPath]);
  const retainedPaths = yield* Effect.forEach(retainedRuns, ({ branch, owner }) => {
    const missingOwnership = owner === undefined || branch === null;
    if (missingOwnership) return Effect.succeed([]);
    return Effect.map(canonicalWorktreeRoot(owner), (ownerRoot) => {
      const sharesOwnershipRoot =
        !ownerRoot.resolved ||
        !ownershipRoot.resolved ||
        ownerRoot.canonicalPath === ownershipRoot.canonicalPath;
      return sharesOwnershipRoot ? [...ownershipPaths].map((root) => worktreePathFor(root, branch)) : [];
    });
  });
  const ownedWorktreePaths = retainedPaths.flat();
  return yield* manager.reconcile(
    workspace,
    { activeTicketKeys: activeTicketKeys(state), ownedWorktreePaths },
    now,
  );
});

const maintainWorktrees = Effect.fn("Daemon.maintainWorktrees")(function* () {
  const manager = yield* WorktreeManager;
  const worker = yield* ReconcileWorker;
  const snapshot = yield* worker.snapshot;
  const now = yield* Clock.currentTimeMillis;
  const registry = yield* (yield* WorkspaceRegistry).state;
  const stateByName = statesByName(snapshot);
  const reconcilable = registry.workspaces
    .map((workspace) => ({ workspace, state: stateByName.get(workspace.config.name) }))
    .filter(
      (entry): entry is ReconcilableWorkspace =>
        entry.workspace.config.worktrees !== undefined &&
        entry.state !== undefined &&
        PollState.guards.ok(entry.state.poll),
    );
  yield* Effect.forEach(
    reconcilable,
    ({ workspace, state }) => {
      const correlation = { workspace: workspace.config.name };
      return manager
        .tryWithMaintenanceLock(reconcileWorkspaceWorktrees(workspace, registry.workspaces, state, now))
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.logInfo("worktree maintenance skipped; Run owns a worktree"),
              onSome: (outcome) => Effect.logInfo("worktree maintenance", outcome),
            }),
          ),
          Effect.catchTag("GitError", (error) =>
            Effect.logWarning("worktree maintenance failed", {
              message: error.message,
            }),
          ),
          Effect.annotateLogs(correlation),
          Effect.annotateSpans(correlation),
        );
    },
    { discard: true },
  );
});

const continueAfterHeartbeatFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
  Effect.catchCauseIf(
    effect,
    (cause) => !Cause.hasInterruptsOnly(cause),
    (cause) => Effect.logError(message, { cause }),
  );

const reconcileTick = Effect.fn("Daemon.reconcileHeartbeat")(function* () {
  const worker = yield* ReconcileWorker;
  const publisher = yield* DaemonEventPublisher;
  yield* continueAfterHeartbeatFailure(
    worker.submit().pipe(Effect.tap((receipt) => Effect.logInfo("reconcile tick", receipt))),
    "reconcile heartbeat failed",
  );
  yield* publisher.publishItems();
  yield* publisher.publishWorkspaces();
  yield* maintainWorktrees();
});

const reconcileHeartbeat = (pollIntervalMillis: number) =>
  continueAfterHeartbeatFailure(reconcileTick(), "reconcile heartbeat failed").pipe(
    Effect.repeat(Schedule.spaced(pollIntervalMillis)),
  );

export const bootstrap = Effect.gen(function* () {
  const controlStore = yield* ControlStore;
  if (controlStore.health === "unavailable") return;
  const worker = yield* ReconcileWorker;
  const recovery = yield* Recovery;
  yield* continueAfterHeartbeatFailure(worker.submit(), "reconcile bootstrap failed");
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

const performanceRegressionTick = Effect.fn("Daemon.performanceRegressionHeartbeat")(function* () {
  const source = yield* PerformanceHealthSource;
  const sensor = yield* PerformanceRegressionSensor;
  yield* sensor.observe(yield* source.snapshot);
});

const performanceRegressionHeartbeat = () =>
  continueAfterHeartbeatFailure(performanceRegressionTick(), "performance regression heartbeat failed").pipe(
    Effect.repeat(Schedule.spaced("10 seconds")),
    Effect.provideService(References.TracerEnabled, false),
  );

export interface HeartbeatOptions {
  readonly pollIntervalMillis: number;
  readonly drain: DrainOptions;
}

const activeHeartbeats = (options: HeartbeatOptions) =>
  Effect.all([reconcileHeartbeat(options.pollIntervalMillis), executeHeartbeat()], {
    concurrency: "unbounded",
  }).pipe(Effect.onInterrupt(() => Effect.flatMap(Scheduler, (scheduler) => scheduler.drain(options.drain))));

const awaitHeartbeatInterruption = () => Effect.callback<never>(() => Effect.void);

const operationalHeartbeats = (options: HeartbeatOptions) =>
  Effect.flatMap(ControlStore, (controlStore) => {
    if (controlStore.health === "unavailable") return awaitHeartbeatInterruption();
    return activeHeartbeats(options);
  });

export const heartbeats = (options: HeartbeatOptions) =>
  Effect.all([operationalHeartbeats(options), reportDaemonProcessHealth, performanceRegressionHeartbeat()], {
    concurrency: "unbounded",
  });
