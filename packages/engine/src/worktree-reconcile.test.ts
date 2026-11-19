import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { WorktreeEntry } from "./git";
import * as Worktree from "./worktree";
import {
  decodeBranchName,
  fakeFs,
  fakeGit,
  LayeredWorktree,
  makeRecorder,
  provide,
  WorktreeRecorder,
  workspaceWith,
  worktreeLayer,
} from "./worktree-fixtures";

describe("Worktree.reconcile", () => {
  const retention = (
    activeTicketKeys: ReadonlyArray<string>,
    ownedWorktreePaths: ReadonlyArray<string> = [],
  ) => ({ activeTicketKeys, ownedWorktreePaths });
  const entries: ReadonlyArray<WorktreeEntry> = [
    { path: "/repo", branch: "main" },
    { path: "/repo.worktrees/active", branch: "active" },
    { path: "/repo.worktrees/idle", branch: "idle" },
    { path: "/repo.worktrees/gone", branch: "gone" },
  ];

  it.effect("tears down orphaned worktrees and reaps idle ones past the age", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const fs = fakeFs(recorder, {
        "/repo.worktrees/active": { mtimeMillis: 9500 },
        "/repo.worktrees/idle": { mtimeMillis: 5000 },
        "/repo.worktrees/gone": { mtimeMillis: 9500 },
      });
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(fakeGit(recorder, { worktrees: entries }), fs),
      );
      const maintenance = yield* manager.tryWithMaintenanceLock(
        manager.reconcile(workspaceWith({ reapAfterMillis: 1000 }), retention(["active", "idle"]), 10_000),
      );
      if (Option.isNone(maintenance)) return assert.fail("expected maintenance to run");
      const outcome = maintenance.value;
      assert.deepStrictEqual(outcome.tornDown, ["gone"]);
      assert.deepStrictEqual(outcome.reaped, ["idle"]);
      const removed = yield* Ref.get(recorder.removed);
      assert.deepStrictEqual(removed, [
        { path: "/repo.worktrees/gone", force: true },
        { path: "/repo.worktrees/idle", force: false },
      ]);
    }),
  );

  it.effect("only tears down orphans when no reap age is configured", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const fs = fakeFs(recorder, { "/repo.worktrees/idle": { mtimeMillis: 0 } });
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(fakeGit(recorder, { worktrees: entries }), fs),
      );
      const outcome = yield* manager.reconcile(workspaceWith(), retention(["active", "idle"]), 10_000);
      assert.deepStrictEqual(outcome.reaped, []);
      assert.deepStrictEqual(outcome.tornDown, ["gone"]);
      const removed = yield* Ref.get(recorder.removed);
      assert.deepStrictEqual(removed, [{ path: "/repo.worktrees/gone", force: true }]);
    }),
  );

  it.effect("keeps a worktree whose ticket is still active after a title rename", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const renamed: ReadonlyArray<WorktreeEntry> = [
        { path: "/repo.worktrees/13-old-title", branch: "13-old-title" },
      ];
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(fakeGit(recorder, { worktrees: renamed }), fakeFs(recorder, {})),
      );
      const outcome = yield* manager.reconcile(workspaceWith(), retention(["13"]), 10_000);
      assert.deepStrictEqual(outcome.tornDown, []);
      const removed = yield* Ref.get(recorder.removed);
      assert.deepStrictEqual(removed, []);
    }),
  );

  it.effect("does not let a normal ticket claim an encoded fallback worktree", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const branch = Worktree.branchName({ id: "!", title: "encoded" });
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(
          fakeGit(recorder, { worktrees: [{ path: `/repo.worktrees/${branch}`, branch }] }),
          fakeFs(recorder, {}),
        ),
      );
      const outcome = yield* manager.reconcile(workspaceWith(), retention(["u"]), 10_000);
      assert.deepStrictEqual(outcome.tornDown, [branch]);
    }),
  );

  it.effect("keeps an active worktree on an externally linked branch", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const branch = "claude/github-issue-13-a1b2c3";
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(
          fakeGit(recorder, { worktrees: [{ path: `/repo.worktrees/${branch}`, branch }] }),
          fakeFs(recorder, {}),
        ),
      );
      const outcome = yield* manager.reconcile(workspaceWith(), retention(["13", branch]), 10_000);
      assert.deepStrictEqual(outcome.tornDown, []);
      assert.deepStrictEqual(yield* Ref.get(recorder.removed), []);
    }),
  );

  it.effect("never removes an in-flight Run's worktree after its branch changes", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;
      const branch = decodeBranchName("705-in-flight");
      const path = `/repo.worktrees/${branch}`;

      const outcome = yield* manager.reconcile(
        workspaceWith({ reapAfterMillis: 1000 }),
        retention([], [path]),
        10_000,
      );

      assert.deepStrictEqual(outcome, { tornDown: [], reaped: [] });
      assert.deepStrictEqual(yield* Ref.get(recorder.removed), []);
    }).pipe(
      Effect.provide(
        worktreeLayer(
          { worktrees: [{ path: "/repo.worktrees/705-in-flight", branch: "renamed" }] },
          { "/repo.worktrees/705-in-flight": { mtimeMillis: 0 } },
        ),
      ),
    ),
  );
});

describe("Worktree retention locks", () => {
  it.effect("allows parallel Run ownership and skips maintenance", () =>
    Effect.gen(function* () {
      const manager = yield* LayeredWorktree;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const parallelPreparationEntered = yield* Ref.make(false);
      const maintenanceEntered = yield* Ref.make(false);
      const first = yield* manager
        .withRunOwnershipLock(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* manager.withRunOwnershipLock(Ref.set(parallelPreparationEntered, true));
      const maintenance = yield* manager.tryWithMaintenanceLock(Ref.set(maintenanceEntered, true));

      assert.isTrue(yield* Ref.get(parallelPreparationEntered));
      assert.isFalse(yield* Ref.get(maintenanceEntered));
      assert.isTrue(Option.isNone(maintenance));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);

      const completed = yield* manager.tryWithMaintenanceLock(Ref.set(maintenanceEntered, true));
      assert.isTrue(Option.isSome(completed));
      assert.isTrue(yield* Ref.get(maintenanceEntered));
    }).pipe(Effect.provide(worktreeLayer({}))),
  );
});
