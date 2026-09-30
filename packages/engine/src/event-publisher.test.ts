import {
  applyDaemonEvent,
  ClassifiedItem,
  ControlStoreFailure,
  type ControlStore as ControlStorePicture,
  DaemonEvent,
  DaemonRpcs,
  defaultControlStore,
  HarnessName,
  initialBoard,
  itemKey,
  localOwnerId,
  PluginFailure,
  RunId,
  type RunRecord,
  SchedulerStats,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
  WorkspaceState,
  workspaceFailureState,
  workspaceKey,
  workspaceStateFromInfo,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as MutableRef from "effect/MutableRef";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { ControlStore, type ControlStoreService } from "./control-store";
import * as Daemon from "./daemon";
import * as DaemonEventBus from "./daemon-event-bus";
import {
  controlStoreWithDiagnostics,
  DaemonEventPublisher,
  layer as eventPublisherLayer,
} from "./event-publisher";
import { IssueTracker, type IssueTrackerService, type TrackerItem } from "./issue-tracker";
import { PluginManager } from "./plugin";
import { classifiedItemsOf, schedulerStatsOf } from "./read-model";
import * as Reconcile from "./reconcile";
import * as Registry from "./registry";
import * as RunControl from "./run-control";
import * as RunLedger from "./run-ledger";
import * as Scheduler from "./scheduler";
import { SourceControlProvider } from "./source-control";
import { engineTestLayer } from "./testing/engine-test-layer";
import { harnessProbeTestLayer } from "./testing/harness-probe-layer";

const engineServices = engineTestLayer();
const controlStoreService = {
  health: "available",
  seed: defaultControlStore,
  picture: Effect.succeed(defaultControlStore),
  setDaemonLimit: () => Effect.succeed(defaultControlStore),
  establishConnection: () => Effect.succeed(defaultControlStore),
  revokeConnection: () => Effect.succeed(defaultControlStore),
  removeConnection: () => Effect.succeed(defaultControlStore),
  setHarnessEnabled: () => Effect.succeed(defaultControlStore),
  updateOperationSettings: () => Effect.succeed(defaultControlStore),
  installPlugin: () => Effect.succeed(defaultControlStore),
  uninstallPlugin: () => Effect.succeed(defaultControlStore),
  updateContributionSetting: () => Effect.succeed(defaultControlStore),
  withWrite: (effect) => effect,
} satisfies ControlStoreService;
const controlStoreLayer = Layer.succeed(ControlStore, controlStoreService);
const pluginManagerLayer = Layer.succeed(PluginManager, {
  overview: Effect.succeed({ plugins: [] }),
  install: () => Effect.die(new Error("unexpected Plugin install")),
  uninstall: () => Effect.die(new Error("unexpected Plugin uninstall")),
  contributions: () => Effect.succeed([]),
});
const reconcileLayer = Reconcile.layer.pipe(
  Layer.provide(DaemonEventBus.layer),
  Layer.provide(pluginManagerLayer),
);

interface EventPublisherProbeService {
  readonly items: Ref.Ref<ReadonlyArray<TrackerItem>>;
  readonly stats: Ref.Ref<Scheduler.SchedulerState>;
  readonly registry: Ref.Ref<Registry.RegistryState>;
}

class EventPublisherProbe extends Context.Service<EventPublisherProbe, EventPublisherProbeService>()(
  "@cogwork/engine/event-publisher.test/EventPublisherProbe",
) {
  static readonly layer = (items: ReadonlyArray<TrackerItem> = [], globalInFlight = 0) =>
    Layer.effect(
      EventPublisherProbe,
      Effect.gen(function* () {
        return {
          items: yield* Ref.make(items),
          stats: yield* Ref.make(schedulerState(globalInFlight)),
          registry: yield* Ref.make<Registry.RegistryState>({
            workspaces: [registeredWorkspace],
            failures: [],
          }),
        };
      }),
    );
}

interface SnapshotRefreshProbeService {
  readonly reconciles: Ref.Ref<number>;
  readonly starts: Queue.Queue<number>;
  readonly releases: Queue.Queue<void>;
}

class SnapshotRefreshProbe extends Context.Service<SnapshotRefreshProbe, SnapshotRefreshProbeService>()(
  "@cogwork/engine/event-publisher.test/SnapshotRefreshProbe",
) {
  static readonly layer = Layer.effect(
    SnapshotRefreshProbe,
    Effect.gen(function* () {
      return {
        reconciles: yield* Ref.make(0),
        starts: yield* Queue.make<number>(),
        releases: yield* Queue.make<void>(),
      };
    }),
  );
}

interface ControlStoreProbeService {
  readonly current: Ref.Ref<ControlStorePicture>;
  readonly readStarted: Deferred.Deferred<void>;
  readonly releaseRead: Deferred.Deferred<void>;
}

class ControlStoreProbe extends Context.Service<ControlStoreProbe, ControlStoreProbeService>()(
  "@cogwork/engine/event-publisher.test/ControlStoreProbe",
) {
  static readonly layer = Layer.effect(
    ControlStoreProbe,
    Effect.gen(function* () {
      return {
        current: yield* Ref.make(defaultControlStore),
        readStarted: yield* Deferred.make<void>(),
        releaseRead: yield* Deferred.make<void>(),
      };
    }),
  );
}

class LogMessages extends Context.Service<LogMessages, MutableRef.MutableRef<ReadonlyArray<string>>>()(
  "@cogwork/engine/event-publisher.test/LogMessages",
) {
  static readonly layer = Layer.sync(LogMessages, () => MutableRef.make<ReadonlyArray<string>>([]));
  static readonly captureLayer = Logger.layer([
    Effect.map(LogMessages, (messages) =>
      Logger.make(({ message }) => MutableRef.update(messages, (current) => [...current, String(message)])),
    ),
  ]).pipe(Layer.provideMerge(LogMessages.layer));
}

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
  }),
};

