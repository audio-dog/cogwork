import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Git, type GitService } from "../git";
import { countingLayer, GitInvocationCounter } from "./git-invocation-counting";

const baseGitLayer = Layer.succeed(Git, {
  fetch: () => Effect.void,
  remoteBranchExists: () => Effect.succeed(false),
  addWorktree: () => Effect.void,
  removeWorktree: () => Effect.void,
  listWorktrees: () => Effect.succeed([]),
  fastForward: () => Effect.void,
  divergence: () => Effect.succeed({ ahead: 0, behind: 0 }),
  operationInProgress: () => Effect.succeed(null),
  rebase: () => Effect.void,
  remoteUrl: () => Effect.succeed("file:///repo.git"),
} satisfies GitService);

layer(countingLayer.pipe(Layer.provide(baseGitLayer)))((it) => {
  it.effect("counts Git invocations by operation and resets them", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      const counter = yield* GitInvocationCounter;

      yield* git.fetch("/repo", "origin");
      yield* git.fetch("/repo", "origin");
      yield* git.remoteBranchExists("/repo", "origin", "branch");
      yield* git.addWorktree({
        repoPath: "/repo",
        worktreePath: "/worktree",
        branch: "branch",
        startPoint: "origin/main",
      });
      yield* git.removeWorktree("/repo", "/worktree", true);
      yield* git.listWorktrees("/repo");
      yield* git.fastForward("/worktree", "origin", "branch");
      yield* git.divergence("/worktree", "origin", "branch");
      yield* git.operationInProgress("/worktree");
      yield* git.rebase("/worktree", "origin", "branch");
      yield* git.remoteUrl("/repo", "origin");

      assert.deepStrictEqual(yield* counter.read, {
        fetch: 2,
        remoteBranchExists: 1,
        addWorktree: 1,
        removeWorktree: 1,
        listWorktrees: 1,
        fastForward: 1,
        divergence: 1,
        operationInProgress: 1,
        rebase: 1,
        remoteUrl: 1,
      });

      yield* counter.reset;

      assert.deepStrictEqual(yield* counter.read, {
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
      });
    }),
  );
});
