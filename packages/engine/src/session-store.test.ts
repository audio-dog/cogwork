import {
  type AgUiEvent,
  HarnessName,
  type RunEvent,
  RunId,
  SessionId,
  WorkItemId,
  WorkspaceId,
} from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DaemonEventBus from "./daemon-event-bus";
import { layerMemory, RunLedger } from "./run-ledger";
import { foldThread, make, SessionStore } from "./session-store";

const runId = Schema.decodeSync(RunId);
const workspace = Schema.decodeSync(WorkspaceId)("gh");
const workItem = Schema.decodeSync(WorkItemId)("#7");
const session = Schema.decodeSync(SessionId)("sess-1");
const harness = Schema.decodeSync(HarnessName)("cursor");

const event = (seq: number, value: AgUiEvent): RunEvent => ({
  seq,
  type: value.type,
  name: value.name ?? null,
  data: JSON.stringify(value),
  atMillis: 1000 + seq,
});

const layer = Layer.provideMerge(
  Layer.effect(SessionStore, make),
  layerMemory.pipe(Layer.provide(DaemonEventBus.layer)),
);

describe("foldThread", () => {
  it("splits assistant text on a tool call and keeps the tool's name and args", () => {
    const events = [
      event(0, { type: "TEXT_MESSAGE_CONTENT", delta: "Hello " }),
      event(1, { type: "TEXT_MESSAGE_CONTENT", delta: "world" }),
      event(2, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash", args: "ls -la" }),
      event(3, { type: "TEXT_MESSAGE_CONTENT", delta: "done" }),
      event(4, { type: "RUN_FINISHED", finishReason: "stop" }),
    ];
    assert.deepStrictEqual(foldThread(events), [
      { role: "assistant", content: "Hello world" },
      { role: "tool", content: "ls -la", toolName: "bash" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("folds each tool call once even when the harness streams several deltas for it", () => {
    const events = [
      event(0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read", args: "a.ts" }),
      event(1, { type: "TOOL_CALL_ARGS", toolCallId: "t1", args: "a.ts" }),
      event(2, { type: "TOOL_CALL_END", toolCallId: "t1" }),
    ];
    assert.deepStrictEqual(foldThread(events), [{ role: "tool", content: "a.ts", toolName: "read" }]);
  });

  it("ignores events it cannot decode", () => {
    assert.deepStrictEqual(foldThread([{ data: "not json" }]), []);
  });
});

describe("SessionStore ledger-backed message store", () => {
  const insert = (id: string, startedAtMillis: number, events: ReadonlyArray<RunEvent>) =>
    Effect.flatMap(RunLedger, (ledger) =>
      ledger
        .insertRun({
          id: runId(id),
          workspace,
          workItem,
          stage: "implement",
          harness,
          branch: "b",
          session,
          usage: null,
          status: "running",
          startedAtMillis,
          endedAtMillis: null,
        })
        .pipe(Effect.andThen(Effect.forEach(events, (e) => ledger.appendEvent(runId(id), e)))),
    );

  const loadThread = (store: typeof SessionStore.Service, id: SessionId) =>
    Effect.promise(() => store.persistence.stores.messages.loadThread(id));

  it.effect("folds a session's transcript across the runs that share it, oldest run first", () =>
    Effect.gen(function* () {
      yield* insert("run-2", 2000, [
        event(0, { type: "TEXT_MESSAGE_CONTENT", delta: "second" }),
        event(1, { type: "RUN_FINISHED", finishReason: "stop" }),
      ]);
      yield* insert("run-1", 1000, [
        event(0, { type: "TEXT_MESSAGE_CONTENT", delta: "first" }),
        event(1, { type: "RUN_FINISHED", finishReason: "stop" }),
      ]);

      const store = yield* SessionStore;
      assert.deepStrictEqual(yield* loadThread(store, session), [
        { role: "assistant", content: "first" },
        { role: "assistant", content: "second" },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("carries a prior tool call back as a labelled user turn", () =>
    Effect.gen(function* () {
      yield* insert("run-1", 1000, [
        event(0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash", args: "ls" }),
        event(1, { type: "RUN_FINISHED", finishReason: "stop" }),
      ]);

      const store = yield* SessionStore;
      assert.deepStrictEqual(yield* loadThread(store, session), [
        { role: "user", content: "Result from bash:\nls" },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns an empty transcript for a session with nothing recorded", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      assert.deepStrictEqual(yield* loadThread(store, session), []);
    }).pipe(Effect.provide(layer)),
  );
});

describe("SessionStore.resumeHandle", () => {
  const insertSession = (handle: string | null) =>
    Effect.flatMap(RunLedger, (ledger) =>
      ledger.insertSession({
        kind: "opaque-handle",
        id: session,
        workspace,
        harness,
        createdAtMillis: 0,
        handle,
      }),
    );

  it.effect("hands back the opaque handle a CLI runner resumes from", () =>
    Effect.gen(function* () {
      yield* insertSession("cursor-abc");
      const store = yield* SessionStore;
      assert.strictEqual(yield* store.resumeHandle(session), "cursor-abc");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("is null for a session that has no handle yet", () =>
    Effect.gen(function* () {
      yield* insertSession(null);
      const store = yield* SessionStore;
      assert.isNull(yield* store.resumeHandle(session));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("is null for a session that was never recorded", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      assert.isNull(yield* store.resumeHandle(session));
    }).pipe(Effect.provide(layer)),
  );
});
