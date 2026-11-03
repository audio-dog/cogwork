import type {
  BoardItem,
  PrSummary,
  RunId,
  RunStatus,
  RunSummary,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { runStatusLabel } from "./run-status";

export type StateTone = "live" | "ready" | "muted";

export interface ItemStateDescriptor {
  readonly label: string;
  readonly tone: StateTone;
  readonly running: boolean;
}

export interface ItemTabSubject {
  readonly id: WorkItemId;
  readonly title: string;
  readonly url: string | null;
  readonly pr: PrSummary | null;
}

export const itemTabSubject = (entry: BoardItem | null, workItem: WorkItemId) =>
  entry
    ? ({
        id: entry.item.id,
        title: entry.item.title,
        url: entry.item.url ?? null,
        pr: entry.item.pr,
      } satisfies ItemTabSubject)
    : ({ id: workItem, title: workItem, url: null, pr: null } satisfies ItemTabSubject);

const settledItemState = (run: RunSummary | null, subject: ItemTabSubject) =>
  subject.pr
    ? ({ label: "Ready to merge", tone: "ready", running: false } satisfies ItemStateDescriptor)
    : ({
        label: run ? runStatusLabel[run.status] : "No Runs",
        tone: "muted",
        running: false,
      } satisfies ItemStateDescriptor);

export const describeItemState = (run: RunSummary | null, subject: ItemTabSubject) =>
  run?.status === "running"
    ? ({ label: `Running · ${run.operation}`, tone: "live", running: true } satisfies ItemStateDescriptor)
    : settledItemState(run, subject);

export type SubTabKey = "main" | "run" | "pr";

export interface SubTab {
  readonly key: SubTabKey;
  readonly label: string;
}

const allSubTabs: readonly SubTab[] = [
  { key: "main", label: "Main" },
  { key: "run", label: "Live run" },
  { key: "pr", label: "Pull request" },
];

export const subTabsFor = (subject: ItemTabSubject) =>
  allSubTabs.filter(({ key }) => key !== "pr" || subject.pr !== null);

export const resolveSubTab = (active: SubTabKey, tabs: readonly SubTab[]) =>
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

export const previousAttempts = (runs: readonly RunSummary[], focalRunId: RunId | null) =>
  runs.filter((run) => run.id !== focalRunId).toSorted((a, b) => b.startedAtMillis - a.startedAtMillis);

export const selectedRunForItem = (
  selectedRun: RunSummary | null | undefined,
  workspace: WorkspaceId,
  workItem: WorkItemId,
) => (selectedRun?.workspace === workspace && selectedRun.workItem === workItem ? selectedRun : null);
