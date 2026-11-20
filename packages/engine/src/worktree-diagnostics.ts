import * as Effect from "effect/Effect";

import type { BranchDivergence, GitError, GitOperationInProgress, GitOperationRecord } from "./git";

export const logRemovalFailure = Effect.fn("Worktree.logRemovalFailure")(function* (
  path: string,
  message: string,
) {
  yield* Effect.logWarning("worktree removal failed", { path, message });
  return null;
});

export const logMissingRemote = Effect.fn("Worktree.logMissingRemote")(function* (
  remote: string,
  branch: string,
) {
  yield* Effect.logWarning(
    "reusing a worktree whose branch has no counterpart on the remote; its local commits are kept as they are",
    { branch, remote },
  );
});

const commitWord = (count: number) => (count === 1 ? "commit" : "commits");

export const unresolvableMessage = (
  remote: string,
  branch: string,
  divergence: BranchDivergence,
  reason: string,
) =>
  [
    `branch ${branch} has diverged from ${remote}/${branch}`,
    `(${divergence.ahead} local ${commitWord(divergence.ahead)} the remote lacks,`,
    `${divergence.behind} remote ${commitWord(divergence.behind)} the branch lacks)`,
    `and replaying the local commits onto ${remote}/${branch} failed: ${reason}.`,
    "The worktree was left as it was, so no local commits were discarded —",
    "a human needs to decide how to reconcile the branch.",
  ].join(" ");

export const operationInProgressSummary = (branch: string, operation: GitOperationInProgress) => {
  const conflicts = operation.unmergedPaths.length
    ? `unmerged paths: ${operation.unmergedPaths.join(", ")}`
    : "no unmerged paths remain";
  return `branch ${branch} has a ${operation.operation} in progress (${conflicts}).`;
};

export const operationMessage = (branch: string, operation: GitOperationInProgress) =>
  [
    operationInProgressSummary(branch, operation),
    "The worktree was left as it was; a human needs to finish or abort the operation.",
  ].join(" ");

export const isSameOperation = (recorded: GitOperationRecord | null, current: GitOperationRecord) =>
  recorded?.operation === current.operation &&
  recorded.identity === current.identity &&
  recorded.head === current.head;

export const logUnrecordedOperation = Effect.fn("Worktree.logUnrecordedOperation")(function* (
  worktreePath: string,
  error: GitError,
) {
  yield* Effect.logWarning("could not record the Git operation a Run left; the next Run will refuse it", {
    worktreePath,
    command: error.command,
    message: error.message,
  });
});
