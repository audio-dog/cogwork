import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { type GitService, withTransitionLogging } from "./git";
import { LogProbe } from "./testing/log-probe";

const baseGit = {
  fetch: () => Effect.void,
  remoteBranchExists: () => Effect.succeed(false),
  addWorktree: () => Effect.void,
  removeWorktree: () => Effect.void,
  listWorktrees: () => Effect.succeed([]),
  fastForward: () => Effect.void,
  divergence: () => Effect.succeed({ ahead: 0, behind: 0 }),
  operationInProgress: () => Effect.succeed(null),
  rebase: () => Effect.void,
  remoteUrl: () => Effect.succeed("git@example.test:acme/repo.git"),
} satisfies GitService;

it.layer(LogProbe.captureLayer)((it) => {
  it.effect("logs each Git worktree and branch mutation once", () => {
    const git = withTransitionLogging(baseGit);

    return Effect.gen(function* () {
      const logs = yield* LogProbe;
      yield* git.addWorktree({
        repoPath: "/repo",
        worktreePath: "/worktrees/feature",
        branch: "feature",
        startPoint: "origin/main",
      });
      yield* git.removeWorktree("/repo", "/worktrees/feature", true);
      yield* git.fastForward("/worktrees/feature", "origin", "feature");
      yield* git.rebase("/worktrees/feature", "origin", "feature");

      assert.deepStrictEqual(
        (yield* logs.entries).map(({ message }) => message),
        [
          [
            "added Git worktree",
            { worktreePath: "/worktrees/feature", branch: "feature", startPoint: "origin/main" },
          ],
          ["removed Git worktree", { worktreePath: "/worktrees/feature", force: true }],
          [
            "fast-forwarded Git branch",
            { worktreePath: "/worktrees/feature", remote: "origin", branch: "feature" },
          ],
          ["rebased Git branch", { worktreePath: "/worktrees/feature", remote: "origin", branch: "feature" }],
        ],
      );
    });
  });
});
