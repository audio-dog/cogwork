import {
  applyOperationSettingBatch,
  type CancelRunError,
  ClassifiedItem,
  Connection,
  type ConnectionEstablishment,
  ContributionSettingUpdate,
  ControlStoreFailure,
  type ControlStore as ControlStorePicture,
  connectionIdOf,
  DaemonEvent,
  type DaemonLimitUpdate,
  DaemonRpcs,
  type HarnessModelOptionDescriptor,
  HarnessName,
  IssueTrackerError,
  type LocalContribution,
  localOwnerId,
  type ModelOptionSelections,
  OperationSettingUpdate,
  type PluginItem,
  type PluginOverview,
  Principal,
  RunId,
  type RunRecord,
  type RunStatus,
  resolveOperationSetting,
  type SettingLevel,
  type TriageRole,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
  WorkspaceRegistration,
  WorkspaceState,
  WorkspaceUpdate,
} from "@cogwork/contracts";

import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import {
  deregisterWorkspace as deregisterWorkspaceCommand,
  establishConnection as establishConnectionCommand,
  removeConnection as removeConnectionCommand,
  setContributionSetting as setContributionSettingCommand,
  uninstallPlugin as uninstallPluginCommand,
  updateWorkspace as updateWorkspaceCommand,
} from "./commands";
import { ConnectionStore, type ConnectionStoreService } from "./connection";
import { ControlStore, type ControlStoreService } from "./control-store";
import * as Daemon from "./daemon";
import * as DaemonEventBus from "./daemon-event-bus";
import { DaemonEventPublisher, layer as eventPublisherLayer } from "./event-publisher";
import { fullHarnessExecution, type HarnessRunner } from "./harness";
import { layer as harnessReadinessLayer } from "./harness-readiness";
import type { HandBackOutcome, HandOffOutcome, ReclassifyOutcome, TrackerItem } from "./issue-tracker";
import * as IssueTracker from "./issue-tracker";
import { PluginManager } from "./plugin";
import * as Reconcile from "./reconcile";
import * as Registry from "./registry";
import * as RunControl from "./run-control";
import * as RunLedger from "./run-ledger";
import * as Scheduler from "./scheduler";
import { type PrSignals, SourceControlProvider } from "./source-control";
import { engineTestLayer } from "./testing/engine-test-layer";
import { harnessProbeTestLayer } from "./testing/harness-probe-layer";

const id = Schema.decodeSync(WorkItemId);
const rid = Schema.decodeSync(RunId);
const wsid = Schema.decodeSync(WorkspaceId);
const harness = Schema.decodeSync(HarnessName);

const assertAlreadyFinishedCancelError = (error: CancelRunError, status: RunStatus) => {
  assert.strictEqual(error._tag, "CancelRunError");
  assert.strictEqual(error.reason, "already-finished");
  assert.strictEqual(error.status, status);
};
const effortOption: HarnessModelOptionDescriptor = {
  type: "select",
  id: "effort",
  label: "Effort",
  values: [{ value: "high", label: "High" }],
  defaultValue: "high",
};
const commandHarnessRunner: HarnessRunner = {
  name: harness("cursor"),
  sessionKind: "opaque-handle",
  projectedMembers: [],
  planMiddleware: [],
  execution: { ...fullHarnessExecution, profiles: ["full"] },
  capabilities: {
    authenticationModes: ["host"],
    session: { affinity: "runtime-host", fork: false, humanAttach: false },
    structuredOutput: "none",
    policyFidelity: "exact",
    fileEventFidelity: "absent",
    usageQuality: "none",
    readinessDiagnostics: false,
    journal: false,
    takeover: false,
  },
  authentication: { mode: "host", reference: "test" },
  catalog: {
    models: [
      {
        value: "test",
        label: "Test",
        options: [effortOption],
      },
      { value: "test-next", label: "Test next", options: [effortOption] },
    ],
  },
  readiness: () =>
    Effect.succeed({
      operational: { status: "ready", retryable: false, diagnostic: "ready" },
      installation: { status: "installed", version: "test" },
      compatibility: { status: "compatible", requirement: null },
      authentication: { mode: "host", status: "available", diagnostic: "available" },
      diagnostics: [],
    }),
  preflight: () => Effect.void,
  run: () => Stream.die("unused"),
};
const alternateHarnessRunner = {
  ...commandHarnessRunner,
  name: harness("codex"),
  catalog: {
    models: [
      {
        value: "codex-model",
        label: "Codex model",
        options: [effortOption],
      },
    ],
  },
} satisfies HarnessRunner;
const reconcileStubLayer = Layer.succeed(Reconcile.ReconcileWorker, {
  submit: () => Effect.succeed({ workspaces: 0, failures: 0, pendingWork: 0, paused: 0 }),
  submitAfterCurrent: () => Effect.succeed({ workspaces: 0, failures: 0, pendingWork: 0, paused: 0 }),
  snapshot: Effect.succeed({ generation: 0, observedAtMillis: 0, workspaces: [] }),
  invalidateAvailability: () => Effect.void,
});
const interruptionGate = Latch.makeUnsafe();
const acmeRegistration = Schema.decodeSync(WorkspaceRegistration)({
  name: "acme",
  checkoutPath: "/repos/acme",
  issueTracker: { type: "github", connectionId: "github/acme" },
  linearHistory: false,
  concurrency: 2,
});
const acmeUpdate = Schema.decodeSync(WorkspaceUpdate)({
  name: "renamed acme",
  issueTracker: { type: "github", connectionId: "github/acme" },
  linearHistory: true,
  concurrency: 4,
});
const unboundRegistration = Schema.decodeSync(WorkspaceRegistration)({
  name: "unbound",
  checkoutPath: "/repos/unbound",
  issueTracker: { type: "github" },
  sourceControl: { type: "github" },
});
const mismatchedRegistration = Schema.decodeSync(WorkspaceRegistration)({
  name: "mismatch",
  checkoutPath: "/repos/mismatch",
  issueTracker: {
    type: "linear",
    connectionId: "github/acme",
    teams: ["ENG"],
  },
});

const registered: Registry.RegisteredWorkspace = {
  source: "control-store:example",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "example",
    checkoutPath: "/repos/example",
    issueTracker: { type: "linear" },
  }),
};

const registryLayer = Layer.succeed(
  Registry.WorkspaceRegistry,
  Registry.readOnlyRegistry({ workspaces: [registered], failures: [] }),
);
const registryServices = Layer.mergeAll(registryLayer, Registry.managementReadOnlyLayer);
const failedWorkspaceRegistryServices = Layer.mergeAll(
  Layer.succeed(
    Registry.WorkspaceRegistry,
    Registry.readOnlyRegistry({
      workspaces: [],
      failures: [
        {
          name: wsid("example"),
          source: "/repos/example",
          message: "invalid Workspace input",
          issueTracker: registered.config.issueTracker,
        },
      ],
    }),
  ),
  Registry.managementReadOnlyLayer,
);

const stubConfig: Scheduler.SchedulerConfig = { globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 50 };

const schedulerStub = () =>
  Layer.effect(
    Scheduler.Scheduler,
    Effect.gen(function* () {
      const configRef = yield* Ref.make(stubConfig);
      const stateRef = yield* Ref.make(Scheduler.initialState);
      return {
        tick: () => Effect.succeed(0),
        awaitIdle: Effect.void,
        drain: () => Effect.succeed({ inFlight: 0, interrupted: 0 }),
        admit: () => Effect.void,
        isInFlight: () => Effect.succeed(false),
        setScheduling: (desired) =>
          Ref.updateAndGet(stateRef, (state) => ({ ...state, paused: desired === "paused" })),
        setLimit: (update: DaemonLimitUpdate) =>
          Ref.updateAndGet(configRef, (current) => ({
            globalLimit: update.key === "global-concurrency" ? update.value : current.globalLimit,
            perWorkspaceLimit:
              update.key === "per-workspace-concurrency" ? update.value : current.perWorkspaceLimit,
            dailyBudget: update.key === "daily-budget" ? update.value : current.dailyBudget,
          })),
        config: Ref.get(configRef),
        stats: Ref.get(stateRef),
      };
    }),
  );

interface TrackerCalls {
  readonly handBack: ReadonlyArray<{ readonly workItem: WorkItemId; readonly outcome: HandBackOutcome }>;
  readonly reclassify: ReadonlyArray<{ readonly workItem: WorkItemId; readonly outcome: ReclassifyOutcome }>;
  readonly handOff: ReadonlyArray<{ readonly workItem: WorkItemId; readonly outcome: HandOffOutcome }>;
  readonly released: ReadonlyArray<WorkItemId>;
}

const emptyCalls: TrackerCalls = { handBack: [], reclassify: [], handOff: [], released: [] };

const providerStub = Layer.succeed(SourceControlProvider, {
  observe: () => Effect.succeed(new Map<WorkItemId, PrSignals>()),
  comment: () => Effect.void,
  findOpenPullRequest: () => Effect.succeed(null),
  openPullRequest: () => Effect.succeed({ number: 1, url: "https://example.test/pull/1" }),
});

const trackerStub = (service: Partial<IssueTracker.IssueTrackerService>) =>
  ({
    rateLimitScope: () => null,
    observe: () => Effect.succeed([]),
    claim: () => Effect.void,
    release: () => Effect.void,
    note: () => Effect.void,
    triaged: () => Effect.void,
    implemented: () => Effect.void,
    followedUp: () => Effect.void,
    attemptFailed: () => Effect.void,
    handOff: () => Effect.void,
    handBack: () => Effect.void,
    stalled: () => Effect.void,
    reclassify: () => Effect.void,
    ...service,
  }) satisfies IssueTracker.IssueTrackerService;

const trackerLayer = (
  service: Partial<IssueTracker.IssueTrackerService>,
): Layer.Layer<IssueTracker.IssueTracker | SourceControlProvider> =>
  Layer.mergeAll(Layer.succeed(IssueTracker.IssueTracker, trackerStub(service)), providerStub);

interface WorkspaceRefreshProbeService {
  readonly reconciles: Ref.Ref<number>;
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

class WorkspaceRefreshProbe extends Context.Service<WorkspaceRefreshProbe, WorkspaceRefreshProbeService>()(
  "@cogwork/engine/commands.test/WorkspaceRefreshProbe",
) {
  static readonly layer = Layer.effect(
    WorkspaceRefreshProbe,
    Effect.all({
      reconciles: Ref.make(0),
      started: Deferred.make<void>(),
      release: Deferred.make<void>(),
    }),
  );
  static readonly trackerLayer = Layer.effect(
    IssueTracker.IssueTracker,
    Effect.gen(function* () {
      const probe = yield* WorkspaceRefreshProbe;
      return trackerStub({
        observe: () =>
          Ref.update(probe.reconciles, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(probe.started, undefined)),
            Effect.andThen(Deferred.await(probe.release)),
            Effect.map(() => [trackerItem({ claimLabeled: false, claimedByUs: false })]),
          ),
      });
    }),
  ).pipe(Layer.provideMerge(WorkspaceRefreshProbe.layer), Layer.merge(providerStub));
}

interface WorkspaceUpdatePublicationProbeService {
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  readonly refreshes: Ref.Ref<number>;
}

class WorkspaceUpdatePublicationProbe extends Context.Service<
  WorkspaceUpdatePublicationProbe,
  WorkspaceUpdatePublicationProbeService
