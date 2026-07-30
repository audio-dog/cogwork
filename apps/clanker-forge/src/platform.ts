import { exec, execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { Git, Worktree, WorktreeFs } from "@clanker-forge/engine";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () => execFileAsync("git", [...args], { cwd }),
    catch: (cause) => new Git.GitError({ command: `git ${args.join(" ")}`, message: describe(cause) }),
  }).pipe(Effect.map((result) => result.stdout));

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

const gitImpl: Git.GitService = {
  fetch: (repoPath, remote) => runGit(repoPath, ["fetch", remote]).pipe(Effect.asVoid),
  remoteBranchExists: (repoPath, remote, branch) =>
    runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]).pipe(
      Effect.as(true),
      Effect.catchTag("GitError", () => Effect.succeed(false)),
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
};

export const gitLayer = Layer.succeed(Git.Git, gitImpl);

const worktreeFsImpl: WorktreeFs.WorktreeFsService = {
  linkFile: (target, linkPath) =>
    Effect.tryPromise({
      try: async () => {
        await fs.mkdir(path.dirname(linkPath), { recursive: true });
        await fs.rm(linkPath, { force: true });
        await fs.symlink(target, linkPath);
      },
      catch: (cause) =>
        new WorktreeFs.WorktreeFsError({ operation: `link ${linkPath}`, message: describe(cause) }),
    }),
  runCommand: (cwd, command) =>
    Effect.tryPromise({
      try: () => execAsync(command, { cwd }),
      catch: (cause) => new WorktreeFs.WorktreeFsError({ operation: command, message: describe(cause) }),
    }).pipe(Effect.asVoid),
  stat: (target) =>
    Effect.promise(() =>
      fs
        .stat(target)
        .then((entry) => ({ mtimeMillis: entry.mtimeMs }))
        .catch(() => null),
    ),
};

export const worktreeFsLayer = Layer.succeed(WorktreeFs.WorktreeFs, worktreeFsImpl);

export const worktreeManagerLayer = Worktree.managerLayer.pipe(
  Layer.provide(Layer.mergeAll(gitLayer, worktreeFsLayer)),
);
