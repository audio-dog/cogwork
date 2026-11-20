import { WorkflowCatalogKey, WorkflowId, WorkflowNodeId, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { clockSource, latestScheduledInstant, makeClockSource, nextScheduledInstant } from "./clock-source";
import type { TriggerReadPort, TriggerSource, TriggerSubscription } from "./trigger-source";
import { makeWorkflowOptions } from "./workflow-options";

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
  filters: [],
  workspaces: [],
  catchUp: null,
});

const daily = (zone: string, hour: number, minute: number) =>
  subscription("schedule.daily", [
    { id: "hour", value: String(hour) },
    { id: "minute", value: String(minute) },
    { id: "zone", value: zone },
  ]);

const sweep = subscription("schedule.sweep", [
  { id: "hour", value: "0" },
  { id: "minute", value: "1" },
  { id: "zone", value: "UTC" },
  { id: "source", value: "trackers" },
  { id: "state", value: "parked" },
  { id: "idle-days", value: "30" },
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

  it.effect("emits the 50 oldest idle items on one sweep tick", () =>
    Effect.gen(function* () {
      const day = 86_400_000;
      const start = millis("2026-01-01T00:00:00Z");
      const candidates = Array.from({ length: 60 }, (_, index) => ({
        key: {
          _tag: "Issue" as const,
          workspace: Schema.decodeSync(WorkspaceId)("cogwork"),
          id: Schema.decodeSync(WorkItemId)(`#${index + 1}`),
        },
        workspace: Schema.decodeSync(WorkspaceId)("cogwork"),
        lastTouchedAtMillis: start - (120 - index) * day,
      }));
      const readPort: TriggerReadPort = {
        sweep: () => Effect.succeed(candidates),
      };
      yield* TestClock.setTime(start);
      const events = yield* clockSource
        .observe([sweep], readPort)
        .pipe(Stream.take(50), Stream.runCollect, Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("1 minute");
      const selected = yield* Fiber.join(events);

      assert.deepStrictEqual(
        selected.map(({ key }) => (key._tag === "Issue" ? key.id : "")),
        Array.from({ length: 50 }, (_, index) => `#${index + 1}`),
      );
      assert.isTrue(selected.every(({ cause }) => cause._tag === "Clock"));
      assert.isTrue(
        selected.every(
          ({ target }) => target?.workflow === sweep.workflow && target.trigger === sweep.trigger,
        ),
      );
    }),
  );

  it.effect("lists IANA zones for schedule zone parameters", () =>
    Effect.gen(function* () {
      const entry = clockSource.entries.find(({ key }) => key === decodeEntry("schedule.daily"));
      if (entry === undefined) return assert.fail("missing daily entry");
      const options = yield* makeWorkflowOptions(clockSource.options ?? []).list(entry, "zone", []);

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

  it.effect("lists parked and tracker labels as sweep states", () =>
    Effect.gen(function* () {
      const baseEntry = clockSource.entries[0];
      if (baseEntry === undefined) return assert.fail("missing clock entry");
      const workspace = yield* Schema.decodeEffect(WorkspaceId)("cogwork");
      const labels: TriggerSource = {
        id: "github",
        entries: [
          {
            ...baseEntry,
            key: decodeEntry("github.issue-has-label"),
            parameters: [{ id: "label", required: true, source: "live", values: [] }],
          },
        ],
        availability: () => Effect.succeed({ _tag: "Available" }),
        options: [
          {
            system: "github",
            readers: {
              label: () => Effect.succeed([{ value: "stale", name: "stale", listedIn: [workspace] }]),
            },
          },
        ],
        observe: () => Stream.empty,
      };
      const clock = makeClockSource([labels]);
      const sweep = clock.entries.find(({ key }) => key === decodeEntry("schedule.sweep"));
      if (sweep === undefined) return assert.fail("missing sweep entry");

      const options = yield* makeWorkflowOptions(clock.options ?? []).list(sweep, "state", [workspace]);

      assert.deepStrictEqual(
        options.map(({ value }) => value),
        ["parked", "stale"],
      );
    }),
  );
});
