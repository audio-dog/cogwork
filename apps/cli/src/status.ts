import {
  type ControlStore,
  type DaemonStatus,
  type SchedulerStats,
  type WorkspaceId,
  type WorkspaceInfo,
  workspaceLabel,
} from "@cogwork/contracts";
import { readyToMergeText } from "./read-model-item";
import { terminalLine } from "./terminal-text";

const section = (label: string, lines: ReadonlyArray<string>) =>
  lines.length === 0 ? [] : [`      ${label}:`, ...lines.map((line) => `        · ${line}`)];

const labelWithId = (workspace: { readonly id: WorkspaceId; readonly displayName?: string }) => {
  const label = workspaceLabel(workspace);
  return label === workspace.id ? label : `${label} (${workspace.id})`;
};

const formatWorkspace = (workspace: WorkspaceInfo) => {
  const readyToMerge = section(
    "ready-to-merge",
    workspace.readyToMerge.map((item) => terminalLine(readyToMergeText(item))),
  );
  return [
    `  - ${terminalLine(labelWithId(workspace))} [${workspace.issueTracker}] ${workspace.checkoutPath}`,
    ...readyToMerge,
  ].join("\n");
};

const formatFailure = (failure: DaemonStatus["failures"][number]) => {
  const label =
    failure.id === undefined
      ? failure.displayName
      : labelWithId({ id: failure.id, displayName: failure.displayName });
  const workspace = label === undefined ? "" : `${terminalLine(label)} · `;
  return `  ! ${workspace}${failure.source}: ${failure.message}`;
};

export const formatScheduler = (scheduler: SchedulerStats) => {
  const loads = scheduler.perWorkspace
    .map((load) => `${terminalLine(workspaceLabel(load))}=${load.inFlight}/${load.limit}`)
    .join(" ");
  const suffix = loads.length === 0 ? "" : ` (${loads})`;
  const paused = scheduler.scheduling === "paused" ? " · paused" : "";
  return `scheduler: ${scheduler.globalInFlight}/${scheduler.globalLimit} in-flight · budget ${scheduler.dailyBudgetUsed}/${scheduler.dailyBudgetLimit}${paused}${suffix}`;
};

const daemonLimitLines = (controlStore: ControlStore) => [
  `global-concurrency: ${controlStore.daemonLimits.globalConcurrency}`,
  `per-workspace-concurrency: ${controlStore.daemonLimits.perWorkspaceConcurrency}`,
  `daily-budget: ${controlStore.daemonLimits.dailyBudget}`,
];

export const formatDaemonLimits = (controlStore: ControlStore) => daemonLimitLines(controlStore).join("\n");

const formatControlStore = (controlStore: ControlStore) =>
  ["control store:", "  daemon limits:", ...daemonLimitLines(controlStore).map((line) => `    ${line}`)].join(
    "\n",
  );

export const formatStatus = (status: DaemonStatus) => {
  const header = `daemon: ${status.health} (uptime ${Math.round(status.uptimeMillis / 1000)}s)`;
  const workspaces =
    status.workspaces.length === 0
      ? "  (no workspaces registered)"
      : status.workspaces.map(formatWorkspace).join("\n");
  const failures = status.failures.map(formatFailure).join("\n");
  return [
    header,
    formatScheduler(status.scheduler),
    ...(status.eventBusDroppedEvents === 0
      ? []
      : [`event bus: ${status.eventBusDroppedEvents} dropped events`]),
    "workspaces:",
    workspaces,
    ...(status.failures.length > 0 ? ["failures:", failures] : []),
  ].join("\n");
};

export const formatStatusWithStore = (status: DaemonStatus, controlStore: ControlStore) =>
  [formatStatus(status), formatControlStore(controlStore)].join("\n");

export const formatOfflineStatus = (controlStore: ControlStore) =>
  [
    "daemon: needs a daemon",
    formatControlStore(controlStore),
    "scheduler: needs a daemon",
    "workspace state: needs a daemon",
    "availability: needs a daemon",
  ].join("\n");
