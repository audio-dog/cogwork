import {
  agUiFileDiffUnavailableEvent,
  RunActivity,
  type RunStatus,
  type RunWatchItem,
} from "@cogwork/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  foldTranscript,
  makeTranscriptSource,
  type TranscriptEntry,
  transcriptReplaying,
} from "./run-activity";
import {
  commandOf,
  headingLine,
  repoRelative,
  runLine,
  stageNote,
  statusLine,
  stepBody,
  transcriptRows,
} from "./run-transcript";

const tool = (overrides: Partial<Extract<TranscriptEntry, { kind: "tool" }>> = {}) =>
  ({
    kind: "tool",
    key: "tool:1",
    name: "command_execution",
    args: "",
    result: null,
    complete: true,
    ...overrides,
  }) satisfies TranscriptEntry;

const reviewerCard = {
  kind: "subagent",
  key: "subagent:a",
  name: "reviewer",
  status: "running",
  text: "Reading the diff.",
  message: null,
} satisfies TranscriptEntry;

const shell = (command: string, args = JSON.stringify({ command })) => tool({ args });

const shellOutput = (output: string, exitCode = 0) =>
  JSON.stringify({ aggregated_output: output, exit_code: exitCode, status: "completed" });

const text = (value: string, key = "text:1") =>
  ({ kind: "text", key, text: value }) satisfies TranscriptEntry;

const decodeActivity = Schema.decodeSync(RunActivity);

const activity = (event: RunActivity["event"], seq: number) =>
  decodeActivity({
    runId: "r",
    workspace: "w",
    workItem: "i",
    operation: "implement",
    seq,
    atMillis: 0,
    correlation: {
      threadId: null,
      messageId: null,
      toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : null,
    },
    event,
  });

describe("stageNote", () => {
  it("reads the sentence out of a stage result object", () => {
    expect(stageNote('{"_tag":"follow-up","outcome":"noop","summary":"Checked CI."}')).toBe("Checked CI.");
    expect(stageNote('{"_tag":"triage","role":"needs-info","proposal":"Ask for a repro."}')).toBe(
      "Ask for a repro.",
    );
  });

  it("declines anything that is not a stage result", () => {
    expect(stageNote("Plain prose from another harness.")).toBeNull();
    expect(stageNote('{"summary":"no tag"}')).toBeNull();
    expect(stageNote("{ broken json")).toBeNull();
  });
});

describe("commandOf", () => {
  it("unwraps the shell that the harness wraps every command in", () => {
    expect(commandOf(JSON.stringify({ command: "/bin/zsh -lc 'gh pr checks'" }))).toBe("gh pr checks");
  });

  it("keeps the command when the closing quote is lost to nested quoting", () => {
    expect(commandOf(JSON.stringify({ command: `/bin/zsh -lc "git log $(git merge-base HEAD main)'` }))).toBe(
      "git log $(git merge-base HEAD main)'",
    );
  });

  it("returns nothing for a call that is not a shell command", () => {
    expect(commandOf(JSON.stringify({ changes: [{ path: "a.ts", kind: "update" }] }))).toBe("");
  });
});

describe("repoRelative", () => {
  it("strips the worktree root", () => {
    expect(repoRelative("/Users/x/sites/cogwork.worktrees/233-connections/packages/engine/src/run.ts")).toBe(
      "packages/engine/src/run.ts",
    );
  });

  it("falls back to a home-relative path", () => {
    expect(repoRelative("/Users/x/.agents/skills/tdd/SKILL.md")).toBe("~/.agents/skills/tdd/SKILL.md");
  });
});

