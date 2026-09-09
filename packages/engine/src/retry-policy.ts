import {
  type ControlStoreFailure,
  type IssueTrackerError,
  issueTrackerErrorIsPermanent,
} from "@cogwork/contracts";
import type { HandoffCause } from "./comments";
import type { ContextAssemblerError } from "./context-assembler";
import type { ContextFsError } from "./context-fs";
import type { CredentialError } from "./credential-store";
import type { GitError } from "./git";
import type { HarnessError } from "./harness";
import type { RunLedgerError } from "./run-ledger";
import type { RunPlanAssemblyError } from "./run-plan";
import type { WorktreeDivergedError, WorktreeOperationInProgressError } from "./worktree";
import type { WorktreeFsError } from "./worktree-fs";

export type PrepareError =
  | ControlStoreFailure
  | GitError
  | WorktreeFsError
  | WorktreeDivergedError
  | WorktreeOperationInProgressError
  | CredentialError
  | ContextFsError
  | ContextAssemblerError
  | RunPlanAssemblyError
  | RunLedgerError;

export type RetryFailure = PrepareError | HarnessError | IssueTrackerError;

type NonRetryableHandoffCause = Extract<HandoffCause, { readonly kind: "non-retryable" }>;
type MaxAttemptsHandoffCause = Extract<HandoffCause, { readonly kind: "max-attempts" }>;

export interface RetryInputs {
  readonly failure: RetryFailure;
  readonly attempts: number;
}

export type RetryDecision =
  | {
      readonly retryable: true;
      readonly handoffCause: MaxAttemptsHandoffCause;
    }
  | {
      readonly retryable: false;
      readonly handoffCause: NonRetryableHandoffCause;
    };

const retryableOf = (failure: RetryFailure) => {
  if (failure._tag === "IssueTrackerError") return !issueTrackerErrorIsPermanent(failure);
  return failure.retryable;
};

const maxAttemptsDecision = (attempts: number) =>
  ({
    retryable: true,
    handoffCause: { kind: "max-attempts", attempts },
  }) satisfies RetryDecision;

export const nonRetryableDecision = {
  retryable: false,
  handoffCause: { kind: "non-retryable" },
} satisfies RetryDecision;

export const decideRetry = ({ failure, attempts }: RetryInputs) =>
  retryableOf(failure) ? maxAttemptsDecision(attempts) : nonRetryableDecision;
