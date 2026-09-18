import {
  ClassifiedItem,
  type LifecycleStage,
  type RunId,
  type RunStatus,
  type RunSummary,
  type WorkItemId,
  type WorkspaceId,
} from "@cogwork/contracts";

export type StateTone = "live" | "attention" | "ready" | "muted";

export interface ItemStateDescriptor {
  readonly label: string;
  readonly tone: StateTone;
  readonly running: boolean;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const calmDescriptor = (verb: "Queued" | "Working", stage: LifecycleStage | null): ItemStateDescriptor => {
  return { label: stage ? `${verb} · ${stage}` : verb, tone: "muted", running: false };
};

export function describeItemState(item: ClassifiedItem, run: RunSummary | null): ItemStateDescriptor {
  if (run?.status === "running") {
    return { label: `Running · ${run.stage}`, tone: "live", running: true };
  }
  return ClassifiedItem.match(item, {
    NeedsHuman: ({ reason }) => ({
      label: `Needs a decision · ${reason}`,
      tone: "attention",
      running: false,
    }),
    Blocked: ({ openBlockers }) => ({
      label: `Blocked · ${plural(openBlockers, "open blocker")}`,
      tone: "muted",
      running: false,
    }),
    ReadyToMerge: () => ({ label: "Ready to merge", tone: "ready", running: false }),
    Eligible: (eligible) => calmDescriptor("Queued", eligible.stage),
    Claimed: (claimed) => calmDescriptor("Working", claimed.claim.stage ?? null),
  });
}

export type SubTabKey = "main" | "run" | "pr";

export interface SubTab {
  readonly key: SubTabKey;
  readonly label: string;
}

export const subTabs = (hasPr: boolean): readonly SubTab[] => [
  { key: "main", label: "Main" },
  { key: "run", label: "Live run" },
  ...(hasPr ? [{ key: "pr" as const, label: "Pull request" }] : []),
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
