import {
  Connection,
  type ConnectionEstablishment,
  ControlStoreFailure,
  type ControlStore as ControlStorePicture,
  connectionIdOf,
  type DaemonLimitUpdate,
  DaemonRpcs,
  HarnessName,
  IssueTrackerError,
  localOwnerId,
  type OperationSettingUpdate,
  type PluginItem,
  type PluginOverview,
  RunId,
  type RunRecord,
  type TriageRole,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
  WorkspaceRegistration,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { ConnectionStore, type ConnectionStoreService } from "./connection";
import { ControlStore, type ControlStoreService } from "./control-store";
import * as Daemon from "./daemon";
import * as DaemonEventBus from "./daemon-event-bus";
import { DaemonEventPublisher, layer as eventPublisherLayer } from "./event-publisher";
import type { HandOffOutcome, ReclassifyOutcome, TrackerItem } from "./issue-tracker";
import * as IssueTracker from "./issue-tracker";
import { PluginManager } from "./plugin";
import * as Reconcile from "./reconcile";
import * as Registry from "./registry";
import * as RunControl from "./run-control";
import * as RunLedger from "./run-ledger";
import { layer as runRecorderLayer } from "./run-recorder";
import * as Scheduler from "./scheduler";
import { type PrSignals, SourceControlProvider } from "./source-control";

const id = Schema.decodeSync(WorkItemId);
const rid = Schema.decodeSync(RunId);
const wsid = Schema.decodeSync(WorkspaceId);
const harness = Schema.decodeSync(HarnessName);
const acmeRegistration = Schema.decodeSync(WorkspaceRegistration)({
  name: "acme",
  checkoutPath: "/repos/acme",
  gitRemote: "git@github.com:acme/repo.git",
  issueTracker: { type: "github", connectionId: "github/acme", repo: "acme/repo" },
  linearHistory: false,
  concurrency: 2,
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
    harness: { preferred: "cursor" },
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
  readonly reclassify: ReadonlyArray<{ readonly workItem: WorkItemId; readonly outcome: ReclassifyOutcome }>;
  readonly handOff: ReadonlyArray<{ readonly workItem: WorkItemId; readonly outcome: HandOffOutcome }>;
  readonly released: ReadonlyArray<WorkItemId>;
}

const emptyCalls: TrackerCalls = { reclassify: [], handOff: [], released: [] };

const providerStub = Layer.succeed(SourceControlProvider, {
  observe: () => Effect.succeed(new Map<WorkItemId, PrSignals>()),
  comment: () => Effect.void,
});

const trackerLayer = (
  service: Partial<IssueTracker.IssueTrackerService>,
): Layer.Layer<IssueTracker.IssueTracker | SourceControlProvider> =>
  Layer.mergeAll(
    Layer.succeed(IssueTracker.IssueTracker, {
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
      stalled: () => Effect.void,
      reclassify: () => Effect.void,
      ...service,
    }),
    providerStub,
  );

const recordingTracker = (items: ReadonlyArray<TrackerItem>, calls: Ref.Ref<TrackerCalls>) =>
  trackerLayer({
    observe: () => Effect.succeed(items),
    reclassify: (_workspace, workItem, outcome) =>
      Ref.update(calls, (c) => ({ ...c, reclassify: [...c.reclassify, { workItem, outcome }] })),
    handOff: (_workspace, workItem, outcome) =>
      Ref.update(calls, (c) => ({ ...c, handOff: [...c.handOff, { workItem, outcome }] })),
    release: (_workspace, workItem) =>
      Ref.update(calls, (c) => ({ ...c, released: [...c.released, workItem] })),
  });

const runLedgerLayer = RunLedger.layerMemory.pipe(Layer.provideMerge(DaemonEventBus.layer));
const runRecorder = runRecorderLayer.pipe(Layer.provide(runLedgerLayer));
const pluginManagerLayer = Layer.succeed(PluginManager, {
  overview: Effect.succeed({ plugins: [] }),
  install: () => Effect.die(new Error("unexpected Plugin install")),
  uninstall: () => Effect.die(new Error("unexpected Plugin uninstall")),
  contributions: () => Effect.succeed([]),
});
const connectionStoreLayerWithStatus = (
  status: "established" | "revoked",
  existing: Connection | null = null,
  remove: ConnectionStoreService["remove"] = () => Effect.die("unexpected Connection remove"),
) =>
  Layer.succeed(ConnectionStore, {
    overview: () => Effect.succeed({ connections: [] }),
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
    establish: () => Effect.die("unexpected Connection establish"),
    revoke: () => Effect.die("unexpected Connection revoke"),
    remove,
  });
const connectionStoreLayer = connectionStoreLayerWithStatus("established");

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
        install: (pluginId) =>
          Effect.gen(function* () {
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
};

interface ControlStoreStubOptions {
  readonly seed?: ControlStorePicture;
  readonly read?: Effect.Effect<ControlStorePicture, ControlStoreFailure>;
  readonly setDaemonLimit?: ControlStoreService["setDaemonLimit"];
  readonly updateOperationSetting?: ControlStoreService["updateOperationSetting"];
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
    }),
  updateOperationSetting = (update) =>
    Effect.succeed({
      ...picture,
      operationSettings: update._tag === "Set" ? [update.row] : [],
    }),
}: ControlStoreStubOptions = {}) =>
  Layer.succeed(ControlStore, {
    health: "available",
    seed,
    picture: read,
    setDaemonLimit,
    establishConnection: () => Effect.succeed(picture),
    revokeConnection: () => Effect.succeed(picture),
    removeConnection: () => Effect.succeed(picture),
    updateOperationSetting,
    installPlugin: () => Effect.succeed(picture),
    uninstallPlugin: () => Effect.succeed(picture),
    updateContributionSetting: () => Effect.succeed(picture),
    withWrite: (effect) => effect,
  });