>()("@cogwork/engine/commands.test/WorkspaceUpdatePublicationProbe") {
  static readonly layer = Layer.effect(
    WorkspaceUpdatePublicationProbe,
    Effect.all({
      started: Deferred.make<void>(),
      release: Deferred.make<void>(),
      refreshes: Ref.make(0),
    }),
  );
  static readonly publisherLayer = Layer.effect(
    DaemonEventPublisher,
    Effect.map(WorkspaceUpdatePublicationProbe, (probe) => {
      const holdPublication = <A>(value: A) =>
        Deferred.succeed(probe.started, undefined).pipe(
          Effect.andThen(Deferred.await(probe.release)),
          Effect.map(() => value),
        );
      return {
        publishItems: () => Effect.void,
        publishWorkspaces: () => holdPublication([]),
        publishWorkspaceRemoved: Effect.succeed,
        publishScheduler: () =>
          Effect.succeed({
            scheduling: "running" as const,
            globalInFlight: 0,
            globalLimit: 4,
            perWorkspaceLimit: 4,
            dailyBudgetUsed: 0,
            dailyBudgetLimit: 50,
            perWorkspace: [],
          }),
        publishControlStore: holdPublication,
        publishPlugins: (plugins) => holdPublication(plugins),
        publishConnections: (connections) => holdPublication(connections),
        requestSnapshotRefresh: () => Ref.update(probe.refreshes, (count) => count + 1),
      };
    }),
  ).pipe(Layer.provideMerge(WorkspaceUpdatePublicationProbe.layer));
}

const recordingTracker = (items: ReadonlyArray<TrackerItem>, calls: Ref.Ref<TrackerCalls>) =>
  trackerLayer({
    observe: () => Effect.succeed(items),
    reclassify: (_workspace, workItem, outcome) =>
      Ref.update(calls, (c) => ({ ...c, reclassify: [...c.reclassify, { workItem, outcome }] })),
    handOff: (_workspace, workItem, outcome) =>
      Ref.update(calls, (c) => ({ ...c, handOff: [...c.handOff, { workItem, outcome }] })),
    handBack: (_workspace, workItem, outcome) =>
      Ref.update(calls, (c) => ({ ...c, handBack: [...c.handBack, { workItem, outcome }] })),
    release: (_workspace, workItem) =>
      Ref.update(calls, (c) => ({ ...c, released: [...c.released, workItem] })),
  });

const engineServices = engineTestLayer();
const pluginManagerLayer = Layer.succeed(PluginManager, {
  overview: Effect.succeed({ plugins: [] }),
  install: () => Effect.die(new Error("unexpected Plugin install")),
  uninstall: () => Effect.die(new Error("unexpected Plugin uninstall")),
  contributions: () => Effect.succeed([]),
});
interface ConnectionStoreStubOptions {
  readonly status: "established" | "revoked";
  readonly existing?: Connection | null;
  readonly remove?: ConnectionStoreService["remove"];
  readonly establish?: ConnectionStoreService["establish"];
}

const connectionStoreStub = ({
  status,
  existing = null,
  remove = () => Effect.die("unexpected Connection remove"),
  establish = () => Effect.die("unexpected Connection establish"),
}: ConnectionStoreStubOptions) =>
  ({
    overview: Effect.succeed({ connections: [] }),
    find: (connectionId) =>
      Effect.succeed(
        Connection.make({
          id: connectionId,
          system: connectionId.startsWith("linear/") ? "linear" : "github",
          account: "test",
          status,
        }),
      ),
    findSystem: () => Effect.succeed(existing),
    bearer: () => Effect.die("unexpected Connection bearer"),
    readiness: () => Effect.succeed({ _tag: "Ready" }),
    requireReady: () => Effect.void,
    requireSystemReady: () => Effect.void,
    establish,
    revoke: () => Effect.die("unexpected Connection revoke"),
    remove,
  }) satisfies ConnectionStoreService;

const connectionStoreStubLayer = (options: ConnectionStoreStubOptions) =>
  Layer.succeed(ConnectionStore, connectionStoreStub(options));

const connectionStoreLayer = connectionStoreStubLayer({ status: "established" });

interface ConnectionPluginInstallProbeService {
  readonly installStarted: Deferred.Deferred<void>;
  readonly removed: Ref.Ref<ReadonlyArray<Connection["id"]>>;
}

class ConnectionPluginInstallProbe extends Context.Service<
  ConnectionPluginInstallProbe,
  ConnectionPluginInstallProbeService
>()("@cogwork/engine/commands.test/ConnectionPluginInstallProbe") {
  static readonly layer = Layer.effect(
    ConnectionPluginInstallProbe,
    Effect.all({
      installStarted: Deferred.make<void>(),
      removed: Ref.make<ReadonlyArray<Connection["id"]>>([]),
    }),
  );
}

const installedPlugin = (pluginId: string) =>
  ({
    pluginId,
    name: pluginId,
    summary: `${pluginId} tools`,
    record: {
      pluginId,
      resolvedIdentity: `${pluginId}@1.0.0`,
      principal: localOwnerId,
      installedAtMillis: 1,
    },
    resolvedIdentity: `${pluginId}@1.0.0`,
    requiredConnections: [],
    contributions: [],
    manifestFailure: null,
  }) satisfies PluginItem;

const concurrentPluginManagerLayer = (
  firstReady: Deferred.Deferred<void>,
  releaseFirst: Deferred.Deferred<void>,
) =>
  Layer.effect(
    PluginManager,
    Effect.gen(function* () {
      const current = yield* Ref.make<PluginOverview>({ plugins: [] });
      const calls = yield* Ref.make(0);
      return {
        overview: Ref.get(current),
        install: Effect.fn("test.concurrentPluginInstall")(function* (pluginId) {
          const call = yield* Ref.getAndUpdate(calls, (count) => count + 1);
          const overview = {
            plugins:
              call === 0
                ? [installedPlugin(pluginId)]
                : [installedPlugin("github"), installedPlugin(pluginId)],
          } satisfies PluginOverview;
          yield* Ref.set(current, overview);
          if (call > 0) return { overview, notices: [`${pluginId} notice`] };
          yield* Deferred.succeed(firstReady, undefined);
          yield* Deferred.await(releaseFirst);
          return { overview, notices: [`${pluginId} notice`] };
        }),
        uninstall: () => Effect.die(new Error("unexpected Plugin uninstall")),
        contributions: () => Effect.succeed([]),
      };
    }),
  );

const picture: ControlStorePicture = {
  daemonLimits: {
    globalConcurrency: 4,
    perWorkspaceConcurrency: 4,
    dailyBudget: 50,
    revision: 0,
  },
  operationSettings: [],
  connections: [],
  pluginInstalls: [],
  contributionSettings: [],
  harnessSettings: [],
};

interface ControlStoreStubOptions {
  readonly seed?: ControlStorePicture;
  readonly read?: Effect.Effect<ControlStorePicture, ControlStoreFailure>;
  readonly setDaemonLimit?: ControlStoreService["setDaemonLimit"];
  readonly updateContributionSetting?: ControlStoreService["updateContributionSetting"];
  readonly updateOperationSettings?: ControlStoreService["updateOperationSettings"];
  readonly setHarnessEnabled?: ControlStoreService["setHarnessEnabled"];
}

const controlStoreStub = ({
  seed = picture,
  read = Effect.succeed(seed),
  setDaemonLimit = (update) =>
    Effect.succeed({
      daemonLimits: {
        globalConcurrency:
          update.key === "global-concurrency" ? update.value : picture.daemonLimits.globalConcurrency,
        perWorkspaceConcurrency:
          update.key === "per-workspace-concurrency"
            ? update.value
            : picture.daemonLimits.perWorkspaceConcurrency,
        dailyBudget: update.key === "daily-budget" ? update.value : picture.daemonLimits.dailyBudget,
        revision: picture.daemonLimits.revision + 1,
      },
      operationSettings: picture.operationSettings,
      connections: picture.connections,
      pluginInstalls: picture.pluginInstalls,
      contributionSettings: picture.contributionSettings,
      harnessSettings: picture.harnessSettings,
    }),
  updateOperationSettings = (updates) =>
    Effect.succeed({
      ...picture,
      operationSettings: updates.flatMap((update) =>
        OperationSettingUpdate.match(update, {
          Set: ({ row }) => [row],
          Clear: () => [],
        }),
      ),
    }),
  updateContributionSetting = (update) =>
    Effect.succeed({
      ...picture,
      contributionSettings: ContributionSettingUpdate.match(update, {
        Set: ({ row }) => [row],
        Clear: () => [],
      }),
    }),
  setHarnessEnabled = (harness, enabled) =>
    Effect.succeed({ ...picture, harnessSettings: [{ harness, enabled }] }),
}: ControlStoreStubOptions = {}) =>
  Layer.succeed(ControlStore, {
    health: "available",
    seed,
    picture: read,
    setDaemonLimit,
    establishConnection: () => Effect.succeed(picture),
    revokeConnection: () => Effect.succeed(picture),
    removeConnection: () => Effect.succeed(picture),
    setHarnessEnabled,
    updateOperationSettings,
    installPlugin: () => Effect.succeed(picture),
    uninstallPlugin: () => Effect.succeed(picture),
    updateContributionSetting,
    withWrite: (effect) => effect,
  });

const daemonLayer = <SourceExtra = never>(
  source: Layer.Layer<IssueTracker.IssueTracker | SourceControlProvider | SourceExtra>,
  scheduler = schedulerStub(),
  controlStore = controlStoreStub(),
  registries = registryServices,
  plugins: Layer.Layer<PluginManager> = pluginManagerLayer,
  connections = connectionStoreLayer,
  runControl: Layer.Layer<RunControl.RunControl> = RunControl.layer,
  harnessRunners: ReadonlyArray<HarnessRunner> = [],
  reconcile = Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(registries, source))),
) =>
  Daemon.handlersLayer.pipe(
    Layer.provideMerge(harnessReadinessLayer),
    Layer.provideMerge(harnessProbeTestLayer(harnessRunners)),
    Layer.provideMerge(Daemon.principalMiddlewareLayer),
    Layer.provideMerge(Daemon.daemonInfoLayer),
    Layer.provideMerge(eventPublisherLayer),
    Layer.provideMerge(reconcile),
    Layer.provideMerge(registries),
    Layer.provideMerge(scheduler),
    Layer.provideMerge(engineServices),
    Layer.provideMerge(runControl),
    Layer.provideMerge(controlStore),
    Layer.provideMerge(connections),
    Layer.provideMerge(plugins),
    Layer.provideMerge(source),
  );

const daemonLayerWithHarness = (
  source: Layer.Layer<IssueTracker.IssueTracker | SourceControlProvider>,
  controlStore = controlStoreStub(),
  harnessRunners: ReadonlyArray<HarnessRunner> = [commandHarnessRunner],
) =>
  daemonLayer(
    source,
    schedulerStub(),
    controlStore,
    registryServices,
    pluginManagerLayer,
    connectionStoreLayer,
    RunControl.layer,
    harnessRunners,
    reconcileStubLayer,
  );

