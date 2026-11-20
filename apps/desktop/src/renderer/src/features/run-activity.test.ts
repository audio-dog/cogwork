import { type AgUiEvent, DaemonEvent, type RunActivity } from "@cogwork/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";

import {
  applyRunPreview,
  applyTranscriptActivities,
  foldTranscript,
  makeTranscriptFold,
  makeTranscriptPump,
  previewMap,
  type RunPreviewState,
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
      operation: "implement",
      seq,
      atMillis: seq,
      correlation: { threadId: null, messageId, toolCallId: agui.toolCallId ?? null },
      event: agui,
    },
  });
  if (!DaemonEvent.guards.RunActivity(decoded)) throw new Error("Expected run activity");
  return decoded.activity;
};

const runActivity = (seq: number, agui: AgUiEvent & { type: string }) => activity("run-1", seq, agui);

const previewsOf = (activities: ReadonlyArray<RunActivity>) =>
  previewMap(activities.reduce<RunPreviewState>((state, next) => applyRunPreview(state, next), new Map()));

type Event = AgUiEvent & { type: string };

const parentText: Event = { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "parent text" };
const parentToolStart: Event = { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "reviewer" };
const parentToolResult: Event = { type: "TOOL_CALL_RESULT", toolCallId: "t1", result: "review passed" };
const childEvents: ReadonlyArray<Event> = [
  { type: "SUBAGENT_STARTED", subagentRunId: "child-1", name: "reviewer" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "child text", subagentRunId: "child-1" },
  { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "read", subagentRunId: "child-1" },
  { type: "SUBAGENT_FINISHED", subagentRunId: "child-1" },
];

const runActivities = (events: ReadonlyArray<Event>) => events.map((agui, seq) => runActivity(seq, agui));

describe("applyRunPreview", () => {
  it("shows a Run with Subagents as it shows the same Run without them", () => {
    expect(previewsOf(runActivities([parentText, ...childEvents]))).toEqual(
      previewsOf(runActivities([parentText])),
    );
  });

  it("has no preview when there are no events", () => {
    expect(previewsOf([]).size).toBe(0);
  });

  it.each([
    {
      name: "tool end result",
      result: { type: "TOOL_CALL_END", toolCallId: "t1", result: "contents" },
    },
    {
      name: "tool result event",
      result: { type: "TOOL_CALL_RESULT", toolCallId: "t1", result: "contents" },
    },
    {
      name: "tool end content fallback",
      result: { type: "TOOL_CALL_END", toolCallId: "t1", content: "contents" },
    },
  ])("shows output from $name with the original tool label", ({ result }) => {
    const previews = previewsOf([
      activity("run-1", 0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
      activity("run-1", 1, result),
    ]);

    expect(previews.get("run-1")).toEqual({ label: "read", text: "contents" });
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

  it("renders structured custom event detail", () => {
    const previews = previewsOf([
      activity("run-1", 0, { type: "CUSTOM", name: "progress", value: { current: 1, total: 2 } }),
    ]);

    expect(previews.get("run-1")).toEqual({
      label: "progress",
      text: '{"current":1,"total":2}',
    });
  });
});

describe("foldTranscript", () => {
  it("renders a Run with Subagents as it renders the same Run without them", () => {
    expect(
      foldTranscript(runActivities([parentText, parentToolStart, ...childEvents, parentToolResult])),
    ).toEqual(foldTranscript(runActivities([parentText, parentToolStart, parentToolResult])));
  });

  it("pulls each published transcript snapshot once across subscribers", () => {
    const pump = makeTranscriptPump();
    const pull = vi.fn();
    const refresh = vi.fn();
    const first = AsyncResult.success({ done: false, replaying: true, entries: [] });
    const second = AsyncResult.success({ done: false, replaying: true, entries: [] });

    pump(first, pull, refresh);
    pump(first, pull, refresh);
    pump(second, pull, refresh);

    expect(pull).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("replays chunks once and matches a one-pass transcript", () => {
    const activities = [
      runActivity(0, { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hello " }),
      runActivity(1, { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "world" }),
      runActivity(2, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
      runActivity(3, { type: "TOOL_CALL_RESULT", toolCallId: "t1", result: "contents" }),
    ];
    const incremental = activities.reduce<ReturnType<typeof makeTranscriptFold>>(
      (fold, next) => applyTranscriptActivities(fold, [next]),
      makeTranscriptFold(),
    );

    expect(Array.from(incremental.entries)).toEqual(foldTranscript(activities));
  });

  it("ignores already-folded history when a later chunk overlaps it", () => {
    const activities = [
      runActivity(0, { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hello " }),
      runActivity(1, { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "world" }),
      runActivity(2, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
    ];
    const first = applyTranscriptActivities(makeTranscriptFold(), activities.slice(0, 2));
    const incremental = applyTranscriptActivities(first, activities.slice(1));

    expect(Array.from(incremental.entries)).toEqual(foldTranscript(activities));
  });

  it("keeps published entries unchanged when a later chunk extends them", () => {
    const first = applyTranscriptActivities(makeTranscriptFold(), [
      runActivity(0, { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hello " }),
    ]);

    const second = applyTranscriptActivities(first, [
      runActivity(1, { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "world" }),
    ]);

    expect(Array.from(first.entries)).toEqual([{ kind: "text", key: "text:m1", text: "hello " }]);
    expect(second.entries).not.toBe(first.entries);
    expect(Array.from(second.entries)).toEqual([{ kind: "text", key: "text:m1", text: "hello world" }]);
  });

  it("marks a tool call done when its result arrives", () => {
    const entries = foldTranscript([
      runActivity(0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
      runActivity(1, { type: "TOOL_CALL_RESULT", toolCallId: "t1", result: "contents" }),
    ]);

    expect(entries).toMatchObject([{ kind: "tool", name: "read", result: "contents", complete: true }]);
  });

  it("does not render an untyped tool result as JSON", () => {
    const entries = foldTranscript([
      runActivity(0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
      runActivity(1, { type: "TOOL_CALL_RESULT", toolCallId: "t1", result: { path: "secret.txt" } }),
    ]);

    expect(entries).toMatchObject([{ kind: "tool", name: "read", result: "", complete: true }]);
  });

  it("marks a tool call done when it ends without a result event", () => {
    const entries = foldTranscript([
      runActivity(0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
      runActivity(1, { type: "TOOL_CALL_END", toolCallId: "t1" }),
    ]);

    expect(entries).toMatchObject([{ kind: "tool", name: "read", complete: true }]);
  });
});
