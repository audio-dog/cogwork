import { BranchName, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  type AddWorktreeArgs,
  type BranchDivergence,
  type DivergenceHead,
  type FetchOptions,
  Git,
  GitError,
  type GitOperationInProgress,
  type GitService,
  type WorktreeEntry,
} from "./git";
import { LogProbe } from "./testing/log-probe";
import * as Worktree from "./worktree";
import { type FileStat, WorktreeFs, type WorktreeFsService } from "./worktree-fs";

const decodeConfig = Schema.decodeSync(WorkspaceConfig);
const decodeBranchName = Schema.decodeSync(BranchName);
const interruptionGate = Latch.makeUnsafe();
const item = { id: "#13", title: "Worktree lifecycle" } satisfies Worktree.WorkItemRef;
const worktreePath = (branch = Worktree.branchName(item)) =>
  Worktree.worktreePathFor(Worktree.worktreeRoot("/repo"), branch);

const workspaceWith = (worktrees?: Worktree.WorktreeSettings) => ({
  source: "test.workspace.ts",
  contributions: [],
  config: decodeConfig({
    name: "demo",
    checkoutPath: "/repo",
    issueTracker: { type: "github" },
    worktrees,
  }),
});

const makeRecorder = Effect.fn("test.makeRecorder")(function* () {
  return {
    fetched: yield* Ref.make<
      ReadonlyArray<{
        readonly remote: string;
        readonly branches: ReadonlyArray<string> | null;
      }>
    >([]),
    added: yield* Ref.make<ReadonlyArray<AddWorktreeArgs>>([]),
    removed: yield* Ref.make<ReadonlyArray<{ readonly path: string; readonly force: boolean }>>([]),
    fastForwarded: yield* Ref.make<ReadonlyArray<string>>([]),
    rebased: yield* Ref.make<ReadonlyArray<string>>([]),
    operationProbes: yield* Ref.make<ReadonlyArray<string>>([]),
    divergenceChecks: yield* Ref.make<
      ReadonlyArray<{
        readonly path: string;
        readonly remote: string;
        readonly branch: string;
        readonly head: DivergenceHead | undefined;
      }>
    >([]),
    linked: yield* Ref.make<ReadonlyArray<{ readonly target: string; readonly linkPath: string }>>([]),
    removedPaths: yield* Ref.make<ReadonlyArray<string>>([]),
    registeredWorktrees: yield* Ref.make<ReadonlyArray<WorktreeEntry>>([]),
    commands: yield* Ref.make<ReadonlyArray<{ readonly cwd: string; readonly command: string }>>([]),
  };
});

type Recorder = Effect.Success<ReturnType<typeof makeRecorder>>;

class WorktreeRecorder extends Context.Service<WorktreeRecorder, Recorder>()(
  "@cogwork/engine/worktree.test/WorktreeRecorder",
) {
  static readonly layer = Layer.effect(WorktreeRecorder, makeRecorder());
}

class LayeredWorktree extends Context.Service<LayeredWorktree, Worktree.WorktreeManagerService>()(
  "@cogwork/engine/worktree.test/LayeredWorktree",
) {}

const inSync: BranchDivergence = { ahead: 0, behind: 0 };

