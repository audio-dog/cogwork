import {
  ControlStoreFailure,
  type ControlStore as ControlStorePicture,
  type DaemonLimitUpdate,
  DaemonRpcs,
  HarnessName,
  IssueTrackerError,
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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { ControlStore, type ControlStoreService } from "./control-store";
import * as Daemon from "./daemon";
import * as DaemonEventBus from "./daemon-event-bus";
import { DaemonEventPublisher, layer as eventPublisherLayer } from "./event-publisher";
import type { HandOffOutcome, ReclassifyOutcome, TrackerItem } from "./issue-tracker";
import * as IssueTracker from "./issue-tracker";
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
  issueTracker: { type: "github", repo: "acme/repo" },
  linearHistory: false,
  concurrency: 2,
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

const picture: ControlStorePicture = {
  daemonLimits: {
    globalConcurrency: 4,
    perWorkspaceConcurrency: 4,
    dailyBudget: 50,
    revision: 0,
  },
};

const controlStoreStub = (
  setDaemonLimit: ControlStoreService["setDaemonLimit"] = (update) =>
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
    }),
) =>
  Layer.succeed(ControlStore, {
    health: "available",
    seed: picture,
    picture: Effect.succeed(picture),
    setDaemonLimit,
    withWrite: (effect) => effect,
  });

const daemonLayer = (
  source: Layer.Layer<IssueTracker.IssueTracker | SourceControlProvider>,
  scheduler = schedulerStub(),
  controlStore = controlStoreStub(),
  registries = registryServices,
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
  return Layer.mergeAll(
    Layer.succeed(Registry.WorkspaceRegistry, registry),
    Layer.succeed(Registry.WorkspaceManagement, { register }),
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
      yield* control.register(rid("run-1"), fiber);
      yield* Fiber.await(fiber);

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
      yield* control.register(rid("run-1"), fiber);

      const cancelled = yield* control.cancel(rid("run-1"));
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(cancelled);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));

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
          controlStoreStub(() =>
            Effect.fail(ControlStoreFailure.make({ operation: "set daemon limit", message: "disk full" })),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );
});

describe("RegisterWorkspace", () => {
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