const daemonLayer = (
  source: Layer.Layer<IssueTracker.IssueTracker | SourceControlProvider>,
  scheduler = schedulerStub(),
  controlStore = controlStoreStub(),
  registries = registryServices,
  plugins: Layer.Layer<PluginManager> = pluginManagerLayer,
  connections = connectionStoreLayer,
) =>
  Daemon.handlersLayer.pipe(
    Layer.provideMerge(Daemon.principalMiddlewareLayer),
    Layer.provideMerge(Daemon.daemonInfoLayer),
    Layer.provideMerge(eventPublisherLayer),
    Layer.provideMerge(Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(registries, source)))),
    Layer.provideMerge(registries),
    Layer.provideMerge(scheduler),
    Layer.provideMerge(runRecorder),
    Layer.provideMerge(runLedgerLayer),
    Layer.provideMerge(RunControl.layer),
    Layer.provideMerge(controlStore),
    Layer.provideMerge(connections),
    Layer.provideMerge(plugins),
    Layer.provideMerge(source),
  );

const registrationServices = () => {
  const cell = MutableRef.make<Registry.RegistryState>(Registry.emptyRegistry);
  const registry: Registry.WorkspaceRegistryService = {
    get workspaces() {
      return MutableRef.get(cell).workspaces;
    },
    get failures() {
      return MutableRef.get(cell).failures;
    },
    refresh: Effect.sync(() => MutableRef.get(cell)),
  };
  const register: Registry.WorkspaceManagementService["register"] = (registration) => {
    const workspace: Registry.RegisteredWorkspace = {
      source: "control-store:minted",
      contributions: [],
      config: {
        name: wsid("0198f16a-21d7-7000-8000-000000000001"),
        displayName: registration.name,
        checkoutPath: registration.checkoutPath,
        issueTracker: registration.issueTracker,
        sourceControl: registration.sourceControl,
        harness: { preferred: harness("codex") },
        linearHistory: registration.linearHistory,
      },
      workspaceLimit: registration.concurrency,
    };
    MutableRef.update(cell, (state) => ({ ...state, workspaces: [...state.workspaces, workspace] }));
    return Effect.succeed({ _tag: "Registered" as const, workspace });
  };
  const deregister: Registry.WorkspaceManagementService["deregister"] = (workspace) => {
    MutableRef.update(cell, (state) => ({
      workspaces: state.workspaces.filter((entry) => entry.config.name !== workspace),
      failures: state.failures.filter((entry) => entry.name !== workspace),
    }));
    return Effect.succeed(workspace);
  };
  const rebind: Registry.WorkspaceManagementService["rebind"] = (workspace, checkoutPath) => {
    const current = MutableRef.get(cell).workspaces.find((entry) => entry.config.name === workspace);
    if (!current) return Effect.die("workspace not found");
    const rebound = { ...current, config: { ...current.config, checkoutPath } };
    MutableRef.update(cell, (state) => ({
      ...state,
      workspaces: state.workspaces.map((entry) => (entry.config.name === workspace ? rebound : entry)),
    }));
    return Effect.succeed({ _tag: "Registered" as const, workspace: rebound });
  };
  return Layer.mergeAll(
    Layer.succeed(Registry.WorkspaceRegistry, registry),
    Layer.succeed(Registry.WorkspaceManagement, { register, deregister, rebind }),
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
  owned: false,
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
      const item = yield* client.CancelRun({ runId: rid("run-1"), note: "stopping this one" });

      assert.strictEqual(item._tag, "NeedsHuman");
      if (item._tag === "NeedsHuman") {
        assert.strictEqual(item.reason, "ready-for-human");
        assert.strictEqual(item.url, "https://linear.app/acme/issue/AUD-1");
      }

      const settled = yield* ledger.getRun(rid("run-1"));
      assert.strictEqual(settled?.status, "interrupted");

      const recorded = yield* Ref.get(calls);
      assert.deepStrictEqual(recorded.released, [id("AUD-1")]);
      assert.deepStrictEqual(recorded.handOff, [
        { workItem: id("AUD-1"), outcome: { stage: "implement", note: "stopping this one" } },
      ]);

      const [published] = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((event) => event._tag === "ItemChanged"),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.strictEqual(published?.item._tag, "NeedsHuman");
    }).pipe(Effect.provide(daemonLayer(recordingTracker([trackerItem()], calls))), Effect.scoped);
  });

  it.effect("fails with RunNotFound for an unknown run", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(client.CancelRun({ runId: rid("ghost") }));
      assert.strictEqual(error._tag, "RunNotFound");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("fails with RunAlreadyFinished for a run that is not running", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord({ status: "succeeded", endedAtMillis: 10 }));
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const error = yield* Effect.flip(client.CancelRun({ runId: rid("run-1") }));
      assert.strictEqual(error._tag, "RunAlreadyFinished");
      if (error._tag === "RunAlreadyFinished") assert.strictEqual(error.status, "succeeded");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("hands off and releases a run whose workspace input has failed", () => {
    const calls = Ref.makeUnsafe(emptyCalls);
    return Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord());
      const client = yield* RpcTest.makeClient(DaemonRpcs);

      const item = yield* client.CancelRun({ runId: rid("run-1") });
      const run = (yield* client.ListRuns()).find(({ id }) => id === rid("run-1"));
      const recorded = yield* Ref.get(calls);

      assert.strictEqual(item._tag, "NeedsHuman");
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

      assert.strictEqual(result?._tag, "Eligible");
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
      if (published?._tag === "ItemChanged") assert.strictEqual(published.item._tag, "Eligible");
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

describe("RunControl", () => {
  it.effect("forgets a registered fiber when it completes", () =>
    Effect.gen(function* () {
      const control = yield* RunControl.RunControl;
      const fiber = yield* Effect.forkChild(Effect.void);
      yield* control.register(rid("run-1"), fiber, registered);
      yield* Fiber.await(fiber);

      assert.isTrue(Option.isNone(yield* control.workspaceFor(rid("run-1"))));
      assert.isFalse(yield* control.cancel(rid("run-1")));
    }).pipe(Effect.provide(RunControl.layer), Effect.scoped),
  );

  it.effect("interrupts registered fibers when its layer closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(RunControl.layer, scope);
      const control = Context.get(context, RunControl.RunControl);
      const fiber = yield* Effect.forkChild(Effect.never);
      yield* control.register(rid("run-1"), fiber);

      yield* Scope.close(scope, Exit.void);

      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
    }),
  );

  it.effect("interrupts a registered fiber on cancel and reports unknown runs", () =>
    Effect.gen(function* () {
      const control = yield* RunControl.RunControl;
      const fiber = yield* Effect.forkChild(Effect.never);
      yield* control.register(rid("run-1"), fiber, registered);

      assert.deepStrictEqual(yield* control.workspaceFor(rid("run-1")), Option.some(registered));
      const cancelled = yield* control.cancel(rid("run-1"));
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(cancelled);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));

      assert.isTrue(Option.isNone(yield* control.workspaceFor(rid("run-1"))));
      assert.isFalse(yield* control.cancel(rid("run-1")));
      assert.isFalse(yield* control.cancel(rid("ghost")));
    }).pipe(Effect.provide(RunControl.layer), Effect.scoped),
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
        Stream.takeUntil((event) => event._tag === "ItemRemoved"),
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
      if (controlStoreChanged?._tag !== "ControlStoreChanged")
        return assert.fail("expected ControlStoreChanged");
      assert.deepStrictEqual(controlStoreChanged.controlStore, returned);
      assert.deepStrictEqual(returned.daemonLimits, {
        globalConcurrency: 8,
        perWorkspaceConcurrency: 4,
        dailyBudget: 50,
        revision: 1,
      });
      assert.strictEqual(schedulerChanged?._tag, "SchedulerChanged");
      if (schedulerChanged?._tag !== "SchedulerChanged") return assert.fail("expected SchedulerChanged");
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
        Stream.takeUntil((event) => event._tag === "ItemRemoved"),
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
              Effect.fail(ControlStoreFailure.make({ operation: "set daemon limit", message: "disk full" })),
          }),
        ),
      ),
      Effect.scoped,
    ),
  );
});

