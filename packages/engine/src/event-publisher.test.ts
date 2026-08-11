import {
  ClassifiedItem,
  DaemonRpcs,
  SchedulerStats,
  WorkItemId,
  WorkspaceId,
} from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import * as Daemon from "./daemon";
import * as DaemonEventBus from "./daemon-event-bus";
import { DaemonEventPublisher, layer as eventPublisherLayer } from "./event-publisher";
import { IssueTracker, type IssueTrackerService, type TrackerItem } from "./issue-tracker";
import { classifiedItemsOf } from "./read-model";
import * as Reconcile from "./reconcile";
import * as Registry from "./registry";
import * as RunControl from "./run-control";
import * as RunLedger from "./run-ledger";
import * as Scheduler from "./scheduler";
import { SourceControlProvider } from "./source-control";

const id = Schema.decodeSync(WorkItemId);
const stats = Schema.decodeSync(SchedulerStats);
const workspaceId = Schema.decodeSync(WorkspaceId);
const classifiedItem = Schema.decodeSync(ClassifiedItem);

const registryLayer = Layer.succeed(
  Registry.WorkspaceRegistry,
  Registry.buildRegistry({
    loaded: [
      {
        source: "example.workspace.ts",
        value: {
          name: "example",
          checkoutPath: "/repos/example",
          issueTracker: { type: "linear" },
          harness: { preferred: "cursor" },
        },
      },
    ],
    failures: [],
  }),
);

const trackerStub = (observe: IssueTrackerService["observe"]): IssueTrackerService => ({
  rateLimitScope: () => null,
  observe,
  claim: () => Effect.void,
  release: () => Effect.void,
  recordAttempt: () => Effect.void,
  recordFollowUp: () => Effect.void,
  note: () => Effect.void,
  setRoles: () => Effect.void,
});

const providerStub = Layer.succeed(SourceControlProvider, { observe: () => Effect.succeed(new Map()) });

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
    tick: () => Effect.succeed([]),
    drain: () => Effect.succeed({ inFlight: 0, interrupted: 0 }),
    admit: () => Effect.void,
    setScheduling: () => Ref.get(statsRef),
    config: { globalLimit: 4, dailyBudget: 50 },
    stats: Ref.get(statsRef),
  });

const eligibleItem = (title: string): TrackerItem => ({
  id: id("AUD-1"),
  title,
  roles: ["ready-for-agent"],
  claimLabeled: false,
  claim: null,
  claimedByUs: false,
  attempts: [],
  owned: false,
  followUp: null,
  openBlockers: 0,
  proposal: null,
});

const schedulerSentinel = {
  _tag: "SchedulerChanged",
  scheduler: stats({
    scheduling: "running",
    globalInFlight: 99,
    globalLimit: 4,
    dailyBudgetUsed: 0,
    dailyBudgetLimit: 10,
    perWorkspace: [],
  }),
} as const;

const itemSentinelEvent = {
  _tag: "ItemChanged",
  workspace: workspaceId("marker"),
  item: classifiedItem({ _tag: "Eligible", id: "AUD-marker", title: "marker", stage: "triage" }),
} as const;

const publisherLayer = (
  itemsRef: Ref.Ref<ReadonlyArray<TrackerItem>>,
  statsRef: Ref.Ref<Scheduler.SchedulerState>,
) =>
  eventPublisherLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(registryLayer, observing(itemsRef)))),
        schedulerStub(statsRef),
        DaemonEventBus.layer,
      ),
    ),
  );

describe("DaemonEventPublisher", () => {
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

  const daemonLayer = (
    itemsRef: Ref.Ref<ReadonlyArray<TrackerItem>>,
    statsRef: Ref.Ref<Scheduler.SchedulerState>,
  ) =>
    Daemon.handlersLayer.pipe(
      Layer.provideMerge(Daemon.principalMiddlewareLayer),
      Layer.provideMerge(Daemon.daemonInfoLayer),
      Layer.provideMerge(
        Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(registryLayer, observing(itemsRef)))),
      ),
      Layer.provideMerge(registryLayer),
      Layer.provideMerge(schedulerStub(statsRef)),
      Layer.provideMerge(RunLedger.layerMemory),
      Layer.provideMerge(DaemonEventBus.layer),
      Layer.provideMerge(RunControl.layer),
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
});