const registryLayer = Layer.succeed(
  Registry.WorkspaceRegistry,
  Registry.readOnlyRegistry({ workspaces: [registeredWorkspace], failures: [] }),
);

describe("controlStoreWithDiagnostics", () => {
  it("keeps installed Plugin contribution settings valid", () => {
    const controlStore: ControlStorePicture = {
      ...defaultControlStore,
      pluginInstalls: [
        {
          pluginId: "linear",
          resolvedIdentity: "linear@1.0.0",
          principal: localOwnerId,
          installedAtMillis: 1,
        },
      ],
      contributionSettings: [
        {
          contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
          scope: { _tag: "SettingsProfile" },
          enabled: true,
        },
      ],
    };

    const picture = controlStoreWithDiagnostics(controlStore, { workspaces: [], failures: [] });

    assert.isUndefined(picture.contributionSettings[0]?.diagnostic);
  });

  it("marks an installed Plugin overlay for a removed workspace dangling", () => {
    const controlStore: ControlStorePicture = {
      ...defaultControlStore,
      pluginInstalls: [
        {
          pluginId: "linear",
          resolvedIdentity: "linear@1.0.0",
          principal: localOwnerId,
          installedAtMillis: 1,
        },
      ],
      contributionSettings: [
        {
          contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace: workspaceId("removed") },
          enabled: false,
        },
      ],
    };

    const picture = controlStoreWithDiagnostics(controlStore, { workspaces: [], failures: [] });

    assert.strictEqual(picture.contributionSettings[0]?.diagnostic?._tag, "Dangling");
  });
});

const mutableRegistryLayer = Layer.effect(
  Registry.WorkspaceRegistry,
  Effect.map(EventPublisherProbe, (probe) => ({
    state: Ref.get(probe.registry),
    refresh: Ref.get(probe.registry),
  })),
);

const trackerStub = (observe: IssueTrackerService["observe"]): IssueTrackerService => ({
  rateLimitScope: () => null,
  observe,
  readProse: () => Effect.succeed({ body: "", comments: [] }),
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
});

