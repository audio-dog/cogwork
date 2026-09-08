import type { ControlStoreFailure } from "@cogwork/contracts";
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

export type RetryFailure = PrepareError | HarnessError;

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

type IntrinsicRetryFailure = Exclude<RetryFailure, HarnessError | RunLedgerError>;

const intrinsicRetryability = {
  ControlStoreFailure: true,
  GitError: true,
  WorktreeFsError: true,
  WorktreeDivergedError: false,
  WorktreeOperationInProgressError: false,
  CredentialError: false,
  ContextFsError: true,
  ContextAssemblerError: false,
  RunPlanAssemblyError: true,
} satisfies Record<IntrinsicRetryFailure["_tag"], boolean>;

const retryableOf = (failure: RetryFailure) => {
  if ("retryable" in failure) return failure.retryable;
  return intrinsicRetryability[failure._tag];
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
