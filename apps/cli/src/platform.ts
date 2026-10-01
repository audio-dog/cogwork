import { randomUUID } from "node:crypto";
import { ContextFs, Git, Worktree, WorktreeFs } from "@cogwork/engine";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Record from "effect/Record";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const timeoutMessage = (command: string, deadline: string) => `${command} timed out after ${deadline}`;
const noFiles: ReadonlyArray<string> = [];

const recoverNotFound =
  <A, E>(fallback: A, fail: (error: PlatformError.PlatformError) => E) =>
  (error: PlatformError.PlatformError) =>
    error.reason._tag === "NotFound" ? Effect.succeed(fallback) : Effect.fail(fail(error));

const captureWith = (spawner: ChildProcessSpawner["Service"]) => (command: ChildProcess.Command) =>
  Effect.scoped(
    Effect.flatMap(spawner.spawn(command), (handle) =>
      Effect.all(
        {
          stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
          stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
          exitCode: handle.exitCode,
        },
        { concurrency: "unbounded" },
      ),
    ),
  );

const parseWorktreeBlock = (block: string) => {
  const fields = block.split("\0");
  const field = (prefix: string) =>
    fields.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
  const path = field("worktree ");
  const branchRef = field("branch ");
  return {
    entry: path ? { path, branch: branchRef ? branchRef.replace("refs/heads/", "") : null } : null,
    prunable: fields.some((value) => value === "prunable" || value.startsWith("prunable ")),
  };
};

const parseWorktrees = (stdout: string) => {
  const parsed = stdout.split("\0\0").filter(Boolean).map(parseWorktreeBlock);
  return {
    entries: parsed.flatMap(({ entry, prunable }) => {
      if (!entry || prunable) return [];
      return [entry];
    }),
    hasPrunable: parsed.some(({ prunable }) => prunable),
  };
};

