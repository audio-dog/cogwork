import { WorkspaceConfig } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { type AddWorktreeArgs, Git, type GitService, type WorktreeEntry } from "../src/Git";
import * as Worktree from "../src/Worktree";
import { type FileStat, WorktreeFs, type WorktreeFsService } from "../src/WorktreeFs";

const decodeConfig = Schema.decodeSync(WorkspaceConfig);

const workspaceWith = (worktrees?: Worktree.WorktreeSettings) => ({
  source: "test.workspace.ts",
  config: decodeConfig({
    name: "demo",
    checkoutPath: "/repo",
    workSource: { type: "github" },
    harness: { preferred: "cursor" },
    worktrees,
  }),
});

const makeRecorder = Effect.fn("test.makeRecorder")(function* () {
  return {
    fetched: yield* Ref.make<ReadonlyArray<string>>([]),
    added: yield* Ref.make<ReadonlyArray<AddWorktreeArgs>>([]),
    removed: yield* Ref.make<ReadonlyArray<{ readonly path: string; readonly force: boolean }>>([]),
    fastForwarded: yield* Ref.make<ReadonlyArray<string>>([]),
    linked: yield* Ref.make<ReadonlyArray<{ readonly target: string; readonly linkPath: string }>>([]),
    commands: yield* Ref.make<ReadonlyArray<{ readonly cwd: string; readonly command: string }>>([]),
  };
});

type Recorder = Effect.Success<typeof makeRecorder>;

const fakeGit = (
  recorder: Recorder,
  options: {
    readonly worktrees?: ReadonlyArray<WorktreeEntry>;
    readonly remoteBranches?: ReadonlyArray<string>;
  },
) => {
  const remotes = new Set(options.remoteBranches ?? []);
  return {
    fetch: (_repoPath: string, remote: string) => Ref.update(recorder.fetched, (log) => [...log, remote]),
    remoteBranchExists: (_repoPath: string, _remote: string, branch: string) =>
      Effect.succeed(remotes.has(branch)),
    addWorktree: (args: AddWorktreeArgs) => Ref.update(recorder.added, (log) => [...log, args]),
    removeWorktree: (_repoPath: string, worktreePath: string, force: boolean) =>
      Ref.update(recorder.removed, (log) => [...log, { path: worktreePath, force }]),
    listWorktrees: (_repoPath: string) => Effect.succeed(options.worktrees ?? []),
    fastForward: (worktreePath: string, _remote: string, _branch: string) =>
      Ref.update(recorder.fastForwarded, (log) => [...log, worktreePath]),
  } satisfies GitService;
};

const fakeFs = (recorder: Recorder, stats: Readonly<Record<string, FileStat>>) =>
  ({
    linkFile: (target: string, linkPath: string) =>
      Ref.update(recorder.linked, (log) => [...log, { target, linkPath }]),
    runCommand: (cwd: string, command: string) =>
      Ref.update(recorder.commands, (log) => [...log, { cwd, command }]),
    stat: (target: string) => Effect.succeed(stats[target] ?? null),
  }) satisfies WorktreeFsService;

const provide = (git: GitService, fs: WorktreeFsService) =>
  Layer.mergeAll(Layer.succeed(Git, git), Layer.succeed(WorktreeFs, fs));