describe("SetOperationSetting", () => {
  const modelUpdate: OperationSettingUpdate = {
    _tag: "Set",
    row: {
      setting: "model",
      level: { _tag: "Operation", workflow: "coding", operation: "implement" },
      scope: { _tag: "SettingsProfile" },
      value: "anthropic/claude-sonnet-4-5",
    },
  };

  it.effect("returns and publishes the same raw Operation setting rows", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const returned = yield* client.SetOperationSetting({ update: modelUpdate });
      const [published] = yield* Stream.fromSubscription(subscription).pipe(
        Stream.take(1),
        Stream.runCollect,
      );

      assert.strictEqual(published?._tag, "ControlStoreChanged");
      if (published?._tag !== "ControlStoreChanged") return assert.fail("expected ControlStoreChanged");
      assert.deepStrictEqual(published.controlStore, returned);
      if (modelUpdate._tag !== "Set") return assert.fail("expected set update");
      assert.deepStrictEqual(returned.operationSettings, [modelUpdate.row]);
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );

  it.effect("refuses a locked setting with its Operation Definition named", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const failure = yield* Effect.flip(
        client.SetOperationSetting({
          update: {
            _tag: "Set",
            row: {
              setting: "permission-profile",
              level: { _tag: "Operation", workflow: "coding", operation: "triage" },
              scope: { _tag: "SettingsProfile" },
              value: "full",
            },
          },
        }),
      );

      assert.strictEqual(failure._tag, "OperationSettingRefused");
      if (failure._tag !== "OperationSettingRefused")
        return assert.fail("expected Operation setting refusal");
      assert.strictEqual(failure.source, "triage Operation Definition");
    }).pipe(Effect.provide(daemonLayer(trackerLayer({}))), Effect.scoped),
  );
});

