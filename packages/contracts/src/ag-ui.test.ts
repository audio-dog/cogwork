import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  AgUiEvent,
  AgUiEventUnion,
  agUiIsStructuredOutputComplete,
  agUiIsTerminal,
  agUiSessionId,
  agUiTextDelta,
  agUiUsage,
} from "./ag-ui";

const decodeFlatEvent = Schema.decodeUnknownSync(AgUiEvent);
const decodeEvent = Schema.decodeUnknownSync(AgUiEventUnion);

describe("AgUiEventUnion", () => {
  it("decodes named events with typed payloads and extra keys", () => {
    const event = decodeEvent({
      type: "TOOL_CALL_START",
      toolCallId: "call-1",
      toolCallName: "shell",
      args: "pnpm test",
      vendorTraceId: "trace-1",
    });

    if (!AgUiEventUnion.guards.TOOL_CALL_START(event)) return assert.fail("expected tool start");
    assert.strictEqual(event.vendorTraceId, "trace-1");
    assert.strictEqual(
      AgUiEventUnion.match(event, {
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

    assert.isTrue(AgUiEventUnion.guards.TEXT_MESSAGE_START(started));
    assert.isTrue(AgUiEventUnion.guards.TEXT_MESSAGE_END(finished));
  });

  it("decodes unnamed event types without dropping keys", () => {
    const event = decodeEvent({ type: "VENDOR\nPROGRESS", progress: 0.5, nested: { phase: "build" } });

    assert.deepStrictEqual(event, {
      type: "VENDOR\nPROGRESS",
      progress: 0.5,
      nested: { phase: "build" },
    });
    assert.strictEqual(
      AgUiEventUnion.matchOrElse(event, { RUN_STARTED: () => "run" }, ({ type }) => type),
      "VENDOR\nPROGRESS",
    );
    assert.isFalse(AgUiEventUnion.guards.RUN_STARTED(event));
  });

  it("decodes every payload accepted by the flat schema", () => {
    const session = decodeFlatEvent({
      type: "CUSTOM",
      name: "codex.session-id",
      value: { sessionId: "session-1", extra: undefined },
    });
    const finished = decodeFlatEvent({ type: "RUN_FINISHED", runId: 42 });
    const text = decodeFlatEvent({ type: "TEXT_MESSAGE_CONTENT", delta: undefined });

    assert.deepStrictEqual(decodeEvent(session), session);
    assert.deepStrictEqual(decodeEvent(finished), finished);
    assert.deepStrictEqual(decodeEvent(text), text);
    assert.strictEqual(agUiSessionId(session), "session-1");
    assert.isTrue(agUiIsTerminal(finished));
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
    assert.strictEqual(agUiSessionId(session), "session-1");
    assert.isTrue(agUiIsTerminal(finished));
    assert.deepStrictEqual(agUiUsage(finished), {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      estimated: true,
    });
    assert.isTrue(agUiIsStructuredOutputComplete(structured));
  });
});
