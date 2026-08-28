import {
  applyDaemonEvent,
  ClassifiedItem,
  DaemonRpcs,
  defaultControlStore,
  HarnessName,
  initialBoard,
  itemKey,
  RunId,
  type RunRecord,
  SchedulerStats,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
  workspaceFailureState,
  workspaceKey,
  workspaceStateFromInfo,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { ControlStore } from "./control-store";
import * as Daemon from "./daemon";
import * as DaemonEventBus from "./daemon-event-bus";
import { DaemonEventPublisher, layer as eventPublisherLayer } from "./event-publisher";
import { IssueTracker, type IssueTrackerService, type TrackerItem } from "./issue-tracker";
import { classifiedItemsOf, schedulerStatsOf } from "./read-model";
import * as Reconcile from "./reconcile";
import * as Registry from "./registry";
import * as RunControl from "./run-control";
import * as RunLedger from "./run-ledger";
import { layer as runRecorderLayer } from "./run-recorder";
import * as Scheduler from "./scheduler";
import { SourceControlProvider } from "./source-control";

const runLedgerTestLayer = RunLedger.layerMemory.pipe(Layer.provideMerge(DaemonEventBus.layer));
const runRecorderTestLayer = runRecorderLayer.pipe(Layer.provide(runLedgerTestLayer));
const controlStoreLayer = Layer.succeed(ControlStore, {
  health: "available",
  seed: defaultControlStore,
  picture: Effect.succeed(defaultControlStore),
  setDaemonLimit: () => Effect.succeed(defaultControlStore),
  updateOperationSetting: () => Effect.succeed(defaultControlStore),
  updateContributionSetting: () => Effect.succeed(defaultControlStore),
  withWrite: (effect) => effect,
});

const id = Schema.decodeSync(WorkItemId);
const stats = Schema.decodeSync(SchedulerStats);
const workspaceId = Schema.decodeSync(WorkspaceId);
const classifiedItem = Schema.decodeSync(ClassifiedItem);
const runId = Schema.decodeSync(RunId);
const harnessName = Schema.decodeSync(HarnessName);

const registeredWorkspace: Registry.RegisteredWorkspace = {
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
  Registry.readOnlyRegistry({ workspaces: [registeredWorkspace], failures: [] }),
);

const mutableRegistryLayer = (state: MutableRef.MutableRef<Registry.RegistryState>) =>
  Layer.succeed(Registry.WorkspaceRegistry, {
    get workspaces() {
      return MutableRef.get(state).workspaces;
    },
    get failures() {
      return MutableRef.get(state).failures;
    },
    refresh: Effect.sync(() => MutableRef.get(state)),
  });

const trackerStub = (observe: IssueTrackerService["observe"]): IssueTrackerService => ({
  rateLimitScope: () => null,
  observe,
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
});

const providerStub = Layer.succeed(SourceControlProvider, {
  observe: () => Effect.succeed(new Map()),
  comment: () => Effect.void,
});

const observing = (itemsRef: Ref.Ref<ReadonlyArray<TrackerItem>>) =>
  Layer.mergeAll(
    Layer.succeed(
      IssueTracker,
      trackerStub(() => Ref.get(itemsRef)),
    ),
    providerStub,
  );

const schedulerState = (global: number): Scheduler.SchedulerState => ({
  ...Scheduler.initialState,
  global,
  perWorkspace: new Map(),
  budgetDay: 0,
  budgetUsed: 0,
});

const schedulerStub = (statsRef: Ref.Ref<Scheduler.SchedulerState>) =>
  Layer.succeed(Scheduler.Scheduler, {
    tick: () => Effect.succeed(0),
    awaitIdle: Effect.void,
    drain: () => Effect.succeed({ inFlight: 0, interrupted: 0 }),
    admit: () => Effect.void,
    isInFlight: () => Effect.succeed(false),
    setScheduling: () => Ref.get(statsRef),
    setLimit: () => Effect.succeed({ globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 50 }),
    config: Effect.succeed({ globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 50 }),
    stats: Ref.get(statsRef),
  });

const eligibleItem = (title: string): TrackerItem => ({
  id: id("AUD-1"),
  title,
  url: "https://linear.app/acme/issue/AUD-1",
  roles: ["ready-for-agent"],
  assignees: [],
  claimLabeled: false,
  claim: null,
  claimedByUs: false,
  attempts: [],
  owned: false,
  followUp: null,
  openBlockers: 0,
  proposal: null,
  priority: "medium",
});

const parkedItem = (title: string): TrackerItem => ({ ...eligibleItem(title), roles: ["needs-info"] });

const runningRun: RunRecord = {
  id: runId("run-seed"),
  workspace: workspaceId("example"),
  workItem: id("AUD-1"),
  stage: "implement",
  harness: harnessName("cursor"),
  branch: null,
  session: null,
  usage: null,
  status: "running",
  startedAtMillis: 0,
  endedAtMillis: null,
};

const schedulerSentinel = {
  _tag: "SchedulerChanged",
  scheduler: stats({
    scheduling: "running",
    globalInFlight: 99,
    globalLimit: 4,
    perWorkspaceLimit: 4,
    dailyBudgetUsed: 0,
    dailyBudgetLimit: 10,
    perWorkspace: [],
  }),
} as const;

const itemSentinelEvent = {
  _tag: "ItemChanged",
  workspace: workspaceId("marker"),
  item: classifiedItem({ _tag: "Eligible", id: "AUD-marker", title: "marker", url: null, stage: "triage" }),
} as const;

const publisherLayer = (
  itemsRef: Ref.Ref<ReadonlyArray<TrackerItem>>,
  statsRef: Ref.Ref<Scheduler.SchedulerState>,
  workspaces = registryLayer,
) =>
  eventPublisherLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(workspaces, observing(itemsRef)))),
        workspaces,
        schedulerStub(statsRef),
        DaemonEventBus.layer,
      ),
    ),
  );

