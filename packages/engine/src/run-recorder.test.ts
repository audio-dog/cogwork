import {
  type AgUiEvent,
  HarnessName,
  type RunEvent,
  RunId,
  type RunRecord,
  type Session,
  SessionId,
  sessionHandle,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as DaemonEventBus from "./daemon-event-bus";
import { activityOf } from "./daemon-event-bus";
import * as RunLedger from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { engineTestLayer } from "./testing/engine-test-layer";

const runId = Schema.decodeSync(RunId);
const sessionId = Schema.decodeSync(SessionId);
const workspace = Schema.decodeSync(WorkspaceId)("gh");
const workItem = Schema.decodeSync(WorkItemId)("#7");
const cursor = Schema.decodeSync(HarnessName)("cursor");

const testLayer = engineTestLayer();

const run = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id: runId(id),
  workspace,
  workItem,
  stage: "implement",
  harness: cursor,
  branch: null,
  session: null,
  usage: null,
  status: "running",
  startedAtMillis: 1000,
  endedAtMillis: null,
  ...over,
});

const opaqueSession = (id: SessionId): Session => ({
  kind: "opaque-handle",
  id,
  workspace,
  harness: cursor,
  createdAtMillis: 0,
  handle: null,
});

const text = (delta: string) => ({ type: "TEXT_MESSAGE_CONTENT", delta }) satisfies AgUiEvent;

const ledgerEvent = (seq: number, agUi: AgUiEvent, atMillis = 1000 + seq): RunEvent => ({
  seq,
  type: agUi.type,
  name: typeof agUi.name === "string" ? agUi.name : null,
  data: JSON.stringify(agUi),
  atMillis,
});

const undecodable = (seq: number, atMillis = 1000 + seq): RunEvent => ({
  seq,
  type: "?",
  name: null,
  data: "not json",
  atMillis,
});

const sessionEvent = (id: string, namespace = "cursor") =>
  ({ type: "CUSTOM", name: `${namespace}.session-id`, value: { sessionId: id } }) satisfies AgUiEvent;

const runStarted: AgUiEvent = { type: "RUN_STARTED" };
const finished: AgUiEvent = { type: "RUN_FINISHED", finishReason: "stop" };

const recordAll = (record: RunRecord, events: ReadonlyArray<AgUiEvent>) =>
  Effect.gen(function* () {
    const recorder = yield* RunRecorder;
    const eventBus = yield* DaemonEventBus.DaemonEventBus;
    const subscription = yield* eventBus.subscribe();
    const handles = yield* Effect.forEach(events, (event) => recorder.record(record, event));
    const activities = yield* DaemonEventBus.runActivityStream(Stream.fromSubscription(subscription)).pipe(
      Stream.take(events.length),
      Stream.runCollect,
    );
    return { handles, activities: [...activities] };
  });

const seqOf = (events: ReadonlyArray<{ readonly seq: number }>) => events.map((event) => event.seq);

