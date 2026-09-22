import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { Git, type GitService } from "../git";

export type GitInvocationCounts = Readonly<Record<keyof GitService, number>>;

export interface GitInvocationCounterService {
  readonly read: Effect.Effect<GitInvocationCounts>;
  readonly reset: Effect.Effect<void>;
  readonly track: <A, E, R>(
    operation: keyof GitService,
    invocation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

const makeEmptyCounts = () =>
  ({
    fetch: 0,
    remoteBranchExists: 0,
    addWorktree: 0,
    removeWorktree: 0,
    listWorktrees: 0,
    fastForward: 0,
    divergence: 0,
    operationInProgress: 0,
    rebase: 0,
    remoteUrl: 0,
  }) satisfies GitInvocationCounts;

export class GitInvocationCounter extends Context.Service<
  GitInvocationCounter,
  GitInvocationCounterService
>()("@cogwork/engine/testing/git-invocation-counting/GitInvocationCounter") {
  static readonly layer = Layer.effect(
    GitInvocationCounter,
    Effect.gen(function* () {
      const counts = yield* Ref.make<GitInvocationCounts>(makeEmptyCounts());
      return {
        read: Ref.get(counts),
        reset: Ref.set(counts, makeEmptyCounts()),
        track: (operation, invocation) =>
          Ref.update(counts, (current) => ({
            ...current,
            [operation]: current[operation] + 1,
          })).pipe(Effect.andThen(invocation)),
      } satisfies GitInvocationCounterService;
    }),
  );
}

export const countingLayer = Layer.effect(
  Git,
  Effect.gen(function* () {
    const git = yield* Git;
    const counter = yield* GitInvocationCounter;

    const countedGit = {
      fetch: (repoPath, remote, options) => counter.track("fetch", git.fetch(repoPath, remote, options)),
      remoteBranchExists: (repoPath, remote, branch) =>
        counter.track("remoteBranchExists", git.remoteBranchExists(repoPath, remote, branch)),
      addWorktree: (args) => counter.track("addWorktree", git.addWorktree(args)),
      removeWorktree: (repoPath, worktreePath, force) =>
        counter.track("removeWorktree", git.removeWorktree(repoPath, worktreePath, force)),
      listWorktrees: (repoPath) => counter.track("listWorktrees", git.listWorktrees(repoPath)),
      fastForward: (worktreePath, remote, branch) =>
        counter.track("fastForward", git.fastForward(worktreePath, remote, branch)),
      divergence: (worktreePath, remote, branch) =>
        counter.track("divergence", git.divergence(worktreePath, remote, branch)),
      operationInProgress: (worktreePath) =>
        counter.track("operationInProgress", git.operationInProgress(worktreePath)),
      rebase: (worktreePath, remote, branch) =>
        counter.track("rebase", git.rebase(worktreePath, remote, branch)),
      remoteUrl: (repoPath, remote) => counter.track("remoteUrl", git.remoteUrl(repoPath, remote)),
    } satisfies GitService;

    return countedGit;
  }),
).pipe(Layer.provideMerge(GitInvocationCounter.layer));