const registrationServices = (
  contributions: readonly LocalContribution[] = [],
  afterUpdateWrite: Effect.Effect<void> = Effect.void,
) => {
  const cell = Ref.makeUnsafe<Registry.RegistryState>(Registry.emptyRegistry);
  const registry: Registry.WorkspaceRegistryService = {
    state: Ref.get(cell),
    refresh: Ref.get(cell),
  };
  const register: Registry.WorkspaceManagementService["register"] = Effect.fn("test.register")(
    function* (registration) {
      const workspace: Registry.RegisteredWorkspace = {
        source: "control-store:minted",
        contributions,
        record: registration,
        config: {
          name: wsid("0198f16a-21d7-7000-8000-000000000001"),
          displayName: registration.name,
          checkoutPath: registration.checkoutPath,
          issueTracker: registration.issueTracker,
          sourceControl: registration.sourceControl,
          linearHistory: registration.linearHistory,
        },
        workspaceLimit: registration.concurrency,
      };
      yield* Ref.update(cell, (state) => ({ ...state, workspaces: [...state.workspaces, workspace] }));
      return { _tag: "Registered" as const, workspace };
    },
  );
  const deregister: Registry.WorkspaceManagementService["deregister"] = Effect.fn("test.deregister")(
    function* (workspace) {
      yield* Ref.update(cell, (state) => ({
        workspaces: state.workspaces.filter((entry) => entry.config.name !== workspace),
        failures: state.failures.filter((entry) => entry.name !== workspace),
      }));
      return workspace;
    },
  );
  const update: Registry.WorkspaceManagementService["update"] = Effect.fn("test.update")(
    function* (workspace, update) {
      const current = (yield* Ref.get(cell)).workspaces.find((entry) => entry.config.name === workspace);
      if (!current) return yield* Effect.die("workspace not found");
      const changed: Registry.RegisteredWorkspace = {
        ...current,
        record: { ...update, checkoutPath: current.config.checkoutPath },
        config: {
          name: current.config.name,
          displayName: update.name,
          checkoutPath: current.config.checkoutPath,
          issueTracker: update.issueTracker,
          sourceControl: update.sourceControl,
          mcpSkills: update.mcpSkills,
          worktrees: update.worktrees,
          linearHistory: update.linearHistory,
        },
        workspaceLimit: update.concurrency,
      };
      yield* afterUpdateWrite;
      yield* Ref.update(cell, (state) => ({
        ...state,
        workspaces: state.workspaces.map((entry) => (entry.config.name === workspace ? changed : entry)),
      }));
      return { _tag: "Registered" as const, workspace: changed };
    },
  );
  const rebind: Registry.WorkspaceManagementService["rebind"] = Effect.fn("test.rebind")(
    function* (workspace, checkoutPath) {
      const current = (yield* Ref.get(cell)).workspaces.find((entry) => entry.config.name === workspace);
      if (!current) return yield* Effect.die("workspace not found");
      const rebound = { ...current, config: { ...current.config, checkoutPath } };
      yield* Ref.update(cell, (state) => ({
        ...state,
        workspaces: state.workspaces.map((entry) => (entry.config.name === workspace ? rebound : entry)),
      }));
      return { _tag: "Registered" as const, workspace: rebound };
    },
  );
  return Layer.mergeAll(
    Layer.succeed(Registry.WorkspaceRegistry, registry),
    Layer.succeed(Registry.WorkspaceManagement, { register, update, deregister, rebind }),
  );
};

const failedRegistrationServices = () => {
  const failure = { source: "/repos/missing", message: "Workspace input is missing" };
  return Layer.mergeAll(
    Layer.succeed(
      Registry.WorkspaceRegistry,
      Registry.readOnlyRegistry({ workspaces: [], failures: [failure] }),
    ),
    Layer.succeed(Registry.WorkspaceManagement, {
      register: () => Effect.succeed({ _tag: "Failed" as const, failure }),
      update: () => Effect.die("unexpected update"),
      deregister: () => Effect.die("unexpected deregister"),
      rebind: () => Effect.die("unexpected re-bind"),
    }),
  );
};

const runRecord = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: rid("run-1"),
  workspace: wsid("example"),
  workItem: id("AUD-1"),
  stage: "implement",
  harness: harness("cursor"),
  branch: null,
  session: null,
  usage: null,
  status: "running",
  startedAtMillis: 0,
  endedAtMillis: null,
  ...over,
});

const trackerItem = (over: Partial<TrackerItem> = {}): TrackerItem => ({
  id: id("AUD-1"),
  title: "cancel me",
  url: "https://linear.app/acme/issue/AUD-1",
  roles: ["ready-for-agent"],
  assignees: [],
  claimLabeled: true,
  claim: null,
  claimedByUs: true,
  attempts: [],
  handback: null,
  followUp: null,
  openBlockers: 0,
  proposal: null,
  priority: "medium",
  ...over,
});

describe("CancelRun", () => {
  it.effect("settles the run, hands the item off to a human, and releases the claim", () => {
    const calls = Ref.makeUnsafe(emptyCalls);
    return Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord());
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();

      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();

      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const outcome = yield* client.CancelRun({ runId: rid("run-1"), note: "stopping this one" });
      const { item } = outcome;

      assert.strictEqual(outcome._tag, "Cancelled");
      if (!ClassifiedItem.guards.NeedsHuman(item)) assert.fail("expected NeedsHuman item");
      assert.strictEqual(item.reason, "ready-for-human");
      assert.strictEqual(item.url, "https://linear.app/acme/issue/AUD-1");

      const settled = yield* ledger.getRun(rid("run-1"));
      assert.strictEqual(settled?.status, "interrupted");

      const recorded = yield* Ref.get(calls);
      assert.deepStrictEqual(recorded.released, [id("AUD-1")]);
      assert.deepStrictEqual(recorded.handOff, [
        { workItem: id("AUD-1"), outcome: { stage: "implement", note: "stopping this one" } },
      ]);

      const [published] = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(DaemonEvent.guards.ItemChanged),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.strictEqual(published?.item._tag, "NeedsHuman");
    }).pipe(Effect.provide(daemonLayer(recordingTracker([trackerItem()], calls))), Effect.scoped);
  });

  it.effect("fails with a not-found CancelRunError for an unknown run", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(client.CancelRun({ runId: rid("ghost") }));
      assert.strictEqual(error._tag, "CancelRunError");
      assert.strictEqual(error.reason, "not-found");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("fails with an already-finished CancelRunError for a run that is not running", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord({ status: "succeeded", endedAtMillis: 10 }));
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(client.CancelRun({ runId: rid("run-1") }));
      assertAlreadyFinishedCancelError(error, "succeeded");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("releases the claim when a run finishes before interruption", () => {
    const calls = Ref.makeUnsafe(emptyCalls);
    const cancelStarted = Deferred.makeUnsafe<void>();
    const finishCancel = Deferred.makeUnsafe<void>();
    const runControl = Layer.succeed(RunControl.RunControl, {
      run: (_runId, _workspace, effect) => effect,
      cancel: () =>
        Deferred.succeed(cancelStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishCancel)),
          Effect.map(() => RunControl.RunCancellation.NotFound({})),
        ),
    });
    return Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord());
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const cancelling = yield* Effect.forkChild(Effect.flip(client.CancelRun({ runId: rid("run-1") })));
      yield* Deferred.await(cancelStarted);
      yield* ledger.updateRun(rid("run-1"), {
        status: "succeeded",
        usage: null,
        endedAtMillis: 1,
      });
      yield* Deferred.succeed(finishCancel, undefined);

      const error = yield* Fiber.join(cancelling);
      assertAlreadyFinishedCancelError(error, "succeeded");
      assert.deepStrictEqual((yield* Ref.get(calls)).released, [id("AUD-1")]);
    }).pipe(
      Effect.provide(
        daemonLayer(
          recordingTracker([], calls),
          schedulerStub(),
          controlStoreStub(),
          registryServices,
          pluginManagerLayer,
          connectionStoreLayer,
          runControl,
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("keeps the claim while interrupted work is still draining", () => {
    const calls = Ref.makeUnsafe(emptyCalls);
    const claimed = trackerItem({
      claim: { by: "cogwork", claimedAtMillis: 0, stage: "implement" },
    });
    return Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord());
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();

      const started = yield* Deferred.make<void>();
      const finishTeardown = yield* Deferred.make<void>();
      const control = yield* RunControl.RunControl;
      const issueTracker = yield* IssueTracker.IssueTracker;
      const running = yield* Effect.forkChild(
        control.run(
          rid("run-1"),
          registered,
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(interruptionGate.await),
            Effect.ensuring(Deferred.await(finishTeardown)),
          ),
          Effect.ignore(issueTracker.release(registered, id("AUD-1"))),
        ),
      );
      yield* Deferred.await(started);

      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const cancelling = yield* Effect.forkChild(client.CancelRun({ runId: rid("run-1") }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      const outcome = yield* Fiber.join(cancelling);

      assert.strictEqual(outcome._tag, "StillDraining");
      assert.strictEqual(outcome.item._tag, "NeedsHuman");
      assert.strictEqual((yield* ledger.getRun(rid("run-1")))?.status, "interrupted");
      assert.deepStrictEqual((yield* Ref.get(calls)).released, []);
      assert.isUndefined(running.pollUnsafe());

      yield* Deferred.succeed(finishTeardown, undefined);
      yield* Fiber.await(running);
      assert.deepStrictEqual((yield* Ref.get(calls)).released, [id("AUD-1")]);
    }).pipe(Effect.provide(daemonLayer(recordingTracker([claimed], calls))), Effect.scoped);
  });

  it.effect("settles cancellation after the RPC caller disconnects", () => {
    const calls = Ref.makeUnsafe(emptyCalls);
    const claimed = trackerItem({
      claim: { by: "cogwork", claimedAtMillis: 0, stage: "implement" },
    });
    return Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord());
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();

      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const finishTeardown = yield* Deferred.make<void>();
      const control = yield* RunControl.RunControl;
      const issueTracker = yield* IssueTracker.IssueTracker;
      const running = yield* Effect.forkChild(
        control.run(
          rid("run-1"),
          registered,
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(interruptionGate.await),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            Effect.ensuring(Deferred.await(finishTeardown)),
          ),
          Effect.ignore(issueTracker.release(registered, id("AUD-1"))),
        ),
      );
      yield* Deferred.await(started);

      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const cancelling = yield* Effect.forkChild(client.CancelRun({ runId: rid("run-1") }));
      yield* Deferred.await(interrupted);
      cancelling.interruptUnsafe(Fiber.getCurrent()?.id);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow;

      const statusAfterDisconnect = (yield* ledger.getRun(rid("run-1")))?.status;
      const callsAfterDisconnect = yield* Ref.get(calls);
      yield* Deferred.succeed(finishTeardown, undefined);
      yield* Fiber.await(running);
      yield* Fiber.await(cancelling);

      assert.strictEqual(statusAfterDisconnect, "interrupted");
      assert.deepStrictEqual(callsAfterDisconnect.released, []);
      assert.deepStrictEqual((yield* Ref.get(calls)).released, [id("AUD-1")]);
    }).pipe(Effect.provide(daemonLayer(recordingTracker([claimed], calls))), Effect.scoped);
  });

  it.effect("logs tracker cleanup failures and still returns the parked item", () => {
    const messages: string[] = [];
    const unavailable = () =>
      Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "tracker down" }));
    return Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord());
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();

      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const outcome = yield* client
        .CancelRun({ runId: rid("run-1") })
        .pipe(Effect.withLogger(Logger.make(({ message }) => messages.push(String(message)))));

      assert.strictEqual(outcome._tag, "Cancelled");
      assert.strictEqual(outcome.item._tag, "NeedsHuman");
      assert.isTrue(messages.some((message) => message.includes("run hand-off failed")));
      assert.isTrue(messages.some((message) => message.includes("claim release failed")));
    }).pipe(
      Effect.provide(
        daemonLayer(
          trackerLayer({
            observe: () => Effect.succeed([trackerItem()]),
            handOff: unavailable,
            release: unavailable,
          }),
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("hands off and releases a run whose workspace input has failed", () => {
    const calls = Ref.makeUnsafe(emptyCalls);
    return Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord());
      const client = yield* RpcTest.makeClient(DaemonRpcs);

      const outcome = yield* client.CancelRun({ runId: rid("run-1") });
      const run = (yield* client.ListRuns()).find(({ id }) => id === rid("run-1"));
      const recorded = yield* Ref.get(calls);

      assert.strictEqual(outcome._tag, "Cancelled");
      assert.strictEqual(outcome.item._tag, "NeedsHuman");
      assert.strictEqual(run?.status, "interrupted");
      assert.deepStrictEqual(recorded.handOff, [
        { workItem: id("AUD-1"), outcome: { stage: "implement", note: undefined } },
      ]);
      assert.deepStrictEqual(recorded.released, [id("AUD-1")]);
    }).pipe(
      Effect.provide(
        daemonLayer(
          recordingTracker([], calls),
          schedulerStub(),
          controlStoreStub(),
          failedWorkspaceRegistryServices,
        ),
      ),
      Effect.scoped,
    );
  });
});

