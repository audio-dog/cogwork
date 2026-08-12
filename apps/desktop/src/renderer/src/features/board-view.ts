import {
  type Board,
  type ClassifiedItem,
  type WorkspaceId,
  type WorkspaceState,
  workspaceKey,
} from "@clanker-forge/contracts";
import { type FeedItem, workspaceItems } from "./feed";

export type BoardColumnId =
  | "needs-triage"
  | "ready-for-agent"
  | "working"
  | "in-review"
  | "needs-you"
  | "blocked";

export interface BoardColumnMeta {
  readonly id: BoardColumnId;
  readonly label: string;
}

export const boardColumnOrder: ReadonlyArray<BoardColumnMeta> = [
  { id: "needs-triage", label: "Needs triage" },
  { id: "ready-for-agent", label: "Ready for agent" },
  { id: "working", label: "Working" },
  { id: "in-review", label: "In review" },
  { id: "needs-you", label: "Needs you" },
  { id: "blocked", label: "Blocked" },
];

export const boardColumnOf = (item: ClassifiedItem): BoardColumnId => {
  switch (item._tag) {
    case "NeedsHuman":
      return "needs-you";
    case "Blocked":
      return "blocked";
    case "Claimed":
      return "working";
    case "Eligible":
      if (item.stage === "triage") return "needs-triage";
      if (item.stage === "implement") return "ready-for-agent";
      return "in-review";
  }
};

export interface BoardColumn extends BoardColumnMeta {
  readonly items: ReadonlyArray<FeedItem>;
}

export const boardColumns = (board: Board, filter: WorkspaceId | null): ReadonlyArray<BoardColumn> => {
  const entries = workspaceItems(board, filter);
  return boardColumnOrder.map((meta) => ({
    ...meta,
    items: entries.filter((entry) => boardColumnOf(entry.item) === meta.id),
  }));
};

export interface LaneColumn extends BoardColumnMeta {
  readonly count: number;
  readonly items: ReadonlyArray<FeedItem>;
}

export interface Lane {
  readonly key: string;
  readonly state: WorkspaceState;
  readonly columns: ReadonlyArray<LaneColumn>;
  readonly running: number;
  readonly total: number;
  readonly needsYou: number;
}

const runningIn = (board: Board, workspace: WorkspaceId): number =>
  [...board.runs.values()].filter((run) => run.status === "running" && run.workspace === workspace).length;

const laneColumnsFor = (board: Board, name: WorkspaceId | null): ReadonlyArray<LaneColumn> => {
  if (name === null) return boardColumnOrder.map((meta) => ({ ...meta, count: 0, items: [] }));
  return boardColumns(board, name).map(({ id, label, items }) => ({ id, label, count: items.length, items }));
};

const needsYouIn = (board: Board, workspace: WorkspaceId): number =>
  workspaceItems(board, workspace).filter(({ item }) => item._tag === "NeedsHuman" || item.pr !== undefined)
    .length;

const laneOf = (board: Board, state: WorkspaceState): Lane => {
  const name = state._tag === "Registered" ? state.name : null;
  const columns = laneColumnsFor(board, name);
  return {
    key: workspaceKey(state),
    state,
    columns,
    running: name === null ? 0 : runningIn(board, name),
    total: columns.reduce((sum, column) => sum + column.count, 0),
    needsYou: name === null ? 0 : needsYouIn(board, name),
  };
};

export const lanes = (board: Board): ReadonlyArray<Lane> =>
  [...board.workspaces.values()]
    .map((state) => laneOf(board, state))
    .sort((a, b) => a.key.localeCompare(b.key));