describe("Worktree.ensure", () => {
  it.effect("creates a worktree from origin/main when the branch has no remote", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const manager = yield* Effect.provide(
        Worktree.make,
        provide(fakeGit(recorder, {}), fakeFs(recorder, {})),
      );
      const result = yield* manager.ensure(workspaceWith({ setup: ["pnpm install"] }), {
        id: "#13",
        title: "Worktree lifecycle",
      });
      assert.strictEqual(result.created, true);
      assert.strictEqual(result.branch, "13-worktree-lifecycle");
      assert.strictEqual(result.path, "/repo.worktrees/13-worktree-lifecycle");
      const added = yield* Ref.get(recorder.added);
      assert.strictEqual(added[0]?.startPoint, "origin/main");
      const fetched = yield* Ref.get(recorder.fetched);
      assert.deepStrictEqual(fetched, ["origin"]);
      const commands = yield* Ref.get(recorder.commands);
      assert.deepStrictEqual(commands, [
        { cwd: "/repo.worktrees/13-worktree-lifecycle", command: "pnpm install" },
      ]);
    }),
  );

  it.effect("creates from origin/<branch> when the remote branch already exists", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const git = fakeGit(recorder, { remoteBranches: ["13-worktree-lifecycle"] });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      yield* manager.ensure(workspaceWith(), { id: "#13", title: "Worktree lifecycle" });
      const added = yield* Ref.get(recorder.added);
      assert.strictEqual(added[0]?.startPoint, "origin/13-worktree-lifecycle");
    }),
  );

  it.effect("symlinks configured env files that exist in the checkout", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const fs = fakeFs(recorder, { "/repo/.env": { mtimeMillis: 1 } });
      const manager = yield* Effect.provide(Worktree.make, provide(fakeGit(recorder, {}), fs));
      yield* manager.ensure(workspaceWith({ linkEnvFiles: [".env", ".env.missing"] }), {
        id: "#13",
        title: "Worktree lifecycle",
      });
      const linked = yield* Ref.get(recorder.linked);
      assert.deepStrictEqual(linked, [
        { target: "/repo/.env", linkPath: "/repo.worktrees/13-worktree-lifecycle/.env" },
      ]);
    }),
  );

  it.effect("fast-forwards an existing worktree instead of recreating it", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const worktreePath = Worktree.worktreePathFor(Worktree.worktreeRoot("/repo"), "13-worktree-lifecycle");
      const git = fakeGit(recorder, {
        worktrees: [{ path: worktreePath, branch: "13-worktree-lifecycle" }],
        remoteBranches: ["13-worktree-lifecycle"],
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      const result = yield* manager.ensure(workspaceWith(), { id: "#13", title: "Worktree lifecycle" });
      assert.strictEqual(result.created, false);
      const fastForwarded = yield* Ref.get(recorder.fastForwarded);
      assert.deepStrictEqual(fastForwarded, [worktreePath]);
      const added = yield* Ref.get(recorder.added);
      assert.strictEqual(added.length, 0);
    }),
  );

  it.effect("re-runs setup when reusing an existing worktree", () =>
    Effect.gen(function* () {
      const recorder = yield* makeRecorder();
      const worktreePath = Worktree.worktreePathFor(Worktree.worktreeRoot("/repo"), "13-worktree-lifecycle");
      const git = fakeGit(recorder, {
        worktrees: [{ path: worktreePath, branch: "13-worktree-lifecycle" }],
        remoteBranches: ["13-worktree-lifecycle"],
      });
      const manager = yield* Effect.provide(Worktree.make, provide(git, fakeFs(recorder, {})));
      const result = yield* manager.ensure(workspaceWith({ setup: ["pnpm install"] }), {
        id: "#13",
        title: "Worktree lifecycle",
      });
      assert.strictEqual(result.created, false);
      const commands = yield* Ref.get(recorder.commands);
      assert.deepStrictEqual(commands, [{ cwd: worktreePath, command: "pnpm install" }]);
    }),
  );
});

describe("Worktree.reconcile", () => {
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
        ["active", "idle"],
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
      const outcome = yield* manager.reconcile(workspaceWith(), ["active", "idle"], 10_000);
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
      const outcome = yield* manager.reconcile(workspaceWith(), ["13"], 10_000);
      assert.deepStrictEqual(outcome.tornDown, []);
      const removed = yield* Ref.get(recorder.removed);
      assert.deepStrictEqual(removed, []);
    }),
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
      const result = yield* Effect.exit(manager.remove(workspaceWith(), "../../escape"));
      assert.strictEqual(result._tag, "Failure");
      const removed = yield* Ref.get(recorder.removed);
      assert.deepStrictEqual(removed, []);
    }),
  );
});
