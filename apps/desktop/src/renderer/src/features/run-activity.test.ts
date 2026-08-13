import { type AgUiEvent, DaemonEvent } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { runPreviews } from "./run-activity";

const event = Schema.decodeSync(DaemonEvent);

const activity = (
  runId: string,
  seq: number,
  agui: AgUiEvent & { type: string },
  messageId: string | null = null,
) =>
  event({
    _tag: "RunActivity",
    activity: {
      runId,
      workspace: "acme",
      workItem: "1",
      stage: "implement",
      seq,
      atMillis: seq,
      correlation: { threadId: null, messageId, toolCallId: agui.toolCallId ?? null },
      event: agui,
    },
  });

describe("runPreviews", () => {
  it("has no preview when there are no events", () => {
    expect(runPreviews([]).size).toBe(0);
  });

  it("labels a tool call by its name and shows the result", () => {
    const previews = runPreviews([
      activity("run-1", 0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "grep" }),
      activity("run-1", 1, { type: "TOOL_CALL_END", toolCallId: "t1", result: "12 matches" }),
    ]);

    expect(previews.get("run-1")).toEqual({ label: "grep", text: "12 matches" });
  });

  it("accumulates streaming text within one message", () => {
    const previews = runPreviews([
      activity("run-1", 0, { type: "TEXT_MESSAGE_CONTENT", delta: "Extending " }, "m1"),
      activity("run-1", 1, { type: "TEXT_MESSAGE_CONTENT", delta: "the store." }, "m1"),
    ]);

    expect(previews.get("run-1")).toEqual({ label: "responding", text: "Extending the store." });
  });

  it("resets accumulated text when the message id changes", () => {
    const previews = runPreviews([
      activity("run-1", 0, { type: "TEXT_MESSAGE_CONTENT", delta: "first" }, "m1"),
      activity("run-1", 1, { type: "TEXT_MESSAGE_CONTENT", delta: "second" }, "m2"),
    ]);

    expect(previews.get("run-1")).toEqual({ label: "responding", text: "second" });
  });

  it("keeps the latest activity per run and tracks runs independently", () => {
    const previews = runPreviews([
      activity("run-1", 0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
      activity("run-2", 1, { type: "TEXT_MESSAGE_CONTENT", delta: "hello" }, "m1"),
      activity("run-1", 2, { type: "STEP_STARTED", stepName: "typecheck" }),
    ]);

    expect(previews.get("run-1")).toEqual({ label: "step", text: "typecheck" });
    expect(previews.get("run-2")).toEqual({ label: "responding", text: "hello" });
  });

  it("collapses whitespace and clips long text to a single line", () => {
    const long = "x".repeat(400);
    const previews = runPreviews([
      activity("run-1", 0, { type: "TEXT_MESSAGE_CONTENT", delta: `line one\n\n${long}` }, "m1"),
    ]);

    const preview = previews.get("run-1");
    expect(preview?.label).toBe("responding");
    expect(preview?.text.includes("\n")).toBe(false);
    expect(preview?.text.endsWith("…")).toBe(true);
    expect(preview?.text.length).toBe(160);
  });

  it("ignores an unknown or hostile event type without throwing", () => {
    const previews = runPreviews([
      activity("run-1", 0, { type: "__proto__" }),
      activity("run-1", 1, { type: "SOMETHING_NEW" }),
      activity("run-1", 2, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
    ]);

    expect(previews.get("run-1")).toEqual({ label: "read", text: "" });
  });

  it("ignores the session-id custom event", () => {
    const previews = runPreviews([
      activity("run-1", 0, { type: "CUSTOM", name: "harness.session-id", value: { sessionId: "s1" } }),
    ]);

    expect(previews.has("run-1")).toBe(false);
  });
});
