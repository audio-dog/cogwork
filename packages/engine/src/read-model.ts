import type { ReadyToMergeItem, SchedulerStats, WorkspaceId } from "@cogwork/contracts";
import { workspaceFailureState, workspaceStateFromInfo } from "@cogwork/contracts";
import * as Effect from "effect/Effect";

import type { RegisteredWorkspace, RegistryState } from "./projector";
import type { SchedulerConfig, SchedulerState } from "./scheduler";
import { SourceControlProvider } from "./source-control";
import { WorkflowArtifactStore } from "./workflow-artifact-store";

export const readyToMergeByWorkspace = Effect.fn("ReadModel.readyToMergeByWorkspace")(function* (
  registry: RegistryState,
) {
  const artifactStore = yield* WorkflowArtifactStore;
  const sourceControl = yield* SourceControlProvider;
  const artifacts = yield* artifactStore.all.pipe(
    Effect.catchTag("ControlStoreFailure", (error) =>
      Effect.logWarning("Ready to merge artifacts unavailable", { message: error.message }).pipe(
        Effect.map(() => null),
      ),
    ),
  );
  if (artifacts === null) return new Map<WorkspaceId, ReadonlyArray<ReadyToMergeItem>>();
  const entries = yield* Effect.forEach(registry.workspaces, (workspace) =>
    sourceControl
      .readyToMerge(
        workspace,
        artifacts.filter((artifact) => artifact.workspace === workspace.config.id),
      )
      .pipe(
        Effect.map((items) => [[workspace.config.id, items] as const]),
        Effect.catchTag("IssueTrackerError", (error) =>
          Effect.logWarning("Ready to merge read failed", {
            workspace: workspace.config.id,
            message: error.message,
          }).pipe(Effect.map(() => [])),
        ),
      ),
  );
  return new Map(entries.flat());
});

const workspaceRecordOf = (workspace: RegisteredWorkspace) =>
  workspace.record ?? {
    displayName: workspace.config.displayName,
    checkoutPath: workspace.config.checkoutPath,
    issueTracker: workspace.config.issueTracker,
    linearHistory: workspace.config.linearHistory,
    ...(workspace.config.sourceControl ? { sourceControl: workspace.config.sourceControl } : {}),
    ...(workspace.config.mcpSkills ? { mcpSkills: workspace.config.mcpSkills } : {}),
    ...(workspace.config.worktrees ? { worktrees: workspace.config.worktrees } : {}),
    ...(workspace.workspaceLimit ? { concurrency: workspace.workspaceLimit } : {}),
  };

export const workspaceInfoOf = (
  workspace: RegisteredWorkspace,
  readyToMerge: ReadonlyArray<ReadyToMergeItem> = [],
) => ({
  id: workspace.config.id,
  displayName: workspace.config.displayName,
  checkoutPath: workspace.config.checkoutPath,
  issueTracker: workspace.config.issueTracker.type,
  record: workspaceRecordOf(workspace),
  contributions: workspace.contributions,
  readyToMerge,
});

export const workspaceStatesOf = (
  registry: RegistryState,
  readyToMerge: ReadonlyMap<string, ReadonlyArray<ReadyToMergeItem>> = new Map(),
) => [
  ...registry.workspaces.map((workspace) =>
    workspaceStateFromInfo(workspaceInfoOf(workspace, readyToMerge.get(workspace.config.id))),
  ),
  ...registry.failures.map(workspaceFailureState),
];

const runsIn = (state: SchedulerState, workspace: WorkspaceId) =>
  [...state.startedRuns.values()].filter((runWorkspace) => runWorkspace === workspace).length;

const workspaceLoadsOf = (registry: RegistryState, config: SchedulerConfig, state: SchedulerState) => [
  ...registry.workspaces.map((workspace) => ({
    id: workspace.config.id,
    displayName: workspace.config.displayName,
    inFlight: runsIn(state, workspace.config.id),
    limit: workspace.workspaceLimit ?? config.perWorkspaceLimit,
  })),
  ...registry.failures.flatMap((failure) => {
    if (failure.id === undefined) return [];
    return [
      {
        id: failure.id,
        displayName: failure.displayName,
        inFlight: runsIn(state, failure.id),
        limit: failure.workspaceLimit ?? config.perWorkspaceLimit,
      },
    ];
  }),
];

const budgetChargedToRuns = (state: SchedulerState) =>
  Math.max(0, state.budgetUsed - (state.global - state.startedRuns.size));

export const schedulerStatsOf = (
  registry: RegistryState,
  config: SchedulerConfig,
  state: SchedulerState,
): SchedulerStats => ({
  scheduling: state.paused ? "paused" : "running",
  globalInFlight: state.startedRuns.size,
  globalLimit: config.globalLimit,
  perWorkspaceLimit: config.perWorkspaceLimit,
  dailyBudgetUsed: budgetChargedToRuns(state),
  dailyBudgetLimit: config.dailyBudget,
  perWorkspace: workspaceLoadsOf(registry, config, state),
});