describe("Reclassify", () => {
  it.effect("moves an item to a new role, notes it, and returns the reprojected item", () => {
    const calls = Ref.makeUnsafe(emptyCalls);
    const item = trackerItem({
      id: id("AUD-2"),
      roles: ["needs-triage"],
      claimedByUs: false,
      claimLabeled: false,
    });
    return Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();

      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();

      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const result = yield* client.Reclassify({
        workspace: wsid("example"),
        workItem: id("AUD-2"),
        role: "ready-for-agent" as TriageRole,
        note: "picking this up",
      });

      assert.isTrue(result !== null && ClassifiedItem.guards.Eligible(result));
      const recorded = yield* Ref.get(calls);
      assert.deepStrictEqual(recorded.reclassify, [
        {
          workItem: id("AUD-2"),
          outcome: {
            changes: { remove: ["needs-triage"], add: ["ready-for-agent"] },
            note: "picking this up",
          },
        },
      ]);

      const [published] = yield* Stream.fromSubscription(subscription).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      assert.strictEqual(published?._tag, "ItemChanged");
      if (!published || !DaemonEvent.guards.ItemChanged(published)) {
        return assert.fail("expected ItemChanged");
      }
      assert.isTrue(ClassifiedItem.guards.Eligible(published.item));
    }).pipe(Effect.provide(daemonLayer(recordingTracker([item], calls))), Effect.scoped);
  });

  it.effect("returns null when the item is reclassified as wontfix", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const result = yield* client.Reclassify({
        workspace: wsid("example"),
        workItem: id("AUD-3"),
        role: "wontfix" as TriageRole,
      });
      assert.strictEqual(result, null);
    }).pipe(
      Effect.provide(
        daemonLayer(trackerLayer({ observe: () => Effect.succeed([trackerItem({ id: id("AUD-3") })]) })),
      ),
      Effect.scoped,
    ),
  );

  it.effect("fails with WorkItemNotFound for an unknown item", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(
        client.Reclassify({
          workspace: wsid("example"),
          workItem: id("MISSING"),
          role: "ready-for-agent" as TriageRole,
        }),
      );
      assert.strictEqual(error._tag, "WorkItemNotFound");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("surfaces an issue tracker failure", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(
        client.Reclassify({
          workspace: wsid("example"),
          workItem: id("AUD-4"),
          role: "ready-for-agent" as TriageRole,
        }),
      );
      assert.strictEqual(error._tag, "IssueTrackerError");
    }).pipe(
      Effect.provide(
        daemonLayer(
          trackerLayer({
            observe: () => Effect.succeed([trackerItem({ id: id("AUD-4") })]),
            reclassify: () =>
              Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "tracker down" })),
          }),
        ),
      ),
      Effect.scoped,
    ),
  );
});

describe("HandBack", () => {
  it.effect("clears failure history, applies one role, and returns the eligible item", () => {
    const calls = Ref.makeUnsafe(emptyCalls);
    const item = trackerItem({
      id: id("AUD-5"),
      roles: ["ready-for-human"],
      claimedByUs: false,
      claimLabeled: false,
      attempts: [
        { stage: "implement", outcome: "failed", atMillis: 1 },
        { stage: "implement", outcome: "failed", atMillis: 2 },
        { stage: "implement", outcome: "failed", atMillis: 3 },
      ],
    });
    return Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      yield* TestClock.adjust("4 millis");

      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const result = yield* client.HandBack({
        workspace: wsid("example"),
        workItem: id("AUD-5"),
        role: "ready-for-agent",
        note: "worktree setup repaired",
      });

      assert.strictEqual(result?._tag, "Eligible");
      assert.deepStrictEqual((yield* Ref.get(calls)).handBack, [
        {
          workItem: id("AUD-5"),
          outcome: {
            record: { by: localOwnerId, atMillis: 4 },
            changes: { remove: ["ready-for-human"], add: ["ready-for-agent"] },
            note: "worktree setup repaired",
          },
        },
      ]);
    }).pipe(Effect.provide(daemonLayer(recordingTracker([item], calls))), Effect.scoped);
  });

  it.effect("fails with WorkItemNotFound for an unknown item", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      yield* worker.submit();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(
        client.HandBack({
          workspace: wsid("example"),
          workItem: id("MISSING"),
          role: "ready-for-agent",
        }),
      );
      assert.strictEqual(error._tag, "WorkItemNotFound");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );
});

describe("SetScheduling", () => {
  it.effect("publishes one SchedulerChanged, and the next tick adds no duplicate", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const publisher = yield* DaemonEventPublisher;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);

      yield* client.SetScheduling({ desired: "paused" });
      yield* publisher.publishScheduler();
      yield* bus.publish({ _tag: "ItemRemoved", workspace: wsid("example"), id: id("AUD-1") });

      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil(DaemonEvent.guards.ItemRemoved),
        Stream.runCollect,
      );
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["SchedulerChanged", "ItemRemoved"],
      );
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("reports paused after pausing and running after resuming", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const paused = yield* client.SetScheduling({ desired: "paused" });
      assert.strictEqual(paused.scheduling, "paused");
      const running = yield* client.SetScheduling({ desired: "running" });
      assert.strictEqual(running.scheduling, "running");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );
});

describe("SetDaemonLimit", () => {
  it.effect("returns and publishes the same whole Control store picture", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetDaemonLimit({
        update: { key: "global-concurrency", value: 8, expectedRevision: 0 },
      });
      const published = yield* Stream.fromSubscription(subscription).pipe(Stream.take(2), Stream.runCollect);
      const [controlStoreChanged, schedulerChanged] = published;

      assert.strictEqual(controlStoreChanged?._tag, "ControlStoreChanged");
      if (!controlStoreChanged || !DaemonEvent.guards.ControlStoreChanged(controlStoreChanged)) {
        return assert.fail("expected ControlStoreChanged");
      }
      assert.deepStrictEqual(controlStoreChanged.controlStore, returned);
      assert.deepStrictEqual(returned.daemonLimits, {
        globalConcurrency: 8,
        perWorkspaceConcurrency: 4,
        dailyBudget: 50,
        revision: 1,
      });
      assert.strictEqual(schedulerChanged?._tag, "SchedulerChanged");
      if (!schedulerChanged || !DaemonEvent.guards.SchedulerChanged(schedulerChanged)) {
        return assert.fail("expected SchedulerChanged");
      }
      assert.strictEqual(schedulerChanged.scheduler.globalLimit, 8);
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("does not change scheduler memory when the row write fails", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const failure = yield* Effect.flip(
        client.SetDaemonLimit({
          update: { key: "global-concurrency", value: 9, expectedRevision: 0 },
        }),
      );
      const scheduler = yield* Scheduler.Scheduler;
      yield* bus.publish({ _tag: "ItemRemoved", workspace: wsid("example"), id: id("AUD-1") });
      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil(DaemonEvent.guards.ItemRemoved),
        Stream.runCollect,
      );

      assert.strictEqual(failure._tag, "ControlStoreFailure");
      assert.strictEqual((yield* scheduler.config).globalLimit, 4);
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["ItemRemoved"],
      );
    }).pipe(
      Effect.provide(
        daemonLayer(
          trackerLayer({}),
          schedulerStub(),
          controlStoreStub({
            setDaemonLimit: () =>
              Effect.fail(
                ControlStoreFailure.make({
                  operation: "set daemon limit",
                  message: "disk full",
                  retryable: true,
                }),
              ),
          }),
        ),
      ),
      Effect.scoped,
    ),
  );
});