describe("RunRecorder", () => {
  it.layer(testLayer)((it) => {
    it.effect("appends and publishes each event as one moment: same seq, timestamp, and event", () =>
      Effect.gen(function* () {
        const record = run("run-append");
        const events = [runStarted, text("hello"), finished];
        const { activities } = yield* recordAll(record, events);

        const ledger = yield* RunLedger.RunLedger;
        const appended = yield* ledger.events(record.id).pipe(Stream.runCollect);

        assert.strictEqual(appended.length, events.length);
        assert.strictEqual(activities.length, events.length);
        events.forEach((event, index) => {
          const appendedEvent = appended[index];
          const activity = activities[index];
          assert.isDefined(appendedEvent);
          assert.isDefined(activity);
          if (!appendedEvent || !activity) return;
          assert.deepStrictEqual(
            activity,
            activityOf(record, appendedEvent.seq, appendedEvent.atMillis, event),
          );
        });
      }),
    );

    it.effect("owns a per-run monotonic sequence starting at zero", () =>
      Effect.gen(function* () {
        const record = run("run-seq");
        yield* recordAll(record, [runStarted, text("a"), text("b"), finished]);

        const ledger = yield* RunLedger.RunLedger;
        assert.deepStrictEqual(seqOf(yield* ledger.events(record.id).pipe(Stream.runCollect)), [0, 1, 2, 3]);
      }),
    );

    it.effect("keeps display names from accepted event fields", () =>
      Effect.gen(function* () {
        const record = run("run-names");
        yield* recordAll(record, [
          { type: "TOOL_CALL_END", toolCallId: "t1", toolCallName: "shell" },
          { type: "VENDOR_STATUS", name: "phase" },
        ]);

        const ledger = yield* RunLedger.RunLedger;
        assert.deepStrictEqual(
          (yield* ledger.events(record.id).pipe(Stream.runCollect)).map(({ name }) => name),
          ["shell", "phase"],
        );
      }),
    );

    it.effect("counts each run's sequence on its own", () =>
      Effect.gen(function* () {
        const first = run("run-count-a");
        const second = run("run-count-b");
        yield* recordAll(first, [runStarted, text("a")]);
        yield* recordAll(second, [runStarted, text("b"), finished]);

        const ledger = yield* RunLedger.RunLedger;
        assert.deepStrictEqual(seqOf(yield* ledger.events(first.id).pipe(Stream.runCollect)), [0, 1]);
        assert.deepStrictEqual(seqOf(yield* ledger.events(second.id).pipe(Stream.runCollect)), [0, 1, 2]);
      }),
    );

    it.effect("captures a clean session handle onto the run's session and returns it", () =>
      Effect.gen(function* () {
        const session = sessionId("sess-handle");
        const record = run("run-handle", { session });
        const ledger = yield* RunLedger.RunLedger;
        yield* ledger.insertSession(opaqueSession(session));

        const recorder = yield* RunRecorder;
        const first = yield* recorder.record(record, runStarted);
        const captured = yield* recorder.record(record, sessionEvent("cursor-abc"));
        const carried = yield* recorder.record(record, text("more"));

        assert.isNull(first);
        assert.strictEqual(captured, "cursor-abc");
        assert.strictEqual(carried, "cursor-abc");
        assert.strictEqual(sessionHandle(yield* ledger.getSession(session)), "cursor-abc");
      }),
    );

    it.effect("captures native handles from every namespaced session-id event", () =>
      Effect.gen(function* () {
        const session = sessionId("sess-generic-handle");
        const record = run("run-generic-handle", { session });
        const ledger = yield* RunLedger.RunLedger;
        yield* ledger.insertSession(opaqueSession(session));

        const recorder = yield* RunRecorder;
        const claude = yield* recorder.record(record, sessionEvent("claude-native", "claude-code"));
        const codex = yield* recorder.record(record, sessionEvent("codex-native", "codex"));

        assert.strictEqual(claude, "claude-native");
        assert.strictEqual(codex, "codex-native");
        assert.strictEqual(sessionHandle(yield* ledger.getSession(session)), "codex-native");
      }),
    );

    it.effect("refuses a handle carrying whitespace or a backtick", () =>
      Effect.gen(function* () {
        const session = sessionId("sess-sanitize");
        const record = run("run-sanitize", { session });
        const ledger = yield* RunLedger.RunLedger;
        yield* ledger.insertSession(opaqueSession(session));

        const recorder = yield* RunRecorder;
        const spaced = yield* recorder.record(record, sessionEvent("has space"));
        const ticked = yield* recorder.record(record, sessionEvent("has`tick"));

        assert.isNull(spaced);
        assert.isNull(ticked);
        assert.isNull(sessionHandle(yield* ledger.getSession(session)));
      }),
    );

    it.effect("ignores a malformed session-id payload", () =>
      Effect.gen(function* () {
        const session = sessionId("sess-malformed");
        const record = run("run-malformed", { session });
        const ledger = yield* RunLedger.RunLedger;
        yield* ledger.insertSession(opaqueSession(session));

        const recorder = yield* RunRecorder;
        const captured = yield* recorder.record(record, {
          type: "CUSTOM",
          name: "cursor.session-id",
          value: { wrong: "shape" },
        });

        assert.isNull(captured);
        assert.isNull(sessionHandle(yield* ledger.getSession(session)));
      }),
    );

    it.effect("keeps a handle off a run with no session", () =>
      Effect.gen(function* () {
        const record = run("run-nosession");
        const recorder = yield* RunRecorder;
        const captured = yield* recorder.record(record, sessionEvent("cursor-abc"));
        assert.isNull(captured);
      }),
    );

    it.effect("replays a settled run as the very activities its live watchers saw", () =>
      Effect.gen(function* () {
        const record = run("run-replay", { status: "succeeded", endedAtMillis: 2000 });
        const { activities: live } = yield* recordAll(record, [runStarted, text("done"), finished]);

        const recorder = yield* RunRecorder;
        const replayed = yield* recorder.replay(record).pipe(Stream.runCollect);

        assert.deepStrictEqual(replayed, live);
      }),
    );

    it.effect("replays more than 256 events in multiple chunks", () =>
      Effect.gen(function* () {
        const record = run("run-replay-pages");
        const ledger = yield* RunLedger.RunLedger;
        yield* Effect.forEach(
          Array.from({ length: 257 }, (_, seq) => seq),
          (seq) => ledger.appendEvent(record.id, ledgerEvent(seq, text(String(seq)))),
          { discard: true },
        );

        const recorder = yield* RunRecorder;
        const chunks = yield* recorder.replay(record).pipe(Stream.chunks, Stream.runCollect);

        assert.deepStrictEqual(
          chunks.map((chunk) => chunk.length),
          [256, 1],
        );
      }),
    );

    it.effect("drops a stored event it cannot decode when replaying", () =>
      Effect.gen(function* () {
        const record = run("run-replay-bad");
        const ledger = yield* RunLedger.RunLedger;
        yield* ledger.appendEvent(record.id, ledgerEvent(0, runStarted));
        yield* ledger.appendEvent(record.id, undecodable(1));
        yield* ledger.appendEvent(record.id, ledgerEvent(2, finished));

        const recorder = yield* RunRecorder;
        const replayed = yield* recorder.replay(record).pipe(Stream.runCollect);

        assert.deepStrictEqual(seqOf(replayed), [0, 2]);
      }),
    );

    it.effect("hands the transcript fold a session's decoded events, oldest run first", () =>
      Effect.gen(function* () {
        const session = sessionId("sess-fold");
        const older = run("run-old", { session, startedAtMillis: 1000 });
        const newer = run("run-new", { session, startedAtMillis: 2000 });
        const ledger = yield* RunLedger.RunLedger;
        yield* ledger.insertRun(older);
        yield* ledger.insertRun(newer);
        yield* ledger.appendEvent(older.id, ledgerEvent(0, text("first")));
        yield* ledger.appendEvent(older.id, undecodable(1));
        yield* ledger.appendEvent(newer.id, ledgerEvent(0, text("second")));

        const recorder = yield* RunRecorder;
        const decoded = yield* recorder.sessionEvents(session);

        assert.deepStrictEqual(decoded, [text("first"), text("second")]);
      }),
    );
    it.effect("logs an event encoding failure without persisting a placeholder", () =>
      Effect.gen(function* () {
        const record = run("run-encode-failure");
        const recorder = yield* RunRecorder;
        const ledger = yield* RunLedger.RunLedger;
        const messages: Array<string> = [];
        const event = { type: "CUSTOM", content: 1n } satisfies AgUiEvent;

        const error = yield* recorder.record(record, event).pipe(
          Effect.withLogger(
            Logger.make(({ message }) => {
              messages.push(String(message));
            }),
          ),
          Effect.flip,
        );

        assert.strictEqual(error.operation, RunLedger.encodeRunEventOperation);
        assert.deepStrictEqual(yield* ledger.events(record.id).pipe(Stream.runCollect), []);
        assert.isTrue(messages.some((message) => message.includes("run event encoding failed")));
      }),
    );
  });
});
