import type { RunId, RunStatus, RunSummary, WorkItemId, WorkspaceId } from "@cogwork/contracts";

export type StateTone = "live" | "attention" | "ready" | "muted";

export interface ItemStateDescriptor {
  readonly label: string;
  readonly tone: StateTone;
  readonly running: boolean;
}

export function describeItemState(run: RunSummary | null): ItemStateDescriptor {
  if (run?.status === "running") {
    return { label: `Running · ${run.operation}`, tone: "live", running: true };
  }
  return { label: "Ready to merge", tone: "ready", running: false };
}

export type SubTabKey = "main" | "run" | "pr";

export interface SubTab {
  readonly key: SubTabKey;
  readonly label: string;
}

export const subTabs = (): readonly SubTab[] => [
  { key: "main", label: "Main" },
  { key: "run", label: "Live run" },
  { key: "pr", label: "Pull request" },
];

export const resolveSubTab = (active: SubTabKey, tabs: readonly SubTab[]): SubTabKey =>
  tabs.some((tab) => tab.key === active) ? active : "main";

export type AttemptTone = "succeeded" | "failed" | "abandoned";

export const attemptTone: Record<RunStatus, AttemptTone> = {
  running: "abandoned",
  succeeded: "succeeded",
  declined: "abandoned",
  failed: "failed",
  crashed: "failed",
  exhausted: "abandoned",
  interrupted: "abandoned",
};

export const previousAttempts = (
  runs: readonly RunSummary[],
  focalRunId: RunId | null,
): readonly RunSummary[] =>
  runs.filter((run) => run.id !== focalRunId).toSorted((a, b) => b.startedAtMillis - a.startedAtMillis);

export const selectedRunForItem = (
  selectedRun: RunSummary | null | undefined,
  workspace: WorkspaceId,
  workItem: WorkItemId,
) => (selectedRun?.workspace === workspace && selectedRun.workItem === workItem ? selectedRun : null);
