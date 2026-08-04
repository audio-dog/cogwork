import type { HarnessEvent } from "@clanker-forge/contracts";
import { HarnessName, RunId, WorkItemId, WorkspaceId } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Daemon from "./daemon";
import * as RunEventBus from "./run-event-bus";
import { activityOf } from "./run-event-bus";
import * as RunLedger from "./run-ledger";

const runId = Schema.decodeSync(RunId);
const workspace = Schema.decodeSync(WorkspaceId)("example");
const workItem = Schema.decodeSync(WorkItemId)("#49");
const harness = Schema.decodeSync(HarnessName)("cursor");
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

const layer = Layer.mergeAll(RunLedger.layerMemory, RunEventBus.layer);

const record = (id: string) => ({
  id: runId(id),
  workspace,
  workItem,
  stage: "implement" as const,
  harness,
  branch: "49-backfill",
  session: null,
  usage: null,
  status: "running" as const,
  startedAtMillis: 1000,
  endedAtMillis: null,
});

const harnessEvent = (over: Partial<HarnessEvent> & Pick<HarnessEvent, "type">) => ({
  type: over.type,
  name: over.name ?? null,
  text: over.text ?? null,
  sessionId: over.sessionId ?? null,
  usage: over.usage ?? null,
  finishReason: over.finishReason ?? null,
});

const ledgerEvent = (seq: number, event: HarnessEvent, atMillis: number) => ({
  seq,
  type: event.type,
  name: event.name,
  data: encodeJson(event),
  atMillis,
});

const activity = (id: string, seq: number, event: HarnessEvent, atMillis = 1000 + seq) =>
  activityOf(record(id), seq, atMillis, event);

const reconstructText = (activities: ReadonlyArray<{ readonly event: HarnessEvent }>) =>
  activities
    .filter((item) => item.event.type === "TEXT_MESSAGE_CONTENT")
    .map((item) => item.event.text ?? "")
    .join("");

describe("watchActivity", () => {
  it.effect("seeds scoped watchers from ledger history before live events", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const bus = yield* RunEventBus.RunEventBus;
      const id = runId("run-1");
      const started = harnessEvent({ type: "RUN_STARTED" });
      const hello = harnessEvent({ type: "TEXT_MESSAGE_CONTENT", text: "Hel" });
      const lo = harnessEvent({ type: "TEXT_MESSAGE_CONTENT", text: "lo" });
      const bang = harnessEvent({ type: "TEXT_MESSAGE_CONTENT", text: "!" });

      yield* ledger.insertRun(record("run-1"));
      yield* ledger.appendEvent(id, ledgerEvent(0, started, 1000));
      yield* ledger.appendEvent(id, ledgerEvent(1, hello, 1001));
      yield* ledger.appendEvent(id, ledgerEvent(2, lo, 1002));

      const ready = yield* Deferred.make<void>();
      const fiber = yield* Stream.unwrap(Daemon.watchActivity(id)).pipe(
        Stream.tap((item) => (item.seq === 2 ? Deferred.succeed(ready, undefined) : Effect.void)),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Deferred.await(ready);
      yield* bus.publish(activity("run-1", 3, bang, 1003));

      const seen = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        seen.map((item) => item.seq),
        [0, 1, 2, 3],
      );
      assert.strictEqual(reconstructText(seen), "Hello!");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("dedupes overlapping seq values at the history/live seam", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const bus = yield* RunEventBus.RunEventBus;
      const id = runId("run-1");
      const started = harnessEvent({ type: "RUN_STARTED" });
      const mid = harnessEvent({ type: "TEXT_MESSAGE_CONTENT", text: "mid" });
      const next = harnessEvent({ type: "TEXT_MESSAGE_CONTENT", text: "next" });

      yield* ledger.insertRun(record("run-1"));
      yield* ledger.appendEvent(id, ledgerEvent(0, started, 1000));
      yield* ledger.appendEvent(id, ledgerEvent(1, mid, 1001));

      const ready = yield* Deferred.make<void>();
      const fiber = yield* Stream.unwrap(Daemon.watchActivity(id)).pipe(
        Stream.tap((item) => (item.seq === 1 ? Deferred.succeed(ready, undefined) : Effect.void)),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Deferred.await(ready);
      yield* bus.publish(activity("run-1", 1, mid, 1001));
      yield* bus.publish(activity("run-1", 2, next, 1002));

      const seen = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        seen.map((item) => item.seq),
        [0, 1, 2],
      );
      assert.strictEqual(reconstructText(seen), "midnext");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("delivers exactly once an event published between subscribe and history read", () =>
    Effect.gen(function* () {
      const inner = yield* RunLedger.RunLedger;
      const bus = yield* RunEventBus.RunEventBus;
      const id = runId("run-1");
      const started = harnessEvent({ type: "RUN_STARTED" });
      const mid = harnessEvent({ type: "TEXT_MESSAGE_CONTENT", text: "mid" });
      const late = harnessEvent({ type: "TEXT_MESSAGE_CONTENT", text: "late" });

      yield* inner.insertRun(record("run-1"));
      yield* inner.appendEvent(id, ledgerEvent(0, started, 1000));
      yield* inner.appendEvent(id, ledgerEvent(1, mid, 1001));

      const racing = {
        ...inner,
        events: (runId: typeof id) =>
          Effect.gen(function* () {
            const snapshot = yield* inner.events(runId);
            yield* bus.publish(activity("run-1", 2, late, 1002));
            return snapshot;
          }),
      };

      const seen = yield* Stream.unwrap(Daemon.watchActivity(id)).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(RunLedger.RunLedger, racing),
      );

      assert.deepStrictEqual(
        seen.map((item) => item.seq),
        [0, 1, 2],
      );
      assert.strictEqual(reconstructText(seen), "midlate");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("keeps unscoped watch live-only", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const bus = yield* RunEventBus.RunEventBus;
      const started = harnessEvent({ type: "RUN_STARTED" });

      yield* ledger.insertRun(record("run-1"));
      yield* ledger.appendEvent(runId("run-1"), ledgerEvent(0, started, 1000));

      const fiber = yield* Stream.unwrap(Daemon.watchActivity(undefined)).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      yield* bus.publish(activity("run-2", 0, started, 2000));

      const seen = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        seen.map((item) => item.runId),
        [runId("run-2")],
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