const fakeGit = (
  recorder: Recorder,
  options: {
    readonly worktrees?: ReadonlyArray<WorktreeEntry>;
    readonly remoteBranches?: ReadonlyArray<string>;
    readonly divergence?: BranchDivergence;
    readonly divergenceByBase?: Readonly<Record<string, BranchDivergence>>;
    readonly operation?: GitOperationInProgress;
    readonly addFailure?: GitError;
    readonly addAfterRemoval?: string;
    readonly fetchFailure?: GitError;
    readonly rebaseFailure?: GitError;
  },
) => {
  const remotes = new Set(options.remoteBranches ?? []);
  const requiredRemoval = options.addAfterRemoval;
  return {
    fetch: (_repoPath: string, remote: string, fetchOptions?: FetchOptions) =>
      Ref.update(recorder.fetched, (log) => [
        ...log,
        { remote, branches: fetchOptions?.branches ?? null },
      ]).pipe(Effect.andThen(options.fetchFailure ? Effect.fail(options.fetchFailure) : Effect.void)),
    remoteBranchExists: (_repoPath: string, _remote: string, branch: string) =>
      Effect.succeed(remotes.has(branch)),
    addWorktree: (args: AddWorktreeArgs) => {
      if (options.addFailure) return Effect.fail(options.addFailure);
      const add = Ref.update(recorder.added, (log) => [...log, args]);
      if (!requiredRemoval) return add;
      return Ref.get(recorder.removedPaths).pipe(
        Effect.flatMap((removed) =>
          removed.includes(requiredRemoval)
            ? add
            : Effect.fail(
                new GitError({
                  command: `worktree add ${args.worktreePath}`,
                  message: `${args.worktreePath} already exists`,
                  retryable: true,
                }),
              ),
        ),
      );
    },
    removeWorktree: (_repoPath: string, worktreePath: string, force: boolean) =>
      Ref.update(recorder.removed, (log) => [...log, { path: worktreePath, force }]),
    listWorktrees: (_repoPath: string) =>
      Ref.get(recorder.registeredWorktrees).pipe(
        Effect.map((registered) => [...(options.worktrees ?? []), ...registered]),
      ),
    fastForward: (worktreePath: string, _remote: string, _branch: string) =>
      Ref.update(recorder.fastForwarded, (log) => [...log, worktreePath]),
    divergence: (path: string, remote: string, branch: string, head?: DivergenceHead) =>
      Ref.update(recorder.divergenceChecks, (log) => [...log, { path, remote, branch, head }]).pipe(
        Effect.map(() => options.divergenceByBase?.[branch] ?? options.divergence ?? inSync),
      ),
    operationInProgress: (worktreePath: string) =>
      Ref.update(recorder.operationProbes, (log) => [...log, worktreePath]).pipe(
        Effect.map(() => options.operation ?? null),
      ),
    rebase: (worktreePath: string, _remote: string, _branch: string) =>
      options.rebaseFailure === undefined
        ? Ref.update(recorder.rebased, (log) => [...log, worktreePath])
        : Effect.fail(options.rebaseFailure),
    remoteUrl: () => Effect.succeed("git@example.com:repo.git"),
  } satisfies GitService;
};

const fakeFs = (
  recorder: Recorder,
  stats: Readonly<Record<string, FileStat>>,
  registerOnRemove?: WorktreeEntry,
) =>
  ({
    linkFile: (target: string, linkPath: string) =>
      Ref.update(recorder.linked, (log) => [...log, { target, linkPath }]),
    removeDebris: (_root: string, target: string) => {
      const registersWorktree = registerOnRemove?.path === target;
      const preservesTarget = registersWorktree || stats[`${target}/.git`] !== undefined;
      const register = registersWorktree
        ? Ref.update(recorder.registeredWorktrees, (entries) => [...entries, registerOnRemove])
        : Effect.void;
      return register.pipe(
        Effect.andThen(
          preservesTarget
            ? Effect.succeed(false)
            : Ref.update(recorder.removedPaths, (paths) => [...paths, target]).pipe(Effect.map(() => true)),
        ),
      );
    },
    runCommand: (cwd: string, command: string) =>
      Ref.update(recorder.commands, (log) => [...log, { cwd, command }]),
    stat: (target: string) => Effect.succeed(stats[target] ?? null),
  }) satisfies WorktreeFsService;

const provide = (git: GitService, fs: WorktreeFsService) =>
  Layer.mergeAll(Layer.succeed(Git, git), Layer.succeed(WorktreeFs, fs));

const worktreeLayer = (
  options: Parameters<typeof fakeGit>[1],
  stats: Readonly<Record<string, FileStat>> = {},
  registerOnRemove?: WorktreeEntry,
) => {
  const dependencies = Layer.merge(
    Layer.effect(
      Git,
      Effect.map(WorktreeRecorder, (recorder) => fakeGit(recorder, options)),
    ),
    Layer.effect(
      WorktreeFs,
      Effect.map(WorktreeRecorder, (recorder) => fakeFs(recorder, stats, registerOnRemove)),
    ),
  );
  return Layer.effect(LayeredWorktree, Worktree.make).pipe(
    Layer.provide(dependencies),
    Layer.provideMerge(WorktreeRecorder.layer),
  );
};

