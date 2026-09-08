import type { ControlStore, DaemonLimits } from "./daemon";

export const defaultSchedulerGlobalLimit = 4;
export const defaultSchedulerPerWorkspaceLimit = 4;
export const defaultSchedulerDailyBudget = 50;

export const defaultDaemonLimits: DaemonLimits = {
  globalConcurrency: defaultSchedulerGlobalLimit,
  perWorkspaceConcurrency: defaultSchedulerPerWorkspaceLimit,
  dailyBudget: defaultSchedulerDailyBudget,
  revision: 0,
};

export const defaultControlStore: ControlStore = {
  daemonLimits: defaultDaemonLimits,
  connections: [],
  harnessSettings: [],
  operationSettings: [],
  pluginInstalls: [],
  contributionSettings: [],
};
