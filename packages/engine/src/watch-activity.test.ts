import type { AgUiEvent } from "@clanker-forge/contracts";
import { HarnessName, RunId, WorkItemId, WorkspaceId } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Daemon from "./daemon";
import * as DaemonEventBus from "./daemon-event-bus";
import { activityOf } from "./daemon-event-bus";
import * as RunLedger from "./run-ledger";

const runId = Schema.decodeSync(RunId);
const workspace = Schema.decodeSync(WorkspaceId)("example");
const workItem = Schema.decodeSync(WorkItemId)("#49");
const harness = Schema.decodeSync(HarnessName)("cursor");
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

const layer = Layer.mergeAll(RunLedger.layerMemory, DaemonEventBus.layer);

const record = (id: string, status: "running" | "succeeded" = "running") => ({
  id: runId(id),
  workspace,
  workItem,
  stage: "implement" as const,
  harness,
  branch: "49-backfill",
  session: null,
  usage: null,
  status,
  startedAtMillis: 1000,
  endedAtMillis: status === "running" ? null : 2000,
});

const event = (over: Partial<AgUiEvent> & Pick<AgUiEvent, "type">) => ({ ...over }) satisfies AgUiEvent;

const ledgerEvent = (seq: number, agUi: AgUiEvent, atMillis: number) => ({
  seq,
  type: agUi.type,
  name: agUi.name ?? null,
  data: encodeJson(agUi),
  atMillis,
});

const activity = (id: string, seq: number, agUi: AgUiEvent, atMillis = 1000 + seq) =>
  activityOf(record(id), seq, atMillis, agUi);

const reconstructText = (activities: ReadonlyArray<{ readonly event: AgUiEvent }>) =>
  activities
    .filter((item) => item.event.type === "TEXT_MESSAGE_CONTENT")
    .map((item) => item.event.delta ?? "")
    .join("");

