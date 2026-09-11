import { DaemonEvent, RunId, SchedulerStats, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as MutableRef from "effect/MutableRef";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as DaemonEventBus from "./daemon-event-bus";

const stats = Schema.decodeSync(SchedulerStats);
const runId = Schema.decodeSync(RunId);
const workspace = Schema.decodeSync(WorkspaceId)("example");
const workItem = Schema.decodeSync(WorkItemId)("#7");

const schedulerEvent = (globalInFlight: number) =>
  ({
    _tag: "SchedulerChanged",
    emittedAtMillis: 0,
    scheduler: stats({
      scheduling: "running",
      globalInFlight,
      globalLimit: 4,
      perWorkspaceLimit: 4,
      dailyBudgetUsed: 0,
      dailyBudgetLimit: 10,
      perWorkspace: [],
    }),
  }) as const;

describe("DaemonEventBus", () => {
  // Effect registers a metric lazily, so this must read the registry before any other test in this
  // file touches the counter and registers it for us.
  it.effect("snapshots a zero drop count before anything is dropped", () =>
    Effect.gen(function* () {
      const dropId = DaemonEventBus.droppedEventsMetric.id;
      assert.isUndefined((yield* Metric.snapshot).find((snapshot) => snapshot.id === dropId));
      yield* DaemonEventBus.make;
      const dropped = (yield* Metric.snapshot).find((snapshot) => snapshot.id === dropId);
      assert.deepStrictEqual(dropped?.state, { count: 0, incremental: false });
    }),
  );

  it.effect("counts every evicted event and logs only when loss starts", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const logs = MutableRef.make<ReadonlyArray<string>>([]);
      const before = (yield* Metric.value(DaemonEventBus.droppedEventsMetric)).count;
      yield* bus.subscribe();
      yield* Effect.forEach(
        Array.from({ length: 1026 }, (_, i) => i),
        (i) => bus.publish(schedulerEvent(i)),
        { discard: true },
      ).pipe(
        Effect.withLogger(
          Logger.make(({ message }) => MutableRef.update(logs, (current) => [...current, String(message)])),
        ),
      );

      assert.strictEqual(yield* bus.droppedEvents, 2);
      assert.strictEqual((yield* Metric.value(DaemonEventBus.droppedEventsMetric)).count, before + 2);
      assert.strictEqual(
        logs.current.filter((message) => message.includes("Daemon event bus started dropping events")).length,
        1,
      );
    }).pipe(Effect.provide(DaemonEventBus.layer), Effect.scoped),
  );

  it.effect("stays silent while every event fits", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const logs = MutableRef.make<ReadonlyArray<string>>([]);
      yield* bus.subscribe();
      yield* Effect.forEach(
        Array.from({ length: 100 }, (_, i) => i),
        (i) => bus.publish(schedulerEvent(i)),
        { discard: true },
      ).pipe(
        Effect.withLogger(
          Logger.make(({ message }) => MutableRef.update(logs, (current) => [...current, String(message)])),
        ),
      );

      assert.strictEqual(yield* bus.droppedEvents, 0);
      assert.isFalse(
        logs.current.some((message) => message.includes("Daemon event bus started dropping events")),
      );
    }).pipe(Effect.provide(DaemonEventBus.layer), Effect.scoped),
  );

  it.effect("a subscriber that never drains cannot block the publisher", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      yield* bus.subscribe();
      yield* Effect.forEach(
        Array.from({ length: 5000 }, (_, i) => i),
        (i) => bus.publish(schedulerEvent(i)),
        { discard: true },
      );
      assert.isTrue(true);
    }).pipe(Effect.provide(DaemonEventBus.layer), Effect.scoped),
  );

  it.effect("an active subscriber still receives events while another is stuck", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.DaemonEventBus;
      yield* bus.subscribe();
      const active = yield* Effect.forkChild(Stream.runCollect(Stream.take(bus.events, 3)));
      yield* Effect.yieldNow;
      yield* Effect.forEach([0, 1, 2], (i) => bus.publish(schedulerEvent(i)), { discard: true });

      const received = yield* Fiber.join(active);
      assert.deepStrictEqual(
        [...received].map((event) =>
          DaemonEvent.matchOrElse(
            event,
            { SchedulerChanged: ({ scheduler }) => scheduler.globalInFlight },
            () => -1,
          ),
        ),
        [0, 1, 2],
      );
    }).pipe(Effect.provide(DaemonEventBus.layer), Effect.scoped),
  );

  it.effect("projects only run activity out of a mixed event stream", () =>
    Effect.gen(function* () {
      const activity = DaemonEventBus.activityOf(
        { id: runId("run-1"), workspace, workItem, stage: "implement" },
        0,
        1000,
        { type: "RUN_STARTED" },
      );
      const projected = yield* DaemonEventBus.runActivityStream(
        Stream.fromIterable([
          { _tag: "RunActivity", emittedAtMillis: 0, activity } as const,
          schedulerEvent(1),
        ]),
      ).pipe(Stream.runCollect);

      assert.deepStrictEqual(
        [...projected].map((item) => item.seq),
        [0],
      );
    }),
  );
});
