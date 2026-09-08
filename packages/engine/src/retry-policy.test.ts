import { ControlStoreFailure, IssueTrackerError } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { ContextAssemblerError } from "./context-assembler";
import { ContextFsError } from "./context-fs";
import { CredentialError } from "./credential-store";
import { GitError } from "./git";
import { HarnessError } from "./harness";
import { decideRetry, type RetryDecision, type RetryFailure } from "./retry-policy";
import { RunLedgerError } from "./run-ledger";
import { RunPlanAssemblyError } from "./run-plan";
import { WorktreeDivergedError, WorktreeOperationInProgressError } from "./worktree";
import { WorktreeFsError } from "./worktree-fs";

const defaultAttempts = 3;

const maxAttemptsDecision = {
  retryable: true,
  handoffCause: { kind: "max-attempts", attempts: defaultAttempts },
} satisfies RetryDecision;

const nonRetryableDecision = {
  retryable: false,
  handoffCause: { kind: "non-retryable" },
} satisfies RetryDecision;

const fixedRetryableFailures = [
  {
    name: "control store failure",
    failure: new ControlStoreFailure({ operation: "read", message: "unavailable" }),
  },
  {
    name: "git failure",
    failure: new GitError({ command: "git fetch", message: "unavailable" }),
  },
  {
    name: "worktree filesystem failure",
    failure: new WorktreeFsError({ operation: "link", message: "unavailable" }),
  },
  {
    name: "context filesystem failure",
    failure: new ContextFsError({ operation: "read", message: "unavailable" }),
  },
  {
    name: "run plan assembly failure",
    failure: new RunPlanAssemblyError({ message: "invalid plan", cause: new Error("invalid plan") }),
  },
] satisfies ReadonlyArray<{ readonly name: string; readonly failure: RetryFailure }>;

const fixedNonRetryableFailures = [
  {
    name: "diverged worktree",
    failure: new WorktreeDivergedError({
      remote: "origin",
      branch: "484-retry-policy",
      message: "cannot rebase",
    }),
  },
  {
    name: "worktree operation in progress",
    failure: new WorktreeOperationInProgressError({
      branch: "484-retry-policy",
      operation: "merge",
      unmergedPaths: ["packages/engine/src/executor.ts"],
      message: "merge in progress",
    }),
  },
  {
    name: "credential failure",
    failure: new CredentialError({ account: "github", message: "missing credential" }),
  },
  {
    name: "context assembly failure",
    failure: new ContextAssemblerError({ source: "AGENTS.md", message: "invalid context" }),
  },
] satisfies ReadonlyArray<{ readonly name: string; readonly failure: RetryFailure }>;

const harnessReasons = [
  "unknown-harness",
  "missing-harness",
  "incompatible-harness",
  "credential",
  "stale-selection",
  "policy",
  "workspace",
  "sandbox",
  "launch",
  "turn",
] satisfies ReadonlyArray<HarnessError["reason"]>;

const harnessFailure = (reason: HarnessError["reason"], retryable: boolean) =>
  new HarnessError({ reason, retryable, message: "harness failed" });

const ledgerFailure = (retryable: boolean) =>
  new RunLedgerError({ operation: "append event", retryable, message: "ledger failed" });

const decide = (failure: RetryFailure) => decideRetry({ failure, attempts: defaultAttempts });

describe("decideRetry", () => {
  it.each(fixedRetryableFailures)("keeps $name retryable", ({ failure }) => {
    assert.deepStrictEqual(decide(failure), maxAttemptsDecision);
  });

  it.each(fixedNonRetryableFailures)("hands off after $name", ({ failure }) => {
    assert.deepStrictEqual(decide(failure), nonRetryableDecision);
  });

  it.each(harnessReasons)("keeps retryable $0 harness failures retryable", (reason) => {
    assert.deepStrictEqual(decide(harnessFailure(reason, true)), maxAttemptsDecision);
  });

  it.each(harnessReasons)("hands off after non-retryable $0 harness failures", (reason) => {
    assert.deepStrictEqual(decide(harnessFailure(reason, false)), nonRetryableDecision);
  });

  it("keeps a retryable Run ledger failure retryable", () => {
    assert.deepStrictEqual(decide(ledgerFailure(true)), maxAttemptsDecision);
  });

  it("hands off after a non-retryable Run ledger failure", () => {
    assert.deepStrictEqual(decide(ledgerFailure(false)), nonRetryableDecision);
  });

  it("keeps a temporary issue tracker refusal retryable", () => {
    const failure = new IssueTrackerError({ reason: "auth", retryable: false, message: "unauthorized" });

    assert.deepStrictEqual(decide(failure), maxAttemptsDecision);
  });

  it("hands off after a permanent issue tracker refusal", () => {
    const failure = new IssueTrackerError({ reason: "unavailable", retryable: false, message: "denied" });

    assert.deepStrictEqual(decide(failure), nonRetryableDecision);
  });

  it("carries the attempt count into a retryable failure's hand-off cause", () => {
    assert.deepStrictEqual(decideRetry({ failure: harnessFailure("turn", true), attempts: 7 }), {
      retryable: true,
      handoffCause: { kind: "max-attempts", attempts: 7 },
    });
  });
});
