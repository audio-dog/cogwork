import {
  keyOf,
  LineageId,
  localOwnerId,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowId,
  WorkflowNodeId,
  type WorkflowRecord,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, layer } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { clockEntries } from "./clock-source";
import { bootControlStoreLayer } from "./control-store";
import { Coordination, type CoordinationService, fold } from "./coordination";
import { DaemonEventBus, make as makeDaemonEventBus } from "./daemon-event-bus";
import { makeScriptedSource } from "./scripted-source";
import {
  make,
  makeControlStoreTriggerObservationStore,
  makeMemoryTriggerObservationStore,
  matchTriggerEvent,
  TriggerObservationStore,
  TriggerObservationStoreError,
  type TriggerObservationStoreService,
} from "./trigger-observation";
import {
  SourceFailure,
  type TriggerSource,
  TriggerSources,
  type TriggerSubscription,
} from "./trigger-source";
import { Workflows, type WorkflowsService } from "./workflow";

const workflowId = Schema.decodeSync(WorkflowId)("daily-summary");
const otherWorkflowId = Schema.decodeSync(WorkflowId)("other-workflow");
const triggerId = Schema.decodeSync(WorkflowNodeId)("schedule");
const entry = Schema.decodeSync(WorkflowCatalogKey)("schedule.daily");
const scheduleParameters = [
  { id: "hour", value: "0" },
  { id: "minute", value: "0" },
  { id: "zone", value: "UTC" },
];
const scheduledInstant = Date.UTC(2025, 0, 1);
const document = Schema.decodeSync(WorkflowDocument)({
  name: "Daily summary",
  workspaces: { _tag: "Listed", workspaces: [] },
  triggers: [
    {
      id: triggerId,
      entry,
      parameters: scheduleParameters,
      start: Schema.decodeSync(WorkflowNodeId)("summarize"),
    },
  ],
  operations: [],
});

const record = (enabled: boolean): WorkflowRecord => ({
  id: workflowId,
  principal: localOwnerId,
  workingCopy: document,
  workingRevision: 1,
  publishedCopy: document,
  publishedRevision: 1,
  enabled,
  diagnostics: [],
  readiness: [],
});

const workItem = { _tag: "ScheduleInstant", workflow: workflowId, instantMillis: scheduledInstant } as const;
const event = {
  key: workItem,
  revision: String(scheduledInstant),
  cause: { _tag: "Unknown" },
  atMillis: scheduledInstant,
  entry,
  workspace: null,
} as const;
const lineage = { root: Schema.decodeSync(LineageId)(keyOf(workItem)), parent: null, hop: 0 } as const;

const subscription: TriggerSubscription = {
  workflow: workflowId,
  trigger: triggerId,
  operation: Schema.decodeSync(WorkflowNodeId)("summarize"),
  entry,
  parameters: scheduleParameters,
  workspaces: [],
  catchUp: { since: 0 },
};

const workflowService = (current: Ref.Ref<WorkflowRecord>): WorkflowsService => ({
  create: () => Effect.die("unused"),
  edit: () => Effect.die("unused"),
  publish: () => Effect.die("unused"),
  switch: () => Effect.die("unused"),
  delete: () => Effect.die("unused"),
  list: Effect.map(Ref.get(current), (workflow) => ({ workflows: [workflow], unreadable: [] })),
  get: () => Effect.die("unused"),
  validate: () => Effect.succeed([]),
  catalog: Effect.die("unused"),
  templates: Effect.succeed([]),
  listOptions: () => Effect.succeed([]),
});

const coordinationService = (
  processed: Ref.Ref<string | null>,
  observed: Ref.Ref<number>,
  sourceRevision: Ref.Ref<string | null>,
): CoordinationService => ({
  fold,
  read: () =>
    Effect.map(Effect.all([Ref.get(processed), Ref.get(sourceRevision)]), ([revision, observedRevision]) =>
      fold(
        {
          claim: null,
          attempts: [],
          handbacks: [],
          parks: [],
          revision: { observed: observedRevision ?? event.revision, processed: revision },
        },
        "cogwork",
      ),
    ),
  claim: () => Effect.die("unused"),
  release: () => Effect.die("unused"),
  recordAttempt: () => Effect.die("unused"),
  park: () => Effect.die("unused"),
  handBack: () => Effect.die("unused"),
  observe: (_ref, revision) =>
    Ref.update(observed, (count) => count + 1).pipe(
      Effect.andThen(
        Ref.modify(
          sourceRevision,
          (current) => [current === revision ? "redelivered" : "moved", revision] as const,
        ),
      ),
    ),
  markProcessed: (_ref, revision) => Ref.set(processed, revision),
});

