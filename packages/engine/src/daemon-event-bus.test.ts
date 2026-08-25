import { RunId, SchedulerStats, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
          event._tag === "SchedulerChanged" ? event.scheduler.globalInFlight : -1,
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
