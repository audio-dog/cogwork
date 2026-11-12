import type { AgUiEvent, RunRecord } from "@cogwork/contracts";
import { BranchName, HarnessName, RunId, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Daemon from "./daemon";
import * as DaemonEventBus from "./daemon-event-bus";
import { activityOf } from "./daemon-event-bus";
import * as RunLedger from "./run-ledger";
import { RunRecorder, type RunRecorderService } from "./run-recorder";
import { engineTestLayer } from "./testing/engine-test-layer";

const runId = Schema.decodeSync(RunId);
const branchName = Schema.decodeSync(BranchName);
const workspace = Schema.decodeSync(WorkspaceId)("example");
const workItem = Schema.decodeSync(WorkItemId)("#49");
const harness = Schema.decodeSync(HarnessName)("cursor");

const layer = engineTestLayer();

const record = (id: string, status: "running" | "succeeded" = "running"): RunRecord => ({
  id: runId(id),
  workspace,
  workItem,
  operation: "implement" as const,
  harness,
  branch: branchName("49-backfill"),
  session: null,
  usage: null,
  status,
  startedAtMillis: 1000,
  endedAtMillis: status === "running" ? null : 2000,
});

const event = (over: Partial<AgUiEvent> & Pick<AgUiEvent, "type">) => ({ ...over }) satisfies AgUiEvent;

// A manual live publish for the history/live seam tests. `activityOf` wraps an
// already-decoded harness event — it never touches a run event's payload — so
// these stay clear of the encoding the recorder owns.
const activity = (id: string, seq: number, agUi: AgUiEvent, atMillis = 1000 + seq) =>
  activityOf(record(id), seq, atMillis, agUi);

const reconstructText = (activities: ReadonlyArray<{ readonly event: AgUiEvent }>) =>
  activities
    .filter((item) => item.event.type === "TEXT_MESSAGE_CONTENT")
    .map((item) => item.event.delta ?? "")
    .join("");

// Records events through the recorder — the one seam that encodes and publishes —
// and returns the live activities a subscriber saw, so tests never hand-build the
// encoding and can compare replay against the live stream.
const recordWatching = (rec: RunRecord, events: ReadonlyArray<AgUiEvent>) =>
  Effect.gen(function* () {
    const recorder = yield* RunRecorder;
    const eventBus = yield* DaemonEventBus.DaemonEventBus;
    const subscription = yield* eventBus.subscribe();
    yield* Effect.forEach(events, (item) => recorder.record(rec, item));
    const live = yield* DaemonEventBus.runActivityStream(Stream.fromSubscription(subscription)).pipe(
      Stream.take(events.length),
      Stream.runCollect,
    );
    return [...live];
  });

const seed = (rec: RunRecord, events: ReadonlyArray<AgUiEvent>) =>
  Effect.flatMap(RunRecorder, (recorder) => Effect.forEach(events, (item) => recorder.record(rec, item)));

describe("watchActivity", () => {
  it.effect("seeds scoped watchers from ledger history before live events", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const recorder = yield* RunRecorder;
      const id = runId("run-1");
      const rec = record("run-1");

      yield* ledger.insertRun(rec);
      yield* seed(rec, [
        event({ type: "RUN_STARTED" }),
        event({ type: "TEXT_MESSAGE_CONTENT", delta: "Hel" }),
        event({ type: "TEXT_MESSAGE_CONTENT", delta: "lo" }),
      ]);

      const ready = yield* Deferred.make<void>();
      const fiber = yield* Stream.unwrap(Daemon.watchActivity(id)).pipe(
        Stream.tap((item) => (item.seq === 2 ? Deferred.succeed(ready, undefined) : Effect.void)),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Deferred.await(ready);
      yield* recorder.record(rec, event({ type: "TEXT_MESSAGE_CONTENT", delta: "!" }));

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
      const eventBus = yield* DaemonEventBus.DaemonEventBus;
      const id = runId("run-1");
      const rec = record("run-1");

      yield* ledger.insertRun(rec);
      yield* seed(rec, [
        event({ type: "RUN_STARTED" }),
        event({ type: "TEXT_MESSAGE_CONTENT", delta: "mid" }),
      ]);

      const ready = yield* Deferred.make<void>();
      const fiber = yield* Stream.unwrap(Daemon.watchActivity(id)).pipe(
        Stream.tap((item) => (item.seq === 1 ? Deferred.succeed(ready, undefined) : Effect.void)),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Deferred.await(ready);
      yield* eventBus.publishActivity(
        activity("run-1", 1, event({ type: "TEXT_MESSAGE_CONTENT", delta: "mid" }), 1001),
      );
      yield* eventBus.publishActivity(
        activity("run-1", 2, event({ type: "TEXT_MESSAGE_CONTENT", delta: "next" }), 1002),
      );

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
      const ledger = yield* RunLedger.RunLedger;
      const recorder = yield* RunRecorder;
      const eventBus = yield* DaemonEventBus.DaemonEventBus;
      const id = runId("run-1");
      const rec = record("run-1");
      const late = event({ type: "TEXT_MESSAGE_CONTENT", delta: "late" });

      yield* ledger.insertRun(rec);
      yield* seed(rec, [
        event({ type: "RUN_STARTED" }),
        event({ type: "TEXT_MESSAGE_CONTENT", delta: "mid" }),
      ]);

      const racing: RunRecorderService = {
        ...recorder,
        replay: (run) =>
          recorder.replay(run).pipe(
            Stream.tap((item) =>
              item.seq === 0
                ? Effect.andThen(
                    ledger.appendEvent(id, {
                      seq: 2,
                      type: late.type,
                      name: null,
                      data: JSON.stringify(late),
                      atMillis: 1002,
                    }),
                    eventBus.publishActivity(activity("run-1", 2, late, 1002)),
                  )
                : Effect.void,
            ),
          ),
      };

      const seen = yield* Stream.unwrap(Daemon.watchActivity(id)).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(RunRecorder, racing),
      );

      assert.deepStrictEqual(
        seen.map((item) => item.seq),
        [0, 1, 2],
      );
      assert.strictEqual(reconstructText(seen), "midlate");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("replays a settled run as the very activities its live watchers saw", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const id = runId("run-1");
      const rec = record("run-1");

      yield* ledger.insertRun(rec);
      const live = yield* recordWatching(rec, [
        event({ type: "RUN_STARTED" }),
        event({ type: "TEXT_MESSAGE_CONTENT", delta: "done" }),
        event({ type: "RUN_FINISHED", finishReason: "stop" }),
      ]);
      yield* ledger.updateRun(id, { status: "succeeded", usage: null, endedAtMillis: 2000 });

      const replayed = yield* Stream.unwrap(Daemon.watchActivity(id)).pipe(Stream.runCollect);

      assert.deepStrictEqual([...replayed], live);
      assert.strictEqual(reconstructText([...replayed]), "done");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("replays the whole harness event and lifts its correlation ids onto the envelope", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const id = runId("run-1");
      const rec = record("run-1");
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

      yield* ledger.insertRun(rec);
      const live = yield* recordWatching(rec, [
        event({ type: "RUN_STARTED" }),
        reasoning,
        toolResult,
        event({ type: "RUN_FINISHED", finishReason: "stop" }),
      ]);
      yield* ledger.updateRun(id, { status: "succeeded", usage: null, endedAtMillis: 2000 });

      const replayed = [...(yield* Stream.unwrap(Daemon.watchActivity(id)).pipe(Stream.runCollect))];
      assert.deepStrictEqual(replayed, live);

      const replayedReasoning = replayed.find((item) => item.event.type === "REASONING_MESSAGE_CONTENT");
      const replayedResult = replayed.find((item) => item.event.type === "TOOL_CALL_RESULT");

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
      const eventBus = yield* DaemonEventBus.DaemonEventBus;
      const id = runId("run-1");
      const rec = record("run-1");
      yield* ledger.insertRun(rec);
      yield* seed(rec, [event({ type: "RUN_STARTED" })]);

      const fiber = yield* Stream.unwrap(Daemon.watchActivity(id)).pipe(Stream.runCollect, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* eventBus.publishActivity(
        activity("run-1", 1, event({ type: "TEXT_MESSAGE_CONTENT", delta: "hi" })),
      );
      yield* eventBus.publishActivity(
        activity("run-1", 2, event({ type: "RUN_FINISHED", finishReason: "stop" })),
      );

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
      const eventBus = yield* DaemonEventBus.DaemonEventBus;
      const id = runId("run-1");
      const rec = record("run-1");
      yield* ledger.insertRun(rec);
      yield* seed(rec, [event({ type: "RUN_STARTED" })]);

      const collect = () => Stream.unwrap(Daemon.watchActivity(id)).pipe(Stream.runCollect, Effect.forkChild);
      const first = yield* collect();
      const second = yield* collect();

      yield* Effect.yieldNow;
      yield* eventBus.publishActivity(
        activity("run-1", 1, event({ type: "TEXT_MESSAGE_CONTENT", delta: "hi" })),
      );
      yield* eventBus.publishActivity(
        activity("run-1", 2, event({ type: "RUN_FINISHED", finishReason: "stop" })),
      );

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
      const eventBus = yield* DaemonEventBus.DaemonEventBus;
      const rec = record("run-1");
      const started = event({ type: "RUN_STARTED" });

      yield* ledger.insertRun(rec);
      yield* seed(rec, [started]);

      const fiber = yield* Stream.unwrap(Daemon.watchActivity(undefined)).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      yield* eventBus.publishActivity(activity("run-2", 0, started, 2000));

      const seen = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        seen.map((item) => item.runId),
        [runId("run-2")],
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
