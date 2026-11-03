import type { Board, ReadModelItem, WorkspaceId } from "@cogwork/contracts";

export interface AttentionEntry {
  readonly workspace: WorkspaceId;
  readonly item: ReadModelItem;
}

export const attentionEntries = (board: Board): ReadonlyArray<AttentionEntry> =>
  [...board.items.values()]
    .map(({ workspace, item }) => ({ workspace, item }))
    .toSorted((left, right) => left.item.pr.waitingSinceMillis - right.item.pr.waitingSinceMillis);

export const filterAttention = (
  entries: ReadonlyArray<AttentionEntry>,
  selectedWorkspaces: ReadonlySet<string>,
) => entries.filter((entry) => selectedWorkspaces.size === 0 || selectedWorkspaces.has(entry.workspace));