const sourceFailingOnce = (starts: Ref.Ref<number>, failure: SourceFailure): TriggerSource => ({
  id: "clock",
  entries: clockEntries,
  availability: () => Effect.succeed({ _tag: "Available" }),
  listOptions: () => Effect.succeed([]),
  observe: (subscriptions) =>
    subscriptions.length === 0
      ? Stream.empty
      : Stream.unwrap(
          Ref.updateAndGet(starts, (count) => count + 1).pipe(
            Effect.map((count) => (count === 1 ? Stream.fail(failure) : Stream.never)),
          ),
        ),
});

describe("TriggerObservation", () => {
  it("matches a schedule event to one Trigger with the scheduled parameters", () => {
    const other = { ...subscription, workflow: Schema.decodeSync(WorkflowId)("other") };
    const later = {
      ...subscription,
      trigger: Schema.decodeSync(WorkflowNodeId)("later"),
      operation: Schema.decodeSync(WorkflowNodeId)("later-operation"),
      parameters: scheduleParameters.map((parameter) =>
        parameter.id === "hour" ? { ...parameter, value: "1" } : parameter,
      ),
    };

    assert.deepStrictEqual(matchTriggerEvent([later, subscription, other], event), [subscription]);
  });

  it("matches a source event only to the Trigger whose parameters produced it", () => {
    const selected = {
      ...subscription,
      entry: Schema.decodeSync(WorkflowCatalogKey)("slack.i-am-mentioned"),
      parameters: [{ id: "channel", value: "C123" }],
    };
    const other = { ...selected, parameters: [{ id: "channel", value: "C456" }] };
    const slackEvent = {
      ...event,
      key: { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" } as const,
      entry: selected.entry,
      parameters: selected.parameters,
    };

    assert.deepStrictEqual(matchTriggerEvent([other, selected], slackEvent), [selected]);
  });

  it.effect("admits every matching Workflow for one source revision", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const workflows = {
        ...workflowService(current),
        list: Effect.succeed({
          workflows: [record(true), { ...record(true), id: otherWorkflowId }],
          unreadable: [],
        }),
      } satisfies WorkflowsService;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflows),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
      );
      yield* observation.refresh;
      yield* Effect.yieldNow;
      const changes = yield* observation.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit({
        ...event,
        key: { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" },
        revision: "900.000",
        atMillis: 900_000,
      });
      yield* TestClock.adjust("1 second");
      const admitted = yield* Fiber.join(changes);

      assert.isTrue(Option.isSome(admitted));
      if (Option.isNone(admitted)) return;
      assert.deepStrictEqual(
        admitted.value.map(({ subscription }) => subscription.workflow).toSorted(),
        [workflowId, otherWorkflowId].toSorted(),
      );
      assert.lengthOf(yield* observation.eligible, 2);
      assert.strictEqual(yield* Ref.get(observed), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps matching Workflow admissions invisible until the batch is durable", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const secondWrite = yield* Deferred.make<void>();
      const releaseWrite = yield* Deferred.make<void>();
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const blockedStore: TriggerObservationStoreService = {
        ...store,
        putAll: (admissions) =>
          Deferred.succeed(secondWrite, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWrite)),
            Effect.andThen(store.putAll(admissions)),
          ),
      };
      const workflows = {
        ...workflowService(current),
        list: Effect.succeed({
          workflows: [record(true), { ...record(true), id: otherWorkflowId }],
          unreadable: [],
        }),
      } satisfies WorkflowsService;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflows),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, blockedStore),
        Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
      );
      yield* observation.refresh;
      yield* Effect.yieldNow;
      yield* scripted.emit({
        ...event,
        key: { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" },
        revision: "900.000",
        atMillis: 900_000,
      });
      yield* Deferred.await(secondWrite);

      assert.deepStrictEqual(yield* observation.eligible, []);

      yield* Deferred.succeed(releaseWrite, undefined);
      yield* Effect.yieldNow;
      assert.lengthOf(yield* observation.eligible, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("retries an atomic Workflow admission batch on source redelivery", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const putCount = yield* Ref.make(0);
      const failedPut = yield* Deferred.make<void>();
      const repairedPut = yield* Deferred.make<void>();
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const flakyStore: TriggerObservationStoreService = {
        ...store,
        putAll: (admissions) =>
          Ref.updateAndGet(putCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.succeed(failedPut, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(new TriggerObservationStoreError({ message: "write failed" })),
                    ),
                  )
                : store.putAll(admissions).pipe(Effect.tap(() => Deferred.succeed(repairedPut, undefined))),
            ),
          ),
      };
      const workflows = {
        ...workflowService(current),
        list: Effect.succeed({
          workflows: [record(true), { ...record(true), id: otherWorkflowId }],
          unreadable: [],
        }),
      } satisfies WorkflowsService;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflows),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, flakyStore),
        Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
      );
      const sourceEvent = {
        ...event,
        key: { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" },
        revision: "900.000",
        atMillis: 900_000,
      } as const;
      yield* observation.refresh;
      yield* Effect.yieldNow;
      yield* scripted.emit(sourceEvent);
      yield* Deferred.await(failedPut);
      assert.deepStrictEqual(yield* store.admissions, []);

      yield* observation.refresh;
      yield* Effect.yieldNow;
      const repaired = yield* Deferred.await(repairedPut).pipe(
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(sourceEvent);
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isSome(yield* Fiber.join(repaired)));
      assert.lengthOf(yield* observation.eligible, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("admits once and stops the source after switch-off", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const scripted = yield* makeScriptedSource("clock", clockEntries);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [scripted.source]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
      );
      yield* Effect.yieldNow;
      yield* observation.refresh;
      const changed = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(event);
      yield* Fiber.join(changed);

      assert.lengthOf(yield* observation.eligible, 1);
      assert.strictEqual(yield* Ref.get(observed), 1);
      assert.lengthOf(yield* scripted.subscriptions, 1);

      const redelivery = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* scripted.emit(event);
      yield* TestClock.adjust("1 second");
      assert.isTrue(Option.isNone(yield* Fiber.join(redelivery)));

      yield* Ref.set(current, record(false));
      const declined = yield* observation.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      );
      const nextInstant = scheduledInstant + 86_400_000;
      yield* scripted.emit({
        ...event,
        key: { ...event.key, instantMillis: nextInstant },
        revision: String(nextInstant),
        atMillis: nextInstant,
      });
      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isNone(yield* Fiber.join(declined)));
      assert.strictEqual(yield* Ref.get(observed), 2);

      yield* bus.publish({ _tag: "WorkflowChanged", workflow: record(false) });
      yield* Effect.yieldNow;

      assert.deepStrictEqual(yield* observation.eligible, []);
      assert.deepStrictEqual(yield* scripted.subscriptions, []);
    }).pipe(Effect.scoped),
  );

  it.effect("restarts a rate-limited source only after Retry-After", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const starts = yield* Ref.make(0);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const rateLimited = sourceFailingOnce(
        starts,
        new SourceFailure({
          source: "clock",
          reason: "rate-limited",
          retryAfterMillis: 12_000,
          message: "wait",
        }),
      );
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [rateLimited]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
      );
      yield* Effect.yieldNow;
      yield* observation.refresh;
      yield* Effect.yieldNow;

      assert.strictEqual(yield* Ref.get(starts), 1);
      yield* TestClock.adjust(11_999);
      yield* observation.refresh;
      assert.strictEqual(yield* Ref.get(starts), 1);
      yield* TestClock.adjust(1);
      yield* Effect.yieldNow;
      yield* observation.refresh;
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(starts), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("restarts a connection-blocked source when Connections change", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(record(true));
      const processed = yield* Ref.make<string | null>(null);
      const observed = yield* Ref.make(0);
      const sourceRevision = yield* Ref.make<string | null>(null);
      const starts = yield* Ref.make(0);
      const store = yield* makeMemoryTriggerObservationStore;
      const bus = yield* makeDaemonEventBus;
      const blocked = sourceFailingOnce(
        starts,
        new SourceFailure({
          source: "clock",
          reason: "connection-not-ready",
          retryAfterMillis: null,
          message: "connect",
        }),
      );
      yield* make.pipe(
        Effect.provideService(Workflows, workflowService(current)),
        Effect.provideService(Coordination, coordinationService(processed, observed, sourceRevision)),
        Effect.provideService(TriggerSources, [blocked]),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, bus),
      );
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(starts), 1);
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(yield* Ref.get(starts), 1);

      yield* bus.publish({
        _tag: "ConnectionsChanged",
        connections: { connections: [] },
        danglingWorkspaces: [],
      });
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(starts), 2);
    }).pipe(Effect.scoped),
  );
});

