import {
  type AgUiEvent,
  BranchName,
  HarnessName,
  type RunEvent,
  RunId,
  SessionId,
  type SessionKind,
  sessionHandle,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import { RunLedger } from "./run-ledger";
import { foldThread, SessionStore } from "./session-store";
import { engineTestLayer } from "./testing/engine-test-layer";

const runId = Schema.decodeSync(RunId);
const branchName = Schema.decodeSync(BranchName);
const workspace = Schema.decodeSync(WorkspaceId)("gh");
const workItem = Schema.decodeSync(WorkItemId)("#7");
const session = Schema.decodeSync(SessionId)("sess-1");
const harness = Schema.decodeSync(HarnessName)("cursor");

const event = (seq: number, value: AgUiEvent): RunEvent => ({
  seq,
  type: value.type,
  name: typeof value.name === "string" ? value.name : null,
  data: JSON.stringify(value),
  atMillis: 1000 + seq,
});

const layer = engineTestLayer();

describe("foldThread", () => {
  it("leaves Subagent child events out of the parent transcript", () => {
    const events: ReadonlyArray<AgUiEvent> = [
      { type: "TEXT_MESSAGE_CONTENT", delta: "Parent " },
      { type: "SUBAGENT_STARTED", subagentRunId: "child-1", name: "reviewer" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "child text", subagentRunId: "child-1" },
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "read", subagentRunId: "child-1" },
      { type: "SUBAGENT_FINISHED", subagentRunId: "child-1" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "text" },
      { type: "RUN_FINISHED", finishReason: "stop" },
    ];
    assert.deepStrictEqual(foldThread(events), [{ role: "assistant", content: "Parent text" }]);
  });

  it("splits assistant text on a tool call and keeps the tool's name and args", () => {
    const events: ReadonlyArray<AgUiEvent> = [
      { type: "TEXT_MESSAGE_CONTENT", delta: "Hello " },
      { type: "TEXT_MESSAGE_CONTENT", delta: "world" },
      { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash", args: "ls -la" },
      { type: "TEXT_MESSAGE_CONTENT", delta: "done" },
      { type: "RUN_FINISHED", finishReason: "stop" },
    ];
    assert.deepStrictEqual(foldThread(events), [
      { role: "assistant", content: "Hello world" },
      { role: "tool", content: "ls -la", toolName: "bash" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("folds each tool call once even when the harness streams several deltas for it", () => {
    const events: ReadonlyArray<AgUiEvent> = [
      { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read", args: "a.ts" },
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", args: "a.ts" },
      { type: "TOOL_CALL_END", toolCallId: "t1" },
    ];
    assert.deepStrictEqual(foldThread(events), [{ role: "tool", content: "a.ts", toolName: "read" }]);
  });

  it("keeps the tool name when a later tool event arrives first", () => {
    const events: ReadonlyArray<AgUiEvent> = [
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", toolCallName: "read", args: "a.ts" },
      { type: "TOOL_CALL_END", toolCallId: "t2", toolCallName: "write", args: "b.ts" },
      { type: "TOOL_CALL_RESULT", toolCallId: "t3", toolCallName: "shell" },
    ];

    assert.deepStrictEqual(foldThread(events), [
      { role: "tool", content: "a.ts", toolName: "read" },
      { role: "tool", content: "b.ts", toolName: "write" },
      { role: "tool", content: "", toolName: "shell" },
    ]);
  });

  it("folds a forward-compatible tool call event", () => {
    const events: ReadonlyArray<AgUiEvent> = [
      {
        type: "TOOL_CALL_CHUNK",
        toolCallId: "t1",
        toolCallName: "bash",
        args: "ls",
      },
    ];

    assert.deepStrictEqual(foldThread(events), [{ role: "tool", content: "ls", toolName: "bash" }]);
  });

  it("preserves a structured result as an assistant turn", () => {
    const raw = '{"_tag":"triage","role":"ready-for-agent","proposal":"Verified and ready."}';
    const events: ReadonlyArray<AgUiEvent> = [
      { type: "CUSTOM", name: "structured-output.start", value: { messageId: "m1" } },
      {
        type: "CUSTOM",
        name: "structured-output.complete",
        value: {
          object: { _tag: "triage", role: "ready-for-agent", proposal: "Verified and ready." },
          raw,
        },
      },
      { type: "RUN_FINISHED", finishReason: "stop" },
    ];

    assert.deepStrictEqual(foldThread(events), [{ role: "assistant", content: raw }]);
  });

  it("ignores a malformed structured result envelope", () => {
    const events: ReadonlyArray<AgUiEvent> = [
      {
        type: "CUSTOM",
        name: "structured-output.complete",
        value: { object: { _tag: "triage" } },
      },
      { type: "RUN_FINISHED", finishReason: "stop" },
    ];

    assert.deepStrictEqual(foldThread(events), []);
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
          operation: "implement",
          harness,
          branch: branchName("b"),
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

describe("SessionStore interrupt persistence adapter", () => {
  it.effect("runs the Effect service through the Promise contract", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const interrupts = store.persistence.stores.interrupts;
      yield* Effect.promise(() =>
        interrupts.create({
          interruptId: "interrupt-1",
          runId: "run-1",
          threadId: "thread-1",
          requestedAt: 10,
          payload: {},
        }),
      );
      yield* TestClock.setTime(1234);
      yield* Effect.promise(() => interrupts.resolve("interrupt-1"));

      assert.strictEqual((yield* Effect.promise(() => interrupts.get("interrupt-1")))?.resolvedAt, 1234);
    }).pipe(Effect.provide(layer)),
  );
});

describe("SessionStore.mint", () => {
  const declares = (kind: SessionKind) => () => kind;

  it.effect("mints an owned-transcript session when the runner declares it", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const ledger = yield* RunLedger;
      const id = yield* store.mint({ workspace, harness, createdAtMillis: 5 }, declares("owned-transcript"));
      const minted = yield* ledger.getSession(id);
      assert.strictEqual(minted?.kind, "owned-transcript");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("mints an opaque-handle session with no handle yet when the runner declares it", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const ledger = yield* RunLedger;
      const id = yield* store.mint({ workspace, harness, createdAtMillis: 5 }, declares("opaque-handle"));
      const minted = yield* ledger.getSession(id);
      assert.strictEqual(minted?.kind, "opaque-handle");
      assert.isNull(sessionHandle(minted));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("gives each minted session a distinct id", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const first = yield* store.mint({ workspace, harness, createdAtMillis: 5 }, declares("opaque-handle"));
      const second = yield* store.mint({ workspace, harness, createdAtMillis: 5 }, declares("opaque-handle"));
      assert.notStrictEqual(first, second);
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