describe("SetOperationSetting", () => {
  const cursorSelected = {
    ...picture,
    operationSettings: [
      {
        setting: "harness" as const,
        level: { _tag: "Default" as const },
        scope: { _tag: "SettingsProfile" as const },
        value: "cursor",
      },
    ],
  };
  const cursorSelectedStore = controlStoreStub({ seed: cursorSelected });
  const staleModelOptionsStore = controlStoreStub({
    seed: {
      ...cursorSelected,
      operationSettings: [
        ...cursorSelected.operationSettings,
        {
          setting: "model-options",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: { effort: "retired-effort" },
        },
      ],
    },
  });
  const staleInheritedModelOptionsStore = controlStoreStub({
    seed: {
      ...cursorSelected,
      operationSettings: [
        ...cursorSelected.operationSettings,
        {
          setting: "model-options",
          level: { _tag: "Default" },
          scope: { _tag: "SettingsProfile" },
          value: { effort: "retired-effort" },
        },
        {
          setting: "model-options",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: { effort: "old-effort" },
        },
      ],
    },
  });
  const staleModelStore = controlStoreStub({
    seed: {
      ...cursorSelected,
      operationSettings: [
        ...cursorSelected.operationSettings,
        {
          setting: "model",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: "retired-model",
        },
      ],
    },
  });
  const shadowedOtherHarnessStore = controlStoreStub({
    seed: {
      ...cursorSelected,
      operationSettings: [
        ...cursorSelected.operationSettings,
        {
          setting: "harness",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: "codex",
        },
        {
          setting: "model",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: "codex-model",
        },
      ],
    },
  });
  const modelUpdate: OperationSettingUpdate = {
    _tag: "Set",
    row: {
      setting: "model",
      level: { _tag: "Operation", workflow: "coding", operation: "implement" },
      scope: { _tag: "SettingsProfile" },
      value: "test",
    },
  };

  it.effect("resets model options when the Harness changes", () => {
    const configured: ControlStorePicture = {
      ...cursorSelected,
      operationSettings: [
        ...cursorSelected.operationSettings,
        {
          setting: "model-options",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: { effort: "high" },
        },
      ],
    };
    const store = controlStoreStub({
      seed: configured,
      updateOperationSettings: (updates) =>
        Effect.succeed({
          ...configured,
          operationSettings: applyOperationSettingBatch(configured.operationSettings, updates),
        }),
    });
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({
        updates: [
          {
            _tag: "Set",
            row: {
              setting: "harness",
              level: { _tag: "Operation", workflow: "coding", operation: "implement" },
              scope: { _tag: "SettingsProfile" },
              value: "codex",
            },
          },
        ],
      });

      assert.deepStrictEqual(
        resolveOperationSetting(returned.operationSettings, "model-options", {
          workflow: "coding",
          operation: "implement",
          workspace: null,
        }),
        {},
      );
    }).pipe(
      Effect.provide(
        daemonLayerWithHarness(trackerLayer({}), store, [commandHarnessRunner, alternateHarnessRunner]),
      ),
      Effect.scoped,
    );
  });

  it.effect("resets profile and overlay model options when the Runtime host Harness changes", () => {
    const configured: ControlStorePicture = {
      ...cursorSelected,
      operationSettings: [
        ...cursorSelected.operationSettings,
        {
          setting: "harness",
          level: { _tag: "Default" },
          scope: { _tag: "RuntimeHost" },
          value: "cursor",
        },
        {
          setting: "model-options",
          level: { _tag: "Default" },
          scope: { _tag: "SettingsProfile" },
          value: { effort: "high" },
        },
        {
          setting: "model-options",
          level: { _tag: "Default" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace: wsid("example") },
          value: { effort: "high" },
        },
      ],
    };
    const store = controlStoreStub({
      seed: configured,
      updateOperationSettings: (updates) =>
        Effect.succeed({
          ...configured,
          operationSettings: applyOperationSettingBatch(configured.operationSettings, updates),
        }),
    });
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({
        updates: [
          {
            _tag: "Set",
            row: {
              setting: "harness",
              level: { _tag: "Default" },
              scope: { _tag: "RuntimeHost" },
              value: "codex",
            },
          },
        ],
      });

      const contexts = [
        { workflow: "coding", operation: "implement", workspace: null },
        { workflow: "coding", operation: "implement", workspace: wsid("example") },
      ];
      assert.deepStrictEqual(
        contexts.map((context) =>
          resolveOperationSetting(returned.operationSettings, "model-options", context),
        ),
        [{}, {}],
      );
    }).pipe(
      Effect.provide(
        daemonLayerWithHarness(trackerLayer({}), store, [commandHarnessRunner, alternateHarnessRunner]),
      ),
      Effect.scoped,
    );
  });

  it.effect("preserves model options when the model does not change", () => {
    const configured: ControlStorePicture = {
      ...cursorSelected,
      operationSettings: [
        ...cursorSelected.operationSettings,
        modelUpdate.row,
        {
          setting: "model-options",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: { effort: "high" },
        },
      ],
    };
    const store = controlStoreStub({
      seed: configured,
      updateOperationSettings: (updates) =>
        Effect.succeed({
          ...configured,
          operationSettings: applyOperationSettingBatch(configured.operationSettings, updates),
        }),
    });
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({ updates: [modelUpdate] });

      assert.deepStrictEqual(
        returned.operationSettings.find(({ setting }) => setting === "model-options")?.value,
        { effort: "high" },
      );
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}), store)), Effect.scoped);
  });

  it.effect("resets options for a changed model row even while that model is shadowed", () => {
    const configured: ControlStorePicture = {
      ...cursorSelected,
      operationSettings: [
        ...cursorSelected.operationSettings,
        {
          setting: "model",
          level: { _tag: "Default" },
          scope: { _tag: "SettingsProfile" },
          value: "test",
        },
        {
          setting: "model-options",
          level: { _tag: "Default" },
          scope: { _tag: "SettingsProfile" },
          value: { effort: "high" },
        },
        modelUpdate.row,
      ],
    };
    const update: OperationSettingUpdate = {
      _tag: "Set",
      row: {
        setting: "model",
        level: { _tag: "Default" },
        scope: { _tag: "SettingsProfile" },
        value: "test-next",
      },
    };
    const store = controlStoreStub({
      seed: configured,
      updateOperationSettings: (updates) =>
        Effect.succeed({
          ...configured,
          operationSettings: applyOperationSettingBatch(configured.operationSettings, updates),
        }),
    });
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({ updates: [update] });

      assert.deepStrictEqual(
        resolveOperationSetting(returned.operationSettings, "model-options", {
          workflow: "coding",
          operation: "triage",
          workspace: null,
        }),
        {},
      );
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}), store)), Effect.scoped);
  });

  it.effect("restores inherited model options when a model override is cleared", () => {
    const configured: ControlStorePicture = {
      ...cursorSelected,
      operationSettings: [
        ...cursorSelected.operationSettings,
        {
          setting: "model",
          level: { _tag: "Default" },
          scope: { _tag: "SettingsProfile" },
          value: "test",
        },
        {
          setting: "model-options",
          level: { _tag: "Default" },
          scope: { _tag: "SettingsProfile" },
          value: { effort: "high" },
        },
        {
          setting: "model",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: "test-next",
        },
        {
          setting: "model-options",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: {},
        },
      ],
    };
    const store = controlStoreStub({
      seed: configured,
      updateOperationSettings: (updates) =>
        Effect.succeed({
          ...configured,
          operationSettings: applyOperationSettingBatch(configured.operationSettings, updates),
        }),
    });
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({
        updates: [
          {
            _tag: "Clear",
            cell: {
              setting: "model",
              level: { _tag: "Operation", workflow: "coding", operation: "implement" },
              scope: { _tag: "SettingsProfile" },
            },
          },
        ],
      });

      assert.deepStrictEqual(
        resolveOperationSetting(returned.operationSettings, "model-options", {
          workflow: "coding",
          operation: "implement",
          workspace: null,
        }),
        { effort: "high" },
      );
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}), store)), Effect.scoped);
  });

  it.effect("clears model options atomically when a model changes", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({ updates: [modelUpdate] });
      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil(DaemonEvent.guards.WorkspaceChanged),
        Stream.runCollect,
      );
      const published = events[0];

      assert.strictEqual(published?._tag, "ControlStoreChanged");
      if (!published || !DaemonEvent.guards.ControlStoreChanged(published)) {
        return assert.fail("expected ControlStoreChanged");
      }
      assert.deepStrictEqual(published.controlStore, returned);
      if (!OperationSettingUpdate.guards.Set(modelUpdate)) return assert.fail("expected model update");
      assert.deepStrictEqual(returned.operationSettings, [
        modelUpdate.row,
        {
          setting: "model-options",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: {},
        },
      ]);
      assert.strictEqual(events[1]?._tag, "WorkspaceChanged");
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}), cursorSelectedStore)), Effect.scoped),
  );

  it.effect("persists a permission profile declared by the selected Harness", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({
        updates: [
          {
            _tag: "Set",
            row: {
              setting: "permission-profile",
              level: { _tag: "Operation", workflow: "coding", operation: "triage" },
              scope: { _tag: "SettingsProfile" },
              value: "full",
            },
          },
        ],
      });

      assert.strictEqual(returned.operationSettings[0]?.value, "full");
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}), cursorSelectedStore)), Effect.scoped),
  );

  it.effect("refuses a permission profile the selected Harness does not declare", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const failure = yield* Effect.flip(
        client.SetOperationSetting({
          updates: [
            {
              _tag: "Set",
              row: {
                setting: "permission-profile",
                level: { _tag: "Operation", workflow: "coding", operation: "triage" },
                scope: { _tag: "SettingsProfile" },
                value: "read-only",
              },
            },
          ],
        }),
      );

      assert.strictEqual(failure._tag, "OperationSettingRefused");
      if (failure._tag !== "OperationSettingRefused")
        return assert.fail("expected Operation setting refusal");
      assert.strictEqual(failure.source, "Harness cursor");
      assert.include(failure.reason, "does not offer permission profile read-only");
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}), cursorSelectedStore)), Effect.scoped),
  );

  it.effect("refuses a model absent from the current Harness catalog", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const failure = yield* Effect.flip(
        client.SetOperationSetting({
          updates: [
            {
              _tag: "Set",
              row: {
                setting: "model",
                level: { _tag: "Operation", workflow: "coding", operation: "implement" },
                scope: { _tag: "SettingsProfile" },
                value: "retired-model",
              },
            },
          ],
        }),
      );

      assert.strictEqual(failure._tag, "OperationSettingRefused");
      if (failure._tag !== "OperationSettingRefused")
        return assert.fail("expected Operation setting refusal");
      assert.strictEqual(failure.setting, "model");
      assert.include(failure.reason, "does not offer model retired-model");
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}), cursorSelectedStore)), Effect.scoped),
  );

  it.effect("reports permitted values when refusing model options", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const selections: ReadonlyArray<ModelOptionSelections> = [{ effort: "low" }, { speed: true }];
      const failures = yield* Effect.forEach(selections, (value) =>
        Effect.flip(
          client.SetOperationSetting({
            updates: [
              {
                _tag: "Set",
                row: {
                  setting: "model-options",
                  level: { _tag: "Operation", workflow: "coding", operation: "implement" },
                  scope: { _tag: "SettingsProfile" },
                  value,
                },
              },
            ],
          }),
        ),
      );

      failures.forEach((failure) => {
        assert.strictEqual(failure._tag, "OperationSettingRefused");
        if (failure._tag !== "OperationSettingRefused") assert.fail("expected Operation setting refusal");
        assert.include(failure.reason, 'permitted model options: effort ("high")');
      });
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}), cursorSelectedStore)), Effect.scoped),
  );

  it.effect("refuses catalog-absent values at Default and Workflow levels", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const levels = [
        { _tag: "Default" },
        { _tag: "Workflow", workflow: "coding" },
      ] satisfies ReadonlyArray<SettingLevel>;

      const failures = yield* Effect.forEach(levels, (level) =>
        Effect.flip(
          client.SetOperationSetting({
            updates: [
              {
                _tag: "Set",
                row: {
                  setting: "model",
                  level,
                  scope: { _tag: "SettingsProfile" },
                  value: "retired-model",
                },
              },
            ],
          }),
        ),
      );
      failures.forEach((failure) => {
        assert.strictEqual(failure._tag, "OperationSettingRefused");
        if (failure._tag !== "OperationSettingRefused") {
          assert.fail("expected Operation setting refusal");
        }
        assert.include(failure.reason, "does not offer model retired-model");
      });
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}), cursorSelectedStore)), Effect.scoped),
  );

  it.effect("persists a broad selection shadowed by another Harness", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({
        updates: [
          {
            _tag: "Set",
            row: {
              setting: "model",
              level: { _tag: "Default" },
              scope: { _tag: "SettingsProfile" },
              value: "test",
            },
          },
        ],
      });

      assert.strictEqual(returned.operationSettings[0]?.value, "test");
    }).pipe(
      Effect.provide(
        daemonLayerWithHarness(trackerLayer({}), shadowedOtherHarnessStore, [
          commandHarnessRunner,
          alternateHarnessRunner,
        ]),
      ),
      Effect.scoped,
    ),
  );

  it.effect("persists a broad model change while narrower model options are stale", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({
        updates: [
          {
            _tag: "Set",
            row: {
              setting: "model",
              level: { _tag: "Default" },
              scope: { _tag: "SettingsProfile" },
              value: "test-next",
            },
          },
        ],
      });

      assert.strictEqual(
        returned.operationSettings.find(
          ({ setting, level }) => setting === "model" && level._tag === "Default",
        )?.value,
        "test-next",
      );
    }).pipe(
      Effect.provide(daemonLayerWithHarness(trackerLayer({}), staleInheritedModelOptionsStore)),
      Effect.scoped,
    ),
  );

  it.effect("clears a selection without requiring a cached catalog", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({
        updates: [
          {
            _tag: "Clear",
            cell: {
              setting: "model",
              level: { _tag: "Operation", workflow: "coding", operation: "implement" },
              scope: { _tag: "SettingsProfile" },
            },
          },
        ],
      });

      assert.deepStrictEqual(returned.operationSettings, []);
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}), cursorSelectedStore)), Effect.scoped),
  );

  it.effect("allows a valid selection write while an unrelated saved selection is stale", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({
        updates: [
          {
            _tag: "Set",
            row: {
              setting: "model",
              level: { _tag: "Operation", workflow: "coding", operation: "implement" },
              scope: { _tag: "SettingsProfile" },
              value: "test",
            },
          },
        ],
      });

      assert.strictEqual(returned.operationSettings[0]?.value, "test");
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}), staleModelOptionsStore)), Effect.scoped),
  );

  it.effect("persists a Harness pick when its clear exposes a stale inherited value", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({
        updates: [
          {
            _tag: "Set",
            row: {
              setting: "harness",
              level: { _tag: "Operation", workflow: "coding", operation: "implement" },
              scope: { _tag: "SettingsProfile" },
              value: "codex",
            },
          },
          {
            _tag: "Set",
            row: {
              setting: "model",
              level: { _tag: "Operation", workflow: "coding", operation: "implement" },
              scope: { _tag: "SettingsProfile" },
              value: "codex-model",
            },
          },
          {
            _tag: "Clear",
            cell: {
              setting: "model-options",
              level: { _tag: "Operation", workflow: "coding", operation: "implement" },
              scope: { _tag: "SettingsProfile" },
            },
          },
        ],
      });

      assert.deepStrictEqual(
        returned.operationSettings.map(({ setting, value }) => ({ setting, value })),
        [
          { setting: "harness", value: "codex" },
          { setting: "model", value: "codex-model" },
        ],
      );
    }).pipe(
      Effect.provide(
        daemonLayerWithHarness(trackerLayer({}), staleInheritedModelOptionsStore, [
          commandHarnessRunner,
          alternateHarnessRunner,
        ]),
      ),
      Effect.scoped,
    ),
  );

  it.effect("refuses an explicit Set of an unchanged stale selection", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const failure = yield* Effect.flip(
        client.SetOperationSetting({
          updates: [
            {
              _tag: "Set",
              row: {
                setting: "model",
                level: { _tag: "Operation", workflow: "coding", operation: "implement" },
                scope: { _tag: "SettingsProfile" },
                value: "retired-model",
              },
            },
          ],
        }),
      );

      assert.strictEqual(failure._tag, "OperationSettingRefused");
      if (failure._tag !== "OperationSettingRefused") {
        return assert.fail("expected Operation setting refusal");
      }
      assert.include(failure.reason, "does not offer model retired-model");
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}), staleModelStore)), Effect.scoped),
  );
});

