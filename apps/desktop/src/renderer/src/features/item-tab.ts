import type { ClassifiedItem, LifecycleStage, RunId, RunStatus, RunSummary } from "@cogwork/contracts";

// The header state chip: a content-hugging summary of where the item stands.
// Tones follow the spec palette — live = primary, attention = amber,
// ready = emerald, muted = everything calm (blocked, queued, claimed).
export type StateTone = "live" | "attention" | "ready" | "muted";

export interface ItemStateDescriptor {
  readonly label: string;
  readonly tone: StateTone;
  readonly running: boolean;
}

const stageOf = (item: ClassifiedItem): LifecycleStage | null => {
  switch (item._tag) {
    case "Eligible":
      return item.stage;
    case "Claimed":
      return item.claim.stage ?? null;
    default:
      return null;
  }
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

// A live run wins over the item's resting classification — a running item reads
// "Running · {stage}" whatever its tag. Otherwise the tag decides the chip.
export function describeItemState(item: ClassifiedItem, run: RunSummary | null): ItemStateDescriptor {
  if (run?.status === "running") {
    return { label: `Running · ${run.stage}`, tone: "live", running: true };
  }
  switch (item._tag) {
    case "NeedsHuman":
      return { label: `Needs a decision · ${item.reason}`, tone: "attention", running: false };
    case "Blocked":
      return {
        label: `Blocked · ${plural(item.openBlockers, "open blocker")}`,
        tone: "muted",
        running: false,
      };
    default: {
      if (item.pr?.review === "ready") {
        return { label: "Ready to merge", tone: "ready", running: false };
      }
      const stage = stageOf(item);
      const verb = item._tag === "Eligible" ? "Queued" : "Working";
      return { label: stage ? `${verb} · ${stage}` : verb, tone: "muted", running: false };
    }
  }
}

// The sub-tab strip. Live run is always present (it holds the transcript, live
// or replayed); Pull request only shows when the item has one.
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

// When the active sub-tab vanishes (e.g. the PR is gone) fall back to Main.
export const resolveSubTab = (active: SubTabKey, tabs: readonly SubTab[]): SubTabKey =>
  tabs.some((tab) => tab.key === active) ? active : "main";

export type AttemptTone = "succeeded" | "failed" | "abandoned";

export const attemptTone: Record<RunStatus, AttemptTone> = {
  running: "abandoned",
  succeeded: "succeeded",
  failed: "failed",
  crashed: "failed",
  exhausted: "abandoned",
  interrupted: "abandoned",
};

// Everything but the focal run, newest first — the collapsed attempt history
// under the focal (latest/live) run.
export const previousAttempts = (
  runs: readonly RunSummary[],
  focalRunId: RunId | null,
): readonly RunSummary[] =>
  runs.filter((run) => run.id !== focalRunId).toSorted((a, b) => b.startedAtMillis - a.startedAtMillis);
