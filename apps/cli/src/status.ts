import type { DaemonStatus, SchedulerStats, WorkspaceInfo } from "@clanker-forge/contracts";

const section = (label: string, lines: ReadonlyArray<string>) =>
  lines.length === 0 ? [] : [`      ${label}:`, ...lines.map((line) => `        · ${line}`)];

const blockersLabel = (count: number) => `${count} open blocker${count === 1 ? "" : "s"}`;

const formatWorkspace = (workspace: WorkspaceInfo) => {
  const poll = workspace.poll.status === "paused" ? [`      paused: ${workspace.poll.message}`] : [];
  const eligible = section(
    "eligible",
    workspace.eligible.map((item) => `${item.stage} ${item.id} ${item.title}`),
  );
  const claimed = section(
    "claimed",
    workspace.claimed.map((item) => `${item.id} ${item.title} (by ${item.claim.by})`),
  );
  const blocked = section(
    "blocked",
    workspace.blocked.map((item) => `${item.id} ${item.title} (${blockersLabel(item.openBlockers)})`),
  );
  const needsHuman = section(
    "needs-human",
    workspace.needsHuman.map((item) => `${item.reason} ${item.id} ${item.title}`),
  );
  return [
    `  - ${workspace.name} [${workspace.workSource}/${workspace.harness}] ${workspace.checkoutPath}`,
    ...poll,
    ...eligible,
    ...claimed,
    ...blocked,
    ...needsHuman,
  ].join("\n");
};

const formatScheduler = (scheduler: SchedulerStats) => {
  const loads = scheduler.perWorkspace.map((load) => `${load.name}=${load.inFlight}`).join(" ");
  const suffix = loads.length === 0 ? "" : ` (${loads})`;
  return `scheduler: ${scheduler.globalInFlight}/${scheduler.globalLimit} in-flight · budget ${scheduler.dailyBudgetUsed}/${scheduler.dailyBudgetLimit}${suffix}`;
};

export const formatStatus = (status: DaemonStatus) => {
  const header = `daemon: ${status.health} (uptime ${Math.round(status.uptimeMillis / 1000)}s)`;
  const workspaces =
    status.workspaces.length === 0
      ? "  (no workspaces registered)"
      : status.workspaces.map(formatWorkspace).join("\n");
  const failures = status.failures.map((failure) => `  ! ${failure.source}: ${failure.message}`).join("\n");
  return [
    header,
    formatScheduler(status.scheduler),
    "workspaces:",
    workspaces,
    ...(status.failures.length > 0 ? ["failures:", failures] : []),
  ].join("\n");
};