describe("Worktree.ensure", () => {
  it.effect("creates a worktree from origin/main when the branch has no remote", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(fakeGit(recorder, {}), fakeFs(recorder, {})),
      );
      const before = (yield* Metric.value(Worktree.worktreeEnsureDuration)).count;
      const result = yield* manager.ensure(workspaceWith({ setup: ["pnpm install"] }), item);
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
        operation: { operation: "merge", unmergedPaths: ["src/a.ts", "src/b.ts"] },
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));

      const failure = yield* Effect.flip(manager.ensure(workspaceWith({ setup: ["pnpm install"] }), item));

      if (failure._tag !== "WorktreeError")
        return yield* Effect.die(`expected WorktreeError, got ${failure._tag}`);
      assert.strictEqual(failure.reason, "operation-in-progress");
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
        operation: { operation: "merge", unmergedPaths: ["src/a.ts"] },
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      const result = yield* manager.ensure(workspaceWith({ setup: ["pnpm install"] }), item, {
        resume: true,
      });
      assert.strictEqual(result.created, false);
      assert.strictEqual(result.path, worktreePath());
      assert.deepStrictEqual(yield* Ref.get(recorder.fastForwarded), []);
      assert.deepStrictEqual(yield* Ref.get(recorder.rebased), []);
      assert.deepStrictEqual(yield* Ref.get(recorder.operationProbes), []);
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
          branches: ["main", Worktree.branchName(item)],
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

  it.effect("uses the pushed head when the expected worktree is on another branch", () =>
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
          head: { branch: Worktree.branchName(item), remote: "origin" },
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

  it.effect("uses the pushed head when the expected worktree is missing", () =>
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
          remoteBranches: [Worktree.branchName(item)],
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
          head: { branch: Worktree.branchName(item), remote: "origin" },
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

  it.effect("declines when the local head has not been pushed", () =>
    Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;

      const result = yield* manager.pullRequestReadiness(workspaceWith(), item);

      if (!Worktree.PullRequestReadiness.$is("Declined")(result)) {
        return assert.fail("expected the gate to decline");
      }
      assert.include(result.reason, "has not been pushed to origin");
      assert.deepStrictEqual(yield* Ref.get(recorder.divergenceChecks), []);
    }).pipe(
      Effect.provide(
        worktreeLayer({
          worktrees: [{ path: worktreePath(), branch: Worktree.branchName(item) }],
        }),
      ),
    ),
  );

  it.effect("declines when refresh confirms the cached head was deleted", () => {
    const headBranch = Worktree.branchName(item);
    return Effect.gen(function* () {
      const recorder = yield* WorktreeRecorder;
      const manager = yield* LayeredWorktree;

      const result = yield* manager.pullRequestReadiness(workspaceWith(), item);

      if (!Worktree.PullRequestReadiness.$is("Declined")(result)) {
        return assert.fail("expected the gate to decline");
      }
      assert.include(result.reason, "has not been pushed to origin");
      assert.deepStrictEqual(yield* Ref.get(recorder.divergenceChecks), []);
    }).pipe(
      Effect.provide(
        worktreeLayer({
          fetchFailure: new GitError({
            command: "fetch origin",
            message: "cannot lock ref refs/remotes/origin/main",
            missingBranches: [headBranch],
            retryable: true,
          }),
          remoteBranches: [headBranch],
        }),
      ),
    );
  });

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
          branches: ["main", Worktree.branchName(item)],
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
      const outcome = yield* manager.reconcile(
        workspaceWith({ reapAfterMillis: 1000 }),
        retention(["active", "idle"]),
        10_000,
      );
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
  it.effect("allows parallel Run ownership and excludes maintenance", () =>
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
      const maintenance = yield* manager
        .withMaintenanceLock(Ref.set(maintenanceEntered, true))
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.isTrue(yield* Ref.get(parallelPreparationEntered));
      assert.isFalse(yield* Ref.get(maintenanceEntered));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(maintenance);
      assert.isTrue(yield* Ref.get(maintenanceEntered));
    }).pipe(Effect.provide(worktreeLayer({}))),
  );
});

describe("Worktree.remove", () => {
  it.effect("force-removes a safe branch", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(fakeGit(recorder, {}), fakeFs(recorder, {})),
      );
      yield* manager.remove(workspaceWith(), "13-worktree-lifecycle");
      const removed = yield* Ref.get(recorder.removed);
      assert.deepStrictEqual(removed, [{ path: "/repo.worktrees/13-worktree-lifecycle", force: true }]);
    }),
  );

  it.effect("refuses an unsafe branch and never calls git", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(fakeGit(recorder, {}), fakeFs(recorder, {})),
      );
      yield* Effect.flip(manager.remove(workspaceWith(), "../../escape"));
      const removed = yield* Ref.get(recorder.removed);
      assert.deepStrictEqual(removed, []);
    }),
  );
});
