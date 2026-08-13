import {
  type Board,
  type ClassifiedItem,
  itemKey,
  type NeedsHumanReason,
  type PrSummary,
  type RunSummary,
  type WorkItemId,
  type WorkspaceId,
} from "@clanker-forge/contracts";

export const needsHumanReasonLabel: Record<NeedsHumanReason, string> = {
  "needs-info": "Needs info",
  "ready-for-human": "Ready for human",
};

export interface FeedRun {
  readonly run: RunSummary;
  readonly title: string | null;
}

export interface FeedItem {
  readonly workspace: WorkspaceId;
  readonly item: ClassifiedItem;
}

export interface QueuedItem {
  readonly workspace: WorkspaceId;
  readonly item: Extract<ClassifiedItem, { _tag: "Eligible" }>;
}

export interface MergeGateItem {
  readonly workspace: WorkspaceId;
  readonly item: ClassifiedItem;
  readonly pr: PrSummary;
}

const terminalStatuses: ReadonlySet<RunSummary["status"]> = new Set([
  "succeeded",
  "failed",
  "exhausted",
  "interrupted",
  "crashed",
]);

const inWorkspace = (filter: WorkspaceId | null, workspace: WorkspaceId) =>
  filter === null || filter === workspace;

const titleFor = (board: Board, run: RunSummary) =>
  board.items.get(itemKey(run.workspace, run.workItem))?.item.title ?? null;

const runs = (board: Board, filter: WorkspaceId | null) =>
  [...board.runs.values()].filter((run) => inWorkspace(filter, run.workspace));

export const workspaceItems = (board: Board, filter: WorkspaceId | null): FeedItem[] =>
  [...board.items.values()].filter(({ workspace }) => inWorkspace(filter, workspace));

export const registeredWorkspaces = (board: Board): WorkspaceId[] =>
  [...board.workspaces.values()]
    .filter((state) => state._tag === "Registered")
    .map((state) => state.name)
    .sort();

export const runningRuns = (board: Board, filter: WorkspaceId | null): FeedRun[] =>
  runs(board, filter)
    .filter((run) => run.status === "running")
    .sort((a, b) => a.startedAtMillis - b.startedAtMillis)
    .map((run) => ({ run, title: titleFor(board, run) }));

export const recentlyDone = (board: Board, filter: WorkspaceId | null, limit = 8): FeedRun[] =>
  runs(board, filter)
    .filter((run) => terminalStatuses.has(run.status))
    .sort((a, b) => (b.endedAtMillis ?? 0) - (a.endedAtMillis ?? 0))
    .slice(0, limit)
    .map((run) => ({ run, title: titleFor(board, run) }));

export const queuedItems = (board: Board, filter: WorkspaceId | null): QueuedItem[] =>
  workspaceItems(board, filter).filter((entry): entry is QueuedItem => entry.item._tag === "Eligible");

export const blockedCount = (board: Board, filter: WorkspaceId | null): number =>
  workspaceItems(board, filter).filter(({ item }) => item._tag === "Blocked").length;

export const selfHalts = (board: Board, filter: WorkspaceId | null): FeedItem[] =>
  workspaceItems(board, filter).filter(({ item }) => item._tag === "NeedsHuman");

export const boardItem = (board: Board, workspace: WorkspaceId, workItem: WorkItemId) =>
  board.items.get(itemKey(workspace, workItem)) ?? null;

export const runForItem = (board: Board, workspace: WorkspaceId, workItem: WorkItemId) => {
  const forItem = [...board.runs.values()].filter(
    (run) => run.workspace === workspace && run.workItem === workItem,
  );
  const live = forItem.find((run) => run.status === "running");
  if (live) return live;
  return forItem.sort((a, b) => b.startedAtMillis - a.startedAtMillis)[0] ?? null;
};

export const mergeGate = (board: Board, filter: WorkspaceId | null): MergeGateItem[] =>
  workspaceItems(board, filter)
    .filter(
      (entry): entry is FeedItem & { item: ClassifiedItem & { pr: PrSummary } } =>
        entry.item.pr?.review === "ready",
    )
    .map(({ workspace, item }) => ({ workspace, item, pr: item.pr }))
    .sort((a, b) => a.pr.waitingSinceMillis - b.pr.waitingSinceMillis);

export const itemsWithPr = (board: Board, filter: WorkspaceId | null): FeedItem[] =>
  workspaceItems(board, filter).filter((entry) => entry.item.pr !== undefined);

export const claimedItems = (board: Board, filter: WorkspaceId | null): FeedItem[] =>
  workspaceItems(board, filter).filter((entry) => entry.item._tag === "Claimed");
