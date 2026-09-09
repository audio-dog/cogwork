import { IssueTrackerError } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { CredentialError } from "./credential-store";
import { GitError } from "./git";
import { HarnessError } from "./harness";
import { decideRetry, type RetryDecision, type RetryFailure } from "./retry-policy";

const defaultAttempts = 3;

const maxAttemptsDecision = {
  retryable: true,
  handoffCause: { kind: "max-attempts", attempts: defaultAttempts },
} satisfies RetryDecision;

const nonRetryableDecision = {
  retryable: false,
  handoffCause: { kind: "non-retryable" },
} satisfies RetryDecision;

const harnessFailure = (reason: HarnessError["reason"], retryable: boolean) =>
  new HarnessError({ reason, retryable, message: "harness failed" });

const decide = (failure: RetryFailure) => decideRetry({ failure, attempts: defaultAttempts });

describe("decideRetry", () => {
  it("keeps a retryable prepare failure retryable", () => {
    const failure = new GitError({ command: "git fetch", message: "unavailable", retryable: true });

    assert.deepStrictEqual(decide(failure), maxAttemptsDecision);
  });

  it("hands off after a non-retryable prepare failure", () => {
    const failure = new CredentialError({
      account: "github",
      message: "missing credential",
      retryable: false,
    });

    assert.deepStrictEqual(decide(failure), nonRetryableDecision);
  });

  it("keeps a retryable harness failure retryable", () => {
    assert.deepStrictEqual(decide(harnessFailure("turn", true)), maxAttemptsDecision);
  });

  it("hands off after a non-retryable harness failure", () => {
    assert.deepStrictEqual(decide(harnessFailure("turn", false)), nonRetryableDecision);
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