describe("transcriptRows", () => {
  it("labels a shell call by its program and unwraps the result envelope", () => {
    const [row] = transcriptRows(
      [shell("git status --short", undefined), { ...shell("git status --short"), result: shellOutput("ok") }],
      true,
    );

    expect(row).toMatchObject({ kind: "work" });
    if (row?.kind !== "work") throw new Error("expected a work row");
    expect(row.steps.at(-1)).toMatchObject({ label: "Git", target: "git status --short", detail: "ok" });
  });

  it("marks a non-zero exit as failed", () => {
    const [row] = transcriptRows([{ ...shell("git merge main"), result: shellOutput("CONFLICT", 1) }], true);

    if (row?.kind !== "work") throw new Error("expected a work row");
    expect(row.steps[0]).toMatchObject({ status: "failed" });
  });

  it("reads a file edit as its paths, not as a command", () => {
    const changes = JSON.stringify({
      changes: [
        { path: "/w/cogwork.worktrees/b/apps/cli/src/a.ts", kind: "update" },
        { path: "/w/cogwork.worktrees/b/apps/cli/src/b.ts", kind: "update" },
      ],
    });
    const [row] = transcriptRows([tool({ args: changes })], true);

    if (row?.kind !== "work") throw new Error("expected a work row");
    expect(row.steps[0]).toMatchObject({ label: "Edited", target: "apps/cli/src/a.ts +1 more" });
  });

  it("labels an all-delete change set as deleted", () => {
    const changes = JSON.stringify({ changes: [{ path: "/w/tmp.json", kind: "delete" }] });
    const [row] = transcriptRows([tool({ args: changes })], true);

    if (row?.kind !== "work") throw new Error("expected a work row");
    expect(row.steps[0]).toMatchObject({ label: "Deleted" });
  });

  it("falls back to the tool name rather than dumping an unknown envelope", () => {
    const [row] = transcriptRows([tool({ name: "web_search", args: '{"query":"effect"}' })], true);

    if (row?.kind !== "work") throw new Error("expected a work row");
    expect(row.steps[0]).toMatchObject({ label: "Ran", target: "web_search" });
  });

  it("groups consecutive work and keeps notes standing alone", () => {
    const rows = transcriptRows(
      [
        text('{"_tag":"implement","outcome":"stuck","summary":"Reading the brief."}'),
        shell("gh issue view 1"),
        { ...shell("git status"), key: "tool:2" },
        text("second note", "text:2"),
      ],
      true,
    );

    expect(rows.map((row) => row.kind)).toEqual(["note", "work", "note"]);
    expect(rows[0]).toMatchObject({ text: "Reading the brief." });
    if (rows[1]?.kind !== "work") throw new Error("expected a work row");
    expect(rows[1].steps).toHaveLength(2);
  });

  it("keeps a Subagent card in place between work rows", () => {
    const rows = transcriptRows(
      [shell("gh issue view 1"), reviewerCard, { ...shell("git status"), key: "tool:2" }],
      false,
    );

    expect(rows.map((row) => row.kind)).toEqual(["work", "subagent", "work"]);
    expect(rows[1]).toEqual(reviewerCard);
  });

  it.each([
    { runComplete: false, status: "running", message: null },
    { runComplete: true, status: "error", message: "The Run ended before this Subagent finished." },
  ])(
    "shows a running card as $status when the run is complete: $runComplete",
    ({ runComplete, status, message }) => {
      expect(transcriptRows([reviewerCard], runComplete)).toEqual([{ ...reviewerCard, status, message }]);
    },
  );

  it("clips an output too large to draw and says so", () => {
    const [row] = transcriptRows([{ ...shell("cat big"), result: shellOutput("x".repeat(9000)) }], true);

    if (row?.kind !== "work") throw new Error("expected a work row");
    expect(row.steps[0]?.detail).toHaveLength(8002);
    expect(row.steps[0]?.note).toBe("Clipped from 9,000 characters");
  });
});

describe("stepBody", () => {
  it("gives the whole command back beside its output", () => {
    const [row] = transcriptRows([{ ...shell("git status --short"), result: shellOutput("M a.ts") }], true);

    const step = row?.kind === "work" ? row.steps[0] : undefined;
    if (!step) throw new Error("expected a work row");
    expect(stepBody(step)).toBe("git status --short\n\nM a.ts");
  });
});

