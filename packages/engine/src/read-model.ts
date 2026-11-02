import type { ReadyToMergeItem, SchedulerStats } from "@cogwork/contracts";
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
  const artifacts = yield* (artifactStore.all ?? Effect.succeed([])).pipe(
    Effect.catchTag("ControlStoreFailure", (error) =>
      Effect.logWarning("Ready to merge artifacts unavailable", { message: error.message }).pipe(
        Effect.map(() => []),
      ),
    ),
  );
  const sourceControl = yield* SourceControlProvider;
  const entries = yield* Effect.forEach(registry.workspaces, (workspace) =>
    (
      sourceControl.readyToMerge?.(
        workspace,
        artifacts.filter((artifact) => artifact.workspace === workspace.config.name),
      ) ?? Effect.succeed([])
    ).pipe(
      Effect.catchTag("IssueTrackerError", (error) =>
        Effect.logWarning("Ready to merge read failed", {
          workspace: workspace.config.name,
          message: error.message,
        }).pipe(Effect.map(() => [] as ReadonlyArray<ReadyToMergeItem>)),
      ),
      Effect.map((items) => [workspace.config.name, items] as const),
    ),
  );
  return new Map(entries);
});

const workspaceRecordOf = (workspace: RegisteredWorkspace) =>
  workspace.record ?? {
    name: workspace.config.displayName ?? workspace.config.name,
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
  name: workspace.config.name,
  ...(workspace.config.displayName ? { displayName: workspace.config.displayName } : {}),
  checkoutPath: workspace.config.checkoutPath,
  issueTracker: workspace.config.issueTracker.type,
  record: workspaceRecordOf(workspace),
  poll: { status: "ok" as const },
  contributions: workspace.contributions,
  availability: [],
  readyToMerge,
});

export const workspaceStatesOf = (
  registry: RegistryState,
  readyToMerge: ReadonlyMap<string, ReadonlyArray<ReadyToMergeItem>> = new Map(),
) => [
  ...registry.workspaces.map((workspace) =>
    workspaceStateFromInfo(workspaceInfoOf(workspace, readyToMerge.get(workspace.config.name))),
  ),
  ...registry.failures.map(workspaceFailureState),
];

const workspaceLoadsOf = (registry: RegistryState, config: SchedulerConfig, state: SchedulerState) => [
  ...registry.workspaces.map((workspace) => ({
    name: workspace.config.name,
    inFlight: state.perWorkspace.get(workspace.config.name) ?? 0,
    limit: workspace.workspaceLimit ?? config.perWorkspaceLimit,
  })),
  ...registry.failures.flatMap((failure) => {
    if (failure.name === undefined) return [];
    return [
      {
        name: failure.name,
        inFlight: state.perWorkspace.get(failure.name) ?? 0,
        limit: failure.workspaceLimit ?? config.perWorkspaceLimit,
      },
    ];
  }),
];

export const schedulerStatsOf = (
  registry: RegistryState,
  config: SchedulerConfig,
  state: SchedulerState,
): SchedulerStats => ({
  scheduling: state.paused ? "paused" : "running",
  globalInFlight: state.global,
  globalLimit: config.globalLimit,
  perWorkspaceLimit: config.perWorkspaceLimit,
  dailyBudgetUsed: state.budgetUsed,
  dailyBudgetLimit: config.dailyBudget,
  perWorkspace: workspaceLoadsOf(registry, config, state),
});
