import {
  type ClassifiedItem,
  DaemonEvent,
  type RunSummary,
  type SchedulerStats,
  type WorkspaceId,
} from "@clanker-forge/contracts";

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

const itemKey = (workspace: WorkspaceId, id: string) => `${workspace}::${id}`;

export const applyDaemonEvent = (board: Board, event: DaemonEvent): Board =>
  DaemonEvent.match(event, {
    RunActivity: () => board,
    ItemChanged: ({ workspace, item }) => ({
      ...board,
      items: new Map(board.items).set(itemKey(workspace, item.id), { workspace, item }),
    }),
    RunChanged: ({ run }) => ({ ...board, runs: new Map(board.runs).set(run.id, run) }),
    SchedulerChanged: ({ scheduler }) => ({ ...board, scheduler }),
  });