describe("RegisterWorkspace", () => {
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
          connectionStoreLayerWithStatus("revoked"),
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
        Stream.takeUntil((event) => event._tag === "ItemRemoved"),
        Stream.runCollect,
      );
      assert.strictEqual(workspace._tag, "Registered");
      if (workspace._tag === "Registered") {
        assert.strictEqual(workspace.name, "0198f16a-21d7-7000-8000-000000000001");
        assert.strictEqual(workspace.displayName, "acme");
      }
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["WorkspaceChanged", "ItemRemoved"],
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
        Stream.takeUntil((event) => event._tag === "ItemRemoved"),
        Stream.runCollect,
      );
      assert.deepStrictEqual(workspace, {
        _tag: "Failed",
        source: "/repos/missing",
        message: "Workspace input is missing",
      });
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["WorkspaceChanged", "ItemRemoved"],
      );
    }).pipe(
      Effect.provide(daemonLayer(trackerLayer({}), schedulerStub(), controlStoreStub(), registries)),
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
    connectionStoreLayerWithStatus("established", existing),
  );
  const establishment: ConnectionEstablishment = {
    system: "linear",
    account: "other",
    source: { _tag: "Stored" },
  };

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
        repo: "acme/repo",
      },
      harness: { preferred: "cursor" },
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
          connectionStoreLayerWithStatus("established", null, () => Effect.void),
        ),
      ),
      Effect.scoped,
    );
  });
});

