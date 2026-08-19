import {
  defaultSchedulerDailyBudget,
  defaultSchedulerGlobalLimit,
  defaultSchedulerPerWorkspaceLimit,
} from "@cogwork/contracts";

// Shown only while the daemon is unreachable, so the Engine settings still read sensibly. Once the
// board connects, the controls seed from the scheduler's real stats instead.
export const settingsOfflineFallbacks = {
  globalConcurrency: defaultSchedulerGlobalLimit,
  perWorkspaceConcurrency: defaultSchedulerPerWorkspaceLimit,
  // The engine's daily budget is a count of runs per day, not a dollar figure.
  dailyBudgetRuns: defaultSchedulerDailyBudget,
} as const;

export const minConcurrency = 1;
export const minDailyBudget = 1;