describe("runLine", () => {
  it("reports the terminal state before anything else", () => {
    expect(runLine([], "succeeded")).toBe("Run finished.");
    expect(runLine([], "declined")).toBe("Pull request creation declined.");
    expect(runLine([], "crashed")).toBe("Run failed.");
    expect(runLine([], "interrupted")).toBe("Run interrupted.");
    expect(runLine([], "running")).toBe("Starting…");
  });

  it("names the command instead of the tool", () => {
    const rows = transcriptRows([{ ...shell("gh pr checks"), complete: false }], false);

    expect(runLine(rows, "running")).toBe("Running gh pr checks…");
  });

  it("clips a command too long for one line", () => {
    const rows = transcriptRows([shell(`rg ${"a".repeat(200)}`)], true);

    expect(runLine(rows, "running")).toHaveLength(76);
  });
});

describe("streaming safety", () => {
  it("hides a stage result that has not finished streaming", () => {
    expect(transcriptRows([text('{"_tag":"implement","summary":"I ch')], false)).toEqual([]);
  });

  it("keeps prose from a harness that does not emit stage results", () => {
    const [row] = transcriptRows([text("Plain prose.")], false);

    expect(row).toMatchObject({ kind: "note", text: "Plain prose." });
  });

  it("never leaks a partial envelope into the status line", () => {
    const rows = transcriptRows(
      [shell("gh pr checks"), text('{"_tag":"follow-up","outcome":"noop","sum')],
      true,
    );

    expect(runLine(rows, "running")).not.toContain("_tag");
  });
});

describe("non-shell tool results", () => {
  it("keeps the content of a tool that reports no aggregated output", () => {
    const [row] = transcriptRows(
      [tool({ name: "mcp_tool_call", args: "{}", result: '{"structured_content":{"ok":true}}' })],
      true,
    );

    if (row?.kind !== "work") throw new Error("expected a work row");
    expect(row.steps[0]?.detail).toContain("structured_content");
  });

  it("reads failure from status when there is no exit code", () => {
    const changes = JSON.stringify({ changes: [{ path: "/w/a.ts", kind: "update" }] });
    const [row] = transcriptRows([tool({ args: changes, result: '{"changes":[],"status":"failed"}' })], true);

    if (row?.kind !== "work") throw new Error("expected a work row");
    expect(row.steps[0]).toMatchObject({ label: "Edited", status: "failed" });
  });

  it("clips a raw string result as well as an enveloped one", () => {
    const [row] = transcriptRows([{ ...shell("cat big"), result: "y".repeat(9000) }], true);

    if (row?.kind !== "work") throw new Error("expected a work row");
    expect(row.steps[0]?.note).toBe("Clipped from 9,000 characters");
  });
});

describe("non-tool steps", () => {
  it("renders a thought without repeating its first line", () => {
    const [row] = transcriptRows(
      [{ kind: "reasoning", key: "reason:1", text: "Head line.\nThe rest of it." }],
      true,
    );

    const step = row?.kind === "work" ? row.steps[0] : undefined;
    if (!step) throw new Error("expected a work row");
    expect(step).toMatchObject({ label: "Thought", target: "Head line." });
    expect(stepBody(step)).toBe("Head line.\n\nThe rest of it.");
  });

  it("calls a mixed group steps rather than tool calls", () => {
    const rows = transcriptRows(
      [{ kind: "reasoning", key: "reason:1", text: "Thinking." }, shell("git status")],
      true,
    );

    expect(rows[0]).toMatchObject({ kind: "work", foldNoun: "step" });
    expect(transcriptRows([shell("git status")], true)[0]).toMatchObject({ foldNoun: "tool call" });
  });

  it("treats an unfinished tool as complete once the run has ended", () => {
    const [row] = transcriptRows([{ ...shell("git status"), complete: false }], true);

    if (row?.kind !== "work") throw new Error("expected a work row");
    expect(row.steps[0]).toMatchObject({ status: "done" });
  });
});

describe("runLine over notes and errors", () => {
  it("reports the newest note", () => {
    const rows = transcriptRows(
      [text('{"_tag":"follow-up","outcome":"noop","summary":"Merged main."}')],
      false,
    );

    expect(runLine(rows, "running")).toBe("Merged main.");
  });

  it("reports the newest Subagent card by name and status", () => {
    expect(runLine(transcriptRows([reviewerCard], false), "running")).toBe("reviewer running");
  });

  it("reports a run error", () => {
    const rows = transcriptRows([{ kind: "error", key: "error:1", message: "harness exited" }], false);

    expect(runLine(rows, "running")).toBe("harness exited");
  });
});

