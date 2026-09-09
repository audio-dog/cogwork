import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  command: Schema.String,
  message: Schema.String,
  reason: Schema.optional(Schema.Literal("timeout")),
  retryable: Schema.Boolean,
}) {}

export interface WorktreeEntry {
  readonly path: string;
  readonly branch: string | null;
}

export interface AddWorktreeArgs {
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly startPoint: string;
}

export interface BranchDivergence {
  readonly ahead: number;
  readonly behind: number;
}

export type GitOperation = "merge" | "rebase" | "cherry-pick";

export interface GitOperationInProgress {
  readonly operation: GitOperation;
  readonly unmergedPaths: ReadonlyArray<string>;
}

export interface GitService {
  readonly fetch: (repoPath: string, remote: string) => Effect.Effect<void, GitError>;
  readonly remoteBranchExists: (
    repoPath: string,
    remote: string,
    branch: string,
  ) => Effect.Effect<boolean, GitError>;
  readonly addWorktree: (args: AddWorktreeArgs) => Effect.Effect<void, GitError>;
  readonly removeWorktree: (
    repoPath: string,
    worktreePath: string,
    force: boolean,
  ) => Effect.Effect<void, GitError>;
  readonly listWorktrees: (repoPath: string) => Effect.Effect<ReadonlyArray<WorktreeEntry>, GitError>;
  readonly fastForward: (
    worktreePath: string,
    remote: string,
    branch: string,
  ) => Effect.Effect<void, GitError>;
  readonly divergence: (
    worktreePath: string,
    remote: string,
    baseBranch: string,
    headBranch?: string,
  ) => Effect.Effect<BranchDivergence, GitError>;
  readonly operationInProgress: (
    worktreePath: string,
  ) => Effect.Effect<GitOperationInProgress | null, GitError>;
  readonly rebase: (worktreePath: string, remote: string, branch: string) => Effect.Effect<void, GitError>;
  readonly remoteUrl: (repoPath: string, remote: string) => Effect.Effect<string, GitError>;
}

export class Git extends Context.Service<Git, GitService>()("@cogwork/engine/git") {}
