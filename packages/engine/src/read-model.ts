import type { ClassifiedItem, PrSummary, SchedulerStats, WorkItemId } from "@clanker-forge/contracts";
import { classifiedItemOf } from "./classify";
import type { ObservedPr } from "./follow-up";
import type { ObservedItem } from "./issue-tracker";
import type { WorkspaceReconcileState } from "./reconcile";
import type { SchedulerConfig, SchedulerState } from "./scheduler";

export const prSummaryOf = (pr: ObservedPr): PrSummary => ({
  number: pr.number,
  url: pr.url,
  checks: pr.checks,
  review: pr.review,
  baseDivergence: pr.baseDivergence,
  waitingSinceMillis: pr.waitingSinceMillis,
});

export const prByItem = (state: WorkspaceReconcileState | undefined) =>
  new Map<WorkItemId, PrSummary>(
    (state?.observed ?? []).flatMap((item) => (item.pr ? [[item.id, prSummaryOf(item.pr)] as const] : [])),
  );

export const withPr =
  (prs: ReadonlyMap<WorkItemId, PrSummary>) =>
  <T extends { readonly id: WorkItemId }>(item: T) => {
    const pr = prs.get(item.id);
    return pr === undefined ? item : { ...item, pr };
  };

export const classifiedItemWithPr = (item: ObservedItem): ClassifiedItem | null => {
  const classified = classifiedItemOf(item);
  if (classified === null) return null;
  return item.pr ? { ...classified, pr: prSummaryOf(item.pr) } : classified;
};

export const classifiedItemsOf = (state: WorkspaceReconcileState): ReadonlyArray<ClassifiedItem> => {
  const attach = withPr(prByItem(state));
  return [
    ...state.eligible.map((work) =>
      attach({ _tag: "Eligible" as const, id: work.id, title: work.title, stage: work.stage }),
    ),
    ...state.claimed.map((item) =>
      attach({ _tag: "Claimed" as const, id: item.id, title: item.title, claim: item.claim }),
    ),
    ...state.blocked.map((item) =>
      attach({ _tag: "Blocked" as const, id: item.id, title: item.title, openBlockers: item.openBlockers }),
    ),
    ...state.needsHuman.map((item) =>
      attach({
        _tag: "NeedsHuman" as const,
        id: item.id,
        title: item.title,
        reason: item.reason,
        proposal: item.proposal,
      }),
    ),
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