describe("statusLine", () => {
  it("folds raw activities straight to the line", () => {
    const activities = [
      activity({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "command_execution" }, 0),
      activity(
        { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: JSON.stringify({ command: "gh pr checks" }) },
        1,
      ),
    ];

    expect(statusLine(foldTranscript(activities), "running")).toBe("Running gh pr checks…");
    expect(statusLine([], "succeeded")).toBe("Run finished.");
  });

  it("shows a nonfatal warning when live file changes stop", () => {
    expect(transcriptRows(foldTranscript([activity(agUiFileDiffUnavailableEvent(), 0)]), false)).toEqual([
      {
        kind: "warning",
        key: "warning:0",
        message: "The live file-change feed stopped. File changes may be incomplete.",
      },
    ]);
  });
});

describe("headingLine while history replays", () => {
  type ActivityResult = Parameters<ReturnType<typeof makeTranscriptSource>>[0];

  const watched = (value: RunActivity) => ({ _tag: "RunActivity", activity: value }) satisfies RunWatchItem;
  const historyEnd = { _tag: "HistoryEnd" } satisfies RunWatchItem;

  const pulled = ([first, ...rest]: ReadonlyArray<RunWatchItem>) => {
    if (!first) throw new Error("expected a non-empty chunk");
    return AsyncResult.success({
      done: false,
      items: [first, ...rest] satisfies [RunWatchItem, ...RunWatchItem[]],
    });
  };

  const command = (call: string, seq: number, line: string) => [
    activity({ type: "TOOL_CALL_START", toolCallId: call, toolCallName: "command_execution" }, seq),
    activity({ type: "TOOL_CALL_ARGS", toolCallId: call, delta: JSON.stringify({ command: line }) }, seq + 1),
  ];

  const history = [
    command("t1", 0, "git status"),
    command("t2", 2, "pnpm test"),
    command("t3", 4, "gh pr checks"),
  ];

  const replay = history.map((chunk, index) =>
    pulled([...chunk.map(watched), ...(index === history.length - 1 ? [historyEnd] : [])]),
  );

  const headings = (status: RunStatus, results: ReadonlyArray<ActivityResult>) => {
    const source = makeTranscriptSource();
    return results.map((result) => {
      const snapshot = source(result);
      const entries = AsyncResult.isSuccess(snapshot) ? snapshot.value.entries : [];
      return headingLine(
        transcriptRows(entries, status !== "running"),
        status,
        transcriptReplaying(snapshot),
      );
    });
  };

  const distinctInOrder = (values: ReadonlyArray<string>) =>
    values.filter((value, index) => value !== values[index - 1]);

  it("shows the placeholder until history ends, then the current line", () => {
    const seen = headings("running", [AsyncResult.initial(true), ...replay]);

    expect(distinctInOrder(seen)).toEqual(["Starting…", "Running gh pr checks…"]);
  });

  it("follows a live event after history ends", () => {
    const live = pulled(command("t4", 6, "pnpm build").map(watched));
    const seen = headings("running", [...replay, live]);

    expect(seen.slice(-2)).toEqual(["Running gh pr checks…", "Running pnpm build…"]);
  });

  it("shows the placeholder again when a reconnect replays history", () => {
    const [firstChunk] = replay;
    if (!firstChunk) throw new Error("expected a history chunk");
    const seen = headings("running", [...replay, AsyncResult.initial(true), firstChunk]);

    expect(seen.slice(-3)).toEqual(["Running gh pr checks…", "Starting…", "Starting…"]);
  });

  it("shows a settled run's fixed line from the first render", () => {
    const seen = headings("succeeded", [AsyncResult.initial(true), ...replay]);

    expect(new Set(seen)).toEqual(new Set(["Run finished."]));
  });
});
