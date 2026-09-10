import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  AgUiEvent,
  agUiFileDiffEvent,
  agUiFileDiffUnavailableEvent,
  agUiIsFileDiffEvent,
  agUiIsFileDiffUnavailableEvent,
  agUiIsSessionHandleEvent,
  agUiIsStructuredOutputComplete,
  agUiIsTerminal,
  agUiTextDelta,
  agUiUsage,
} from "./ag-ui";

const decodeEvent = Schema.decodeUnknownSync(AgUiEvent);

describe("AgUiEvent", () => {
  it("decodes named events with typed payloads and extra keys", () => {
    const event = decodeEvent({
      type: "TOOL_CALL_START",
      toolCallId: "call-1",
      toolCallName: "shell",
      args: "pnpm test",
      vendorTraceId: "trace-1",
    });

    if (!AgUiEvent.guards.TOOL_CALL_START(event)) return assert.fail("expected tool start");
    assert.strictEqual(event.vendorTraceId, "trace-1");
    assert.strictEqual(
      AgUiEvent.match(event, {
        RUN_STARTED: () => "run",
        TEXT_MESSAGE_START: () => "text-start",
        TEXT_MESSAGE_CONTENT: () => "text",
        TEXT_MESSAGE_END: () => "text-end",
        REASONING_MESSAGE_CONTENT: () => "reasoning",
        TOOL_CALL_START: ({ toolCallName }) => toolCallName,
        TOOL_CALL_ARGS: () => "args",
        TOOL_CALL_END: () => "end",
        TOOL_CALL_RESULT: () => "result",
        CUSTOM: () => "custom",
        STEP_STARTED: () => "step-started",
        STEP_FINISHED: () => "step-finished",
        RUN_FINISHED: () => "finished",
        RUN_ERROR: () => "error",
      }),
      "shell",
    );
  });

  it("decodes named text lifecycle events", () => {
    const started = decodeEvent({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" });
    const finished = decodeEvent({ type: "TEXT_MESSAGE_END", messageId: "m1" });

    assert.isTrue(AgUiEvent.guards.TEXT_MESSAGE_START(started));
    assert.isTrue(AgUiEvent.guards.TEXT_MESSAGE_END(finished));
  });

  it("decodes unnamed event types without dropping keys", () => {
    const event = decodeEvent({ type: "VENDOR\nPROGRESS", progress: 0.5, nested: { phase: "build" } });

    assert.deepStrictEqual(event, {
      type: "VENDOR\nPROGRESS",
      progress: 0.5,
      nested: { phase: "build" },
    });
    assert.strictEqual(
      AgUiEvent.matchOrElse(event, { RUN_STARTED: () => "run" }, ({ type }) => type),
      "VENDOR\nPROGRESS",
    );
    assert.isFalse(AgUiEvent.guards.RUN_STARTED(event));
  });

  it("backs event helpers with discriminated variants", () => {
    const text = decodeEvent({ type: "TEXT_MESSAGE_CONTENT", delta: "hello" });
    const session = decodeEvent({
      type: "CUSTOM",
      name: "codex.session-id",
      value: { sessionId: "session-1" },
    });
    const finished = decodeEvent({
      type: "RUN_FINISHED",
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, estimated: true },
    });
    const structured = decodeEvent({
      type: "CUSTOM",
      name: "structured-output.complete",
      value: { object: { outcome: "done" }, raw: '{"outcome":"done"}' },
    });

    assert.strictEqual(agUiTextDelta(text), "hello");
    assert.isTrue(agUiIsSessionHandleEvent(session));
    if (!agUiIsSessionHandleEvent(session)) return assert.fail("expected session handle");
    assert.strictEqual(session.value.sessionId, "session-1");
    assert.isTrue(agUiIsStructuredOutputComplete(structured));
    if (!agUiIsStructuredOutputComplete(structured)) return assert.fail("expected structured output");
    assert.deepStrictEqual(structured.value, {
      object: { outcome: "done" },
      raw: '{"outcome":"done"}',
    });
    assert.isTrue(agUiIsTerminal(finished));
    assert.deepStrictEqual(agUiUsage(finished), {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      estimated: true,
    });
  });

  it("owns the shared file-diff event contract", () => {
    const event = agUiFileDiffEvent("src/index.ts", "@@ changed @@");

    assert.isTrue(agUiIsFileDiffEvent(event));
    if (!agUiIsFileDiffEvent(event)) return assert.fail("expected file diff");
    assert.deepStrictEqual(event.value, { path: "src/index.ts", diff: "@@ changed @@" });
    assert.isFalse(agUiIsFileDiffEvent({ type: "CUSTOM", name: "sandbox.file.diff", value: { path: 1 } }));
  });

  it("owns the shared file-diff-unavailable event contract", () => {
    const event = agUiFileDiffUnavailableEvent();

    assert.isTrue(agUiIsFileDiffUnavailableEvent(event));
    if (!agUiIsFileDiffUnavailableEvent(event)) return assert.fail("expected unavailable event");
    assert.strictEqual(event.name, "sandbox.file.diff.unavailable");
    assert.include(event.value.message, "File changes may be incomplete");
    assert.isFalse(
      agUiIsFileDiffUnavailableEvent({
        type: "CUSTOM",
        name: "sandbox.file.diff.unavailable",
        value: { message: 1 },
      }),
    );
  });
});