describe("Harness management", () => {
  it.effect("reports the registered Harness through RPC", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const catalogs = yield* client.GetHarnessCatalogs();
      const readiness = yield* client.GetHarnessReadiness();
      const item = readiness.harnesses[0];

      assert.strictEqual(catalogs[0]?.harness, "cursor");
      assert.deepStrictEqual(
        catalogs[0]?.catalog.models.map(({ value }) => value),
        ["test", "test-next"],
      );
      assert.strictEqual(item?.harness, "cursor");
      assert.isTrue(item?.enabled);
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}))), Effect.scoped),
  );

  it.effect("returns disabled Harness state", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetHarnessEnabled({ harness: harness("cursor"), enabled: false });
      assert.deepStrictEqual(returned.harnessSettings, [{ harness: harness("cursor"), enabled: false }]);
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}))), Effect.scoped),
  );

  it.effect("refuses a Harness that is not registered", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const failure = yield* Effect.flip(
        client.SetHarnessEnabled({ harness: harness("unknown"), enabled: false }),
      );

      assert.strictEqual(failure._tag, "HarnessNotRegistered");
      if (failure._tag !== "HarnessNotRegistered") return assert.fail("expected Harness refusal");
      assert.strictEqual(failure.harness, "unknown");
    }).pipe(Effect.provide(daemonLayerWithHarness(trackerLayer({}))), Effect.scoped),
  );
});

describe("SetContributionSetting", () => {
  const update: ContributionSettingUpdate = {
    _tag: "Set",
    row: {
      contribution: { id: "local:repo/mcp/tools", kind: "mcp-server" },
      scope: { _tag: "PrivateWorkspaceOverlay", workspace: wsid("example") },
      enabled: true,
    },
  };

  it.effect("acknowledges the stored setting before the snapshot refresh finishes", () =>
    Effect.gen(function* () {
      const probe = yield* WorkspaceRefreshProbe;
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const running = yield* Effect.forkChild(client.SetContributionSetting({ update }));
      yield* Deferred.await(probe.started);
      yield* Effect.yieldNow;

      assert.isDefined(running.pollUnsafe());
      const returned = yield* Fiber.join(running);
      yield* Deferred.succeed(probe.release, undefined);

      assert.strictEqual(returned.contributionSettings[0]?.enabled, true);
    }).pipe(Effect.provide(daemonLayer(WorkspaceRefreshProbe.trackerLayer)), Effect.scoped),
  );

  it.effect("signals the refresh when the setting caller disconnects after the write", () =>
    Effect.gen(function* () {
      const probe = yield* WorkspaceUpdatePublicationProbe;
      const setting = yield* Effect.forkChild(setContributionSettingCommand({ update }));
      yield* Deferred.await(probe.started);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(setting));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(probe.release, undefined);
      yield* Fiber.join(interrupting);

      assert.strictEqual(yield* Ref.get(probe.refreshes), 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          registryServices,
          controlStoreStub(),
          reconcileStubLayer,
          WorkspaceUpdatePublicationProbe.publisherLayer,
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("accepts a disk-dependent dangling row and publishes the returned picture", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetContributionSetting({ update });
      const [published] = yield* Stream.fromSubscription(subscription).pipe(
        Stream.take(1),
        Stream.runCollect,
      );

      assert.strictEqual(published?._tag, "ControlStoreChanged");
      if (!published || !DaemonEvent.guards.ControlStoreChanged(published)) {
        return assert.fail("expected ControlStoreChanged");
      }
      assert.deepStrictEqual(published.controlStore, returned);
      assert.strictEqual(returned.contributionSettings[0]?.diagnostic?._tag, "Dangling");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("refuses a Private workspace overlay the engine does not own", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const failure = yield* Effect.flip(
        client.SetContributionSetting({
          update: {
            ...update,
            row: {
              ...update.row,
              scope: { _tag: "PrivateWorkspaceOverlay", workspace: wsid("unknown") },
            },
          },
        }),
      );

      assert.strictEqual(failure._tag, "ContributionSettingRefused");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("clears an overlay for a failed registered workspace", () => {
    const stored = { ...picture, contributionSettings: [update.row] } satisfies ControlStorePicture;
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetContributionSetting({
        update: {
          _tag: "Clear",
          cell: {
            contribution: update.row.contribution,
            scope: update.row.scope,
          },
        },
      });

      assert.deepStrictEqual(returned.contributionSettings, []);
    }).pipe(
      Effect.provide(
        daemonLayer(
          trackerLayer({}),
          schedulerStub(),
          controlStoreStub({
            seed: stored,
            read: Effect.succeed(stored),
            updateContributionSetting: () => Effect.succeed(picture),
          }),
          failedWorkspaceRegistryServices,
        ),
      ),
      Effect.scoped,
    );
  });
});

describe("RegisterWorkspace", () => {
  // A registration that names no Connection is not a Connection problem, and saying so sends the
  // reader to a Connections screen where everything is already established and fine.
  it.effect("names the unset field when a registration binds no Connection", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(client.RegisterWorkspace({ registration: unboundRegistration }));

      assert.include(error.message, "issueTracker names no Connection");
      assert.include(error.message, '"issueTracker.connectionId"');
      assert.include(error.message, "github/<account>");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("rejects a tracker bound to the wrong Connection system", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(client.RegisterWorkspace({ registration: mismatchedRegistration }));

      assert.include(error.message, "not linear");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("rejects a tracker bound to a revoked Connection", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(client.RegisterWorkspace({ registration: acmeRegistration }));

      assert.include(error.message, "not an established Connection");
    }).pipe(
      Effect.provide(
        daemonLayer(
          trackerLayer({}),
          schedulerStub(),
          controlStoreStub(),
          registryServices,
          pluginManagerLayer,
          connectionStoreStubLayer({ status: "revoked" }),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("returns the minted workspace and publishes it once", () => {
    const registries = registrationServices();
    return Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const workspace = yield* client.RegisterWorkspace({
        registration: acmeRegistration,
      });
      yield* bus.publish({ _tag: "ItemRemoved", workspace: wsid("sentinel"), id: id("sentinel") });

      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil(DaemonEvent.guards.ItemRemoved),
        Stream.runCollect,
      );
      assert.strictEqual(workspace._tag, "Registered");
      if (WorkspaceState.guards.Registered(workspace)) {
        assert.strictEqual(workspace.name, "0198f16a-21d7-7000-8000-000000000001");
        assert.strictEqual(workspace.displayName, "acme");
      }
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["WorkspaceChanged", "ControlStoreChanged", "ItemRemoved"],
      );
    }).pipe(
      Effect.provide(daemonLayer(trackerLayer({}), schedulerStub(), controlStoreStub(), registries)),
      Effect.scoped,
    );
  });

  it.effect("accepts a disk-dependent failure and publishes its diagnostic once", () => {
    const registries = failedRegistrationServices();
    return Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const workspace = yield* client.RegisterWorkspace({ registration: acmeRegistration });
      yield* bus.publish({ _tag: "ItemRemoved", workspace: wsid("sentinel"), id: id("sentinel") });

      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil(DaemonEvent.guards.ItemRemoved),
        Stream.runCollect,
      );
      assert.deepStrictEqual(workspace, {
        _tag: "Failed",
        source: "/repos/missing",
        message: "Workspace input is missing",
      });
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["WorkspaceChanged", "ControlStoreChanged", "ItemRemoved"],
      );
    }).pipe(
      Effect.provide(daemonLayer(trackerLayer({}), schedulerStub(), controlStoreStub(), registries)),
      Effect.scoped,
    );
  });

  it.effect("refreshes contribution diagnostics after inventory changes", () => {
    const contribution = {
      id: "local:repo/mcp/tools",
      authority: "local:repo",
      kind: "mcp-server",
      localName: "tools",
      file: "/repos/acme/.agents/mcp/tools.json",
    } satisfies LocalContribution;
    const stored = {
      ...picture,
      contributionSettings: [
        {
          contribution: { id: contribution.id, kind: "mcp-server" },
          scope: { _tag: "SettingsProfile" },
          enabled: true,
        },
      ],
    } satisfies ControlStorePicture;
    const registries = registrationServices([contribution]);
    return Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);

      yield* client.RegisterWorkspace({ registration: acmeRegistration });
      const [published] = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(DaemonEvent.guards.ControlStoreChanged),
        Stream.take(1),
        Stream.runCollect,
      );

      assert.strictEqual(published?.controlStore.contributionSettings[0]?.diagnostic, undefined);
    }).pipe(
      Effect.provide(
        daemonLayer(
          trackerLayer({}),
          schedulerStub(),
          controlStoreStub({ seed: stored, read: Effect.succeed(stored) }),
          registries,
        ),
      ),
      Effect.scoped,
    );
  });
});

