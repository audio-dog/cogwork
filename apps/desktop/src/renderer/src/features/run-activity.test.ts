import { type AgUiEvent, DaemonEvent, type RunActivity } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  applyRunPreview,
  foldTranscript,
  previewMap,
  type RunPreviewState,
  statusLine,
} from "./run-activity";

const decodeEvent = Schema.decodeUnknownSync(DaemonEvent);
const event = (value: Record<string, unknown>) => decodeEvent({ ...value, emittedAtMillis: 0 });

const activity = (
  runId: string,
  seq: number,
  agui: AgUiEvent & { type: string },
  messageId: string | null = null,
) => {
  const decoded = event({
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
  if (decoded._tag !== "RunActivity") throw new Error("Expected run activity");
  return decoded.activity;
};

const runActivity = (seq: number, agui: AgUiEvent & { type: string }) => activity("run-1", seq, agui);

const previewsOf = (activities: ReadonlyArray<RunActivity>) =>
  previewMap(activities.reduce<RunPreviewState>((state, next) => applyRunPreview(state, next), new Map()));

describe("applyRunPreview", () => {
  it("has no preview when there are no events", () => {
    expect(previewsOf([]).size).toBe(0);
  });

  it("labels a tool call by its name and shows the result", () => {
    const previews = previewsOf([
      activity("run-1", 0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "grep" }),
      activity("run-1", 1, { type: "TOOL_CALL_END", toolCallId: "t1", result: "12 matches" }),
    ]);

    expect(previews.get("run-1")).toEqual({ label: "grep", text: "12 matches" });
  });

  it("accumulates streaming text within one message", () => {
    const previews = previewsOf([
      activity("run-1", 0, { type: "TEXT_MESSAGE_CONTENT", delta: "Extending " }, "m1"),
      activity("run-1", 1, { type: "TEXT_MESSAGE_CONTENT", delta: "the store." }, "m1"),
    ]);

    expect(previews.get("run-1")).toEqual({ label: "responding", text: "Extending the store." });
  });

  it("resets accumulated text when the message id changes", () => {
    const previews = previewsOf([
      activity("run-1", 0, { type: "TEXT_MESSAGE_CONTENT", delta: "first" }, "m1"),
      activity("run-1", 1, { type: "TEXT_MESSAGE_CONTENT", delta: "second" }, "m2"),
    ]);

    expect(previews.get("run-1")).toEqual({ label: "responding", text: "second" });
  });

  it("keeps the latest activity per run and tracks runs independently", () => {
    const previews = previewsOf([
      activity("run-1", 0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
      activity("run-2", 1, { type: "TEXT_MESSAGE_CONTENT", delta: "hello" }, "m1"),
      activity("run-1", 2, { type: "STEP_STARTED", stepName: "typecheck" }),
    ]);

    expect(previews.get("run-1")).toEqual({ label: "step", text: "typecheck" });
    expect(previews.get("run-2")).toEqual({ label: "responding", text: "hello" });
  });

  it("collapses whitespace and clips long text to a single line", () => {
    const long = "x".repeat(400);
    const previews = previewsOf([
      activity("run-1", 0, { type: "TEXT_MESSAGE_CONTENT", delta: `line one\n\n${long}` }, "m1"),
    ]);

    const preview = previews.get("run-1");
    expect(preview?.label).toBe("responding");
    expect(preview?.text.includes("\n")).toBe(false);
    expect(preview?.text.endsWith("…")).toBe(true);
    expect(preview?.text.length).toBe(160);
  });

  it("ignores an unknown or hostile event type without throwing", () => {
    const previews = previewsOf([
      activity("run-1", 0, { type: "__proto__" }),
      activity("run-1", 1, { type: "SOMETHING_NEW" }),
      activity("run-1", 2, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
    ]);

    expect(previews.get("run-1")).toEqual({ label: "read", text: "" });
  });

  it("ignores the session-id custom event", () => {
    const previews = previewsOf([
      activity("run-1", 0, { type: "CUSTOM", name: "harness.session-id", value: { sessionId: "s1" } }),
    ]);

    expect(previews.has("run-1")).toBe(false);
  });
});

describe("foldTranscript", () => {
  it("marks a tool call done when its result arrives", () => {
    const entries = foldTranscript([
      runActivity(0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
      runActivity(1, { type: "TOOL_CALL_RESULT", toolCallId: "t1", result: "contents" }),
    ]);

    expect(entries).toMatchObject([{ kind: "tool", name: "read", result: "contents", complete: true }]);
  });

  it("marks a tool call done when it ends without a result event", () => {
    const entries = foldTranscript([
      runActivity(0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
      runActivity(1, { type: "TOOL_CALL_END", toolCallId: "t1" }),
    ]);

    expect(entries).toMatchObject([{ kind: "tool", name: "read", complete: true }]);
  });
});

describe("statusLine", () => {
  it("describes the live edge in agent language", () => {
    expect(statusLine([], "succeeded")).toBe("Run finished.");
    expect(statusLine([runActivity(0, { type: "TEXT_MESSAGE_CONTENT", delta: "answering" })], "failed")).toBe(
      "Run failed.",
    );
    expect(statusLine([runActivity(0, { type: "REASONING_MESSAGE_CONTENT", delta: "checking" })])).toBe(
      "Thinking…",
    );
    expect(statusLine([runActivity(0, { type: "TEXT_MESSAGE_CONTENT", delta: "answering" })])).toBe(
      "Responding…",
    );
    expect(
      statusLine([runActivity(0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "rg" })]),
    ).toBe("Running rg…");
    expect(
      statusLine([
        runActivity(0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "rg" }),
        runActivity(1, { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: "--files" }),
      ]),
    ).toBe("Running rg…");
    expect(
      statusLine([
        runActivity(0, {
          type: "CUSTOM",
          name: "sandbox.file.diff",
          value: { path: "src/app.ts", diff: "-old\n+new" },
        }),
      ]),
    ).toBe("Editing src/app.ts");
    expect(
      statusLine([
        runActivity(0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "rg" }),
        runActivity(1, { type: "TOOL_CALL_RESULT", toolCallId: "t1", result: "match" }),
      ]),
    ).toBe("Ran rg");
    expect(statusLine([runActivity(0, { type: "RUN_FINISHED" })])).toBe("Run finished.");
  });
});
