import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { GitError } from "./git";
import * as Worktree from "./worktree";
import {
  fakeFs,
  fakeGit,
  item,
  makeRecorder,
  provide,
  workspaceWith,
  worktreePath,
} from "./worktree-fixtures";

describe("Worktree.ensure", () => {
  it.effect("fast-forwards an existing worktree instead of recreating it", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const git = fakeGit(recorder, {
        worktrees: [{ path: worktreePath(), branch: "13-worktree-lifecycle" }],
        remoteBranches: ["13-worktree-lifecycle"],
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      const result = yield* manager.ensure(workspaceWith(), item);
      assert.strictEqual(result.created, false);
      const fastForwarded = yield* Ref.get(recorder.fastForwarded);
      assert.deepStrictEqual(fastForwarded, [worktreePath()]);
      const added = yield* Ref.get(recorder.added);
      assert.strictEqual(added.length, 0);
      assert.deepStrictEqual(yield* Ref.get(recorder.removedPaths), []);
    }),
  );

  it.effect("refuses to sync a reused worktree with a git operation in progress", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const git = fakeGit(recorder, {
        worktrees: [{ path: worktreePath(), branch: "13-worktree-lifecycle" }],
        remoteBranches: ["13-worktree-lifecycle"],
        operation: {
          operation: "merge",
          identity: "5eed0001",
          head: "4ead0001",
          unmergedPaths: ["src/a.ts", "src/b.ts"],
        },
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));

      const failure = yield* Effect.flip(manager.ensure(workspaceWith({ setup: ["pnpm install"] }), item));

      if (failure._tag !== "WorktreeError")
        return yield* Effect.die(`expected WorktreeError, got ${failure._tag}`);
      assert.strictEqual(failure.reason, "operation-in-progress");
      assert.strictEqual(failure.path, worktreePath());
      assert.isFalse(failure.retryable);
      assert.include(failure.message, "branch 13-worktree-lifecycle");
      assert.include(failure.message, "merge");
      assert.include(failure.message, "src/a.ts, src/b.ts");
      assert.deepStrictEqual(yield* Ref.get(recorder.operationProbes), [worktreePath()]);
      assert.deepStrictEqual(yield* Ref.get(recorder.fastForwarded), []);
      assert.deepStrictEqual(yield* Ref.get(recorder.commands), []);
    }),
  );

  it.effect("replays local commits onto the remote when the branch has diverged", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const git = fakeGit(recorder, {
        worktrees: [{ path: worktreePath(), branch: "13-worktree-lifecycle" }],
        remoteBranches: ["13-worktree-lifecycle"],
        divergence: { ahead: 2, behind: 5 },
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      const result = yield* manager.ensure(workspaceWith(), item);
      assert.strictEqual(result.created, false);
      assert.deepStrictEqual(yield* Ref.get(recorder.rebased), [worktreePath()]);
      assert.deepStrictEqual(yield* Ref.get(recorder.fastForwarded), []);
      assert.strictEqual((yield* Ref.get(recorder.added)).length, 0);
    }),
  );

  it.effect("still fast-forwards a branch that is only ahead of its remote", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const git = fakeGit(recorder, {
        worktrees: [{ path: worktreePath(), branch: "13-worktree-lifecycle" }],
        remoteBranches: ["13-worktree-lifecycle"],
        divergence: { ahead: 3, behind: 0 },
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      yield* manager.ensure(workspaceWith(), item);
      assert.deepStrictEqual(yield* Ref.get(recorder.fastForwarded), [worktreePath()]);
      assert.deepStrictEqual(yield* Ref.get(recorder.rebased), []);
    }),
  );

  it.effect("reports an unresolvable divergence without discarding local commits", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const git = fakeGit(recorder, {
        worktrees: [{ path: worktreePath(), branch: "13-worktree-lifecycle" }],
        remoteBranches: ["13-worktree-lifecycle"],
        divergence: { ahead: 2, behind: 5 },
        rebaseFailure: new GitError({
          command: "rebase origin/13-worktree-lifecycle",
          message: "CONFLICT (content): Merge conflict in src/index.ts",
          retryable: true,
        }),
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      const failure = yield* Effect.flip(manager.ensure(workspaceWith({ setup: ["pnpm install"] }), item));
      if (failure._tag !== "WorktreeError")
        return yield* Effect.die(`expected WorktreeError, got ${failure._tag}`);
      assert.strictEqual(failure.reason, "diverged");
      assert.strictEqual(failure.path, worktreePath());
      assert.isFalse(failure.retryable);
      assert.include(failure.message, "2 local commits");
      assert.include(failure.message, "5 remote commits");
      assert.include(failure.message, "Merge conflict");
      assert.include(failure.message, "no local commits were discarded");
      assert.deepStrictEqual(yield* Ref.get(recorder.removed), []);
      assert.deepStrictEqual(yield* Ref.get(recorder.commands), []);
    }),
  );

  it.effect("preserves a timed-out rebase as GitError", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const git = fakeGit(recorder, {
        worktrees: [{ path: worktreePath(), branch: "13-worktree-lifecycle" }],
        remoteBranches: ["13-worktree-lifecycle"],
        divergence: { ahead: 2, behind: 5 },
        rebaseFailure: new GitError({
          command: "rebase origin/13-worktree-lifecycle",
          message: "timed out after 5 minutes",
          reason: "timeout",
          retryable: true,
        }),
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));

      const failure = yield* Effect.flip(manager.ensure(workspaceWith(), item));

      if (failure._tag !== "GitError")
        return yield* Effect.die(new Error(`expected GitError, got ${failure._tag}`));
      assert.strictEqual(failure.reason, "timeout");
    }),
  );

  it.effect("reuses a worktree whose branch has no counterpart on the remote", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const git = fakeGit(recorder, {
        worktrees: [{ path: worktreePath(), branch: "13-worktree-lifecycle" }],
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      const result = yield* manager.ensure(workspaceWith({ setup: ["pnpm install"] }), item);
      assert.strictEqual(result.created, false);
      assert.deepStrictEqual(yield* Ref.get(recorder.fastForwarded), []);
      assert.deepStrictEqual(yield* Ref.get(recorder.rebased), []);
      assert.deepStrictEqual(yield* Ref.get(recorder.removed), []);
      assert.strictEqual((yield* Ref.get(recorder.added)).length, 0);
      assert.deepStrictEqual(yield* Ref.get(recorder.commands), [
        { cwd: worktreePath(), command: "pnpm install" },
      ]);
    }),
  );

  it.effect("re-runs setup when reusing an existing worktree", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const git = fakeGit(recorder, {
        worktrees: [{ path: worktreePath(), branch: "13-worktree-lifecycle" }],
        remoteBranches: ["13-worktree-lifecycle"],
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      const result = yield* manager.ensure(workspaceWith({ setup: ["pnpm install"] }), item);
      assert.strictEqual(result.created, false);
      const commands = yield* Ref.get(recorder.commands);
      assert.deepStrictEqual(commands, [{ cwd: worktreePath(), command: "pnpm install" }]);
    }),
  );

  it.effect("reuses an existing worktree untouched when resuming, leaving uncommitted work in place", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const git = fakeGit(recorder, {
        worktrees: [{ path: worktreePath(), branch: "13-worktree-lifecycle" }],
        remoteBranches: ["13-worktree-lifecycle"],
        divergence: { ahead: 2, behind: 5 },
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      const result = yield* manager.ensure(workspaceWith({ setup: ["pnpm install"] }), item, {
        resume: true,
      });
      assert.strictEqual(result.created, false);
      assert.strictEqual(result.path, worktreePath());
      assert.deepStrictEqual(yield* Ref.get(recorder.fastForwarded), []);
      assert.deepStrictEqual(yield* Ref.get(recorder.rebased), []);
      assert.deepStrictEqual(yield* Ref.get(recorder.commands), []);
    }),
  );

  it.effect("creates a fresh worktree when resuming one that no longer exists", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const git = fakeGit(recorder, { remoteBranches: ["13-worktree-lifecycle"] });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      const result = yield* manager.ensure(workspaceWith({ setup: ["pnpm install"] }), item, {
        resume: true,
      });
      assert.strictEqual(result.created, true);
      const added = yield* Ref.get(recorder.added);
      assert.strictEqual(added[0]?.startPoint, "origin/13-worktree-lifecycle");
      assert.deepStrictEqual(yield* Ref.get(recorder.commands), [
        { cwd: "/repo.worktrees/13-worktree-lifecycle", command: "pnpm install" },
      ]);
    }),
  );
});
