import { assert, describe, it } from "@effect/vitest";
import {
  agentFailureReason,
  attachCommand,
  blockedComment,
  oneLine,
  prepareFailureReason,
  recoveryReason,
  shellQuote,
  statusReason,
  stripResultLines,
  truncate,
} from "./comments";

describe("comments", () => {
  it("normalizes status reasons: one line, truncated, markers stripped", () => {
    assert.strictEqual(
      statusReason("git\n  failed <!-- clanker-forge:attempt stage=implement outcome=failed at=1 --> badly"),
      "git failed badly",
    );
  });

  it("strips the plain-text marker lines Linear coordination bodies use", () => {
    assert.strictEqual(
      statusReason("build failed\nclanker-forge:attempt stage=implement outcome=succeeded at=9"),
      "build failed",
    );
  });

  it("keeps plain-text markers out of the blocked handoff body", () => {
    const body = blockedComment(
      "implement",
      { kind: "non-retryable" },
      "boom\nclanker-forge:ledger",
      undefined,
    );
    assert.notInclude(body, "clanker-forge:ledger");
  });

  it("collapses whitespace", () => {
    assert.strictEqual(oneLine("git\n  failed\tbadly"), "git failed badly");
  });

  it("truncates long reasons", () => {
    const long = "x".repeat(900);
    assert.strictEqual(truncate(long).length, 800);
    assert.ok(truncate(long).endsWith("…"));
  });

  it("strips result sentinel lines from agent text", () => {
    assert.strictEqual(
      stripResultLines("Brief contradicts itself.\nIMPLEMENT-RESULT: blocked\n"),
      "Brief contradicts itself.",
    );
  });

  it("prefers the agent's final message when reporting a blocked run", () => {
    assert.strictEqual(
      agentFailureReason("Cannot reconcile the brief.\nIMPLEMENT-RESULT: blocked", "blocked"),
      "Cannot reconcile the brief.",
    );
  });

  it("labels a missing sentinel and keeps any trailing agent text", () => {
    assert.strictEqual(
      agentFailureReason("Almost done but no footer.", "missing-sentinel"),
      "agent produced no result line — Almost done but no footer.",
    );
  });

  it("formats prepare errors from their tagged fields", () => {
    assert.strictEqual(
      prepareFailureReason({ _tag: "GitError", command: "worktree add", message: "denied" }),
      "git worktree add: denied",
    );
    assert.strictEqual(
      prepareFailureReason({ _tag: "WorktreeFsError", operation: "pnpm install", message: "exit 1" }),
      "pnpm install: exit 1",
    );
  });

  it("builds a blocked handoff note with an optional resume command", () => {
    const body = blockedComment(
      "implement",
      { kind: "exhausted", attempts: 3 },
      "network blip",
      attachCommand("/wt/15-feature", "sess-1"),
    );
    assert.include(body, "Blocked after 3 failed implement attempts.");
    assert.include(body, "ready-for-human");
    assert.include(body, "Last failure: network blip");
    assert.include(body, "```sh");
    assert.include(body, "cd '/wt/15-feature' && agent --resume 'sess-1'");
  });

  it("omits the resume block when no session is available", () => {
    const body = blockedComment("triage", { kind: "non-retryable" }, "no cli", undefined);
    assert.include(body, "non-retryable failure");
    assert.notInclude(body, "Resume the session");
  });

  it("shell-quotes paths and session ids", () => {
    assert.strictEqual(shellQuote("/home/me/my wt"), "'/home/me/my wt'");
    assert.strictEqual(shellQuote("a'b"), `'a'\\''b'`);
    assert.include(attachCommand("/wt", "sess; curl evil"), "agent --resume 'sess; curl evil'");
  });

  it("exposes a stable recovery reason for daemon restarts", () => {
    assert.include(recoveryReason, "daemon restart");
  });
});
