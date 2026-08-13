import type { ActionableItem, ClassifiedItem, SchedulerStats } from "@cogwork/contracts";
import { workspaceFailureState, workspaceStateFromInfo } from "@cogwork/contracts";
import { classifiedItemOf, type EligibleWork } from "./classify";
import type { ObservedItem } from "./issue-tracker";
import type { RegisteredWorkspace, RegistryState } from "./projector";
import type { ReconcileSnapshot, WorkspaceReconcileState } from "./reconcile";
import type { SchedulerConfig, SchedulerState } from "./scheduler";

const okPoll = { status: "ok" as const };

const actionableOf = (work: EligibleWork): ActionableItem => ({
  id: work.id,
  title: work.title,
  stage: work.stage,
  ...(work.pr ? { pr: work.pr } : {}),
});

export const classifiedItemsOf = (state: WorkspaceReconcileState): ReadonlyArray<ClassifiedItem> => [
  ...state.eligible.map((work) => ({ _tag: "Eligible" as const, ...actionableOf(work) })),
  ...state.claimed.map((item) => ({ _tag: "Claimed" as const, ...item })),
  ...state.blocked.map((item) => ({ _tag: "Blocked" as const, ...item })),
  ...state.needsHuman.map((item) => ({ _tag: "NeedsHuman" as const, ...item })),
];

export const classifiedItemWithPr = (item: ObservedItem): ClassifiedItem | null => classifiedItemOf(item);

export const workspaceInfoOf = (
  workspace: RegisteredWorkspace,
  state: WorkspaceReconcileState | undefined,
) => ({
  name: workspace.config.name,
  checkoutPath: workspace.config.checkoutPath,
  issueTracker: workspace.config.issueTracker.type,
  harness: workspace.config.harness.preferred,
  poll: state?.poll ?? okPoll,
  eligible: (state?.eligible ?? []).map(actionableOf),
  claimed: state?.claimed ?? [],
  blocked: state?.blocked ?? [],
  needsHuman: state?.needsHuman ?? [],
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

export const schedulerStatsOf = (config: SchedulerConfig, state: SchedulerState): SchedulerStats => ({
  scheduling: state.paused ? "paused" : "running",
  globalInFlight: state.global,
  globalLimit: config.globalLimit,
  dailyBudgetUsed: state.budgetUsed,
  dailyBudgetLimit: config.dailyBudget,
  perWorkspace: [...state.perWorkspace].map(([name, inFlight]) => ({ name, inFlight })),
});