layer(NodeServices.layer)((it) => {
  it.effect("persists and completes every matching Workflow admission for one revision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-trigger-admissions-" });
      const storePath = path.join(directory, "control.db");
      const sourceEvent = {
        ...event,
        key: { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" },
        revision: "900.000",
        atMillis: 900_000,
      } as const;
      const sourceLineageRoot = yield* Schema.decodeEffect(LineageId)(keyOf(sourceEvent.key));
      const sourceLineage = {
        root: sourceLineageRoot,
        parent: null,
        hop: 0,
      } as const;
      const first = { event: sourceEvent, subscription, lineage: sourceLineage };
      const second = {
        event: sourceEvent,
        subscription: { ...subscription, workflow: otherWorkflowId },
        lineage: sourceLineage,
      };
      const result = yield* makeControlStoreTriggerObservationStore.pipe(
        Effect.flatMap((store) =>
          Effect.all([
            store.putAll([first, second]),
            store.admissions,
            store.complete(first),
            store.admissions,
            store.complete(second),
            store.admissions,
          ]).pipe(
            Effect.map(([, stored, firstWasLast, afterFirst, secondWasLast, remaining]) => ({
              stored,
              firstWasLast,
              afterFirst,
              secondWasLast,
              remaining,
            })),
          ),
        ),
        Effect.provide(bootControlStoreLayer(storePath)),
      );

      assert.deepStrictEqual(
        result.stored.map(({ subscription }) => subscription.workflow).toSorted(),
        [workflowId, otherWorkflowId].toSorted(),
      );
      assert.isFalse(result.firstWasLast);
      assert.deepStrictEqual(
        result.afterFirst.map(({ subscription }) => subscription.workflow),
        [otherWorkflowId],
      );
      assert.isTrue(result.secondWasLast);
      assert.deepStrictEqual(result.remaining, []);
    }),
  );

  it.effect("persists admissions and skips time spent switched off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-trigger-observation-" });
      const storePath = path.join(directory, "control.db");
      const admission = {
        event,
        subscription,
        lineage,
      } as const;
      const useStore = <A, E, R>(
        use: (
          store: Effect.Success<typeof makeControlStoreTriggerObservationStore>,
        ) => Effect.Effect<A, E, R>,
      ) =>
        Effect.flatMap(makeControlStoreTriggerObservationStore, use).pipe(
          Effect.provide(bootControlStoreLayer(storePath)),
        );

      yield* useStore((store) =>
        store
          .activate([subscription], 1_000)
          .pipe(
            Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 1_000))),
          ),
      );
      yield* useStore((store) =>
        store
          .activate([subscription], 2_000)
          .pipe(
            Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 1_000))),
          ),
      );
      yield* useStore((store) =>
        store.activate([subscription], 3_000).pipe(
          Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 1_000))),
          Effect.andThen(
            store.putAll([
              {
                ...admission,
                event: {
                  ...admission.event,
                  key: { ...admission.event.key, instantMillis: 1_500 },
                  revision: "1500",
                  atMillis: 1_500,
                },
              },
            ]),
          ),
        ),
      );
      yield* useStore((store) =>
        Effect.all([store.admissions, store.activate([subscription], 4_000)]).pipe(
          Effect.tap(([admissions, active]) =>
            Effect.sync(() => {
              assert.strictEqual(admissions[0]?.event.revision, "1500");
              assert.strictEqual(active[0]?.catchUp?.since, 1_500);
            }),
          ),
          Effect.andThen(store.activate([], 5_000)),
        ),
      );
      yield* useStore((store) =>
        store
          .activate([subscription], 6_000)
          .pipe(
            Effect.tap((active) => Effect.sync(() => assert.strictEqual(active[0]?.catchUp?.since, 6_000))),
          ),
      );
    }),
  );
});
