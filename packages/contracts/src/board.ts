import type { WorkspaceId } from "./base-schemas";
import type { SchedulerStats } from "./daemon";
import { type ClassifiedItem, DaemonEvent } from "./daemon-event";
import type { RunSummary } from "./run";

export interface BoardItem {
  readonly workspace: WorkspaceId;
  readonly item: ClassifiedItem;
}

export interface Board {
  readonly items: ReadonlyMap<string, BoardItem>;
  readonly runs: ReadonlyMap<string, RunSummary>;
  readonly scheduler: SchedulerStats | null;
}

export const initialBoard: Board = { items: new Map(), runs: new Map(), scheduler: null };

export const itemKey = (workspace: WorkspaceId, id: string) => `${workspace}::${id}`;

const withoutItem = (items: ReadonlyMap<string, BoardItem>, key: string) =>
  new Map([...items].filter(([entryKey]) => entryKey !== key));

export const applyDaemonEvent = (board: Board, event: DaemonEvent): Board =>
  DaemonEvent.match(event, {
    RunActivity: () => board,
    ItemChanged: ({ workspace, item }) => ({
      ...board,
      items: new Map(board.items).set(itemKey(workspace, item.id), { workspace, item }),
    }),
    ItemRemoved: ({ workspace, id }) => ({
      ...board,
      items: withoutItem(board.items, itemKey(workspace, id)),
    }),
    RunChanged: ({ run }) => ({ ...board, runs: new Map(board.runs).set(run.id, run) }),
    SchedulerChanged: ({ scheduler }) => ({ ...board, scheduler }),
  });
