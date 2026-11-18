import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import { type AddWorktreeArgs, GitError, type GitService } from "./git";
import * as Worktree from "./worktree";
import {
  decodeBranchName,
  fakeFs,
  fakeGit,
  item,
  LayeredWorktree,
  makeRecorder,
  provide,
  WorktreeRecorder,
  workspaceWith,
  worktreeLayer,
  worktreePath,
} from "./worktree-fixtures";
import type { WorktreeFsService } from "./worktree-fs";

const interruptionGate = Latch.makeUnsafe();

describe("Worktree.ensure", () => {
  it.effect("creates a worktree from origin/main when the branch has no remote", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(fakeGit(recorder, {}), fakeFs(recorder, {})),
      );
      const before = (yield* Metric.value(Worktree.worktreeEnsureDuration)).count;
      const result = yield* manager.ensure(workspaceWith({ setup: ["pnpm install"] }), item, {
        pushOwner: "engine",
      });
      assert.strictEqual((yield* Metric.value(Worktree.worktreeEnsureDuration)).count, before + 1);
      assert.strictEqual(result.created, true);
      assert.strictEqual(result.branch, "13-worktree-lifecycle");
      assert.strictEqual(result.path, "/repo.worktrees/13-worktree-lifecycle");
      const added = yield* Ref.get(recorder.added);
      assert.strictEqual(added[0]?.startPoint, "origin/main");
      const fetched = yield* Ref.get(recorder.fetched);
      assert.deepStrictEqual(fetched, [{ remote: "origin", branches: null }]);
      const commands = yield* Ref.get(recorder.commands);
      assert.deepStrictEqual(commands, [
        { cwd: "/repo.worktrees/13-worktree-lifecycle", command: "pnpm install" },
      ]);
      assert.deepStrictEqual(yield* Ref.get(recorder.blockedPushes), [
        { path: "/repo.worktrees/13-worktree-lifecycle", remote: "origin" },
      ]);
    }),
  );

  it.effect("restores agent push ownership when reusing an implement worktree", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(fakeGit(recorder, {}), fakeFs(recorder, {})),
      );

      yield* manager.ensure(workspaceWith(), item, { pushOwner: "engine" });
      yield* manager.ensure(workspaceWith(), item, { pushOwner: "agent" });

      assert.deepStrictEqual(yield* Ref.get(recorder.blockedPushes), [
        { path: worktreePath(), remote: "origin" },
      ]);
      assert.deepStrictEqual(yield* Ref.get(recorder.allowedPushes), [
        { path: worktreePath(), remote: "origin" },
      ]);
    }),
  );

  it.effect("clears a target containing only .pnpm-store before creating the worktree", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;
      const target = worktreePath();

      const result = yield* manager.ensure(workspaceWith({ setup: ["pnpm install"] }), item);

      assert.strictEqual(result.created, true);
      assert.deepStrictEqual(yield* Ref.get(recorder.removedPaths), [target]);
      assert.strictEqual((yield* Ref.get(recorder.added)).length, 1);
      assert.deepStrictEqual(yield* Ref.get(recorder.commands), [{ cwd: target, command: "pnpm install" }]);
      assert.deepStrictEqual(yield* Ref.get(recorder.blockedPushes), []);
    }).pipe(
      Effect.provide(
        worktreeLayer(
          { addAfterRemoval: worktreePath() },
          {
            [worktreePath()]: { mtimeMillis: 1 },
            [`${worktreePath()}/.pnpm-store`]: { mtimeMillis: 1 },
          },
        ),
      ),
    ),
  );

  it.effect("refuses a detached worktree without removing it", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;
      const target = worktreePath();

      const failure = yield* Effect.flip(manager.ensure(workspaceWith(), item));

      if (failure._tag !== "WorktreeError")
        return yield* Effect.die(`expected WorktreeError, got ${failure._tag}`);
      assert.strictEqual(failure.reason, "detached");
      assert.strictEqual(failure.path, target);
      assert.isFalse(failure.retryable);
      assert.include(failure.message, target);
      assert.deepStrictEqual(yield* Ref.get(recorder.removedPaths), []);
      assert.deepStrictEqual(yield* Ref.get(recorder.added), []);
    }).pipe(
      Effect.provide(
        worktreeLayer(
          {},
          {
            [worktreePath()]: { mtimeMillis: 1 },
            [`${worktreePath()}/.git`]: { mtimeMillis: 1 },
          },
        ),
      ),
    ),
  );

  it.effect("reuses a worktree registered while debris recovery is in progress", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;

      const result = yield* manager.ensure(workspaceWith(), item);

      assert.strictEqual(result.created, false);
      assert.deepStrictEqual(yield* Ref.get(recorder.removedPaths), []);
      assert.deepStrictEqual(yield* Ref.get(recorder.added), []);
    }).pipe(
      Effect.provide(
        worktreeLayer(
          {},
          { [worktreePath()]: { mtimeMillis: 1 } },
          { path: worktreePath(), branch: Worktree.branchName(item) },
        ),
      ),
    ),
  );

  it.effect("refuses a branch that escapes the worktree root", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;

      const failure = yield* Effect.flip(
        manager.ensure(workspaceWith(), item, { branch: decodeBranchName("../../victim") }),
      );

      if (failure._tag !== "WorktreeError")
        return yield* Effect.die(`expected WorktreeError, got ${failure._tag}`);
      assert.strictEqual(failure.reason, "unsafe-branch");
      assert.isFalse(failure.retryable);
      assert.deepStrictEqual(yield* Ref.get(recorder.fetched), []);
      assert.deepStrictEqual(yield* Ref.get(recorder.removedPaths), []);
      assert.deepStrictEqual(yield* Ref.get(recorder.added), []);
    }).pipe(Effect.provide(worktreeLayer({}))),
  );

  it.effect("removes a newly created worktree when setup is interrupted", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const setupStarted = yield* Deferred.make<void>();
      const fs = {
        ...fakeFs(recorder, {}),
        runCommand: () =>
          Deferred.succeed(setupStarted, undefined).pipe(Effect.andThen(interruptionGate.await)),
      } satisfies WorktreeFsService;
      const manager = yield* Effect.provide(Worktree.make, provide(fakeGit(recorder, {}), fs));
      const ensuring = yield* manager
        .ensure(workspaceWith({ setup: ["pnpm install"] }), item)
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(setupStarted);
      yield* Fiber.interrupt(ensuring);

      assert.deepStrictEqual(yield* Ref.get(recorder.removed), [
        { path: "/repo.worktrees/13-worktree-lifecycle", force: true },
      ]);
    }),
  );

  it.effect("removes a newly created worktree when creation is interrupted", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const addStarted = yield* Deferred.make<void>();
      const finishAdd = yield* Deferred.make<void>();
      const git = {
        ...fakeGit(recorder, {}),
        addWorktree: (args: AddWorktreeArgs) =>
          Deferred.succeed(addStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishAdd)),
            Effect.andThen(Ref.update(recorder.added, (log) => [...log, args])),
          ),
      } satisfies GitService;
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      const ensuring = yield* manager
        .ensure(workspaceWith(), item)
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(addStarted);
      const interrupting = yield* Fiber.interrupt(ensuring).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(finishAdd, undefined);
      yield* Fiber.join(interrupting);

      assert.deepStrictEqual(yield* Ref.get(recorder.removed), [
        { path: "/repo.worktrees/13-worktree-lifecycle", force: true },
      ]);
    }),
  );

  it.effect("does not remove another caller's worktree when creation loses a race", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const addFailure = new GitError({
        command: "worktree add 13-worktree-lifecycle",
        message: "branch is already checked out",
        retryable: true,
      });
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(fakeGit(recorder, { addFailure }), fakeFs(recorder, {})),
      );

      yield* Effect.flip(manager.ensure(workspaceWith(), item));

      assert.deepStrictEqual(yield* Ref.get(recorder.removed), []);
    }),
  );

  it.effect("creates from origin/<branch> when the remote branch already exists", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const git = fakeGit(recorder, { remoteBranches: ["13-worktree-lifecycle"] });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      yield* manager.ensure(workspaceWith(), item);
      const added = yield* Ref.get(recorder.added);
      assert.strictEqual(added[0]?.startPoint, "origin/13-worktree-lifecycle");
    }),
  );

  it.effect("prepares an explicitly linked branch instead of deriving one from the item", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const branch = decodeBranchName("claude/github-issue-13-a1b2c3");
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(fakeGit(recorder, { remoteBranches: [branch] }), fakeFs(recorder, {})),
      );
      const result = yield* manager.ensure(workspaceWith(), item, { branch });
      const [added] = yield* Ref.get(recorder.added);
      assert.strictEqual(result.branch, branch);
      assert.strictEqual(result.path, `/repo.worktrees/${branch}`);
      assert.strictEqual(added?.branch, branch);
      assert.strictEqual(added?.startPoint, `origin/${branch}`);
    }),
  );

  it.effect("symlinks configured link paths that exist in the checkout", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const fs = fakeFs(recorder, { "/repo/.env": { mtimeMillis: 1 } });
      const manager = yield* Effect.provide(Worktree.make, provide(fakeGit(recorder, {}), fs));
      yield* manager.ensure(workspaceWith({ linkPaths: [".env", ".env.missing"] }), item);
      const linked = yield* Ref.get(recorder.linked);
      assert.deepStrictEqual(linked, [
        { target: "/repo/.env", linkPath: "/repo.worktrees/13-worktree-lifecycle/.env" },
      ]);
    }),
  );

  it.effect("links nothing when no link paths are configured", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const fs = fakeFs(recorder, { "/repo/.repos": { mtimeMillis: 1 } });
      const manager = yield* Effect.provide(Worktree.make, provide(fakeGit(recorder, {}), fs));
      yield* manager.ensure(workspaceWith(), item);
      const linked = yield* Ref.get(recorder.linked);
      assert.deepStrictEqual(linked, []);
    }),
  );
});
