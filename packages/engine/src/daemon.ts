import { fileURLToPath } from "node:url";
import {
  agUiIsTerminal,
  type ConnectionOverview,
  type DaemonEvent,
  DaemonRpcs,
  defaultControlStore,
  HarnessCatalog,
  localOwner,
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
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { makeClockSource } from "./clock-source";
import {
  cancelRun,
  deregisterWorkspace,
  establishConnection,
  getGitHubPriorityFields,
  handBack,
  installPlugin,
  loginGranola,
  loginSlack,
  rebindWorkspace,
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
import { layer as connectionVerifierLayer } from "./connection-verify";
import type { ContextAssembler } from "./context-assembler";
import { bootControlStoreLayer, ControlStore, type ControlStoreService } from "./control-store";
import { Coordination } from "./coordination";
import { makeControlStoreCoordination } from "./coordination-control-store";
import { recoverCrashedRuns } from "./crash-recovery";
import type { CredentialStore } from "./credential-store";
import { DaemonEventBus, layer as daemonEventBusLayer, runActivityStream } from "./daemon-event-bus";
import {
  controlStoreWithDiagnostics,
  DaemonEventPublisher,
  layer as eventPublisherLayer,
  readyToMergeEvents,
} from "./event-publisher";
import type { Git } from "./git";
import * as GitHub from "./github";
import { makeGranolaSource, makeGranolaSourceAdapters } from "./granola-source";
import * as Harness from "./harness";
import { HarnessReadinessCache, layer as harnessReadinessLayer } from "./harness-readiness";
import { IssueTracker } from "./issue-tracker";
import { routedLayer as issueTrackerRoutedLayer } from "./issue-tracker-router";
import * as Linear from "./linear";
import * as McpSkill from "./mcp-skill";
import { withParkNotices } from "./park-notice";
import { PerformanceHealthSource } from "./performance-health-source";
import { recordProcessHealth, reportDaemonProcessHealth } from "./performance-metrics";
import {
  PerformanceRegressionSensor,
  layer as performanceRegressionSensorLayer,
} from "./performance-regression-sensor";
import { PluginManager, pluginManagerLayer } from "./plugin";
import type { RegistryState } from "./projector";
import { schedulerStatsOf, workspaceInfoOf, workspaceStatesOf } from "./read-model";
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
import { make as makeSlackSource, httpClientLayer as slackClientLayer } from "./slack-source";
import { layer as slackWriteLayer } from "./slack-write";
import { SourceControlProvider } from "./source-control";
import { makeTrackerTriggerSource } from "./tracker-trigger-source";
import {
  controlStoreTriggerObservationStoreLayer,
  TriggerObservation,
  type TriggerObservationStore,
  layer as triggerObservationLayer,
} from "./trigger-observation";
import { combineTriggerSources, TriggerSources } from "./trigger-source";
import { Workflows, layer as workflowsLayer } from "./workflow";
import { controlStoreLayer as workflowActionPlanStoreLayer } from "./workflow-action-plan-store";
import {
  WorkflowArtifactStore,
  controlStoreLayer as workflowArtifactStoreLayer,
} from "./workflow-artifact-store";
import { WorkflowAttention, layer as workflowAttentionLayer } from "./workflow-attention";
import { workflowCatalogContributionsLayer } from "./workflow-catalog";
import { layer as machineReadinessLayer } from "./workflow-machine-readiness";
import { WorkflowNotifications, layer as workflowNotificationsLayer } from "./workflow-notification";
import { WorkflowRun, layer as workflowRunLayer } from "./workflow-run";
import type { WorktreeManager } from "./worktree";
import { maintainWorktrees } from "./worktree-maintenance";

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
  const scheduler = yield* Scheduler;
  const controlStore = yield* ControlStore;
  const plugins = yield* PluginManager;
  const connections = yield* ConnectionStore;
  const harnesses = yield* HarnessReadinessCache;
  const workflows = yield* Workflows;
  const ledger = yield* RunLedger;
  const emittedAtMillis = yield* Clock.currentTimeMillis;
  const config = yield* scheduler.config;
  const stats = yield* scheduler.stats;
  const running = yield* ledger.runningRuns;
  const registry = yield* (yield* WorkspaceRegistry).state;
  const readyToMerge = yield* (yield* DaemonEventPublisher).readyToMerge;
  const workspaces = workspaceStatesOf(registry, readyToMerge).map(
    (workspace) => ({ _tag: "WorkspaceChanged", workspace }) as const,
  );
  const items = readyToMergeEvents(readyToMerge);
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
    ...workspaces,
    ...items,
    ...runs,
    ...controlStoreEvents,
    ...pluginEvents,
    ...connectionEvents,
    ...workflowEvents,
    harnessEvent,
    scheduling,
  ].map((event) => ({ ...event, emittedAtMillis }));
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

export const handlersLayer = DaemonRpcs.toLayer({
  GetStatus: Effect.fn("Daemon.GetStatus")(function* () {
    const info = yield* DaemonInfo;
    const scheduler = yield* Scheduler;
    const config = yield* scheduler.config;
    const stats = yield* scheduler.stats;
    const now = yield* Clock.currentTimeMillis;
    const bus = yield* DaemonEventBus;
    const controlStore = yield* ControlStore;
    const triggerObservation = yield* TriggerObservation;
    const registry = yield* (yield* WorkspaceRegistry).state;
    const readyToMerge = yield* (yield* DaemonEventPublisher).readyToMerge;
    return {
      health: controlStore.health === "available" ? "running" : "store-unavailable",
      startedAtMillis: info.startedAtMillis,
      uptimeMillis: now - info.startedAtMillis,
      eventBusDroppedEvents: yield* bus.droppedEvents,
      scheduler: schedulerStatsOf(registry, config, stats),
      sources: yield* triggerObservation.health,
      workspaces: registry.workspaces.map((workspace) =>
        workspaceInfoOf(workspace, readyToMerge.get(workspace.config.name)),
      ),
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
  ListWorkflowAttention: () => Effect.flatMap(WorkflowAttention, ({ list }) => list),
  GetWorkflow: (payload) => Effect.flatMap(Workflows, ({ get }) => get(payload)),
  ValidateWorkflow: (payload) => Effect.flatMap(Workflows, ({ validate }) => validate(payload)),
  GetWorkflowCatalog: () => Effect.flatMap(Workflows, ({ catalog }) => catalog),
  GetWorkflowTemplates: () => Effect.flatMap(Workflows, ({ templates }) => templates),
  ListWorkflowOptions: (payload) => Effect.flatMap(Workflows, ({ listOptions }) => listOptions(payload)),
  CancelRun: cancelRun,
  ApproveWorkflowPlan: (payload) => Effect.flatMap(WorkflowRun, ({ approve }) => approve(payload)),
  RejectWorkflowPlan: (payload) => Effect.flatMap(WorkflowRun, ({ reject }) => reject(payload)),
  ChooseWorkflowAnswer: (payload) => Effect.flatMap(WorkflowRun, ({ chooseAnswer }) => chooseAnswer(payload)),
  DismissWorkflowNotification: (payload) =>
    Effect.flatMap(WorkflowNotifications, ({ dismiss }) => dismiss(payload.id)).pipe(Effect.orDie),
  HandBack: handBack,
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
  LoginSlack: loginSlack,
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
  readonly slackLogin?: Layer.Layer<never, E, R | Crypto.Crypto | HttpClient.HttpClient>;
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
  readonly triggerObservationStore?: Layer.Layer<TriggerObservationStore, E, R>;
}

const providerTriggerSourcesLayer = <E, R>(
  dependencies: Layer.Layer<
    IssueTracker | SourceControlProvider | WorkspaceRegistry | WorkflowArtifactStore,
    E,
    R
  >,
) =>
  Layer.effect(
    TriggerSources,
    Effect.all([IssueTracker, SourceControlProvider, WorkspaceRegistry, WorkflowArtifactStore]).pipe(
      Effect.map(([tracker, provider, registry, artifacts]) => {
        const sources = [
          makeTrackerTriggerSource("github", tracker, registry.state, artifacts),
          ...(tracker.triggerSources ?? []),
          ...(provider.triggerSources ?? []),
        ];
        return combineTriggerSources([...sources, makeClockSource(sources)]);
      }),
    ),
  ).pipe(Layer.provide(dependencies));

function engineLayer<E, R>(adapters: HostAdapters<E, R>) {
  // The credential store is stateful — its refresh gate and its minted-token cache only coordinate
  // within one instance — so the issue-tracker reads and the MCP-skill bearer must draw from the same
  // one, or they would mint and rotate the app-actor token independently.
  const credentials = adapters.credentials;
  const controlStore = bootControlStoreLayer(adapters.controlStorePath);
  const workflowArtifacts = workflowArtifactStoreLayer.pipe(Layer.provide(controlStore));
  // One GitHub client, built once: the issue tracker and the establish-time credential check must
  // share it, or the second instance resolves its own credentials and drifts from the first.
  const githubClient = GitHub.clientLayer.pipe(Layer.provide(credentials));
  const issueTrackerAdapters = Layer.mergeAll(issueTrackerRoutedLayer, GitHub.providerLayer).pipe(
    Layer.provide(githubClient),
    Layer.provide(Linear.clientLayer),
    Layer.provide(credentials),
    Layer.provide(workflowArtifacts),
  );
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
  const issueTracker = issueTrackerAdapters.pipe(Layer.provide(registry));
  const providerTriggerSources = providerTriggerSourcesLayer(
    Layer.mergeAll(issueTracker, registry, workflowArtifacts),
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
    Layer.provide(Layer.mergeAll(controlStore, registry, connections, harnessReadiness, plugins)),
  );
  const coordination = Layer.effect(Coordination, withParkNotices(makeControlStoreCoordination)).pipe(
    Layer.provide(Layer.mergeAll(controlStore, issueTracker, registry)),
  );
  const workflowActionPlans = workflowActionPlanStoreLayer.pipe(Layer.provide(controlStore));
  const triggerSources: Layer.Layer<
    TriggerSources,
    E | PlatformError | SqlError,
    R | Crypto.Crypto | FileSystem.FileSystem | Git | HttpClient.HttpClient | Path.Path
  > = Layer.effect(
    TriggerSources,
    Effect.gen(function* () {
      const sources = yield* TriggerSources;
      const connectionStore = yield* ConnectionStore;
      const coordinationService = yield* Coordination;
      const http = yield* HttpClient.HttpClient;
      const slackSource = yield* makeSlackSource;
      return combineTriggerSources([
        ...sources,
        makeGranolaSource(connectionStore, makeGranolaSourceAdapters(http), coordinationService),
        slackSource,
      ]);
    }),
  ).pipe(Layer.provide(Layer.mergeAll(providerTriggerSources, connections, coordination, slackClientLayer)));
  const workflows = workflowsLayer.pipe(
    Layer.provide(
      workflowCatalogContributionsLayer.pipe(Layer.provide(Layer.merge(triggerSources, issueTracker))),
    ),
    Layer.provide(machineReadiness),
    Layer.provide(Layer.mergeAll(controlStore, daemonEventBusLayer, harness)),
  );
  const triggerObservationStore =
    adapters.triggerObservationStore ??
    controlStoreTriggerObservationStoreLayer.pipe(Layer.provide(controlStore));
  const workflowNotifications = workflowNotificationsLayer.pipe(
    Layer.provide(Layer.merge(runLedger, runRecorder)),
  );
  const slackWrite = slackWriteLayer.pipe(Layer.provide(slackClientLayer), Layer.provide(connections));
  const triggerObservation = triggerObservationLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workflows,
        coordination,
        triggerSources,
        triggerObservationStore,
        daemonEventBusLayer,
        issueTracker,
        registry,
      ),
    ),
  );
  const workflowRun = workflowRunLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workflows,
        coordination,
        harnessRuntime,
        issueTracker,
        registry,
        runLedger,
        runRecorder,
        workflowActionPlans,
        workflowArtifacts,
        workflowNotifications,
        slackWrite,
        triggerObservationStore,
        triggerObservation,
        adapters.worktrees,
      ),
    ),
  );
  const workflowAttention = workflowAttentionLayer.pipe(
    Layer.provide(Layer.mergeAll(workflows, coordination, triggerObservationStore, workflowActionPlans)),
  );
  const base = Layer.mergeAll(
    registry,
    plugins,
    connections,
    githubClient,
    ...(adapters.granolaLogin ? [adapters.granolaLogin] : []),
    ...(adapters.slackLogin ? [adapters.slackLogin] : []),
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
    workflowActionPlans,
    workflowArtifacts,
    workflowRun,
    workflowAttention,
    McpSkill.layer.pipe(Layer.provide(credentials)),
    runControlLayer,
    adapters.worktrees,
  );
  return eventPublisherLayer.pipe(
    Layer.provideMerge(
      performanceRegressionSensorLayer({
        appVersion: adapters.appVersion,
        evidenceRoot: adapters.performanceEvidenceRoot,
      }).pipe(
        Layer.provideMerge(
          Layer.unwrap(
            Effect.map(ControlStore, (store) =>
              schedulerLayer(
                configFromControlStore(store.health === "available" ? store.seed : defaultControlStore),
              ),
            ),
          ).pipe(Layer.provideMerge(base)),
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

const continueAfterHeartbeatFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
  Effect.catchCauseIf(
    effect,
    (cause) => !Cause.hasInterruptsOnly(cause),
    (cause) => Effect.logError(message, { cause }),
  );

const executeTick = Effect.fn("Daemon.executeHeartbeat")(function* () {
  const scheduler = yield* Scheduler;
  const publisher = yield* DaemonEventPublisher;
  yield* scheduler.tick();
  yield* publisher.publishScheduler();
});

const executeHeartbeat = () => executeTick().pipe(Effect.repeat(Schedule.spaced("5 seconds")));

const maintenanceTick = Effect.fn("Daemon.maintenanceHeartbeat")(function* () {
  const publisher = yield* DaemonEventPublisher;
  yield* publisher.publishWorkspaces();
  yield* maintainWorktrees();
});

const maintenanceHeartbeat = (pollIntervalMillis: number) =>
  continueAfterHeartbeatFailure(maintenanceTick(), "maintenance heartbeat failed").pipe(
    Effect.repeat(Schedule.spaced(pollIntervalMillis)),
  );

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
  continueAfterHeartbeatFailure(recoverCrashedRuns(), "crashed Run recovery failed").pipe(
    Effect.andThen(
      Effect.all([maintenanceHeartbeat(options.pollIntervalMillis), executeHeartbeat()], {
        concurrency: "unbounded",
      }),
    ),
    Effect.onInterrupt(() => Effect.flatMap(Scheduler, (scheduler) => scheduler.drain(options.drain))),
  );

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
