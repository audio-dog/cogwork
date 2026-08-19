import { defaultSchedulerGlobalLimit } from "@cogwork/contracts";

export const settingsOfflineFallbacks = {
  globalConcurrency: defaultSchedulerGlobalLimit,
  // Engine uses globalLimit when a workspace has no concurrency override.
  perWorkspaceConcurrency: defaultSchedulerGlobalLimit,
  // Dollar budget is local-only until the persistence seam; no engine default to import.
  dailyBudgetDollars: 25,
} as const;

export const minConcurrency = 1;
