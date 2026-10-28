import { WorkflowCatalogKey, WorkflowId, WorkflowNodeId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { clockSource, latestScheduledInstant, nextScheduledInstant } from "./clock-source";
import type { TriggerSubscription } from "./trigger-source";

const decodeWorkflow = Schema.decodeSync(WorkflowId);
const decodeNode = Schema.decodeSync(WorkflowNodeId);
const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);

const subscription = (
  entry: string,
  parameters: ReadonlyArray<{ readonly id: string; readonly value: string }>,
): TriggerSubscription => ({
  workflow: decodeWorkflow("daily-summary"),
  trigger: decodeNode("schedule"),
  operation: decodeNode("summarize"),
  entry: decodeEntry(entry),
  parameters,
  workspaces: [],
  catchUp: null,
});

const daily = (zone: string, hour: number, minute: number) =>
  subscription("schedule.daily", [
    { id: "hour", value: String(hour) },
    { id: "minute", value: String(minute) },
    { id: "zone", value: zone },
  ]);

const millis = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

describe("ClockSource", () => {
  it("chooses the first occurrence of a repeated wall-clock time", () => {
    const schedule = daily("America/New_York", 1, 30);
    const first = nextScheduledInstant(schedule, millis("2025-11-02T04:00:00Z"));
    const afterFirst = first === null ? null : nextScheduledInstant(schedule, first);

    assert.strictEqual(first, millis("2025-11-02T05:30:00Z"));
    assert.strictEqual(afterFirst, millis("2025-11-03T06:30:00Z"));
  });

  it("fires a nonexistent wall-clock time at the next valid minute", () => {
    const instant = nextScheduledInstant(daily("America/New_York", 2, 30), millis("2025-03-09T05:00:00Z"));

    assert.strictEqual(instant, millis("2025-03-09T07:00:00Z"));
  });

  it("selects only the latest missed instant after downtime", () => {
    const instant = latestScheduledInstant(daily("UTC", 8, 0), millis("2025-04-10T12:00:00Z"));

    assert.strictEqual(instant, millis("2025-04-10T08:00:00Z"));
  });

  it.effect("emits at the scheduled instant under TestClock", () =>
    Effect.gen(function* () {
      const events = yield* clockSource
        .observe([
          subscription("schedule.hourly", [
            { id: "minute", value: "1" },
            { id: "zone", value: "UTC" },
          ]),
        ])
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("1 minute");
      const [event] = yield* Fiber.join(events);

      assert.strictEqual(event?.revision, "60000");
      assert.strictEqual(event?.atMillis, 60000);
    }),
  );

  it.effect("lists IANA zones for schedule zone parameters", () =>
    Effect.gen(function* () {
      const options = yield* clockSource.listOptions(decodeEntry("schedule.daily"), "zone");

      assert.include(
        options.map(({ value }) => value),
        "UTC",
      );
      assert.include(
        options.map(({ value }) => value),
        "America/New_York",
      );
    }),
  );
});
