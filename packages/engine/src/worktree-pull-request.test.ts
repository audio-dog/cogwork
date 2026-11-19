import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { GitError } from "./git";
import { LogProbe } from "./testing/log-probe";
import * as Worktree from "./worktree";
import {
  item,
  LayeredWorktree,
  WorktreeRecorder,
  workspaceWith,
  worktreeLayer,
  worktreePath,
} from "./worktree-fixtures";

describe("Worktree.pullRequestReadiness", () => {
  it.effect("uses cached refs when the refresh fails", () => {
    const failure = new GitError({
      command: "fetch origin",
      message: "cannot lock ref refs/remotes/origin/main",
      retryable: true,
    });
    return Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;
      const logs = yield* LogProbe;

      const result = yield* manager.pullRequestReadiness(workspaceWith(), item);

      assert.deepStrictEqual(result, {
        _tag: "Ready",
        headBranch: Worktree.branchName(item),
        baseBranch: "main",
      });
      assert.deepStrictEqual(yield* Ref.get(recorder.fetched), [
        {
          remote: "origin",
          branches: ["main"],
        },
      ]);
      assert.deepStrictEqual(
        (yield* logs.entries).map(({ message }) => message),
        [
          [
            "failed to refresh pull request refs; continuing with cached refs",
            { command: failure.command, message: failure.message },
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          worktreeLayer({
            worktrees: [{ path: worktreePath(), branch: Worktree.branchName(item) }],
            fetchFailure: failure,
            remoteBranches: [Worktree.branchName(item)],
            divergenceByBase: { main: { ahead: 1, behind: 0 } },
          }),
          LogProbe.captureLayer,
        ),
      ),
    );
  });

  it.effect("uses the engine-owned local head when the expected worktree is on another branch", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;

      const result = yield* manager.pullRequestReadiness(workspaceWith(), item);

      assert.deepStrictEqual(result, {
        _tag: "Ready",
        headBranch: Worktree.branchName(item),
        baseBranch: "main",
      });
      assert.deepStrictEqual(yield* Ref.get(recorder.divergenceChecks), [
        {
          path: "/repo",
          remote: "origin",
          branch: "main",
          head: { branch: Worktree.branchName(item) },
        },
      ]);
    }).pipe(
      Effect.provide(
        worktreeLayer({
          worktrees: [{ path: worktreePath(), branch: "another-branch" }],
          remoteBranches: [Worktree.branchName(item)],
          divergenceByBase: { main: { ahead: 2, behind: 0 } },
        }),
      ),
    ),
  );

  it.effect("uses the engine-owned local head when the expected worktree is missing", () =>
    Effect.gen(function* () {
      const manager = yield* LayeredWorktree;

      const result = yield* manager.pullRequestReadiness(workspaceWith(), item);

      assert.deepStrictEqual(result, {
        _tag: "Ready",
        headBranch: Worktree.branchName(item),
        baseBranch: "main",
      });
    }).pipe(
      Effect.provide(
        worktreeLayer({
          divergenceByBase: { main: { ahead: 1, behind: 0 } },
        }),
      ),
    ),
  );

  it.effect("declines when the head is not ahead of the base", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;

      const result = yield* manager.pullRequestReadiness(workspaceWith({ baseBranch: "trunk" }), item);

      if (!Worktree.PullRequestReadiness.$is("Declined")(result)) {
        return assert.fail("expected the gate to decline");
      }
      assert.include(result.reason, "not ahead of origin/trunk");
      assert.deepStrictEqual(yield* Ref.get(recorder.divergenceChecks), [
        {
          path: "/repo",
          remote: "origin",
          branch: "trunk",
          head: { branch: Worktree.branchName(item) },
        },
      ]);
    }).pipe(
      Effect.provide(
        worktreeLayer({
          worktrees: [{ path: worktreePath(), branch: Worktree.branchName(item) }],
          fetchFailure: new GitError({
            command: "fetch origin",
            message: "cannot lock ref refs/remotes/origin/trunk",
            retryable: true,
          }),
          remoteBranches: [Worktree.branchName(item)],
          divergenceByBase: {
            trunk: { ahead: 0, behind: 0 },
          },
        }),
      ),
    ),
  );

  it.effect("accepts a local head that has not been pushed", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;

      const result = yield* manager.pullRequestReadiness(workspaceWith(), item);

      assert.deepStrictEqual(result, {
        _tag: "Ready",
        headBranch: Worktree.branchName(item),
        baseBranch: "main",
      });
      assert.deepStrictEqual((yield* Ref.get(recorder.divergenceChecks))[0]?.head, {
        branch: Worktree.branchName(item),
      });
    }).pipe(
      Effect.provide(
        worktreeLayer({
          worktrees: [{ path: worktreePath(), branch: Worktree.branchName(item) }],
          divergenceByBase: { main: { ahead: 1, behind: 0 } },
        }),
      ),
    ),
  );

  it.effect("declines when refresh confirms the cached base was deleted", () => {
    const headBranch = Worktree.branchName(item);
    return Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;

      const result = yield* manager.pullRequestReadiness(workspaceWith(), item);

      if (!Worktree.PullRequestReadiness.$is("Declined")(result)) {
        return assert.fail("expected the gate to decline");
      }
      assert.include(result.reason, "base main does not exist on origin");
      assert.deepStrictEqual(yield* Ref.get(recorder.divergenceChecks), []);
    }).pipe(
      Effect.provide(
        worktreeLayer({
          fetchFailure: new GitError({
            command: "fetch origin",
            message: "cannot lock ref refs/remotes/origin/main",
            missingBranches: ["main"],
            retryable: true,
          }),
          remoteBranches: [headBranch],
        }),
      ),
    );
  });

  it.effect("returns the engine-owned head and base when the gate passes", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;

      const result = yield* manager.pullRequestReadiness(workspaceWith(), item);

      assert.deepStrictEqual(result, {
        _tag: "Ready",
        headBranch: Worktree.branchName(item),
        baseBranch: "main",
      });
      assert.deepStrictEqual(yield* Ref.get(recorder.fetched), [
        {
          remote: "origin",
          branches: ["main"],
        },
      ]);
    }).pipe(
      Effect.provide(
        worktreeLayer({
          worktrees: [{ path: worktreePath(), branch: Worktree.branchName(item) }],
          remoteBranches: [Worktree.branchName(item)],
          divergenceByBase: {
            main: { ahead: 2, behind: 1 },
          },
        }),
      ),
    ),
  );
});

