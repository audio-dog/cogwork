import { type BranchName, BranchName as BranchNameSchema } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Schema from "effect/Schema";
import { type BranchDivergence, Git, GitError, type GitOperationInProgress, type WorktreeEntry } from "./git";
import type { RegisteredWorkspace } from "./projector";
import { WorktreeFs } from "./worktree-fs";

export const worktreeEnsureDuration = Metric.timer("cogwork_worktree_ensure_duration", {
  description: "Time to ensure a worktree is ready for a Run.",
});

export class WorktreeDivergedError extends Schema.TaggedError<WorktreeDivergedError>()(
  "WorktreeDivergedError",
  {
    remote: Schema.String,
    branch: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export class WorktreeOperationInProgressError extends Schema.TaggedError<WorktreeOperationInProgressError>()(
  "WorktreeOperationInProgressError",
  {
    branch: Schema.String,
    operation: Schema.Literals(["merge", "rebase", "cherry-pick"]),
    unmergedPaths: Schema.Array(Schema.String),
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export interface WorkItemRef {
  readonly id: string;
  readonly title: string;
}

export interface WorktreeSettings {
  readonly root?: string;
  readonly remote?: string;
  readonly baseBranch?: string;
  readonly linkPaths?: ReadonlyArray<string>;
  readonly setup?: ReadonlyArray<string>;
  readonly reapAfterMillis?: number;
}

const joinPath = (base: string, segment: string) => `${base.replace(/\/+$/, "")}/${segment}`;

const kebab = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const ticketSlug = (id: string) => kebab(id);

export const slugify = (title: string) => kebab(title);

export const branchName = (item: WorkItemRef) => {
  const ticket = ticketSlug(item.id);
  const slug = slugify(item.title);
  return BranchNameSchema.make(slug ? `${ticket}-${slug}` : ticket);
};

export const worktreeRoot = (checkoutPath: string, config?: WorktreeSettings) =>
  (config?.root ?? `${checkoutPath}.worktrees`).replace(/\/+$/, "");

export const worktreePathFor = (root: string, branch: string) => joinPath(root, branch);

export const checkoutPathFor = (
  checkoutPath: string,
  item: WorkItemRef,
  stage: string,
  config?: WorktreeSettings,
) => {
  if (stage === "triage") return checkoutPath;
  return worktreePathFor(worktreeRoot(checkoutPath, config), branchName(item));
};

const safeBranch = (branch: string) => /^[a-z0-9][a-z0-9-]*$/.test(branch);

const remoteOf = (config?: WorktreeSettings) => config?.remote ?? "origin";
const baseBranchOf = (config?: WorktreeSettings) => config?.baseBranch ?? "main";

const linkPathsFor = (config?: WorktreeSettings) => [...new Set(config?.linkPaths ?? [])];

export interface EnsuredWorktree {
  readonly branch: BranchName;
  readonly path: string;
  readonly created: boolean;
}

export interface EnsureOptions {
  readonly resume?: boolean;
  readonly branch?: BranchName;
}

export interface ReconcileOutcome {
  readonly tornDown: ReadonlyArray<string>;
  readonly reaped: ReadonlyArray<string>;
}

export type PullRequestReadiness = Data.TaggedEnum<{
  Ready: {
    readonly headBranch: string;
    readonly baseBranch: string;
  };
  Declined: {
    readonly reason: string;
  };
}>;

export const PullRequestReadiness = Data.taggedEnum<PullRequestReadiness>();

const declinedPullRequestReadiness = (reason: string) => PullRequestReadiness.Declined({ reason });

const labelOf = (entry: WorktreeEntry) => entry.branch ?? entry.path;

const logRemovalFailure = Effect.fn("Worktree.logRemovalFailure")(function* (path: string, message: string) {
  yield* Effect.logWarning("worktree removal failed", { path, message });
  return null;
});

const logMissingRemote = Effect.fn("Worktree.logMissingRemote")(function* (remote: string, branch: string) {
  yield* Effect.logWarning(
    "reusing a worktree whose branch has no counterpart on the remote; its local commits are kept as they are",
    { branch, remote },
  );
});

const commitWord = (count: number) => (count === 1 ? "commit" : "commits");

const unresolvableMessage = (remote: string, branch: string, divergence: BranchDivergence, reason: string) =>
  [
    `branch ${branch} has diverged from ${remote}/${branch}`,
    `(${divergence.ahead} local ${commitWord(divergence.ahead)} the remote lacks,`,
    `${divergence.behind} remote ${commitWord(divergence.behind)} the branch lacks)`,
    `and replaying the local commits onto ${remote}/${branch} failed: ${reason}.`,
    "The worktree was left as it was, so no local commits were discarded —",
    "a human needs to decide how to reconcile the branch.",
  ].join(" ");

const operationMessage = (branch: string, operation: GitOperationInProgress) => {
  const conflicts = operation.unmergedPaths.length
    ? `unmerged paths: ${operation.unmergedPaths.join(", ")}`
    : "no unmerged paths remain";
  return [
    `branch ${branch} has a ${operation.operation} in progress (${conflicts}).`,
    "The worktree was left as it was; a human needs to finish or abort the operation.",
  ].join(" ");
};

export const make = Effect.gen(function* () {
  const git = yield* Git;
  const fs = yield* WorktreeFs;

  const pathFor = (repoPath: string, config: WorktreeSettings | undefined, branch: string) =>
    worktreePathFor(worktreeRoot(repoPath, config), branch);

  const linkPath = Effect.fn("Worktree.linkPath")(function* (
    repoPath: string,
    worktreePath: string,
    relative: string,
  ) {
    const target = joinPath(repoPath, relative);
    const stat = yield* fs.stat(target);
    if (!stat) return;
    yield* fs.linkFile(target, joinPath(worktreePath, relative));
  });

  const runSetup = Effect.fn("Worktree.runSetup")(function* (
    repoPath: string,
    worktreePath: string,
    config?: WorktreeSettings,
  ) {
    yield* Effect.forEach(linkPathsFor(config), (relative) => linkPath(repoPath, worktreePath, relative), {
      discard: true,
    });
    yield* Effect.forEach(config?.setup ?? [], (command) => fs.runCommand(worktreePath, command), {
      discard: true,
    });
  });

  const managed = Effect.fn("Worktree.managed")(function* (repoPath: string, config?: WorktreeSettings) {
    const entries = yield* git.listWorktrees(repoPath);
    const prefix = `${worktreeRoot(repoPath, config)}/`;
    return entries.filter((entry) => entry.path.startsWith(prefix));
  });

  const replayOntoRemote = Effect.fn("Worktree.replayOntoRemote")(function* (
    worktreePath: string,
    remote: string,
    branch: string,
    divergence: BranchDivergence,
  ) {
    yield* Effect.logWarning("worktree branch diverged from its remote; replaying local commits", {
      branch,
      remote,
      ...divergence,
    });
    return yield* git.rebase(worktreePath, remote, branch).pipe(
      Effect.catchIf(
        (error) => error.reason !== "timeout",
        (error) =>
          new WorktreeDivergedError({
            remote,
            branch,
            message: unresolvableMessage(remote, branch, divergence, error.message),
            retryable: false,
          }),
      ),
    );
  });

  const syncBranch = Effect.fn("Worktree.syncBranch")(function* (
    worktreePath: string,
    remote: string,
    branch: string,
  ) {
    const divergence = yield* git.divergence(worktreePath, remote, branch);
    if (divergence.ahead === 0 || divergence.behind === 0) {
      return yield* git.fastForward(worktreePath, remote, branch);
    }
    return yield* replayOntoRemote(worktreePath, remote, branch, divergence);
  });

  const refuseOperationInProgress = Effect.fn("Worktree.refuseOperationInProgress")(function* (
    worktreePath: string,
    branch: string,
  ) {
    const operation = yield* git.operationInProgress(worktreePath);
    if (!operation) return;
    return yield* new WorktreeOperationInProgressError({
      branch,
      ...operation,
      message: operationMessage(branch, operation),
      retryable: false,
    });
  });

  const ensure = Effect.fn("Worktree.ensure")(function* (
    workspace: RegisteredWorkspace,
    item: WorkItemRef,
    options?: EnsureOptions,
  ) {
    const config = workspace.config.worktrees;
    const repoPath = workspace.config.checkoutPath;
    const remote = remoteOf(config);
    const branch = options?.branch ?? branchName(item);
    const worktreePath = pathFor(repoPath, config, branch);

    yield* git.fetch(repoPath, remote);
    const entries = yield* git.listWorktrees(repoPath);
    const exists = entries.some((entry) => entry.path === worktreePath);

    if (exists && options?.resume) {
      return { branch, path: worktreePath, created: false } satisfies EnsuredWorktree;
    }

    if (exists) yield* refuseOperationInProgress(worktreePath, branch);

    const hasRemoteBranch = yield* git.remoteBranchExists(repoPath, remote, branch);
    if (!exists) {
      const startPoint = hasRemoteBranch ? `${remote}/${branch}` : `${remote}/${baseBranchOf(config)}`;
      yield* Effect.acquireUseRelease(
        git.addWorktree({ repoPath, worktreePath, branch, startPoint }),
        () => runSetup(repoPath, worktreePath, config),
        (_created, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.ignore(git.removeWorktree(repoPath, worktreePath, true)),
      );
      return { branch, path: worktreePath, created: true } satisfies EnsuredWorktree;
    }

    if (hasRemoteBranch) yield* syncBranch(worktreePath, remote, branch);
    else yield* logMissingRemote(remote, branch);
    yield* runSetup(repoPath, worktreePath, config);
    return { branch, path: worktreePath, created: false } satisfies EnsuredWorktree;
  }, Effect.trackDuration(worktreeEnsureDuration));

  const pullRequestReadiness = Effect.fn("Worktree.pullRequestReadiness")(function* (
    workspace: RegisteredWorkspace,
    item: WorkItemRef,
  ) {
    const config = workspace.config.worktrees;
    const repoPath = workspace.config.checkoutPath;
    const remote = remoteOf(config);
    const baseBranch = baseBranchOf(config);
    const headBranch = branchName(item);
    const worktreePath = pathFor(repoPath, config, headBranch);
    const entries = yield* git.listWorktrees(repoPath);
    const actualBranch = entries.find((entry) => entry.path === worktreePath)?.branch ?? null;
    if (actualBranch !== headBranch) {
      return declinedPullRequestReadiness(
        `worktree ${worktreePath} is on ${actualBranch ?? "no branch"}, expected ${headBranch}`,
      );
    }

    yield* git.fetch(repoPath, remote);
    const remoteHeadExists = yield* git.remoteBranchExists(repoPath, remote, headBranch);
    if (!remoteHeadExists) {
      return declinedPullRequestReadiness(`head ${headBranch} has not been pushed to ${remote}`);
    }
    const headDivergence = yield* git.divergence(worktreePath, remote, headBranch);
    if (headDivergence.ahead > 0 || headDivergence.behind > 0) {
      return declinedPullRequestReadiness(`local head ${headBranch} does not match ${remote}/${headBranch}`);
    }
    const divergence = yield* git.divergence(worktreePath, remote, baseBranch, headBranch);
    if (divergence.ahead === 0) {
      return declinedPullRequestReadiness(`head ${headBranch} is not ahead of ${remote}/${baseBranch}`);
    }
    return PullRequestReadiness.Ready({ headBranch, baseBranch });
  });

  const list = Effect.fn("Worktree.list")(function* (workspace: RegisteredWorkspace) {
    return yield* managed(workspace.config.checkoutPath, workspace.config.worktrees);
  });

  const remove = Effect.fn("Worktree.remove")(function* (workspace: RegisteredWorkspace, branch: string) {
    const config = workspace.config.worktrees;
    const repoPath = workspace.config.checkoutPath;
    if (!safeBranch(branch)) {
      return yield* new GitError({
        command: `worktree remove ${branch}`,
        message: `refusing unsafe worktree branch "${branch}"`,
        retryable: true,
      });
    }
    return yield* git.removeWorktree(repoPath, pathFor(repoPath, config, branch), true);
  });

  const isIdle = Effect.fn("Worktree.isIdle")(function* (
    entry: WorktreeEntry,
    reapAfterMillis: number,
    now: number,
  ) {
    const stat = yield* fs.stat(entry.path);
    return stat !== null && now - stat.mtimeMillis > reapAfterMillis;
  });

  const attemptRemoval = Effect.fn("Worktree.attemptRemoval")(function* (
    repoPath: string,
    entry: WorktreeEntry,
    force: boolean,
  ) {
    return yield* git.removeWorktree(repoPath, entry.path, force).pipe(
      Effect.map(() => labelOf(entry)),
      Effect.catchTag("GitError", (error) => logRemovalFailure(entry.path, error.message)),
    );
  });

  const reconcile = Effect.fn("Worktree.reconcile")(function* (
    workspace: RegisteredWorkspace,
    activeTicketKeys: ReadonlyArray<string>,
    now: number,
  ) {
    const config = workspace.config.worktrees;
    const repoPath = workspace.config.checkoutPath;
    const entries = yield* managed(repoPath, config);
    const belongsToActiveTicket = (branch: string) =>
      activeTicketKeys.some((key) => branch === key || branch.startsWith(`${key}-`));

    const orphaned = entries.filter((entry) => entry.branch !== null && !belongsToActiveTicket(entry.branch));
    const retained = entries.filter((entry) => entry.branch === null || belongsToActiveTicket(entry.branch));
    const reapAfterMillis = config?.reapAfterMillis;
    const idle =
      reapAfterMillis === undefined
        ? []
        : yield* Effect.filter(retained, (entry) => isIdle(entry, reapAfterMillis, now));

    const tornDown = yield* Effect.forEach(orphaned, (entry) => attemptRemoval(repoPath, entry, true));
    const reaped = yield* Effect.forEach(idle, (entry) => attemptRemoval(repoPath, entry, false));

    return {
      tornDown: tornDown.filter((label): label is string => label !== null),
      reaped: reaped.filter((label): label is string => label !== null),
    } satisfies ReconcileOutcome;
  });

  return { ensure, pullRequestReadiness, list, remove, reconcile } as const;
});

export type WorktreeManagerService = Effect.Success<typeof make>;

export class WorktreeManager extends Context.Service<WorktreeManager, WorktreeManagerService>()(
  "@cogwork/engine/worktree/WorktreeManager",
) {}

export const managerLayer = Layer.effect(WorktreeManager, make);
