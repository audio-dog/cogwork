import {
  type ControlStore,
  type DaemonStatus,
  PollState,
  type SchedulerStats,
  type WorkspaceInfo,
} from "@cogwork/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const section = (label: string, lines: ReadonlyArray<string>) =>
  lines.length === 0 ? [] : [`      ${label}:`, ...lines.map((line) => `        · ${line}`)];

const blockersLabel = (count: number) => `${count} open blocker${count === 1 ? "" : "s"}`;

const proposalPreviewMax = 100;

const proposalPreview = (proposal: string | null) => {
  if (proposal === null) return "";
  const oneLine = proposal.replace(/\s+/g, " ").trim();
  if (oneLine.length <= proposalPreviewMax) return ` — ${oneLine}`;
  const preview = `${oneLine.slice(0, proposalPreviewMax - 1).trimEnd()}…`;
  return ` — ${preview}`;
};

const isoOrMillis = (millis: number) =>
  Option.match(DateTime.make(millis), { onNone: () => String(millis), onSome: DateTime.formatIso });

const pauseQualifier = (poll: Extract<PollState, { readonly status: "paused" }>) => {
  if (poll.reason !== "rate-limited") return " (needs attention)";
  if (poll.retryAtMillis === null) return " (self-healing)";
  return ` (self-healing, retrying after ${isoOrMillis(poll.retryAtMillis)})`;
};

const formatPoll = (poll: PollState) =>
  PollState.match(poll, {
    ok: () => [],
    pending: () => ["      poll: not yet run"],
    paused: (paused) => [`      paused: ${paused.reason}${pauseQualifier(paused)} — ${paused.message}`],
  });

const workspaceLabel = (workspace: { readonly name?: string; readonly displayName?: string }) => {
  if (workspace.name === undefined) return workspace.displayName ?? "";
  if (workspace.displayName === undefined) return workspace.name;
  return `${workspace.displayName} (${workspace.name})`;
};

const formatWorkspace = (workspace: WorkspaceInfo) => {
  const poll = formatPoll(workspace.poll);
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
    workspace.needsHuman.map(
      (item) => `${item.reason} ${item.id} ${item.title}${proposalPreview(item.proposal)}`,
    ),
  );
  const readyToMerge = section(
    "ready-to-merge",
    workspace.readyToMerge.map((item) => `${item.id} ${item.title} (PR #${item.pr.number})`),
  );
  return [
    `  - ${workspaceLabel(workspace)} [${workspace.issueTracker}] ${workspace.checkoutPath}`,
    ...poll,
    ...eligible,
    ...claimed,
    ...blocked,
    ...needsHuman,
    ...readyToMerge,
  ].join("\n");
};

const formatFailure = (failure: DaemonStatus["failures"][number]) => {
  const label = workspaceLabel(failure);
  const workspace = label.length === 0 ? "" : `${label} · `;
  return `  ! ${workspace}${failure.source}: ${failure.message}`;
};

export const formatScheduler = (scheduler: SchedulerStats) => {
  const loads = scheduler.perWorkspace.map((load) => `${load.name}=${load.inFlight}/${load.limit}`).join(" ");
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