describe("Worktree.pushBranch", () => {
  it.effect("pushes the engine-owned branch to the remote's explicit URL", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;
      const headBranch = Worktree.branchName(item);

      yield* manager.pushBranch(workspaceWith(), headBranch);

      assert.deepStrictEqual(yield* Ref.get(recorder.pushedBranches), [
        {
          repoPath: "/repo",
          remoteUrl: "git@example.com:repo.git",
          branch: headBranch,
        },
      ]);
    }).pipe(Effect.provide(worktreeLayer({}))),
  );

  it.effect("does nothing when the pull request branch has no new commits", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;
      const headBranch = Worktree.branchName(item);
      const pushBranchIfAhead = manager.pushBranchIfAhead;
      if (!pushBranchIfAhead) return yield* Effect.die("push-if-ahead unavailable");

      const pushed = yield* pushBranchIfAhead(workspaceWith(), headBranch);

      assert.isFalse(pushed);
      assert.isEmpty(yield* Ref.get(recorder.pushedBranches));
    }).pipe(
      Effect.provide(
        worktreeLayer({ remoteBranches: [Worktree.branchName(item)], divergence: { ahead: 0, behind: 0 } }),
      ),
    ),
  );

  it.effect("pushes when the pull request branch has new commits", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;
      const headBranch = Worktree.branchName(item);
      const pushBranchIfAhead = manager.pushBranchIfAhead;
      if (!pushBranchIfAhead) return yield* Effect.die("push-if-ahead unavailable");

      const pushed = yield* pushBranchIfAhead(workspaceWith(), headBranch);

      assert.isTrue(pushed);
      assert.deepStrictEqual(yield* Ref.get(recorder.pushedBranches), [
        {
          repoPath: "/repo",
          remoteUrl: "git@example.com:repo.git",
          branch: headBranch,
        },
      ]);
    }).pipe(
      Effect.provide(
        worktreeLayer({ remoteBranches: [Worktree.branchName(item)], divergence: { ahead: 1, behind: 0 } }),
      ),
    ),
  );
});
