import { BranchName, WorkspaceConfig } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import * as Worktree from "./worktree";
import { type FileStat, WorktreeFs, type WorktreeFsService } from "./worktree-fs";

const decodeConfig = Schema.decodeSync(WorkspaceConfig);
export const decodeBranchName = Schema.decodeSync(BranchName);
export const item = { id: "#13", title: "Worktree lifecycle" } satisfies Worktree.WorkItemRef;
export const worktreePath = (branch = Worktree.branchName(item)) =>
  Worktree.worktreePathFor(Worktree.worktreeRoot("/repo"), branch);

export const workspaceWith = (worktrees?: Worktree.WorktreeSettings) => ({
  source: "test.workspace.ts",
  contributions: [],
  config: decodeConfig({
    id: "demo",
    displayName: "demo",
    checkoutPath: "/repo",
    issueTracker: { type: "github" },
    worktrees,
  }),
});

export const makeRecorder = Effect.fn("test.makeRecorder")(function* () {
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
    blockedPushes: yield* Ref.make<ReadonlyArray<{ readonly path: string; readonly remote: string }>>([]),
    allowedPushes: yield* Ref.make<ReadonlyArray<{ readonly path: string; readonly remote: string }>>([]),
    pushedBranches: yield* Ref.make<
      ReadonlyArray<{ readonly repoPath: string; readonly remoteUrl: string; readonly branch: string }>
    >([]),
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

export class WorktreeRecorder extends Context.Service<WorktreeRecorder, Recorder>()(
  "@cogwork/engine/worktree-fixtures/WorktreeRecorder",
) {
  static readonly layer = Layer.effect(WorktreeRecorder, makeRecorder());
}

export class LayeredWorktree extends Context.Service<LayeredWorktree, Worktree.WorktreeManagerService>()(
  "@cogwork/engine/worktree-fixtures/LayeredWorktree",
) {}

const inSync: BranchDivergence = { ahead: 0, behind: 0 };

export const fakeGit = (
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
    recordedOperation: () => Effect.succeed(null),
    recordOperation: () => Effect.void,
    rebase: (worktreePath: string, _remote: string, _branch: string) =>
      options.rebaseFailure === undefined
        ? Ref.update(recorder.rebased, (log) => [...log, worktreePath])
        : Effect.fail(options.rebaseFailure),
    remoteUrl: () => Effect.succeed("git@example.com:repo.git"),
    blockPush: (path: string, remote: string) =>
      Ref.update(recorder.blockedPushes, (log) => [...log, { path, remote }]),
    allowPush: (path: string, remote: string) =>
      Ref.update(recorder.allowedPushes, (log) => [...log, { path, remote }]),
    pushBranch: (repoPath: string, remoteUrl: string, branch: string) =>
      Ref.update(recorder.pushedBranches, (log) => [...log, { repoPath, remoteUrl, branch }]),
  } satisfies GitService;
};

export const fakeFs = (
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

export const provide = (git: GitService, fs: WorktreeFsService) =>
  Layer.mergeAll(Layer.succeed(Git, git), Layer.succeed(WorktreeFs, fs));

export const worktreeLayer = (
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
