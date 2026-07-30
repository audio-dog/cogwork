import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class GitError extends Schema.TaggedErrorClass<GitError>()("GitError", {
  command: Schema.String,
  message: Schema.String,
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

const unavailable = Effect.fn("Git.unavailable")(function* (command: string) {
  return yield* new GitError({ command, message: "git adapter not provided" });
});

const noWorktrees: ReadonlyArray<WorktreeEntry> = [];

const makeUnavailable = () => ({
  fetch: (_repoPath: string, remote: string) => Effect.asVoid(unavailable(`fetch ${remote}`)),
  remoteBranchExists: (_repoPath: string, remote: string, branch: string) =>
    Effect.map(unavailable(`rev-parse ${remote}/${branch}`), () => false),
  addWorktree: (args: AddWorktreeArgs) => Effect.asVoid(unavailable(`worktree add ${args.branch}`)),
  removeWorktree: (_repoPath: string, worktreePath: string, _force: boolean) =>
    Effect.asVoid(unavailable(`worktree remove ${worktreePath}`)),
  listWorktrees: (_repoPath: string) => Effect.map(unavailable("worktree list"), () => noWorktrees),
  fastForward: (_worktreePath: string, remote: string, branch: string) =>
    Effect.asVoid(unavailable(`merge ${remote}/${branch}`)),
});

export type GitService = ReturnType<typeof makeUnavailable>;

export class Git extends Context.Service<Git, GitService>()("@clanker-forge/engine/Git") {}