const providerStub = Layer.succeed(SourceControlProvider, {
  observe: () => Effect.succeed(new Map()),
  comment: () => Effect.void,
  findOpenPullRequest: () => Effect.succeed(null),
  openPullRequest: () => Effect.succeed({ number: 1, url: "https://example.test/pull/1" }),
});

const observationSources = <R>(issueTracker: Layer.Layer<IssueTracker, never, R>) =>
  Layer.mergeAll(issueTracker, providerStub);

const observing = observationSources(
  Layer.effect(
    IssueTracker,
    Effect.map(EventPublisherProbe, (probe) => trackerStub(() => Ref.get(probe.items))),
  ),
);

const snapshotRefreshObserving = observationSources(
  Layer.effect(
    IssueTracker,
    Effect.gen(function* () {
      const publisherProbe = yield* EventPublisherProbe;
      const refreshProbe = yield* SnapshotRefreshProbe;
      return trackerStub(() =>
        Ref.updateAndGet(refreshProbe.reconciles, (current) => current + 1).pipe(
          Effect.tap((sequence) => Queue.offer(refreshProbe.starts, sequence)),
          Effect.andThen(Queue.take(refreshProbe.releases)),
          Effect.andThen(Ref.get(publisherProbe.items)),
        ),
      );
    }),
  ),
);

const schedulerState = (global: number): Scheduler.SchedulerState => ({
  ...Scheduler.initialState,
  global,
  perWorkspace: new Map(),
  budgetDay: 0,
  budgetUsed: 0,
});

const schedulerStub = Layer.effect(
  Scheduler.Scheduler,
  Effect.map(EventPublisherProbe, (probe) => ({
    tick: () => Effect.succeed(0),
    awaitIdle: Effect.void,
    drain: () => Effect.succeed({ inFlight: 0, interrupted: 0 }),
    admit: () => Effect.void,
    isInFlight: () => Effect.succeed(false),
    setScheduling: () => Ref.get(probe.stats),
    setLimit: () => Effect.succeed({ globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 50 }),
    config: Effect.succeed({ globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 50 }),
    stats: Ref.get(probe.stats),
  })),
);

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
  handback: null,
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

const publisherLayer = <TrackerRequirements>(
  sources: Layer.Layer<IssueTracker | SourceControlProvider, never, TrackerRequirements>,
  workspaces = mutableRegistryLayer,
  store = controlStoreLayer,
) =>
  eventPublisherLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        reconcileLayer.pipe(Layer.provide(Layer.mergeAll(workspaces, sources))),
        workspaces,
        schedulerStub,
        store,
        DaemonEventBus.layer,
      ),
    ),
  );

const publisherTestLayer = (items: ReadonlyArray<TrackerItem> = [], globalInFlight = 0) =>
  publisherLayer(observing).pipe(Layer.provideMerge(EventPublisherProbe.layer(items, globalInFlight)));

const snapshotRefreshPublisherLayer = publisherLayer(snapshotRefreshObserving);

