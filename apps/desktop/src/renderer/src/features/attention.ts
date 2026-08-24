import type {
  Board,
  ClassifiedItem,
  IssueTrackerType,
  NeedsHumanReason,
  PrSummary,
  WorkspaceId,
} from "@cogwork/contracts";

export type AttentionKind = "needs-decision" | "ready-to-merge";
export type AttentionKindFilter = "all" | AttentionKind;

interface AttentionEntryBase {
  readonly workspace: WorkspaceId;
  readonly item: ClassifiedItem;
  readonly kind: AttentionKind;
}

export interface ReadyToMergeAttentionEntry extends AttentionEntryBase {
  readonly kind: "ready-to-merge";
  readonly pr: PrSummary;
}

export interface NeedsDecisionAttentionEntry extends AttentionEntryBase {
  readonly kind: "needs-decision";
  readonly reason: NeedsHumanReason;
  readonly url: string | null;
  readonly tracker: IssueTrackerType | null;
}

export type AttentionEntry = ReadyToMergeAttentionEntry | NeedsDecisionAttentionEntry;

const trackerFor = (board: Board, workspace: WorkspaceId): IssueTrackerType | null => {
  const state = board.workspaces.get(workspace);
  if (state?._tag !== "Registered") return null;
  return state.issueTracker;
};

const byUrgency = (left: AttentionEntry, right: AttentionEntry) => {
  if (left.kind === "needs-decision" && right.kind === "ready-to-merge") return -1;
  if (left.kind === "ready-to-merge" && right.kind === "needs-decision") return 1;
  if (left.kind !== "ready-to-merge" || right.kind !== "ready-to-merge") return 0;
  return left.pr.waitingSinceMillis - right.pr.waitingSinceMillis;
};

const attentionEntryFor = (
  board: Board,
  workspace: WorkspaceId,
  item: ClassifiedItem,
): ReadonlyArray<AttentionEntry> => {
  const tracker = trackerFor(board, workspace);
  const pr = item.pr;
  if (pr?.review === "ready") {
    return [
      {
        workspace,
        item,
        kind: "ready-to-merge" as const,
        pr,
      },
    ];
  }
  if (item._tag !== "NeedsHuman") return [];
  return [
    {
      workspace,
      item,
      kind: "needs-decision" as const,
      reason: item.reason,
      url: item.url,
      tracker,
    },
  ];
};

export const attentionEntries = (board: Board): ReadonlyArray<AttentionEntry> =>
  [...board.items.values()]
    .flatMap(({ workspace, item }) => attentionEntryFor(board, workspace, item))
    .toSorted(byUrgency);

export const attentionCounts = (
  entries: ReadonlyArray<AttentionEntry>,
): Record<AttentionKindFilter, number> => ({
  all: entries.length,
  "needs-decision": entries.filter((entry) => entry.kind === "needs-decision").length,
  "ready-to-merge": entries.filter((entry) => entry.kind === "ready-to-merge").length,
});

export const filterAttention = (
  entries: ReadonlyArray<AttentionEntry>,
  kind: AttentionKindFilter,
  selectedWorkspaces: ReadonlySet<string>,
) =>
  entries.filter(
    (entry) =>
      (kind === "all" || entry.kind === kind) &&
      (selectedWorkspaces.size === 0 || selectedWorkspaces.has(entry.workspace)),
  );