describe("Connection mutations", () => {
  const existing = Connection.make({
    id: connectionIdOf("linear", "acme"),
    system: "linear",
    account: "acme",
    status: "established",
  });
  const layer = daemonLayer(
    trackerLayer({}),
    schedulerStub(),
    controlStoreStub(),
    registryServices,
    pluginManagerLayer,
    connectionStoreStubLayer({ status: "established", existing }),
  );
  const establishment: ConnectionEstablishment = {
    system: "linear",
    account: "other",
    source: { _tag: "Stored" },
  };

  it.effect("signals a snapshot refresh after establishing a Connection", () => {
    const connection = Connection.make({
      id: connectionIdOf("linear", "other"),
      system: "linear",
      account: "other",
      status: "established",
    });
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const probe = yield* WorkspaceRefreshProbe;

      yield* client.EstablishConnection({ establishment });
      yield* Deferred.await(probe.started);

      assert.strictEqual(yield* Ref.get(probe.reconciles), 1);
      yield* Deferred.succeed(probe.release, undefined);
    }).pipe(
      Effect.provide(
        daemonLayer(
          WorkspaceRefreshProbe.trackerLayer,
          schedulerStub(),
          controlStoreStub(),
          registryServices,
          pluginManagerLayer,
          connectionStoreStubLayer({
            status: "established",
            establish: () => Effect.succeed(connection),
          }),
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("signals a snapshot refresh after removing a Connection", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const probe = yield* WorkspaceRefreshProbe;

      yield* client.RemoveConnection({ connectionId: existing.id });
      yield* Deferred.await(probe.started);

      assert.strictEqual(yield* Ref.get(probe.reconciles), 1);
      yield* Deferred.succeed(probe.release, undefined);
    }).pipe(
      Effect.provide(
        daemonLayer(
          WorkspaceRefreshProbe.trackerLayer,
          schedulerStub(),
          controlStoreStub(),
          registryServices,
          pluginManagerLayer,
          connectionStoreStubLayer({ status: "established", remove: () => Effect.void }),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("signals the refresh when a Connection caller disconnects after removal", () =>
    Effect.gen(function* () {
      const probe = yield* WorkspaceUpdatePublicationProbe;
      const removing = yield* Effect.forkChild(removeConnectionCommand({ connectionId: existing.id }));
      yield* Deferred.await(probe.started);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(removing));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(probe.release, undefined);
      yield* Fiber.join(interrupting);

      assert.strictEqual(yield* Ref.get(probe.refreshes), 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          registryServices,
          pluginManagerLayer,
          controlStoreStub(),
          reconcileStubLayer,
          connectionStoreStubLayer({ status: "established", remove: () => Effect.void }),
          WorkspaceUpdatePublicationProbe.publisherLayer,
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("directs account switches through removal", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const establishError = yield* Effect.flip(client.EstablishConnection({ establishment }));
      const reconnectError = yield* Effect.flip(client.ReconnectConnection({ establishment }));

      assert.strictEqual(
        establishError.message,
        "Connection already exists. Use re-connect for the same account, or remove it before connecting to a different account.",
      );
      assert.strictEqual(
        reconnectError.message,
        'Connection is established for "acme". Remove it before connecting to "other".',
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("removes a new Connection when required Plugin installation is interrupted", () => {
    const connection = Connection.make({
      id: connectionIdOf("linear", "other"),
      system: "linear",
      account: "other",
      status: "established",
    });
    const requiredPlugin = {
      ...installedPlugin("linear"),
      record: null,
      resolvedIdentity: null,
      requiredConnections: ["linear"],
    } satisfies PluginItem;
    return Effect.gen(function* () {
      const probe = yield* ConnectionPluginInstallProbe;
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const establishing = yield* Effect.forkChild(client.EstablishConnection({ establishment }));

      yield* Deferred.await(probe.installStarted);
      yield* Fiber.interrupt(establishing);

      assert.deepStrictEqual(yield* Ref.get(probe.removed), [connection.id]);
    }).pipe(
      Effect.provide(
        daemonLayer(
          trackerLayer({}),
          schedulerStub(),
          controlStoreStub(),
          registryServices,
          Layer.effect(
            PluginManager,
            Effect.map(ConnectionPluginInstallProbe, ({ installStarted }) => ({
              overview: Effect.succeed({ plugins: [requiredPlugin] }),
              install: () => Deferred.succeed(installStarted, undefined).pipe(Effect.andThen(Effect.never)),
              uninstall: () => Effect.die("unexpected Plugin uninstall"),
              contributions: () => Effect.succeed([]),
            })),
          ).pipe(Layer.provideMerge(ConnectionPluginInstallProbe.layer)),
          Layer.effect(
            ConnectionStore,
            Effect.map(ConnectionPluginInstallProbe, ({ removed }) =>
              connectionStoreStub({
                status: "established",
                remove: (connectionId) => Ref.update(removed, (ids) => [...ids, connectionId]),
                establish: () => Effect.succeed(connection),
              }),
            ),
          ).pipe(Layer.provideMerge(ConnectionPluginInstallProbe.layer)),
        ).pipe(Layer.provideMerge(ConnectionPluginInstallProbe.layer)),
      ),
      Effect.scoped,
    );
  });

  it.effect("signals after rolling back an interrupted required Plugin installation", () => {
    const connection = Connection.make({
      id: connectionIdOf("linear", "other"),
      system: "linear",
      account: "other",
      status: "established",
    });
    const requiredPlugin = {
      ...installedPlugin("linear"),
      record: null,
      resolvedIdentity: null,
      requiredConnections: ["linear"],
    } satisfies PluginItem;
    return Effect.gen(function* () {
      const probe = yield* WorkspaceUpdatePublicationProbe;
      const removed = yield* Ref.make<ReadonlyArray<Connection["id"]>>([]);
      const establishing = yield* Effect.forkChild(
        establishConnectionCommand({ establishment }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(Principal, { id: localOwnerId }),
              Layer.succeed(PluginManager, {
                overview: Effect.succeed({ plugins: [requiredPlugin] }),
                install: () =>
                  Effect.succeed({ overview: { plugins: [installedPlugin("linear")] }, notices: [] }),
                uninstall: () => Effect.die("unexpected Plugin uninstall"),
                contributions: () => Effect.succeed([]),
              }),
              Layer.succeed(
                ConnectionStore,
                connectionStoreStub({
                  status: "established",
                  establish: () => Effect.succeed(connection),
                  remove: (connectionId) => Ref.update(removed, (ids) => [...ids, connectionId]),
                }),
              ),
              controlStoreStub(),
              reconcileStubLayer,
            ),
          ),
        ),
      );

      yield* Deferred.await(probe.started);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(establishing));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(probe.release, undefined);
      yield* Fiber.join(interrupting);

      assert.deepStrictEqual(yield* Ref.get(removed), [connection.id]);
      assert.strictEqual(yield* Ref.get(probe.refreshes), 2);
    }).pipe(Effect.provide(WorkspaceUpdatePublicationProbe.publisherLayer), Effect.scoped);
  });

  it.effect("warns when a failed workspace uses the removed source-control Connection", () => {
    const github = connectionIdOf("github", "acme");
    const failed = Schema.decodeSync(WorkspaceConfig)({
      name: "failed",
      checkoutPath: "/repos/failed",
      issueTracker: {
        type: "linear",
        connectionId: "linear/acme",
        teams: ["ENG"],
      },
      sourceControl: {
        type: "github",
        connectionId: github,
      },
    });
    const registries = Layer.mergeAll(
      Layer.succeed(
        Registry.WorkspaceRegistry,
        Registry.readOnlyRegistry({
          workspaces: [],
          failures: [
            {
              name: failed.name,
              displayName: "Failed",
              source: failed.checkoutPath,
              message: "invalid Workspace input",
              issueTracker: failed.issueTracker,
              sourceControl: failed.sourceControl,
            },
          ],
        }),
      ),
      Registry.managementReadOnlyLayer,
    );
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const result = yield* client.RemoveConnection({ connectionId: github });

      assert.deepStrictEqual(result.danglingWorkspaces, [failed.name]);
    }).pipe(
      Effect.provide(
        daemonLayer(
          trackerLayer({}),
          schedulerStub(),
          controlStoreStub(),
          registries,
          pluginManagerLayer,
          connectionStoreStubLayer({ status: "established", remove: () => Effect.void }),
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("includes a workspace registered while required Plugins uninstall", () => {
    const github = connectionIdOf("github", "acme");
    const uninstallStarted = Deferred.makeUnsafe<void>();
    const finishUninstall = Deferred.makeUnsafe<void>();
    const pluginOverview = {
      plugins: [{ ...installedPlugin("github"), requiredConnections: ["github"] }],
    } satisfies PluginOverview;
    const plugins = Layer.succeed(PluginManager, {
      overview: Effect.succeed(pluginOverview),
      install: () => Effect.die("unexpected Plugin install"),
      uninstall: () =>
        Deferred.succeed(uninstallStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishUninstall)),
          Effect.map(() => ({ overview: { plugins: [] }, notices: [] })),
        ),
      contributions: () => Effect.succeed([]),
    });
    const registries = registrationServices();
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const removing = yield* Effect.forkChild(client.RemoveConnection({ connectionId: github }));
      yield* Deferred.await(uninstallStarted);
      const registered = yield* client.RegisterWorkspace({ registration: acmeRegistration });
      if (registered.name === undefined) return assert.fail("expected registration to succeed");
      yield* Deferred.succeed(finishUninstall, undefined);
      const result = yield* Fiber.join(removing);

      assert.deepStrictEqual(result.danglingWorkspaces, [registered.name]);
    }).pipe(
      Effect.provide(
        daemonLayer(
          trackerLayer({}),
          schedulerStub(),
          controlStoreStub(),
          registries,
          plugins,
          connectionStoreStubLayer({ status: "established", remove: () => Effect.void }),
        ),
      ),
      Effect.scoped,
    );
  });
});

describe("workspace lifecycle commands", () => {
  it.effect("polls a new workspace and clears its items after deregistration", () => {
    const registries = registrationServices();
    return Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const probe = yield* WorkspaceRefreshProbe;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);

      const registered = yield* client.RegisterWorkspace({ registration: acmeRegistration });
      if (!WorkspaceState.guards.Registered(registered)) return assert.fail("expected registration");
      yield* Deferred.await(probe.started);
      assert.strictEqual(yield* Ref.get(probe.reconciles), 1);
      yield* Deferred.succeed(probe.release, undefined);

      const [published] = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(DaemonEvent.guards.ItemChanged),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.strictEqual(published?.workspace, registered.name);

      yield* client.DeregisterWorkspace({ workspace: registered.name });
      const [removed] = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(DaemonEvent.guards.ItemRemoved),
        Stream.take(1),
        Stream.runCollect,
      );

      assert.strictEqual(removed?.workspace, registered.name);
      assert.strictEqual(removed?.id, id("AUD-1"));
    }).pipe(
      Effect.provide(
        daemonLayer(WorkspaceRefreshProbe.trackerLayer, schedulerStub(), controlStoreStub(), registries),
      ),
      Effect.scoped,
    );
  });

  it.effect("requests a fresh snapshot when the caller disconnects after the workspace write", () => {
    const registries = registrationServices();
    return Effect.gen(function* () {
      const management = yield* Registry.WorkspaceManagement;
      const probe = yield* WorkspaceUpdatePublicationProbe;
      yield* management.register(acmeRegistration);
      const workspace = wsid("0198f16a-21d7-7000-8000-000000000001");

      const updating = yield* Effect.forkChild(updateWorkspaceCommand({ workspace, update: acmeUpdate }));
      yield* Deferred.await(probe.started);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(updating));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(probe.release, undefined);
      yield* Fiber.join(interrupting);

      assert.strictEqual(yield* Ref.get(probe.refreshes), 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(registries, connectionStoreLayer, WorkspaceUpdatePublicationProbe.publisherLayer),
      ),
      Effect.scoped,
    );
  });

  it.effect("finishes a persisted workspace update when the caller disconnects", () => {
    const updateStarted = Deferred.makeUnsafe<void>();
    const releaseUpdate = Deferred.makeUnsafe<void>();
    const persisted = Ref.makeUnsafe(false);
    const registries = registrationServices(
      [],
      Ref.set(persisted, true).pipe(
        Effect.andThen(Deferred.succeed(updateStarted, undefined)),
        Effect.andThen(Deferred.await(releaseUpdate)),
      ),
    );
    return Effect.gen(function* () {
      const management = yield* Registry.WorkspaceManagement;
      const registry = yield* Registry.WorkspaceRegistry;
      const publication = yield* WorkspaceUpdatePublicationProbe;
      yield* management.register(acmeRegistration);
      yield* Deferred.succeed(publication.release, undefined);
      const workspace = wsid("0198f16a-21d7-7000-8000-000000000001");

      const updating = yield* Effect.forkChild(updateWorkspaceCommand({ workspace, update: acmeUpdate }));
      yield* Deferred.await(updateStarted);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(updating));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseUpdate, undefined);
      yield* Fiber.join(interrupting);

      const registered = (yield* registry.state).workspaces.find(
        (candidate) => candidate.config.name === workspace,
      );
      assert.isTrue(yield* Ref.get(persisted));
      assert.strictEqual(registered?.config.displayName, acmeUpdate.name);
      assert.strictEqual(yield* Ref.get(publication.refreshes), 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(registries, connectionStoreLayer, WorkspaceUpdatePublicationProbe.publisherLayer),
      ),
      Effect.scoped,
    );
  });

  it.effect("signals a refresh when post-deregistration publication fails", () => {
    const registries = registrationServices();
    return Effect.gen(function* () {
      const management = yield* Registry.WorkspaceManagement;
      const probe = yield* WorkspaceUpdatePublicationProbe;
      yield* management.register(acmeRegistration);

      const error = yield* Effect.flip(
        deregisterWorkspaceCommand({ workspace: wsid("0198f16a-21d7-7000-8000-000000000001") }),
      );

      assert.strictEqual(error._tag, "WorkspaceRegistryError");
      assert.strictEqual(yield* Ref.get(probe.refreshes), 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          registries,
          controlStoreStub({
            read: Effect.fail(
              ControlStoreFailure.make({
                operation: "read control store",
                message: "disk unavailable",
                retryable: true,
              }),
            ),
          }),
          WorkspaceUpdatePublicationProbe.publisherLayer,
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("refuses an invalid Connection reference before editing the workspace", () => {
    const registries = registrationServices();
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const registry = yield* Registry.WorkspaceRegistry;
      const registered = yield* client.RegisterWorkspace({ registration: acmeRegistration });
      if (!WorkspaceState.guards.Registered(registered)) return assert.fail("expected registration");

      const error = yield* Effect.flip(
        client.UpdateWorkspace({
          workspace: registered.name,
          update: { ...acmeUpdate, issueTracker: { ...acmeUpdate.issueTracker, connectionId: "unbound" } },
        }),
      );
      const stored = Registry.findWorkspace(yield* registry.state, registered.name);

      assert.strictEqual(error._tag, "WorkspaceRegistrationError");
      assert.strictEqual(stored?.config.displayName, acmeRegistration.name);
    }).pipe(
      Effect.provide(daemonLayer(trackerLayer({}), schedulerStub(), controlStoreStub(), registries)),
      Effect.scoped,
    );
  });

  it.effect("returns and publishes the saved workspace before a fresh reconcile finishes", () => {
    const registries = registrationServices();
    return Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const probe = yield* WorkspaceRefreshProbe;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const registered = yield* client.RegisterWorkspace({ registration: acmeRegistration });
      if (!WorkspaceState.guards.Registered(registered)) return assert.fail("expected registration");

      const updating = yield* Effect.forkChild(
        client.UpdateWorkspace({ workspace: registered.name, update: acmeUpdate }),
      );
      yield* Deferred.await(probe.started);
      yield* Effect.yieldNow;
      assert.isDefined(updating.pollUnsafe());
      const updated = yield* Fiber.join(updating);
      const events = yield* Stream.fromSubscription(subscription).pipe(Stream.take(5), Stream.runCollect);

      assert.strictEqual(
        WorkspaceState.guards.Registered(updated) ? updated.record?.name : null,
        "renamed acme",
      );
      assert.strictEqual(
        WorkspaceState.guards.Registered(updated) ? updated.checkoutPath : null,
        "/repos/acme",
      );
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        [
          "WorkspaceChanged",
          "ControlStoreChanged",
          "WorkspaceChanged",
          "ControlStoreChanged",
          "SchedulerChanged",
        ],
      );
      const schedulerChanged = events.at(-1);
      if (!schedulerChanged || !DaemonEvent.guards.SchedulerChanged(schedulerChanged)) {
        return assert.fail("expected SchedulerChanged");
      }
      assert.strictEqual(
        schedulerChanged.scheduler.perWorkspace.find(({ name }) => name === registered.name)?.limit,
        acmeUpdate.concurrency,
      );
      const published = [...events].flatMap((event) =>
        DaemonEvent.guards.WorkspaceChanged(event) ? [event.workspace] : [],
      );
      assert.deepStrictEqual(published.at(-1), updated);
      const refreshing = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil(DaemonEvent.guards.WorkspaceChanged),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.succeed(probe.release, undefined);
      const refreshedEvents = yield* Fiber.join(refreshing);
      assert.deepStrictEqual(
        [...refreshedEvents].map((event) => event._tag),
        ["ItemChanged", "WorkspaceChanged"],
      );
      assert.strictEqual(yield* Ref.get(probe.reconciles), 1);
    }).pipe(
      Effect.provide(
        daemonLayer(WorkspaceRefreshProbe.trackerLayer, schedulerStub(), controlStoreStub(), registries),
      ),
      Effect.scoped,
    );
  });

  it.effect("returns the WorkspaceId and publishes the refreshed Control store picture", () => {
    const registries = registrationServices();
    const workspace = wsid("0198f16a-21d7-7000-8000-000000000001");
    const remainingSetting = {
      setting: "model",
      level: { _tag: "Default" },
      scope: { _tag: "SettingsProfile" },
      value: "openai/gpt-5",
    } satisfies ControlStorePicture["operationSettings"][number];
    const beforeDeregister = {
      ...picture,
      operationSettings: [
        {
          ...remainingSetting,
          scope: { _tag: "PrivateWorkspaceOverlay", workspace },
        },
        remainingSetting,
      ],
    } satisfies ControlStorePicture;
    const afterDeregister = {
      ...picture,
      operationSettings: [remainingSetting],
    } satisfies ControlStorePicture;
    return Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const registered = yield* client.RegisterWorkspace({ registration: acmeRegistration });
      if (!WorkspaceState.guards.Registered(registered)) return assert.fail("expected registration");

      const deregistered = yield* client.DeregisterWorkspace({ workspace: registered.name });
      yield* bus.publish({ _tag: "ItemRemoved", workspace: wsid("sentinel"), id: id("sentinel") });
      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil(DaemonEvent.guards.ItemRemoved),
        Stream.runCollect,
      );

      assert.strictEqual(deregistered, registered.name);
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["WorkspaceChanged", "ControlStoreChanged", "WorkspaceRemoved", "ControlStoreChanged", "ItemRemoved"],
      );
      const controlStoreChanged = [...events].find(DaemonEvent.guards.ControlStoreChanged);
      assert.deepStrictEqual(controlStoreChanged?.controlStore, afterDeregister);
    }).pipe(
      Effect.provide(
        daemonLayer(
          trackerLayer({}),
          schedulerStub(),
          controlStoreStub({ seed: beforeDeregister, read: Effect.succeed(afterDeregister) }),
          registries,
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("returns and publishes the re-bound workspace picture", () => {
    const registries = registrationServices();
    return Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const registered = yield* client.RegisterWorkspace({ registration: acmeRegistration });
      if (!WorkspaceState.guards.Registered(registered)) return assert.fail("expected registration");

      const rebound = yield* client.RebindWorkspace({
        workspace: registered.name,
        checkoutPath: "/repos/moved-acme",
      });
      const events = yield* Stream.fromSubscription(subscription).pipe(Stream.take(4), Stream.runCollect);

      assert.strictEqual(rebound._tag, "Registered");
      assert.strictEqual(
        WorkspaceState.guards.Registered(rebound) ? rebound.checkoutPath : null,
        "/repos/moved-acme",
      );
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["WorkspaceChanged", "ControlStoreChanged", "WorkspaceChanged", "ControlStoreChanged"],
      );
    }).pipe(
      Effect.provide(daemonLayer(trackerLayer({}), schedulerStub(), controlStoreStub(), registries)),
      Effect.scoped,
    );
  });

  it.effect("keeps cancellation cleanup for a deregistered in-flight Run", () => {
    const calls = Ref.makeUnsafe(emptyCalls);
    const registries = registrationServices();
    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const registeredState = yield* client.RegisterWorkspace({ registration: acmeRegistration });
      if (!WorkspaceState.guards.Registered(registeredState)) return assert.fail("expected registration");

      const registry = yield* Registry.WorkspaceRegistry;
      const registeredWorkspace = (yield* registry.state).workspaces.at(0);
      if (!registeredWorkspace) return assert.fail("expected registered workspace");

      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord({ workspace: registeredState.name }));
      const started = yield* Deferred.make<void>();
      const control = yield* RunControl.RunControl;
      const issueTracker = yield* IssueTracker.IssueTracker;
      yield* Effect.forkChild(
        control.run(
          rid("run-1"),
          registeredWorkspace,
          Deferred.succeed(started, undefined).pipe(Effect.andThen(interruptionGate.await)),
          Effect.ignore(issueTracker.release(registeredWorkspace, id("AUD-1"))),
        ),
      );
      yield* Deferred.await(started);

      yield* client.DeregisterWorkspace({ workspace: registeredState.name });
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      yield* client.CancelRun({ runId: rid("run-1") });
      yield* bus.publish({ _tag: "ItemRemoved", workspace: wsid("sentinel"), id: id("sentinel") });
      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil(DaemonEvent.guards.ItemRemoved),
        Stream.runCollect,
      );

      const recorded = yield* Ref.get(calls);
      assert.deepStrictEqual(recorded.handOff, [
        { workItem: id("AUD-1"), outcome: { stage: "implement", note: undefined } },
      ]);
      assert.deepStrictEqual(recorded.released, [id("AUD-1")]);
      assert.isFalse([...events].some(DaemonEvent.guards.ItemChanged));
    }).pipe(
      Effect.provide(
        daemonLayer(recordingTracker([], calls), schedulerStub(), controlStoreStub(), registries),
      ),
      Effect.scoped,
    );
  });
});