describe("DaemonEventPublisher", () => {
  it.effect("reconciles and publishes Workspace changes after a background refresh request", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const publisher = yield* DaemonEventPublisher;
      const worker = yield* Reconcile.ReconcileWorker;
      const subscription = yield* bus.subscribe();

      yield* publisher.requestSnapshotRefresh();
      const [published] = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(DaemonEvent.guards.WorkspaceChanged),
        Stream.take(1),
        Stream.runCollect,
      );

      assert.strictEqual(published?._tag, "WorkspaceChanged");
      assert.strictEqual((yield* worker.snapshot).generation, 1);
    }).pipe(Effect.provide(publisherTestLayer()), Effect.scoped),
  );

  it.effect("coalesces a mutation burst into one follow-up snapshot refresh", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const publisher = yield* DaemonEventPublisher;
      const publisherProbe = yield* EventPublisherProbe;
      const refreshProbe = yield* SnapshotRefreshProbe;
      const subscription = yield* bus.subscribe();
      const publishedItems = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(DaemonEvent.guards.ItemChanged),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* publisher.requestSnapshotRefresh();
      assert.strictEqual(yield* Queue.take(refreshProbe.starts), 1);
      yield* Effect.all(
        [
          publisher.requestSnapshotRefresh(),
          publisher.requestSnapshotRefresh(),
          publisher.requestSnapshotRefresh(),
        ],
        { concurrency: "unbounded", discard: true },
      );
      yield* Queue.offer(refreshProbe.releases, undefined);

      assert.strictEqual(yield* Queue.take(refreshProbe.starts), 2);
      const unexpectedThird = yield* Queue.take(refreshProbe.starts).pipe(
        Effect.timeout("1 second"),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Ref.set(publisherProbe.items, [eligibleItem("after burst")]);
      yield* Queue.offer(refreshProbe.releases, undefined);

      const published = [...(yield* Fiber.join(publishedItems))];
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      const noThird = yield* Fiber.join(unexpectedThird);

      assert.deepStrictEqual(
        published.map((event) => event.item.title),
        ["first", "after burst"],
      );
      assert.isTrue(Cause.isTimeoutError(noThird));
      assert.strictEqual(yield* Ref.get(refreshProbe.reconciles), 2);
    }).pipe(
      Effect.provide(
        snapshotRefreshPublisherLayer.pipe(
          Layer.provideMerge(EventPublisherProbe.layer([eligibleItem("first")])),
          Layer.provideMerge(SnapshotRefreshProbe.layer),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.layer(
    publisherLayer(
      observing,
      registryLayer,
      Layer.effect(
        ControlStore,
        Effect.gen(function* () {
          const probe = yield* ControlStoreProbe;
          const gate = Semaphore.makeUnsafe(1);
          return {
            health: "available",
            seed: defaultControlStore,
            picture: Ref.get(probe.current).pipe(
              Effect.tap(() => Deferred.succeed(probe.readStarted, undefined)),
              Effect.tap(() => Deferred.await(probe.releaseRead)),
            ),
            setDaemonLimit: () => Ref.get(probe.current),
            establishConnection: () => Ref.get(probe.current),
            revokeConnection: () => Ref.get(probe.current),
            removeConnection: () => Ref.get(probe.current),
            setHarnessEnabled: () => Ref.get(probe.current),
            updateOperationSettings: () => Ref.get(probe.current),
            installPlugin: () => Ref.get(probe.current),
            uninstallPlugin: () => Ref.get(probe.current),
            updateContributionSetting: () => Ref.get(probe.current),
            withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermits(1)(effect),
          } satisfies ControlStoreService;
        }),
      ).pipe(Layer.provideMerge(ControlStoreProbe.layer)),
    ).pipe(Layer.provideMerge(EventPublisherProbe.layer()), Layer.provideMerge(ControlStoreProbe.layer)),
  )("Control store refresh", (it) => {
    it.effect("keeps a concurrent write newer than a workspace refresh", () =>
      Effect.gen(function* () {
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const worker = yield* Reconcile.ReconcileWorker;
        const publisher = yield* DaemonEventPublisher;
        const store = yield* ControlStore;
        const probe = yield* ControlStoreProbe;
        const subscription = yield* bus.subscribe();
        const updated: ControlStorePicture = {
          ...defaultControlStore,
          contributionSettings: [
            {
              contribution: { id: "github", kind: "mcp-server" },
              scope: { _tag: "SettingsProfile" },
              enabled: true,
            },
          ],
        };

        yield* worker.submit();
        const refresh = yield* Effect.forkChild(publisher.publishWorkspaces());
        yield* Deferred.await(probe.readStarted);
        const write = yield* Effect.forkChild(
          store.withWrite(
            Ref.set(probe.current, updated).pipe(Effect.andThen(publisher.publishControlStore(updated))),
          ),
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(probe.releaseRead, undefined);
        yield* Fiber.join(refresh);
        yield* Fiber.join(write);
        yield* bus.publish(itemSentinelEvent);

        const events = yield* Stream.fromSubscription(subscription).pipe(Stream.take(4), Stream.runCollect);
        const board = [...events].reduce(applyDaemonEvent, initialBoard);
        assert.strictEqual(board.controlStore?.contributionSettings[0]?.enabled, true);
      }),
    );
  });

  it.effect("does not publish stale items after their workspace leaves the registry", () =>
    Effect.gen(function* () {
      const probe = yield* EventPublisherProbe;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const worker = yield* Reconcile.ReconcileWorker;
      const publisher = yield* DaemonEventPublisher;
      const subscription = yield* bus.subscribe();

      yield* worker.submit();
      yield* Ref.set(probe.registry, Registry.emptyRegistry);
      yield* publisher.publishWorkspaceRemoved(registeredWorkspace.config.name);
      yield* publisher.publishItems();
      yield* bus.publish(schedulerSentinel);

      const events = yield* Stream.fromSubscription(subscription).pipe(Stream.take(2), Stream.runCollect);
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["WorkspaceRemoved", "SchedulerChanged"],
      );
    }).pipe(Effect.provide(publisherTestLayer([eligibleItem("stale")])), Effect.scoped),
  );

  it.effect("emits ItemChanged only for items whose classified read model changed", () =>
    Effect.gen(function* () {
      const probe = yield* EventPublisherProbe;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const worker = yield* Reconcile.ReconcileWorker;
      const publisher = yield* DaemonEventPublisher;
      const subscription = yield* bus.subscribe();

      yield* worker.submit();
      yield* publisher.publishItems();
      yield* publisher.publishItems();

      yield* Ref.set(probe.items, [eligibleItem("second")]);
      yield* worker.submit();
      yield* publisher.publishItems();

      yield* bus.publish(schedulerSentinel);
      const events = yield* Stream.fromSubscription(subscription).pipe(Stream.take(3), Stream.runCollect);
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["ItemChanged", "ItemChanged", "SchedulerChanged"],
      );
    }).pipe(Effect.provide(publisherTestLayer([eligibleItem("first")])), Effect.scoped),
  );

  it.effect("emits SchedulerChanged only when the scheduler read model changes", () =>
    Effect.gen(function* () {
      const probe = yield* EventPublisherProbe;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const publisher = yield* DaemonEventPublisher;
      const subscription = yield* bus.subscribe();

      yield* publisher.publishScheduler();
      yield* publisher.publishScheduler();
      yield* Ref.set(probe.stats, schedulerState(2));
      yield* publisher.publishScheduler();

      yield* bus.publish(itemSentinelEvent);
      const events = [
        ...(yield* Stream.fromSubscription(subscription).pipe(Stream.take(3), Stream.runCollect)),
      ];
      const inFlight = events.flatMap((event) =>
        DaemonEvent.guards.SchedulerChanged(event) ? [event.scheduler.globalInFlight] : [],
      );
      assert.deepStrictEqual(inFlight, [1, 2]);
      assert.strictEqual(events.at(-1)?._tag, "ItemChanged");
    }).pipe(Effect.provide(publisherTestLayer([], 1)), Effect.scoped),
  );

  it.effect("emits ItemRemoved so a board folded through churn drops the closed item", () =>
    Effect.gen(function* () {
      const probe = yield* EventPublisherProbe;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const worker = yield* Reconcile.ReconcileWorker;
      const publisher = yield* DaemonEventPublisher;
      const subscription = yield* bus.subscribe();

      yield* worker.submit();
      yield* publisher.publishItems();

      yield* Ref.set(probe.items, [parkedItem("first")]);
      yield* worker.submit();
      yield* publisher.publishItems();

      yield* Ref.set(probe.items, []);
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
    }).pipe(Effect.provide(publisherTestLayer([eligibleItem("first")])), Effect.scoped),
  );

  const daemonLayer = (
    workspaces = mutableRegistryLayer,
    store = controlStoreLayer,
    plugins = pluginManagerLayer,
  ) =>
    Daemon.handlersLayer.pipe(
      Layer.provideMerge(harnessProbeTestLayer()),
      Layer.provideMerge(Daemon.principalMiddlewareLayer),
      Layer.provideMerge(Daemon.daemonInfoLayer),
      Layer.provideMerge(eventPublisherLayer),
      Layer.provideMerge(Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(workspaces, observing)))),
      Layer.provideMerge(workspaces),
      Layer.provideMerge(Registry.managementReadOnlyLayer),
      Layer.provideMerge(schedulerStub),
      Layer.provideMerge(engineServices),
      Layer.provideMerge(RunControl.layer),
      Layer.provideMerge(store),
      Layer.provideMerge(plugins),
      Layer.provideMerge(observing),
    );

  const daemonTestLayer = (items: ReadonlyArray<TrackerItem> = [], globalInFlight = 0) =>
    daemonLayer().pipe(Layer.provideMerge(EventPublisherProbe.layer(items, globalInFlight)));

  const storeFailure = new ControlStoreFailure({
    operation: "read Control store",
    message: "store read failed",
    retryable: true,
  });
  const pluginFailure = new PluginFailure({
    operation: "read Plugin catalog",
    pluginId: null,
    file: null,
    message: "catalog read failed",
  });
  const failingStore = Layer.succeed(ControlStore, {
    ...controlStoreService,
    picture: Effect.fail(storeFailure),
  });
  const failingPlugins = Layer.succeed(PluginManager, {
    overview: Effect.fail(pluginFailure),
    install: () => Effect.die(new Error("unexpected Plugin install")),
    uninstall: () => Effect.die(new Error("unexpected Plugin uninstall")),
    contributions: () => Effect.succeed([]),
  });
  it.effect("logs Control store and Plugin seed failures before omitting their seed events", () =>
    Effect.gen(function* () {
      const messages = yield* LogMessages;
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const seed = yield* client
        .WatchEvents()
        .pipe(Stream.takeUntil(DaemonEvent.guards.SeedEnd), Stream.runCollect, Effect.timeout("1 second"));

      assert.isFalse([...seed].some(DaemonEvent.isAnyOf(["ControlStoreChanged", "PluginsChanged"])));
      assert.isTrue(
        MutableRef.get(messages).some((message) => message.includes("Control store seed failed")),
      );
      assert.isTrue(MutableRef.get(messages).some((message) => message.includes("Plugin seed failed")));
    }).pipe(
      Effect.provide(
        daemonLayer(registryLayer, failingStore, failingPlugins).pipe(
          Layer.provideMerge(EventPublisherProbe.layer()),
          Layer.provideMerge(LogMessages.captureLayer),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("lets a client track the board live from WatchEvents, matching GetStatus", () =>
    Effect.gen(function* () {
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
        DaemonEvent.guards.ItemChanged(event) && ClassifiedItem.guards.Eligible(event.item)
          ? [event.item.id]
          : [],
      );
      assert.deepStrictEqual(trackedIds, [id("AUD-1")]);

      const status = yield* client.GetStatus();
      assert.strictEqual(status.workspaces[0]?.eligible[0]?.id, id("AUD-1"));
    }).pipe(Effect.provide(daemonTestLayer([eligibleItem("first")])), Effect.scoped),
  );

  it.effect("self-seeds WatchEvents so folding the seed equals the daemon's read models", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const worker = yield* Reconcile.ReconcileWorker;
      const ledger = yield* RunLedger.RunLedger;
      const scheduler = yield* Scheduler.Scheduler;
      const registry = yield* Registry.WorkspaceRegistry;

      yield* worker.submit();
      yield* ledger.insertRun(runningRun);

      const seed = [
        ...(yield* client
          .WatchEvents()
          .pipe(Stream.takeUntil(DaemonEvent.guards.SeedEnd), Stream.runCollect)),
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
      const expectedScheduler = schedulerStatsOf(
        yield* registry.state,
        yield* scheduler.config,
        yield* scheduler.stats,
      );

      const status = yield* client.GetStatus();
      const expectedWorkspaces = new Map(
        [...status.workspaces.map(workspaceStateFromInfo), ...status.failures.map(workspaceFailureState)].map(
          (workspace) => [workspaceKey(workspace), workspace] as const,
        ),
      );

      assert.deepStrictEqual(board.items, expectedItems);
      assert.deepStrictEqual(board.runs, expectedRuns);
      assert.deepStrictEqual(board.workspaces, expectedWorkspaces);
      assert.deepStrictEqual(board.scheduler, expectedScheduler);
      assert.deepStrictEqual(board.controlStore, defaultControlStore);
    }).pipe(Effect.provide(daemonTestLayer([eligibleItem("first")], 1)), Effect.scoped),
  );

  it.effect("does not seed stale items after their workspace leaves the registry", () =>
    Effect.gen(function* () {
      const probe = yield* EventPublisherProbe;
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const worker = yield* Reconcile.ReconcileWorker;

      yield* worker.submit();
      yield* Ref.set(probe.registry, Registry.emptyRegistry);
      const seed = yield* client
        .WatchEvents()
        .pipe(Stream.takeUntil(DaemonEvent.guards.SeedEnd), Stream.runCollect);

      assert.isFalse([...seed].some(DaemonEvent.guards.ItemChanged));
    }).pipe(Effect.provide(daemonTestLayer([eligibleItem("stale")])), Effect.scoped),
  );

  it.effect("places one SeedEnd after the stamped seed and keeps it out of the event bus", () =>
    Effect.gen(function* () {
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

      const watcher = yield* client
        .WatchEvents()
        .pipe(Stream.takeUntil(DaemonEvent.guards.ItemRemoved), Stream.runCollect, Effect.forkChild);
      const busEvent = yield* Stream.fromSubscription(subscription).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* bus.publish(live).pipe(Effect.andThen(Effect.yieldNow), Effect.repeat(Schedule.recurs(50)));

      const received = [...(yield* Fiber.join(watcher))];
      const observedByBus = [...(yield* Fiber.join(busEvent))];
      const boundary = received.filter(DaemonEvent.guards.SeedEnd);
      const boundaryIndex = received.findIndex(DaemonEvent.guards.SeedEnd);
      const seed = received.slice(0, boundaryIndex);

      assert.strictEqual(boundary.length, 1);
      assert.strictEqual(received[boundaryIndex + 1]?._tag, "ItemRemoved");
      assert.strictEqual(new Set(seed.map((event) => event.emittedAtMillis)).size, 1);
      assert.strictEqual(typeof boundary[0]?.emittedAtMillis, "number");
      assert.deepStrictEqual(
        observedByBus.map((event) => event._tag),
        ["ItemRemoved"],
      );
    }).pipe(Effect.provide(daemonTestLayer([eligibleItem("first")], 1)), Effect.scoped),
  );

  const failingRegistryLayer = Layer.succeed(
    Registry.WorkspaceRegistry,
    Registry.readOnlyRegistry({
      workspaces: [],
      failures: [{ source: "broken.workspace.ts", message: "config threw at import" }],
    }),
  );

  it.effect("seeds a failed-to-load workspace onto the board with its failure", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);

      const seed = [
        ...(yield* client
          .WatchEvents()
          .pipe(Stream.takeUntil(DaemonEvent.guards.SchedulerChanged), Stream.runCollect)),
      ];
      const board = seed.reduce(applyDaemonEvent, initialBoard);

      const failed = board.workspaces.get("broken.workspace.ts");
      assert.strictEqual(failed?._tag, "Failed");
      assert.strictEqual(
        failed && WorkspaceState.guards.Failed(failed) ? failed.message : null,
        "config threw at import",
      );

      const status = yield* client.GetStatus();
      assert.strictEqual(status.failures[0]?.source, "broken.workspace.ts");
    }).pipe(
      Effect.provide(daemonLayer(failingRegistryLayer).pipe(Layer.provideMerge(EventPublisherProbe.layer()))),
      Effect.scoped,
    ),
  );
});
