import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { IssueTracker } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { WorkspaceRegistry } from "./registry-service";
import { RunLedger } from "./run-ledger";
import { SourceControlProvider } from "./source-control";
import { ticketSlug, WorktreeManager, worktreePathFor, worktreeRoot } from "./worktree";

const canonicalWorktreeRoot = Effect.fn("WorktreeMaintenance.canonicalWorktreeRoot")(function* (
  workspace: RegisteredWorkspace,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configuredPath = path.resolve(
    worktreeRoot(workspace.config.checkoutPath, workspace.config.worktrees),
  );
  return yield* fs.realPath(configuredPath).pipe(
    Effect.match({
      onFailure: () => ({ configuredPath, canonicalPath: configuredPath, resolved: false }),
      onSuccess: (canonicalPath) => ({ configuredPath, canonicalPath, resolved: true }),
    }),
  );
});

const ownedWorktreePaths = Effect.fn("WorktreeMaintenance.ownedWorktreePaths")(function* (
  workspace: RegisteredWorkspace,
  workspaces: ReadonlyArray<RegisteredWorkspace>,
) {
  const ledger = yield* RunLedger;
  const running = yield* ledger.runningRuns;
  const workspaceById = new Map(workspaces.map((candidate) => [candidate.config.id, candidate]));
  const ownershipRoot = yield* canonicalWorktreeRoot(workspace);
  const ownershipPaths = [ownershipRoot.configuredPath, ownershipRoot.canonicalPath];
  const retained = yield* Effect.forEach(running, ({ branch, workspace: runWorkspace }) => {
    const owner = workspaceById.get(runWorkspace);
    if (owner === undefined || branch === null) return Effect.succeed([]);
    return Effect.map(canonicalWorktreeRoot(owner), (ownerRoot) => {
      const sharesOwnershipRoot =
        !ownerRoot.resolved ||
        !ownershipRoot.resolved ||
        ownerRoot.canonicalPath === ownershipRoot.canonicalPath;
      return sharesOwnershipRoot ? ownershipPaths.map((root) => worktreePathFor(root, branch)) : [];
    });
  });
  return retained.flat();
});

const activeBranches = Effect.fn("WorktreeMaintenance.activeBranches")(function* (
  workspace: RegisteredWorkspace,
) {
  const tracker = yield* IssueTracker;
  const sourceControl = yield* SourceControlProvider;
  const [items, pullRequestBranches] = yield* Effect.all([
    tracker.observe(workspace),
    sourceControl.openPullRequestBranches(workspace),
  ]);
  return [...items.map(({ id }) => ticketSlug(id)), ...pullRequestBranches];
});

const maintainWorkspace = Effect.fn("WorktreeMaintenance.maintainWorkspace")(function* (
  workspace: RegisteredWorkspace,
  workspaces: ReadonlyArray<RegisteredWorkspace>,
) {
  const manager = yield* WorktreeManager;
  const activeTicketKeys = yield* activeBranches(workspace);
  const owned = yield* ownedWorktreePaths(workspace, workspaces);
  const now = yield* Clock.currentTimeMillis;
  return yield* manager.reconcile(workspace, { activeTicketKeys, ownedWorktreePaths: owned }, now);
});

export const maintainWorktrees = Effect.fn("WorktreeMaintenance.maintainWorktrees")(function* () {
  const manager = yield* WorktreeManager;
  const registry = yield* (yield* WorkspaceRegistry).state;
  const managed = registry.workspaces.filter(({ config }) => config.worktrees !== undefined);
  yield* Effect.forEach(
    managed,
    (workspace) => {
      const correlation = { workspace: workspace.config.id };
      return manager.tryWithMaintenanceLock(maintainWorkspace(workspace, registry.workspaces)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.logInfo("worktree maintenance skipped; Run owns a worktree"),
            onSome: (outcome) => Effect.logInfo("worktree maintenance", outcome),
          }),
        ),
        Effect.catchTags({
          GitError: (error) => Effect.logWarning("worktree maintenance failed", { message: error.message }),
          IssueTrackerError: (error) =>
            Effect.logWarning("worktree maintenance skipped; open items unavailable", {
              message: error.message,
            }),
        }),
        Effect.annotateLogs(correlation),
        Effect.annotateSpans(correlation),
      );
    },
    { discard: true },
  );
});
