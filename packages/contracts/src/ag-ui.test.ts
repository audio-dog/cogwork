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
  agUiIsSubagentEvent,
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
        SUBAGENT_STARTED: () => "subagent-started",
        SUBAGENT_FINISHED: () => "subagent-finished",
        SUBAGENT_ERROR: () => "subagent-error",
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

  it("decodes a recorded Run with Subagent events, and a recorded Run from before them", () => {
    const withSubagent = [
      { type: "RUN_STARTED", threadId: "s", runId: "r" },
      {
        type: "SUBAGENT_STARTED",
        subagentRunId: "sub-1",
        name: "reviewer",
        description: "Reviews one change",
        parentToolCallId: "call-1",
        timestamp: 1,
      },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "child text", subagentRunId: "sub-1" },
      { type: "SUBAGENT_FINISHED", subagentRunId: "sub-1", result: "review passed", timestamp: 2 },
      { type: "SUBAGENT_ERROR", subagentRunId: "sub-2", message: "model overloaded", timestamp: 3 },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "parent text" },
      { type: "RUN_FINISHED", threadId: "s", runId: "r" },
    ].map((event) => decodeEvent(event));
    const beforeSubagents = [
      { type: "RUN_STARTED", threadId: "s", runId: "r" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "parent text" },
      { type: "RUN_FINISHED", threadId: "s", runId: "r" },
    ].map((event) => decodeEvent(event));

    const lifecycle = withSubagent.map((event) =>
      AgUiEvent.matchOrElse(
        event,
        {
          SUBAGENT_STARTED: ({ subagentRunId }) => `${subagentRunId} started`,
          SUBAGENT_FINISHED: ({ subagentRunId }) => `${subagentRunId} finished`,
          SUBAGENT_ERROR: ({ subagentRunId }) => `${subagentRunId} failed`,
        },
        () => null,
      ),
    );
    assert.deepStrictEqual(lifecycle, [
      null,
      "sub-1 started",
      null,
      "sub-1 finished",
      "sub-2 failed",
      null,
      null,
    ]);
    assert.deepStrictEqual(withSubagent.map(agUiIsSubagentEvent), [
      false,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    assert.deepStrictEqual(beforeSubagents.map(agUiIsSubagentEvent), [false, false, false]);
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

  it("uses TanStack's Anthropic prompt total without adding cache counts again", () => {
    const finished = decodeEvent({
      type: "RUN_FINISHED",
      usage: {
        promptTokens: 17,
        completionTokens: 3,
        totalTokens: 20,
        promptTokensDetails: { cachedTokens: 5, cacheWriteTokens: 7 },
      },
    });

    assert.deepStrictEqual(agUiUsage(finished), {
      inputTokens: 17,
      outputTokens: 3,
      totalTokens: 20,
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