const countAt = (parts: ReadonlyArray<string>, index: number) => {
  const value = Number(parts[index]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const parseDivergence = (stdout: string) => {
  const parts = stdout.trim().split(/\s+/);
  const behind = countAt(parts, 0);
  const ahead = countAt(parts, 1);
  if (behind === null || ahead === null) return null;
  return { ahead, behind } satisfies Git.BranchDivergence;
};

const parseRefObjects = (output: string) =>
  new Map(
    output.split("\n").flatMap((line) => {
      const [objectId, ref] = line.split("\t");
      const missingRefPart = !objectId || !ref;
      if (missingRefPart) return [];
      return [[ref, objectId] as const];
    }),
  );

const gitCommandDeadline = "5 minutes";

interface GitOperationState {
  readonly statePaths: readonly [string, ...ReadonlyArray<string>];
}

const gitOperationStates = {
  merge: { statePaths: ["MERGE_HEAD"] },
  rebase: { statePaths: ["rebase-merge", "rebase-apply/rebasing"] },
  "cherry-pick": { statePaths: ["CHERRY_PICK_HEAD"] },
} satisfies { readonly [Operation in Git.GitOperation]: GitOperationState };

export const gitLayer = Layer.effect(
  Git.Git,
  Effect.gen(function* () {
    const capture = captureWith(yield* ChildProcessSpawner);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const runGit = (cwd: string, args: ReadonlyArray<string>) => {
      const command = `git ${args.join(" ")}`;
      const fail = (message: string) => new Git.GitError({ command, message, retryable: true });
      return capture(ChildProcess.make("git", [...args], { cwd })).pipe(
        Effect.mapError((cause) => fail(describe(cause))),
        Effect.timeout(gitCommandDeadline),
        Effect.catchTag(
          "TimeoutError",
          () =>
            new Git.GitError({
              command,
              message: timeoutMessage(command, gitCommandDeadline),
              reason: "timeout",
              retryable: true,
            }),
        ),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : fail(result.stderr.trim() || `exited with code ${result.exitCode}`),
        ),
      );
    };

    const operationStatePathExists = Effect.fn("Git.operationStatePathExists")(function* (
      worktreePath: string,
      statePath: string,
    ) {
      const value = yield* runGit(worktreePath, ["rev-parse", "--git-path", statePath]);
      const resolvedStatePath = path.resolve(worktreePath, value.trim());
      return yield* fs.exists(resolvedStatePath).pipe(
        Effect.catch(
          recoverNotFound(
            false,
            (cause) =>
              new Git.GitError({
                command: `git rev-parse --git-path ${statePath}`,
                message: describe(cause),
                retryable: true,
              }),
          ),
        ),
      );
    });

    const operationInProgress = Effect.fn("Git.operationInProgress")(function* (worktreePath: string) {
      const found = yield* Effect.findFirst(Record.toEntries(gitOperationStates), ([, state]) =>
        Effect.findFirst(state.statePaths, (statePath) =>
          operationStatePathExists(worktreePath, statePath),
        ).pipe(Effect.map(Option.isSome)),
      );
      if (Option.isNone(found)) return null;
      const unmergedPaths = yield* runGit(worktreePath, ["diff", "--name-only", "--diff-filter=U"]).pipe(
        Effect.map((stdout) => stdout.split("\n").filter(Boolean)),
      );
      return { operation: found.value[0], unmergedPaths } satisfies Git.GitOperationInProgress;
    });

    const reconcileConfirmedMissingBranches = Effect.fn("Git.reconcileConfirmedMissingBranches")(function* (
      repoPath: string,
      remote: string,
      branches: readonly [string, ...ReadonlyArray<string>],
    ) {
      const branchRefs = branches.map((branch) => `refs/heads/${branch}`);
      const trackingRefs = branches.map((branch) => `refs/remotes/${remote}/${branch}`);
      const trackingObjects = yield* runGit(repoPath, [
        "for-each-ref",
        "--format=%(objectname)%09%(refname)",
        ...trackingRefs,
      ]).pipe(
        Effect.map(parseRefObjects),
        Effect.orElseSucceed(() => new Map<string, string>()),
      );
      const advertisedOutput = yield* runGit(repoPath, ["ls-remote", "--heads", remote, ...branchRefs]);
      const advertisedRefs = new Set(parseRefObjects(advertisedOutput).keys());
      const missingBranches = branches.filter((branch) => !advertisedRefs.has(`refs/heads/${branch}`));
      const missingTrackingRefs = missingBranches.flatMap((branch) => {
        const trackingRef = `refs/remotes/${remote}/${branch}`;
        const objectId = trackingObjects.get(trackingRef);
        return objectId ? [[trackingRef, objectId] as const] : [];
      });
      yield* Effect.forEach(
        missingTrackingRefs,
        ([trackingRef, objectId]) => runGit(repoPath, ["update-ref", "-d", trackingRef, objectId]),
        { discard: true },
      ).pipe(Effect.ignore);
      return missingBranches;
    });

    return Git.withTransitionLogging({
      fetch: Effect.fn("Git.fetch")(function* (repoPath, remote, options) {
        if (!options) return yield* runGit(repoPath, ["fetch", "--prune", remote]);
        const refspecs = options.branches.map(
          (branch) => `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
        );
        return yield* runGit(repoPath, ["fetch", "--no-tags", remote, ...refspecs]).pipe(
          Effect.catch((failure) =>
            reconcileConfirmedMissingBranches(repoPath, remote, options.branches).pipe(
              Effect.matchEffect({
                onFailure: () => Effect.fail(failure),
                onSuccess: (missingBranches) =>
                  Effect.fail(
                    new Git.GitError({
                      command: failure.command,
                      message: failure.message,
                      retryable: failure.retryable,
                      ...(failure.reason ? { reason: failure.reason } : {}),
                      ...(missingBranches.length > 0 ? { missingBranches } : {}),
                    }),
                  ),
              }),
            ),
          ),
        );
      }),
      remoteBranchExists: (repoPath, remote, branch) =>
        runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]).pipe(
          Effect.map(() => true),
          Effect.catchIf(
            (error) => error.reason !== "timeout",
            () => Effect.succeed(false),
          ),
        ),
      addWorktree: ({ repoPath, worktreePath, branch, startPoint }) =>
        runGit(repoPath, ["worktree", "add", "-B", branch, worktreePath, startPoint]).pipe(Effect.asVoid),
      removeWorktree: (repoPath, worktreePath, force) => {
        const prune = runGit(repoPath, ["worktree", "prune"]);
        return runGit(repoPath, ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath]).pipe(
          Effect.onError(() => Effect.ignore(prune)),
          Effect.andThen(Effect.ignore(prune)),
          Effect.asVoid,
        );
      },
      listWorktrees: (repoPath) =>
        runGit(repoPath, ["worktree", "list", "--porcelain", "-z"]).pipe(
          Effect.map(parseWorktrees),
          Effect.tap(({ hasPrunable }) =>
            hasPrunable ? Effect.ignore(runGit(repoPath, ["worktree", "prune"])) : Effect.void,
          ),
          Effect.map(({ entries }) => entries),
        ),
      fastForward: (worktreePath, remote, branch) =>
        runGit(worktreePath, ["merge", "--ff-only", `${remote}/${branch}`]).pipe(Effect.asVoid),
      divergence: (worktreePath, remote, baseBranch, head = { branch: baseBranch }) => {
        const headRef = head.remote ? `${head.remote}/${head.branch}` : `refs/heads/${head.branch}`;
        const range = `${remote}/${baseBranch}...${headRef}`;
        return runGit(worktreePath, ["rev-list", "--left-right", "--count", range]).pipe(
          Effect.flatMap((stdout) => {
            const parsed = parseDivergence(stdout);
            if (parsed) return Effect.succeed(parsed);
            return new Git.GitError({
              command: `rev-list --left-right --count ${range}`,
              message: `unreadable divergence output "${stdout.trim()}"`,
              retryable: true,
            });
          }),
        );
      },
      operationInProgress,
      rebase: (worktreePath, remote, branch) =>
        runGit(worktreePath, ["rebase", `${remote}/${branch}`, branch]).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : Effect.ignore(runGit(worktreePath, ["rebase", "--abort"])),
          ),
          Effect.asVoid,
        ),
      remoteUrl: (repoPath, remote) =>
        runGit(repoPath, ["config", "--local", "--get", `remote.${remote}.url`]).pipe(
          Effect.map((value) => value.trim()),
        ),
    } satisfies Git.GitService);
  }),
);

const setupCommandDeadline = "30 minutes";

export const worktreeFsLayer = Layer.effect(
  WorktreeFs.WorktreeFs,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const capture = captureWith(yield* ChildProcessSpawner);

    const fail = (operation: string) => (cause: unknown) =>
      new WorktreeFs.WorktreeFsError({ operation, message: describe(cause), retryable: true });

    const isWithinRoot = (root: string, target: string) => {
      const relative = path.relative(root, target);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    };

    return {
      linkFile: (target, linkPath) =>
        fs
          .makeDirectory(path.dirname(linkPath), { recursive: true })
          .pipe(
            Effect.andThen(fs.remove(linkPath, { force: true })),
            Effect.andThen(fs.symlink(target, linkPath)),
            Effect.mapError(fail(`link ${linkPath}`)),
          ),
      removeDebris: (root, target) =>
        Effect.all([fs.realPath(root), fs.realPath(path.dirname(target))]).pipe(
          Effect.mapError(fail(`resolve ${target}`)),
          Effect.flatMap(([realRoot, realParent]) => {
            if (!isWithinRoot(realRoot, realParent)) {
              return new WorktreeFs.WorktreeFsError({
                operation: `remove debris ${target}`,
                message: `${target} resolves outside worktree root ${root}`,
                retryable: false,
              });
            }

            const resolvedTarget = path.join(realParent, path.basename(target));
            const quarantine = `${resolvedTarget}.cogwork-debris-${randomUUID()}`;
            const gitEntry = path.join(quarantine, ".git");
            return Effect.uninterruptible(
              fs.rename(resolvedTarget, quarantine).pipe(
                Effect.andThen(
                  fs.stat(quarantine).pipe(
                    Effect.flatMap((info) =>
                      info.type === "Directory"
                        ? fs.stat(gitEntry).pipe(
                            Effect.map(() => true),
                            Effect.catch(recoverNotFound(false, fail(`stat ${gitEntry}`))),
                          )
                        : Effect.succeed(false),
                    ),
                    Effect.onError(() => fs.rename(quarantine, resolvedTarget).pipe(Effect.ignore)),
                  ),
                ),
                Effect.flatMap((containsGitEntry) =>
                  containsGitEntry
                    ? fs.rename(quarantine, resolvedTarget).pipe(Effect.map(() => false))
                    : fs.remove(quarantine, { recursive: true }).pipe(Effect.map(() => true)),
                ),
                Effect.mapError(fail(`remove debris ${target}`)),
              ),
            );
          }),
        ),
      runCommand: (cwd, command) =>
        capture(
          ChildProcess.make(command, {
            cwd,
            env: { CI: "true" },
            extendEnv: true,
            shell: true,
          }),
        ).pipe(
          Effect.mapError(fail(command)),
          Effect.timeout(setupCommandDeadline),
          Effect.catchTag(
            "TimeoutError",
            () =>
              new WorktreeFs.WorktreeFsError({
                operation: command,
                message: timeoutMessage(command, setupCommandDeadline),
                retryable: true,
              }),
          ),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : new WorktreeFs.WorktreeFsError({
                  operation: command,
                  message:
                    result.stderr.trim() || result.stdout.trim() || `exited with code ${result.exitCode}`,
                  retryable: true,
                }),
          ),
        ),
      stat: (target) =>
        fs.stat(target).pipe(
          Effect.map((info) =>
            Option.match(info.mtime, {
              onNone: () => null,
              onSome: (mtime) => ({ mtimeMillis: mtime.getTime() }),
            }),
          ),
          Effect.catch(recoverNotFound(null, fail(`stat ${target}`))),
        ),
    } satisfies WorktreeFs.WorktreeFsService;
  }),
);

export const contextFsLayer = Layer.effect(
  ContextFs.ContextFs,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const fail = (operation: string) => (cause: unknown) =>
      new ContextFs.ContextFsError({ operation, message: describe(cause), retryable: true });

    const readFiles = (target: string, options?: { readonly recursive?: boolean }) =>
      fs.readDirectory(target, options).pipe(
        Effect.catch(recoverNotFound(noFiles, fail(`read files ${target}`))),
        Effect.flatMap((entries) =>
          Effect.filter(entries, (entry) => {
            const entryPath = path.join(target, entry);
            return fs.stat(entryPath).pipe(
              Effect.map((info) => info.type === "File"),
              Effect.catch(recoverNotFound(false, fail(`stat context entry ${entryPath}`))),
            );
          }),
        ),
      );

    return {
      directoryExists: (target) =>
        fs.stat(target).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.catch(recoverNotFound(false, fail(`stat directory ${target}`))),
        ),
      readFile: (target) =>
        fs.readFileString(target).pipe(Effect.catch(recoverNotFound(null, fail(`read ${target}`)))),
      readDirectory: readFiles,
      copyDirectory: (source, dest) =>
        fs
          .remove(dest, { recursive: true, force: true })
          .pipe(
            Effect.andThen(fs.makeDirectory(path.dirname(dest), { recursive: true })),
            Effect.andThen(fs.copy(source, dest, { overwrite: true })),
            Effect.mapError(fail(`copy ${source} to ${dest}`)),
          ),
      removeDirectory: (target) =>
        fs.remove(target, { recursive: true, force: true }).pipe(Effect.mapError(fail(`remove ${target}`))),
    } satisfies ContextFs.ContextFsService;
  }),
);

export const worktreeManagerLayer = Worktree.managerLayer.pipe(
  Layer.provide(Layer.mergeAll(gitLayer, worktreeFsLayer)),
);
