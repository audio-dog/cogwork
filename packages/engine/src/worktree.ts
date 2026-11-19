import { type BranchName, BranchName as BranchNameSchema } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TxReentrantLock from "effect/TxReentrantLock";
import { type BranchDivergence, Git, GitError, type GitOperationInProgress, type WorktreeEntry } from "./git";
import type { RegisteredWorkspace } from "./projector";
import {
  isSameOperation,
  logMissingRemote,
  logRemovalFailure,
  logUnrecordedOperation,
  operationMessage,
  unresolvableMessage,
} from "./worktree-diagnostics";
import { WorktreeFs } from "./worktree-fs";

export const worktreeEnsureDuration = Metric.timer("cogwork_worktree_ensure_duration", {
  description: "Time to ensure a worktree is ready for a Run.",
});

export class WorktreeError extends Schema.TaggedError<WorktreeError>()("WorktreeError", {
  reason: Schema.Literals(["detached", "diverged", "operation-in-progress", "unsafe-branch"]),
  branch: Schema.String,
  path: Schema.optional(Schema.String),
  remote: Schema.optional(Schema.String),
  operation: Schema.optional(Schema.Literals(["merge", "rebase", "cherry-pick"])),
  unmergedPaths: Schema.optional(Schema.Array(Schema.String)),
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

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

const codePointSlug = (value: string) =>
  [...value].map((character) => character.codePointAt(0)?.toString(36).padStart(5, "0") ?? "00000").join("");

export const ticketSlug = (id: string) => kebab(id) || `u--${codePointSlug(id)}`;

export const branchBelongsToTicketSlug = (branch: string, slug: string) =>
  branch === slug || (branch.startsWith(`${slug}-`) && !branch.startsWith(`${slug}--`));

export const slugify = (title: string) => kebab(title);

export const branchName = (item: WorkItemRef) => {
  const ticket = ticketSlug(item.id);
  const slug = slugify(item.title);
  return BranchNameSchema.make(slug ? `${ticket}-${slug}` : ticket);
};

export const worktreeRoot = (checkoutPath: string, config?: WorktreeSettings) =>
  (config?.root ?? `${checkoutPath}.worktrees`).replace(/\/+$/, "");

export const worktreePathFor = (root: string, branch: string) => joinPath(root, branch);

const safeBranch = (branch: string) => /^[a-z0-9][a-z0-9-]*$/.test(branch);
const safeWorktreeBranch = (branch: string) =>
  !branch.startsWith("/") &&
  !branch.includes("\\") &&
  branch.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

const remoteOf = (config?: WorktreeSettings) => config?.remote ?? "origin";
export const baseBranchOf = (config?: WorktreeSettings) => config?.baseBranch ?? "main";

const linkPathsFor = (config?: WorktreeSettings) => [...new Set(config?.linkPaths ?? [])];

export interface EnsuredWorktree {
  readonly branch: BranchName;
  readonly path: string;
  readonly created: boolean;
  readonly operationInProgress: GitOperationInProgress | null;
}

export interface EnsureOptions {
  readonly resume?: boolean;
  readonly branch?: BranchName;
  readonly pushOwner?: "agent" | "engine";
}

export interface ReconcileOutcome {
  readonly tornDown: ReadonlyArray<string>;
  readonly reaped: ReadonlyArray<string>;
}

export interface ReconcileRetention {
  readonly activeTicketKeys: ReadonlyArray<string>;
  readonly ownedWorktreePaths: ReadonlyArray<string>;
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

export const make = Effect.gen(function* () {
  const git = yield* Git;
  const fs = yield* WorktreeFs;
  const retentionLock = yield* TxReentrantLock.make();

  const withRunOwnershipLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    TxReentrantLock.withReadLock(retentionLock, effect);

  const tryWithMaintenanceLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.tx(
        TxReentrantLock.locked(retentionLock).pipe(
          Effect.flatMap((locked) =>
            locked
              ? Effect.succeed(false)
              : TxReentrantLock.acquireWrite(retentionLock).pipe(Effect.map(() => true)),
          ),
        ),
      ),
      (acquired) => (acquired ? Effect.asSome(effect) : Effect.succeed(Option.none<A>())),
      (acquired) => (acquired ? TxReentrantLock.releaseWrite(retentionLock) : Effect.void),
    );

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

  const setup = Effect.fn("Worktree.setup")(function* (workspace: RegisteredWorkspace, worktreePath: string) {
    yield* runSetup(workspace.config.checkoutPath, worktreePath, workspace.config.worktrees);
  });

  const pushOwnership = {
    agent: git.allowPush,
    engine: git.blockPush,
  } satisfies Record<NonNullable<EnsureOptions["pushOwner"]>, typeof git.blockPush>;

  const configurePush = (
    worktreePath: string,
    remote: string,
    owner: NonNullable<EnsureOptions["pushOwner"]> = "agent",
  ) => pushOwnership[owner](worktreePath, remote);

  const registeredOrDetached = Effect.fn("Worktree.registeredOrDetached")(function* (
    repoPath: string,
    branch: string,
    worktreePath: string,
  ) {
    const entries = yield* git.listWorktrees(repoPath);
    const registered = entries.some((entry) => entry.path === worktreePath);
    if (registered) return "registered";
    return yield* new WorktreeError({
      reason: "detached",
      branch,
      path: worktreePath,
      message: `worktree path ${worktreePath} contains a .git entry but git does not register it; it was left untouched because it may contain uncommitted work`,
      retryable: false,
    });
  });

  const recoverUnregisteredPath = Effect.fn("Worktree.recoverUnregisteredPath")(function* (
    repoPath: string,
    root: string,
    branch: string,
    worktreePath: string,
  ) {
    const target = yield* fs.stat(worktreePath);
    if (!target) return "vacant";

    const removed = yield* fs.removeDebris(root, worktreePath);
    if (removed) return "vacant";
    return yield* registeredOrDetached(repoPath, branch, worktreePath);
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
          new WorktreeError({
            reason: "diverged",
            remote,
            branch,
            path: worktreePath,
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

  const acceptRecordedOperation = Effect.fn("Worktree.acceptRecordedOperation")(function* (
    worktreePath: string,
    branch: string,
  ) {
    const operation = yield* git.operationInProgress(worktreePath);
    if (!operation) {
      yield* git.recordOperation(worktreePath, null);
      return null;
    }
    const recorded = yield* git.recordedOperation(worktreePath);
    if (isSameOperation(recorded, operation)) return operation;
    return yield* new WorktreeError({
      reason: "operation-in-progress",
      branch,
      path: worktreePath,
      operation: operation.operation,
      unmergedPaths: operation.unmergedPaths,
      message: operationMessage(branch, operation),
      retryable: false,
    });
  });

  const recordOperationLeft = (worktreePath: string) =>
    git.operationInProgress(worktreePath).pipe(
      Effect.flatMap((operation) => git.recordOperation(worktreePath, operation)),
      Effect.catchTag("GitError", (error) => logUnrecordedOperation(worktreePath, error)),
    );

  const acquire = Effect.fn("Worktree.acquire")(function* (
    workspace: RegisteredWorkspace,
    item: WorkItemRef,
    options?: EnsureOptions,
  ) {
    const config = workspace.config.worktrees;
    const repoPath = workspace.config.checkoutPath;
    const remote = remoteOf(config);
    const branch = options?.branch ?? branchName(item);
    if (!safeWorktreeBranch(branch)) {
      return yield* new WorktreeError({
        reason: "unsafe-branch",
        branch,
        message: `refusing worktree branch "${branch}" because it does not resolve below the worktree root`,
        retryable: false,
      });
    }
    const root = worktreeRoot(repoPath, config);
    const worktreePath = worktreePathFor(root, branch);

    yield* git.fetch(repoPath, remote);
    const entries = yield* git.listWorktrees(repoPath);
    const initiallyRegistered = entries.some((entry) => entry.path === worktreePath);
    const targetState = initiallyRegistered
      ? "registered"
      : yield* recoverUnregisteredPath(repoPath, root, branch, worktreePath);
    const registered = targetState === "registered";
    const operationInProgress = registered ? yield* acceptRecordedOperation(worktreePath, branch) : null;
    const keepsWorktreeAsItIs = registered && (operationInProgress !== null || options?.resume);

    if (keepsWorktreeAsItIs) {
      yield* configurePush(worktreePath, remote, options?.pushOwner);
      return { branch, path: worktreePath, created: false, operationInProgress } satisfies EnsuredWorktree;
    }

    const hasRemoteBranch = yield* git.remoteBranchExists(repoPath, remote, branch);
    if (!registered) {
      const startPoint = hasRemoteBranch ? `${remote}/${branch}` : `${remote}/${baseBranchOf(config)}`;
      yield* Effect.acquireUseRelease(
        git.addWorktree({ repoPath, worktreePath, branch, startPoint }),
        () =>
          runSetup(repoPath, worktreePath, config).pipe(
            Effect.andThen(configurePush(worktreePath, remote, options?.pushOwner)),
          ),
        (_created, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.ignore(git.removeWorktree(repoPath, worktreePath, true)),
      );
      return {
        branch,
        path: worktreePath,
        created: true,
        operationInProgress: null,
      } satisfies EnsuredWorktree;
    }

    if (hasRemoteBranch) yield* syncBranch(worktreePath, remote, branch);
    else yield* logMissingRemote(remote, branch);
    yield* runSetup(repoPath, worktreePath, config);
    yield* configurePush(worktreePath, remote, options?.pushOwner);
    return {
      branch,
      path: worktreePath,
      created: false,
      operationInProgress: null,
    } satisfies EnsuredWorktree;
  }, Effect.trackDuration(worktreeEnsureDuration));

  const ensure = (workspace: RegisteredWorkspace, item: WorkItemRef, options?: EnsureOptions) =>
    Effect.uninterruptibleMask((restore) =>
      restore(acquire(workspace, item, options)).pipe(
        Effect.tap((ensured) => Effect.addFinalizer(() => recordOperationLeft(ensured.path))),
      ),
    );

  const pullRequestReadiness = Effect.fn("Worktree.pullRequestReadiness")(function* (
    workspace: RegisteredWorkspace,
    item: WorkItemRef,
    selectedHeadBranch?: string,
  ) {
    const config = workspace.config.worktrees;
    const repoPath = workspace.config.checkoutPath;
    const remote = remoteOf(config);
    const baseBranch = baseBranchOf(config);
    const headBranch = selectedHeadBranch ?? branchName(item);

    const refreshFailure = yield* git
      .fetch(repoPath, remote, {
        branches: [baseBranch],
      })
      .pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => null,
        }),
      );
    if (refreshFailure) {
      yield* Effect.logWarning("failed to refresh pull request refs; continuing with cached refs", {
        command: refreshFailure.command,
        message: refreshFailure.message,
      });
    }
    const confirmedMissing = refreshFailure?.missingBranches?.includes(baseBranch)
      ? `base ${baseBranch} does not exist on ${remote}`
      : null;
    if (confirmedMissing) return declinedPullRequestReadiness(confirmedMissing);
    const divergence = yield* git.divergence(repoPath, remote, baseBranch, {
      branch: headBranch,
    });
    if (divergence.ahead === 0) {
      return declinedPullRequestReadiness(`head ${headBranch} is not ahead of ${remote}/${baseBranch}`);
    }
    return PullRequestReadiness.Ready({ headBranch, baseBranch });
  });

  const pushBranch = Effect.fn("Worktree.pushBranch")(function* (
    workspace: RegisteredWorkspace,
    headBranch: string,
  ) {
    const config = workspace.config.worktrees;
    const repoPath = workspace.config.checkoutPath;
    const remote = remoteOf(config);
    const remoteUrl = yield* git.remoteUrl(repoPath, remote);
    yield* git.pushBranch(repoPath, remoteUrl, headBranch);
  });

  const pushBranchIfAhead = Effect.fn("Worktree.pushBranchIfAhead")(function* (
    workspace: RegisteredWorkspace,
    headBranch: string,
  ) {
    const config = workspace.config.worktrees;
    const repoPath = workspace.config.checkoutPath;
    const remote = remoteOf(config);
    const exists = yield* git.remoteBranchExists(repoPath, remote, headBranch);
    if (exists) {
      const divergence = yield* git.divergence(repoPath, remote, headBranch, { branch: headBranch });
      if (divergence.ahead === 0) return false;
    }
    yield* pushBranch(workspace, headBranch);
    return true;
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
    retention: ReconcileRetention,
    now: number,
  ) {
    const config = workspace.config.worktrees;
    const repoPath = workspace.config.checkoutPath;
    const entries = yield* managed(repoPath, config);
    const ownedWorktreePaths = new Set(retention.ownedWorktreePaths);
    const belongsToActiveTicket = (branch: string) =>
      retention.activeTicketKeys.some((key) => branchBelongsToTicketSlug(branch, key));
    const isOwnedWorktree = (entry: WorktreeEntry) => ownedWorktreePaths.has(entry.path);
    const isActiveWorktree = (entry: WorktreeEntry) =>
      entry.branch === null || belongsToActiveTicket(entry.branch);
    const isOrphaned = (entry: WorktreeEntry) => !isOwnedWorktree(entry) && !isActiveWorktree(entry);
    const isReapCandidate = (entry: WorktreeEntry) => !isOwnedWorktree(entry) && isActiveWorktree(entry);

    const orphaned = entries.filter(isOrphaned);
    const reapCandidates = entries.filter(isReapCandidate);
    const reapAfterMillis = config?.reapAfterMillis;
    const idle =
      reapAfterMillis === undefined
        ? []
        : yield* Effect.filter(reapCandidates, (entry) => isIdle(entry, reapAfterMillis, now));

    const tornDown = yield* Effect.forEach(orphaned, (entry) => attemptRemoval(repoPath, entry, true));
    const reaped = yield* Effect.forEach(idle, (entry) => attemptRemoval(repoPath, entry, false));

    return {
      tornDown: tornDown.filter((label): label is string => label !== null),
      reaped: reaped.filter((label): label is string => label !== null),
    } satisfies ReconcileOutcome;
  });

  return {
    ensure,
    setup,
    pullRequestReadiness,
    pushBranch,
    pushBranchIfAhead,
    list,
    remove,
    reconcile,
    withRunOwnershipLock,
    tryWithMaintenanceLock,
  };
});

export type WorktreeManagerService = Effect.Success<typeof make>;

export class WorktreeManager extends Context.Service<WorktreeManager, WorktreeManagerService>()(
  "@cogwork/engine/worktree/WorktreeManager",
) {}

export const managerLayer = Layer.effect(WorktreeManager, make);
