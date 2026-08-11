import type { DaemonStatus, PollState, SchedulerStats, WorkspaceInfo } from "@clanker-forge/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const section = (label: string, lines: ReadonlyArray<string>) =>
  lines.length === 0 ? [] : [`      ${label}:`, ...lines.map((line) => `        · ${line}`)];

const blockersLabel = (count: number) => `${count} open blocker${count === 1 ? "" : "s"}`;

const proposalPreviewMax = 100;

const proposalPreview = (proposal: string | null) => {
  if (proposal === null) return "";
  const oneLine = proposal.replace(/\s+/g, " ").trim();
  const preview =
    oneLine.length <= proposalPreviewMax ? oneLine : `${oneLine.slice(0, proposalPreviewMax - 1).trimEnd()}…`;
  return ` — ${preview}`;
};

const isoOrMillis = (millis: number) =>
  Option.match(DateTime.make(millis), { onNone: () => String(millis), onSome: DateTime.formatIso });

const pauseQualifier = (poll: Extract<PollState, { readonly status: "paused" }>) => {
  if (poll.reason !== "rate-limited") return " (needs attention)";
  return poll.retryAtMillis === null
    ? " (self-healing)"
    : ` (self-healing, retrying after ${isoOrMillis(poll.retryAtMillis)})`;
};

const formatPoll = (poll: PollState) =>
  poll.status === "ok" ? [] : [`      paused: ${poll.reason}${pauseQualifier(poll)} — ${poll.message}`];

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
  return [
    `  - ${workspace.name} [${workspace.issueTracker}/${workspace.harness}] ${workspace.checkoutPath}`,
    ...poll,
    ...eligible,
    ...claimed,
    ...blocked,
    ...needsHuman,
  ].join("\n");
};

export const formatScheduler = (scheduler: SchedulerStats) => {
  const loads = scheduler.perWorkspace.map((load) => `${load.name}=${load.inFlight}`).join(" ");
  const suffix = loads.length === 0 ? "" : ` (${loads})`;
  const paused = scheduler.scheduling === "paused" ? " · paused" : "";
  return `scheduler: ${scheduler.globalInFlight}/${scheduler.globalLimit} in-flight · budget ${scheduler.dailyBudgetUsed}/${scheduler.dailyBudgetLimit}${paused}${suffix}`;
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
