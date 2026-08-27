import { ContextFs, Git, Worktree, WorktreeFs } from "@cogwork/engine";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const timeoutMessage = (command: string, deadline: string) => `${command} timed out after ${deadline}`;

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

const parseWorktrees = (stdout: string) =>
  stdout
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .flatMap((block) => {
      const lines = block.split("\n");
      const field = (prefix: string) =>
        lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? null;
      const worktreePath = field("worktree ");
      if (!worktreePath) return [];
      const branchRef = field("branch ");
      return [{ path: worktreePath, branch: branchRef ? branchRef.replace("refs/heads/", "") : null }];
    });

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

const gitCommandDeadline = "5 minutes";

export const gitLayer = Layer.effect(
  Git.Git,
  Effect.gen(function* () {
    const capture = captureWith(yield* ChildProcessSpawner);

    const runGit = (cwd: string, args: ReadonlyArray<string>) => {
      const command = `git ${args.join(" ")}`;
      const fail = (message: string) => new Git.GitError({ command, message });
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
            }),
        ),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : fail(result.stderr.trim() || `exited with code ${result.exitCode}`),
        ),
      );
    };

    return {
      fetch: (repoPath, remote) => runGit(repoPath, ["fetch", "--prune", remote]).pipe(Effect.asVoid),
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
      removeWorktree: (repoPath, worktreePath, force) =>
        runGit(repoPath, ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath]).pipe(
          Effect.andThen(runGit(repoPath, ["worktree", "prune"])),
          Effect.asVoid,
        ),
      listWorktrees: (repoPath) =>
        runGit(repoPath, ["worktree", "list", "--porcelain"]).pipe(Effect.map(parseWorktrees)),
      fastForward: (worktreePath, remote, branch) =>
        runGit(worktreePath, ["merge", "--ff-only", `${remote}/${branch}`]).pipe(Effect.asVoid),
      divergence: (worktreePath, remote, branch) => {
        const range = `${remote}/${branch}...refs/heads/${branch}`;
        return runGit(worktreePath, ["rev-list", "--left-right", "--count", range]).pipe(
          Effect.flatMap((stdout) => {
            const parsed = parseDivergence(stdout);
            if (parsed) return Effect.succeed(parsed);
            return new Git.GitError({
              command: `rev-list --left-right --count ${range}`,
              message: `unreadable divergence output "${stdout.trim()}"`,
            });
          }),
        );
      },
      rebase: (worktreePath, remote, branch) =>
        runGit(worktreePath, ["rebase", `${remote}/${branch}`, branch]).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : Effect.ignore(runGit(worktreePath, ["rebase", "--abort"])),
          ),
          Effect.asVoid,
        ),
    } satisfies Git.GitService;
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
      new WorktreeFs.WorktreeFsError({ operation, message: describe(cause) });

    return {
      linkFile: (target, linkPath) =>
        fs
          .makeDirectory(path.dirname(linkPath), { recursive: true })
          .pipe(
            Effect.andThen(fs.remove(linkPath, { force: true })),
            Effect.andThen(fs.symlink(target, linkPath)),
            Effect.mapError(fail(`link ${linkPath}`)),
          ),
      runCommand: (cwd, command) =>
        capture(ChildProcess.make(command, { cwd, shell: true })).pipe(
          Effect.mapError(fail(command)),
          Effect.timeout(setupCommandDeadline),
          Effect.catchTag(
            "TimeoutError",
            () =>
              new WorktreeFs.WorktreeFsError({
                operation: command,
                message: timeoutMessage(command, setupCommandDeadline),
              }),
          ),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : new WorktreeFs.WorktreeFsError({
                  operation: command,
                  message: result.stderr.trim() || `exited with code ${result.exitCode}`,
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
          Effect.orElseSucceed(() => null),
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
      new ContextFs.ContextFsError({ operation, message: describe(cause) });

    const readDirectory = (target: string) =>
      fs
        .readDirectory(target)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed([])
              : Effect.fail(fail(`read directory ${target}`)(error)),
          ),
        );

    return {
      readFile: (target) => fs.readFileString(target).pipe(Effect.orElseSucceed(() => null)),
      readDirectory,
      copyDirectory: (source, dest) =>
        fs
          .remove(dest, { recursive: true, force: true })
          .pipe(
            Effect.andThen(fs.makeDirectory(path.dirname(dest), { recursive: true })),
            Effect.andThen(fs.copy(source, dest, { overwrite: true })),
            Effect.mapError(fail(`copy ${source} to ${dest}`)),
          ),
    } satisfies ContextFs.ContextFsService;
  }),
);

export const worktreeManagerLayer = Worktree.managerLayer.pipe(
  Layer.provide(Layer.mergeAll(gitLayer, worktreeFsLayer)),
);