describe("Plugin lifecycle commands", () => {
  it.effect("acknowledges Plugin installation before the snapshot refresh finishes", () => {
    const overview = { plugins: [installedPlugin("github")] } satisfies PluginOverview;
    const plugins = Layer.succeed(PluginManager, {
      overview: Effect.succeed(overview),
      install: () => Effect.succeed({ overview, notices: [] }),
      uninstall: () => Effect.die("unexpected Plugin uninstall"),
      contributions: () => Effect.succeed([]),
    });
    return Effect.gen(function* () {
      const probe = yield* WorkspaceRefreshProbe;
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const running = yield* Effect.forkChild(client.InstallPlugin({ pluginId: "github" }));
      yield* Deferred.await(probe.started);
      yield* Effect.yieldNow;

      assert.isDefined(running.pollUnsafe());
      const result = yield* Fiber.join(running);
      yield* Deferred.succeed(probe.release, undefined);

      assert.deepStrictEqual(result.overview, overview);
    }).pipe(
      Effect.provide(
        daemonLayer(
          WorkspaceRefreshProbe.trackerLayer,
          schedulerStub(),
          controlStoreStub(),
          registryServices,
          plugins,
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("acknowledges Plugin removal before the snapshot refresh finishes", () => {
    const overview = { plugins: [] } satisfies PluginOverview;
    const plugins = Layer.succeed(PluginManager, {
      overview: Effect.succeed(overview),
      install: () => Effect.die("unexpected Plugin install"),
      uninstall: () => Effect.succeed({ overview, notices: [] }),
      contributions: () => Effect.succeed([]),
    });
    return Effect.gen(function* () {
      const probe = yield* WorkspaceRefreshProbe;
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const running = yield* Effect.forkChild(client.UninstallPlugin({ pluginId: "github" }));
      yield* Deferred.await(probe.started);
      yield* Effect.yieldNow;

      assert.isDefined(running.pollUnsafe());
      const result = yield* Fiber.join(running);
      yield* Deferred.succeed(probe.release, undefined);

      assert.deepStrictEqual(result.overview, overview);
    }).pipe(
      Effect.provide(
        daemonLayer(
          WorkspaceRefreshProbe.trackerLayer,
          schedulerStub(),
          controlStoreStub(),
          registryServices,
          plugins,
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("signals the refresh when the Plugin caller disconnects after removal", () => {
    const overview = { plugins: [] } satisfies PluginOverview;
    const plugins = Layer.succeed(PluginManager, {
      overview: Effect.succeed(overview),
      install: () => Effect.die("unexpected Plugin install"),
      uninstall: () => Effect.succeed({ overview, notices: [] }),
      contributions: () => Effect.succeed([]),
    });
    return Effect.gen(function* () {
      const probe = yield* WorkspaceUpdatePublicationProbe;
      const removing = yield* Effect.forkChild(uninstallPluginCommand({ pluginId: "github" }));
      yield* Deferred.await(probe.started);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(removing));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(probe.release, undefined);
      yield* Fiber.join(interrupting);

      assert.strictEqual(yield* Ref.get(probe.refreshes), 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          plugins,
          controlStoreStub(),
          reconcileStubLayer,
          WorkspaceUpdatePublicationProbe.publisherLayer,
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("never publishes an older Plugin snapshot after a newer mutation", () => {
    const firstReady = Deferred.makeUnsafe<void>();
    const releaseFirst = Deferred.makeUnsafe<void>();
    const plugins = concurrentPluginManagerLayer(firstReady, releaseFirst);
    return Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const first = yield* Effect.forkChild(client.InstallPlugin({ pluginId: "github" }));

      yield* Deferred.await(firstReady);
      yield* client.InstallPlugin({ pluginId: "linear" });
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* bus.publish({ _tag: "ItemRemoved", workspace: wsid("sentinel"), id: id("sentinel") });

      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil(DaemonEvent.guards.ItemRemoved),
        Stream.runCollect,
      );
      const snapshots = [...events].filter(DaemonEvent.guards.PluginsChanged).map((event) => ({
        plugins: event.plugins.plugins.map((plugin) => plugin.pluginId),
        notices: event.notices,
      }));
      assert.deepStrictEqual(snapshots, [
        { plugins: ["github", "linear"], notices: ["linear notice"] },
        { plugins: ["github", "linear"], notices: [] },
      ]);
    }).pipe(
      Effect.provide(
        daemonLayer(trackerLayer({}), schedulerStub(), controlStoreStub(), registryServices, plugins),
      ),
      Effect.scoped,
    );
  });
});
