import type { Board, PrSummary, ReadModelItem, WorkspaceId } from "@cogwork/contracts";

export interface AttentionEntry {
  readonly workspace: WorkspaceId;
  readonly item: ReadModelItem;
  readonly kind: "ready-to-merge";
  readonly pr: PrSummary;
}

export const attentionEntries = (board: Board): ReadonlyArray<AttentionEntry> =>
  [...board.items.values()]
    .map(({ workspace, item }) => ({ workspace, item, kind: "ready-to-merge" as const, pr: item.pr }))
    .toSorted((left, right) => left.pr.waitingSinceMillis - right.pr.waitingSinceMillis);

export const filterAttention = (
  entries: ReadonlyArray<AttentionEntry>,
  selectedWorkspaces: ReadonlySet<string>,
) => entries.filter((entry) => selectedWorkspaces.size === 0 || selectedWorkspaces.has(entry.workspace));