describe("DaemonEventPublisher", () => {
  it.effect("does not publish stale items after their workspace leaves the registry", () =>
    Effect.gen(function* () {
      const itemsRef = yield* Ref.make<ReadonlyArray<TrackerItem>>([eligibleItem("stale")]);
      const statsRef = yield* Ref.make(schedulerState(0));
      const registryState = MutableRef.make<Registry.RegistryState>({
        workspaces: [registeredWorkspace],
        failures: [],
      });
      const workspaces = mutableRegistryLayer(registryState);
      yield* Effect.gen(function* () {
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const worker = yield* Reconcile.ReconcileWorker;
        const publisher = yield* DaemonEventPublisher;
        const subscription = yield* bus.subscribe();

        yield* worker.submit();
        MutableRef.set(registryState, Registry.emptyRegistry);
        yield* publisher.publishWorkspaceRemoved(registeredWorkspace.config.name);
        yield* publisher.publishItems();
        yield* bus.publish(schedulerSentinel);

        const events = yield* Stream.fromSubscription(subscription).pipe(Stream.take(2), Stream.runCollect);
        assert.deepStrictEqual(
          [...events].map((event) => event._tag),
          ["WorkspaceRemoved", "SchedulerChanged"],
        );
      }).pipe(Effect.provide(publisherLayer(itemsRef, statsRef, workspaces)), Effect.scoped);
    }),
  );

  it.effect("emits ItemChanged only for items whose classified read model changed", () =>
    Effect.gen(function* () {
      const itemsRef = yield* Ref.make<ReadonlyArray<TrackerItem>>([eligibleItem("first")]);
      const statsRef = yield* Ref.make(schedulerState(0));
      yield* Effect.gen(function* () {
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const worker = yield* Reconcile.ReconcileWorker;
        const publisher = yield* DaemonEventPublisher;
        const subscription = yield* bus.subscribe();

        yield* worker.submit();
        yield* publisher.publishItems();
        yield* publisher.publishItems();

        yield* Ref.set(itemsRef, [eligibleItem("second")]);
        yield* worker.submit();
        yield* publisher.publishItems();

        yield* bus.publish(schedulerSentinel);
        const events = yield* Stream.fromSubscription(subscription).pipe(Stream.take(3), Stream.runCollect);
        assert.deepStrictEqual(
          [...events].map((event) => event._tag),
          ["ItemChanged", "ItemChanged", "SchedulerChanged"],
        );
      }).pipe(Effect.provide(publisherLayer(itemsRef, statsRef)), Effect.scoped);
    }),
  );

  it.effect("emits SchedulerChanged only when the scheduler read model changes", () =>
    Effect.gen(function* () {
      const itemsRef = yield* Ref.make<ReadonlyArray<TrackerItem>>([]);
      const statsRef = yield* Ref.make(schedulerState(1));
      yield* Effect.gen(function* () {
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const publisher = yield* DaemonEventPublisher;
        const subscription = yield* bus.subscribe();

        yield* publisher.publishScheduler();
        yield* publisher.publishScheduler();
        yield* Ref.set(statsRef, schedulerState(2));
        yield* publisher.publishScheduler();

        yield* bus.publish(itemSentinelEvent);
        const events = [
          ...(yield* Stream.fromSubscription(subscription).pipe(Stream.take(3), Stream.runCollect)),
        ];
        const inFlight = events.flatMap((event) =>
          event._tag === "SchedulerChanged" ? [event.scheduler.globalInFlight] : [],
        );
        assert.deepStrictEqual(inFlight, [1, 2]);
        assert.strictEqual(events.at(-1)?._tag, "ItemChanged");
      }).pipe(Effect.provide(publisherLayer(itemsRef, statsRef)), Effect.scoped);
    }),
  );

  it.effect("emits ItemRemoved so a board folded through churn drops the closed item", () =>
    Effect.gen(function* () {
      const itemsRef = yield* Ref.make<ReadonlyArray<TrackerItem>>([eligibleItem("first")]);
      const statsRef = yield* Ref.make(schedulerState(0));
      yield* Effect.gen(function* () {
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const worker = yield* Reconcile.ReconcileWorker;
        const publisher = yield* DaemonEventPublisher;
        const subscription = yield* bus.subscribe();

        yield* worker.submit();
        yield* publisher.publishItems();

        yield* Ref.set(itemsRef, [parkedItem("first")]);
        yield* worker.submit();
        yield* publisher.publishItems();

        yield* Ref.set(itemsRef, []);
        yield* worker.submit();
        yield* publisher.publishItems();

        const events = [
          ...(yield* Stream.fromSubscription(subscription).pipe(Stream.take(3), Stream.runCollect)),
        ];
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          ["ItemChanged", "ItemChanged", "ItemRemoved"],
        );
        const board = events.reduce(applyDaemonEvent, initialBoard);
        assert.strictEqual(board.items.size, 0);
      }).pipe(Effect.provide(publisherLayer(itemsRef, statsRef)), Effect.scoped);
    }),
  );

  const daemonLayer = (
    itemsRef: Ref.Ref<ReadonlyArray<TrackerItem>>,
    statsRef: Ref.Ref<Scheduler.SchedulerState>,
    workspaces = registryLayer,
  ) =>
    Daemon.handlersLayer.pipe(
      Layer.provideMerge(Daemon.principalMiddlewareLayer),
      Layer.provideMerge(Daemon.daemonInfoLayer),
      Layer.provideMerge(eventPublisherLayer),
      Layer.provideMerge(
        Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(workspaces, observing(itemsRef)))),
      ),
      Layer.provideMerge(workspaces),
      Layer.provideMerge(Registry.managementReadOnlyLayer),
      Layer.provideMerge(schedulerStub(statsRef)),
      Layer.provideMerge(runRecorderTestLayer),
      Layer.provideMerge(runLedgerTestLayer),
      Layer.provideMerge(RunControl.layer),
      Layer.provideMerge(controlStoreLayer),
      Layer.provideMerge(observing(itemsRef)),
    );

  it.effect("lets a client track the board live from WatchEvents, matching GetStatus", () =>
    Effect.gen(function* () {
      const itemsRef = yield* Ref.make<ReadonlyArray<TrackerItem>>([eligibleItem("first")]);
      const statsRef = yield* Ref.make(schedulerState(0));
      yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(DaemonRpcs);
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const worker = yield* Reconcile.ReconcileWorker;

        yield* worker.submit();
        const state = (yield* worker.snapshot).workspaces[0];
        if (state === undefined) return assert.fail("expected a reconciled workspace");
        const [item] = classifiedItemsOf(state);
        if (item === undefined) return assert.fail("expected a classified item");
        const changed = { _tag: "ItemChanged", workspace: state.name, item } as const;

        const watcher = yield* client.WatchEvents().pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
        yield* bus.publish(changed).pipe(Effect.andThen(Effect.yieldNow), Effect.repeat(Schedule.recurs(50)));
        const received = yield* Fiber.join(watcher);

        const trackedIds = [...received].flatMap((event) =>
          event._tag === "ItemChanged" && event.item._tag === "Eligible" ? [event.item.id] : [],
        );
        assert.deepStrictEqual(trackedIds, [id("AUD-1")]);

        const status = yield* client.GetStatus();
        assert.strictEqual(status.workspaces[0]?.eligible[0]?.id, id("AUD-1"));
      }).pipe(Effect.provide(daemonLayer(itemsRef, statsRef)), Effect.scoped);
    }),
  );

  it.effect("self-seeds WatchEvents so folding the seed equals the daemon's read models", () =>
    Effect.gen(function* () {
      const itemsRef = yield* Ref.make<ReadonlyArray<TrackerItem>>([eligibleItem("first")]);
      const statsRef = yield* Ref.make(schedulerState(1));
      yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(DaemonRpcs);
        const worker = yield* Reconcile.ReconcileWorker;
        const ledger = yield* RunLedger.RunLedger;
        const scheduler = yield* Scheduler.Scheduler;
        const registry = yield* Registry.WorkspaceRegistry;

        yield* worker.submit();
        yield* ledger.insertRun(runningRun);

        const seed = [
          ...(yield* client.WatchEvents().pipe(
            Stream.takeUntil((event) => event._tag === "SeedEnd"),
            Stream.runCollect,
          )),
        ];
        const board = seed.reduce(applyDaemonEvent, initialBoard);

        const state = (yield* worker.snapshot).workspaces[0];
        if (state === undefined) return assert.fail("expected a reconciled workspace");
        const expectedItems = new Map(
          classifiedItemsOf(state).map(
            (item) => [itemKey(state.name, item.id), { workspace: state.name, item }] as const,
          ),
        );
        const expectedRuns = new Map((yield* ledger.runningRuns).map((run) => [run.id, run] as const));
        const expectedScheduler = schedulerStatsOf(registry, yield* scheduler.config, yield* scheduler.stats);

        const status = yield* client.GetStatus();
        const expectedWorkspaces = new Map(
          [
            ...status.workspaces.map(workspaceStateFromInfo),
            ...status.failures.map(workspaceFailureState),
          ].map((workspace) => [workspaceKey(workspace), workspace] as const),
        );

        assert.deepStrictEqual(board.items, expectedItems);
        assert.deepStrictEqual(board.runs, expectedRuns);
        assert.deepStrictEqual(board.workspaces, expectedWorkspaces);
        assert.deepStrictEqual(board.scheduler, expectedScheduler);
        assert.deepStrictEqual(board.controlStore, defaultControlStore);
      }).pipe(Effect.provide(daemonLayer(itemsRef, statsRef)), Effect.scoped);
    }),
  );

  it.effect("does not seed stale items after their workspace leaves the registry", () =>
    Effect.gen(function* () {
      const itemsRef = yield* Ref.make<ReadonlyArray<TrackerItem>>([eligibleItem("stale")]);
      const statsRef = yield* Ref.make(schedulerState(0));
      const registryState = MutableRef.make<Registry.RegistryState>({
        workspaces: [registeredWorkspace],
        failures: [],
      });
      const workspaces = mutableRegistryLayer(registryState);
      yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(DaemonRpcs);
        const worker = yield* Reconcile.ReconcileWorker;

        yield* worker.submit();
        MutableRef.set(registryState, Registry.emptyRegistry);
        const seed = yield* client.WatchEvents().pipe(
          Stream.takeUntil((event) => event._tag === "SeedEnd"),
          Stream.runCollect,
        );

        assert.isFalse([...seed].some((event) => event._tag === "ItemChanged"));
      }).pipe(Effect.provide(daemonLayer(itemsRef, statsRef, workspaces)), Effect.scoped);
    }),
  );

  it.effect("places one SeedEnd after the stamped seed and keeps it out of the event bus", () =>
    Effect.gen(function* () {
      const itemsRef = yield* Ref.make<ReadonlyArray<TrackerItem>>([eligibleItem("first")]);
      const statsRef = yield* Ref.make(schedulerState(1));
      yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(DaemonRpcs);
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const worker = yield* Reconcile.ReconcileWorker;
        const subscription = yield* bus.subscribe();

        yield* worker.submit();
        const state = (yield* worker.snapshot).workspaces[0];
        if (state === undefined) return assert.fail("expected a reconciled workspace");
        const [item] = classifiedItemsOf(state);
        if (item === undefined) return assert.fail("expected a classified item");
        const live = { _tag: "ItemRemoved", workspace: state.name, id: item.id } as const;

        const watcher = yield* client.WatchEvents().pipe(
          Stream.takeUntil((event) => event._tag === "ItemRemoved"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const busEvent = yield* Stream.fromSubscription(subscription).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* bus.publish(live).pipe(Effect.andThen(Effect.yieldNow), Effect.repeat(Schedule.recurs(50)));

        const received = [...(yield* Fiber.join(watcher))];
        const observedByBus = [...(yield* Fiber.join(busEvent))];
        const boundary = received.filter((event) => event._tag === "SeedEnd");
        const boundaryIndex = received.findIndex((event) => event._tag === "SeedEnd");
        const seed = received.slice(0, boundaryIndex);

        assert.strictEqual(boundary.length, 1);
        assert.strictEqual(received[boundaryIndex + 1]?._tag, "ItemRemoved");
        assert.strictEqual(new Set(seed.map((event) => event.emittedAtMillis)).size, 1);
        assert.strictEqual(typeof boundary[0]?.emittedAtMillis, "number");
        assert.deepStrictEqual(
          observedByBus.map((event) => event._tag),
          ["ItemRemoved"],
        );
      }).pipe(Effect.provide(daemonLayer(itemsRef, statsRef)), Effect.scoped);
    }),
  );

  const failingRegistryLayer = Layer.succeed(
    Registry.WorkspaceRegistry,
    Registry.readOnlyRegistry({
      workspaces: [],
      failures: [{ source: "broken.workspace.ts", message: "config threw at import" }],
    }),
  );

  const failedLoadDaemonLayer = (
    itemsRef: Ref.Ref<ReadonlyArray<TrackerItem>>,
    statsRef: Ref.Ref<Scheduler.SchedulerState>,
  ) =>
    Daemon.handlersLayer.pipe(
      Layer.provideMerge(Daemon.principalMiddlewareLayer),
      Layer.provideMerge(Daemon.daemonInfoLayer),
      Layer.provideMerge(eventPublisherLayer),
      Layer.provideMerge(
        Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(failingRegistryLayer, observing(itemsRef)))),
      ),
      Layer.provideMerge(failingRegistryLayer),
      Layer.provideMerge(Registry.managementReadOnlyLayer),
      Layer.provideMerge(schedulerStub(statsRef)),
      Layer.provideMerge(runRecorderTestLayer),
      Layer.provideMerge(runLedgerTestLayer),
      Layer.provideMerge(RunControl.layer),
      Layer.provideMerge(observing(itemsRef)),
    );

  it.effect("seeds a failed-to-load workspace onto the board with its failure", () =>
    Effect.gen(function* () {
      const itemsRef = yield* Ref.make<ReadonlyArray<TrackerItem>>([]);
      const statsRef = yield* Ref.make(schedulerState(0));
      yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(DaemonRpcs);

        const seed = [
          ...(yield* client.WatchEvents().pipe(
            Stream.takeUntil((event) => event._tag === "SchedulerChanged"),
            Stream.runCollect,
          )),
        ];
        const board = seed.reduce(applyDaemonEvent, initialBoard);

        const failed = board.workspaces.get("broken.workspace.ts");
        assert.strictEqual(failed?._tag, "Failed");
        assert.strictEqual(failed?._tag === "Failed" ? failed.message : null, "config threw at import");

        const status = yield* client.GetStatus();
        assert.strictEqual(status.failures[0]?.source, "broken.workspace.ts");
      }).pipe(Effect.provide(failedLoadDaemonLayer(itemsRef, statsRef)), Effect.scoped);
    }),
  );
});