describe("workspace lifecycle commands", () => {
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
      if (registered._tag !== "Registered") return assert.fail("expected registration");

      const deregistered = yield* client.DeregisterWorkspace({ workspace: registered.name });
      yield* bus.publish({ _tag: "ItemRemoved", workspace: wsid("sentinel"), id: id("sentinel") });
      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil((event) => event._tag === "ItemRemoved"),
        Stream.runCollect,
      );

      assert.strictEqual(deregistered, registered.name);
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["WorkspaceChanged", "WorkspaceRemoved", "ControlStoreChanged", "ItemRemoved"],
      );
      const controlStoreChanged = [...events].find((event) => event._tag === "ControlStoreChanged");
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
      if (registered._tag !== "Registered") return assert.fail("expected registration");

      const rebound = yield* client.RebindWorkspace({
        workspace: registered.name,
        checkoutPath: "/repos/moved-acme",
      });
      const events = yield* Stream.fromSubscription(subscription).pipe(Stream.take(2), Stream.runCollect);

      assert.strictEqual(rebound._tag, "Registered");
      assert.strictEqual(rebound._tag === "Registered" ? rebound.checkoutPath : null, "/repos/moved-acme");
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["WorkspaceChanged", "WorkspaceChanged"],
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
      if (registeredState._tag !== "Registered") return assert.fail("expected registration");

      const registry = yield* Registry.WorkspaceRegistry;
      const registeredWorkspace = registry.workspaces.at(0);
      if (!registeredWorkspace) return assert.fail("expected registered workspace");

      const ledger = yield* RunLedger.RunLedger;
      yield* ledger.insertRun(runRecord({ workspace: registeredState.name }));
      const fiber = yield* Effect.forkChild(Effect.never);
      const control = yield* RunControl.RunControl;
      yield* control.register(rid("run-1"), fiber, registeredWorkspace);

      yield* client.DeregisterWorkspace({ workspace: registeredState.name });
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      yield* client.CancelRun({ runId: rid("run-1") });
      yield* bus.publish({ _tag: "ItemRemoved", workspace: wsid("sentinel"), id: id("sentinel") });
      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil((event) => event._tag === "ItemRemoved"),
        Stream.runCollect,
      );

      const recorded = yield* Ref.get(calls);
      assert.deepStrictEqual(recorded.handOff, [
        { workItem: id("AUD-1"), outcome: { stage: "implement", note: undefined } },
      ]);
      assert.deepStrictEqual(recorded.released, [id("AUD-1")]);
      assert.isFalse([...events].some((event) => event._tag === "ItemChanged"));
    }).pipe(
      Effect.provide(
        daemonLayer(recordingTracker([], calls), schedulerStub(), controlStoreStub(), registries),
      ),
      Effect.scoped,
    );
  });
});

describe("Plugin lifecycle commands", () => {
  it.effect("never publishes an older Plugin snapshot after a newer mutation", () =>
    Effect.gen(function* () {
      const firstReady = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const plugins = concurrentPluginManagerLayer(firstReady, releaseFirst);

      return yield* Effect.gen(function* () {
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
          Stream.takeUntil((event) => event._tag === "ItemRemoved"),
          Stream.runCollect,
        );
        const snapshots = [...events]
          .filter((event) => event._tag === "PluginsChanged")
          .map((event) => ({
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
    }),
  );
});