describe("watchActivity", () => {
  it.effect("seeds scoped watchers from ledger history before live events", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const id = runId("run-1");
      const started = event({ type: "RUN_STARTED" });
      const hello = event({ type: "TEXT_MESSAGE_CONTENT", delta: "Hel" });
      const lo = event({ type: "TEXT_MESSAGE_CONTENT", delta: "lo" });
      const bang = event({ type: "TEXT_MESSAGE_CONTENT", delta: "!" });

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
      yield* bus.publishActivity(activity("run-1", 3, bang, 1003));

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
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const id = runId("run-1");
      const started = event({ type: "RUN_STARTED" });
      const mid = event({ type: "TEXT_MESSAGE_CONTENT", delta: "mid" });
      const next = event({ type: "TEXT_MESSAGE_CONTENT", delta: "next" });

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
      yield* bus.publishActivity(activity("run-1", 1, mid, 1001));
      yield* bus.publishActivity(activity("run-1", 2, next, 1002));

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
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const id = runId("run-1");
      const started = event({ type: "RUN_STARTED" });
      const mid = event({ type: "TEXT_MESSAGE_CONTENT", delta: "mid" });
      const late = event({ type: "TEXT_MESSAGE_CONTENT", delta: "late" });

      yield* inner.insertRun(record("run-1"));
      yield* inner.appendEvent(id, ledgerEvent(0, started, 1000));
      yield* inner.appendEvent(id, ledgerEvent(1, mid, 1001));

      const racing = {
        ...inner,
        events: (runId: typeof id) =>
          Effect.gen(function* () {
            const snapshot = yield* inner.events(runId);
            yield* bus.publishActivity(activity("run-1", 2, late, 1002));
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

  it.effect("replays a settled run's persisted stream then completes", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const id = runId("run-1");

      yield* ledger.insertRun(record("run-1", "succeeded"));
      yield* ledger.appendEvent(id, ledgerEvent(0, event({ type: "RUN_STARTED" }), 1000));
      yield* ledger.appendEvent(
        id,
        ledgerEvent(1, event({ type: "TEXT_MESSAGE_CONTENT", delta: "done" }), 1001),
      );
      yield* ledger.appendEvent(
        id,
        ledgerEvent(2, event({ type: "RUN_FINISHED", finishReason: "stop" }), 1002),
      );

      const seen = yield* Stream.unwrap(Daemon.watchActivity(id)).pipe(Stream.runCollect);
      assert.deepStrictEqual(
        seen.map((item) => item.seq),
        [0, 1, 2],
      );
      assert.strictEqual(reconstructText(seen), "done");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("replays the whole harness event and lifts its correlation ids onto the envelope", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const id = runId("run-1");
      const reasoning = event({
        type: "REASONING_MESSAGE_CONTENT",
        messageId: "msg-0",
        delta: "weighing the two approaches",
      });
      const toolResult = event({
        type: "TOOL_CALL_RESULT",
        toolCallId: "call-1",
        messageId: "msg-1",
        content: "diff applied",
        role: "tool",
        input: { path: "src/x.ts" },
      });

      yield* ledger.insertRun(record("run-1", "succeeded"));
      yield* ledger.appendEvent(id, ledgerEvent(0, event({ type: "RUN_STARTED" }), 1000));
      yield* ledger.appendEvent(id, ledgerEvent(1, reasoning, 1001));
      yield* ledger.appendEvent(id, ledgerEvent(2, toolResult, 1002));
      yield* ledger.appendEvent(
        id,
        ledgerEvent(3, event({ type: "RUN_FINISHED", finishReason: "stop" }), 1003),
      );

      const seen = [...(yield* Stream.unwrap(Daemon.watchActivity(id)).pipe(Stream.runCollect))];
      const replayedReasoning = seen.find((item) => item.event.type === "REASONING_MESSAGE_CONTENT");
      const replayedResult = seen.find((item) => item.event.type === "TOOL_CALL_RESULT");

      assert.strictEqual(replayedReasoning?.event.delta, "weighing the two approaches");
      assert.strictEqual(replayedResult?.event.content, "diff applied");
      assert.deepStrictEqual(replayedResult?.event.input, { path: "src/x.ts" });
      assert.strictEqual(replayedResult?.event.role, "tool");
      assert.deepStrictEqual(replayedResult?.correlation, {
        threadId: null,
        messageId: "msg-1",
        toolCallId: "call-1",
      });
      assert.deepStrictEqual(replayedReasoning?.correlation, {
        threadId: null,
        messageId: "msg-0",
        toolCallId: null,
      });
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("completes immediately for an unknown run id", () =>
    Effect.gen(function* () {
      const seen = yield* Stream.unwrap(Daemon.watchActivity(runId("missing"))).pipe(Stream.runCollect);
      assert.deepStrictEqual([...seen], []);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("terminates a live watcher once the run finishes", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const id = runId("run-1");
      yield* ledger.insertRun(record("run-1"));
      yield* ledger.appendEvent(id, ledgerEvent(0, event({ type: "RUN_STARTED" }), 1000));

      const fiber = yield* Stream.unwrap(Daemon.watchActivity(id)).pipe(Stream.runCollect, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* bus.publishActivity(activity("run-1", 1, event({ type: "TEXT_MESSAGE_CONTENT", delta: "hi" })));
      yield* bus.publishActivity(activity("run-1", 2, event({ type: "RUN_FINISHED", finishReason: "stop" })));

      const seen = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        seen.map((item) => item.seq),
        [0, 1, 2],
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("serves two concurrent scoped watchers the same full stream", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const id = runId("run-1");
      yield* ledger.insertRun(record("run-1"));
      yield* ledger.appendEvent(id, ledgerEvent(0, event({ type: "RUN_STARTED" }), 1000));

      const collect = () => Stream.unwrap(Daemon.watchActivity(id)).pipe(Stream.runCollect, Effect.forkChild);
      const first = yield* collect();
      const second = yield* collect();

      yield* Effect.yieldNow;
      yield* bus.publishActivity(activity("run-1", 1, event({ type: "TEXT_MESSAGE_CONTENT", delta: "hi" })));
      yield* bus.publishActivity(activity("run-1", 2, event({ type: "RUN_FINISHED", finishReason: "stop" })));

      const seenFirst = yield* Fiber.join(first);
      const seenSecond = yield* Fiber.join(second);
      assert.deepStrictEqual(
        seenFirst.map((item) => item.seq),
        [0, 1, 2],
      );
      assert.deepStrictEqual(
        seenSecond.map((item) => item.seq),
        [0, 1, 2],
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("keeps unscoped watch live-only", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const started = event({ type: "RUN_STARTED" });

      yield* ledger.insertRun(record("run-1"));
      yield* ledger.appendEvent(runId("run-1"), ledgerEvent(0, started, 1000));

      const fiber = yield* Stream.unwrap(Daemon.watchActivity(undefined)).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      yield* bus.publishActivity(activity("run-2", 0, started, 2000));

      const seen = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        seen.map((item) => item.runId),
        [runId("run-2")],
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
