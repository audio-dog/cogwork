import type { ActionableItem, ClassifiedItem, SchedulerStats } from "@cogwork/contracts";
import { workspaceFailureState, workspaceStateFromInfo } from "@cogwork/contracts";
import { classifiedItemOf, type EligibleWork } from "./classify";
import type { ObservedItem } from "./issue-tracker";
import type { RegisteredWorkspace, RegistryState } from "./projector";
import type { ReconcileSnapshot, WorkspaceReconcileState } from "./reconcile";
import type { SchedulerConfig, SchedulerState } from "./scheduler";

const pendingPoll = { status: "pending" as const };

const actionableOf = (work: EligibleWork): ActionableItem => ({
  id: work.id,
  title: work.title,
  ...(work.url !== undefined ? { url: work.url } : {}),
  stage: work.stage,
  ...(work.pr ? { pr: work.pr } : {}),
});

export const classifiedItemsOf = (state: WorkspaceReconcileState): ReadonlyArray<ClassifiedItem> => [
  ...state.eligible.map((work) => ({ _tag: "Eligible", ...actionableOf(work) }) satisfies ClassifiedItem),
  ...state.claimed.map((item) => ({ _tag: "Claimed", ...item }) satisfies ClassifiedItem),
  ...state.blocked.map((item) => ({ _tag: "Blocked", ...item }) satisfies ClassifiedItem),
  ...state.needsHuman.map((item) => ({ _tag: "NeedsHuman", ...item }) satisfies ClassifiedItem),
  ...state.readyToMerge.map((item) => ({ _tag: "ReadyToMerge", ...item }) satisfies ClassifiedItem),
];

export const classifiedItemWithPr = (item: ObservedItem): ClassifiedItem | null => classifiedItemOf(item);

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

export const currentReconcileStatesOf = (registry: RegistryState, snapshot: ReconcileSnapshot) => {
  const names = new Set(registry.workspaces.map((workspace) => workspace.config.name));
  return snapshot.workspaces.filter((state) => names.has(state.name));
};

export const workspaceInfoOf = (
  workspace: RegisteredWorkspace,
  state: WorkspaceReconcileState | undefined,
) => ({
  name: workspace.config.name,
  ...(workspace.config.displayName ? { displayName: workspace.config.displayName } : {}),
  checkoutPath: workspace.config.checkoutPath,
  issueTracker: workspace.config.issueTracker.type,
  record: workspaceRecordOf(workspace),
  poll: state?.poll ?? pendingPoll,
  contributions: workspace.contributions,
  availability: state?.availability ?? [],
  eligible: (state?.eligible ?? []).map(actionableOf),
  claimed: state?.claimed ?? [],
  blocked: state?.blocked ?? [],
  needsHuman: state?.needsHuman ?? [],
  readyToMerge: state?.readyToMerge ?? [],
});

export const workspaceStatesOf = (registry: RegistryState, snapshot: ReconcileSnapshot) => {
  const stateByName = new Map(snapshot.workspaces.map((state) => [state.name, state] as const));
  return [
    ...registry.workspaces.map((workspace) =>
      workspaceStateFromInfo(workspaceInfoOf(workspace, stateByName.get(workspace.config.name))),
    ),
    ...registry.failures.map(workspaceFailureState),
  ];
};

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
