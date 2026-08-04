import type { AgUiEvent, LifecycleStage, RunActivity } from "@clanker-forge/contracts";
import { RunId, WorkItemId, WorkspaceId } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { flushWatch, initialWatchState, stepWatch, type WatchState } from "./watch";

const runId = Schema.decodeSync(RunId);
const workItemId = Schema.decodeSync(WorkItemId);
const workspace = Schema.decodeSync(WorkspaceId)("ws");

interface ActivityOverrides {
  readonly runId?: string;
  readonly workItem?: string;
  readonly stage?: LifecycleStage;
  readonly event: AgUiEvent;
}

const activity = (overrides: ActivityOverrides): RunActivity => ({
  runId: runId(overrides.runId ?? "run-1"),
  workspace,
  workItem: workItemId(overrides.workItem ?? "#44"),
  stage: overrides.stage ?? "triage",
  seq: 0,
  atMillis: 0,
  event: overrides.event,
});

const drain = (activities: ReadonlyArray<RunActivity>): ReadonlyArray<string> =>
  activities.reduce<readonly [WatchState, ReadonlyArray<string>]>(
    (acc, next) => {
      const [state, lines] = acc;
      const [nextState, produced] = stepWatch(state, next);
      return [nextState, [...lines, ...produced]];
    },
    [initialWatchState, []],
  )[1];

const hasControlChar = (text: string) =>
  [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });

const content = (delta: string, overrides: Omit<ActivityOverrides, "event"> = {}) =>
  activity({ ...overrides, event: { type: "TEXT_MESSAGE_CONTENT", delta } });

const messageEnd = (overrides: Omit<ActivityOverrides, "event"> = {}) =>
  activity({ ...overrides, event: { type: "TEXT_MESSAGE_END" } });

describe("stepWatch", () => {
  it("coalesces text deltas into one labeled line on message end", () => {
    const lines = drain([content("Hello, "), content("world"), messageEnd()]);
    assert.deepStrictEqual(lines, ["triage #44 · Hello, world"]);
  });

  it("emits nothing for deltas that never end", () => {
    const lines = drain([content("still thinking")]);
    assert.deepStrictEqual(lines, []);
  });

  it("splits multiline agent text into separate labeled lines", () => {
    const lines = drain([content("line one\nline two"), messageEnd()]);
    assert.deepStrictEqual(lines, ["triage #44 · line one", "triage #44 · line two"]);
  });

  it("flushes pending text before a tool call and labels the tool", () => {
    const lines = drain([
      content("about to run"),
      activity({ event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "shell" } }),
    ]);
    assert.deepStrictEqual(lines, ["triage #44 · about to run", "triage #44 · ⚙ shell"]);
  });

  it("renders tool args and result on tool end", () => {
    const lines = drain([
      activity({ event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "shell" } }),
      activity({ event: { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: "ls -la" } }),
      activity({ event: { type: "TOOL_CALL_END", toolCallId: "t1", result: "file listing" } }),
    ]);
    assert.deepStrictEqual(lines, [
      "triage #44 · ⚙ shell",
      "triage #44 ·   args ls -la",
      "triage #44 ·   → file listing",
    ]);
  });

  it("clips overlong tool results", () => {
    const lines = drain([
      activity({ event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "shell" } }),
      activity({ event: { type: "TOOL_CALL_END", toolCallId: "t1", result: "x".repeat(5000) } }),
    ]);
    const resultLine = lines.at(-1) ?? "";
    assert.isTrue(resultLine.startsWith("triage #44 ·   → "));
    assert.isTrue(resultLine.endsWith("…"));
  });

  it("clips an overlong agent text line", () => {
    const lines = drain([content("x".repeat(5000)), messageEnd()]);
    assert.strictEqual(lines.length, 1);
    const [only] = lines;
    assert.isTrue(only?.startsWith("triage #44 · "));
    assert.isTrue(only?.endsWith("…"));
  });

  it("summarizes run start and finish with reason and tokens", () => {
    const lines = drain([
      activity({ event: { type: "RUN_STARTED" } }),
      activity({ event: { type: "RUN_FINISHED", finishReason: "stop", usage: { totalTokens: 1234 } } }),
    ]);
    assert.deepStrictEqual(lines, ["triage #44 · ▶ run started", "triage #44 · ■ run stop (1234 tokens)"]);
  });

  it("renders custom events but skips the session-id handshake", () => {
    const lines = drain([
      activity({ event: { type: "CUSTOM", name: "cursor.plan", value: { steps: 2 } } }),
      activity({ event: { type: "CUSTOM", name: "cursor.session-id", value: { sessionId: "s" } } }),
    ]);
    assert.deepStrictEqual(lines, ['triage #44 · ✎ cursor.plan {"steps":2}']);
  });

  it("renders run error messages", () => {
    const lines = drain([activity({ event: { type: "RUN_ERROR", message: "boom" } })]);
    assert.deepStrictEqual(lines, ["triage #44 · ✖ boom"]);
  });

  it("keeps concurrent runs separate with their own labels", () => {
    const lines = drain([
      content("first ", { runId: "run-1", workItem: "#1", stage: "triage" }),
      content("second ", { runId: "run-2", workItem: "#2", stage: "implement" }),
      content("run", { runId: "run-1", workItem: "#1", stage: "triage" }),
      messageEnd({ runId: "run-2", workItem: "#2", stage: "implement" }),
      messageEnd({ runId: "run-1", workItem: "#1", stage: "triage" }),
    ]);
    assert.deepStrictEqual(lines, ["implement #2 · second", "triage #1 · first run"]);
  });

  it("flushes dangling buffers when the stream halts", () => {
    const foldState = (activities: ReadonlyArray<RunActivity>) =>
      activities.reduce((state, next) => stepWatch(state, next)[0], initialWatchState);
    const state = foldState([
      content("half a thought", { runId: "run-9", workItem: "#9" }),
      content("second run", { runId: "run-7", workItem: "#7", stage: "implement" }),
    ]);
    assert.deepStrictEqual(flushWatch(state), ["triage #9 · half a thought", "implement #7 · second run"]);
  });

  it("strips terminal control sequences from agent text", () => {
    const lines = drain([content("before\u001b[2J\u0007after"), messageEnd()]);
    assert.strictEqual(lines.length, 1);
    assert.isFalse(hasControlChar(lines[0] ?? ""));
    assert.include(lines[0] ?? "", "before");
    assert.include(lines[0] ?? "", "after");
  });

  it("sanitizes control sequences in tool names", () => {
    const lines = drain([
      activity({
        event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "sh\u001b]0;pwn\u0007" },
      }),
    ]);
    assert.strictEqual(lines.length, 1);
    assert.isFalse(hasControlChar(lines[0] ?? ""));
  });

  it("ignores structural events that carry no activity", () => {
    const lines = drain([
      activity({ event: { type: "TEXT_MESSAGE_START" } }),
      activity({ event: { type: "TOOL_CALL_ARGS", toolCallId: "unknown", delta: "x" } }),
      activity({ event: { type: "TOOL_CALL_END", toolCallId: "unknown" } }),
    ]);
    assert.deepStrictEqual(lines, []);
  });
});
