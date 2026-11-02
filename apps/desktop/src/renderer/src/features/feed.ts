import {
  type Board,
  itemKey,
  ParkReason,
  type RunSummary,
  type WorkItemId,
  type WorkspaceId,
  WorkspaceState,
} from "@cogwork/contracts";

export const parkReasonLabel = (reason: ParkReason) =>
  ParkReason.match(reason, {
    Stuck: () => "Stuck",
    Exhausted: () => "Exhausted",
    HopCap: () => "Hop cap",
    MissingOperation: () => "Missing operation",
    PlanRejected: () => "Plan rejected",
    WriteFailed: () => "Write failed",
    DraftOutcomeUnknown: () => "Draft outcome unknown",
    NoWorkspaceRecognized: () => "No workspace recognized",
    AwaitingApproval: () => "Awaiting approval",
    HandedToYou: () => "Handed to you",
  });

export interface FeedRun {
  readonly run: RunSummary;
  readonly title: string | null;
}

const terminalStatuses: ReadonlySet<RunSummary["status"]> = new Set([
  "succeeded",
  "declined",
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

const registeredStates = (board: Board) =>
  [...board.workspaces.values()].filter(WorkspaceState.guards.Registered);

export const registeredWorkspaces = (board: Board): WorkspaceId[] =>
  registeredStates(board)
    .map((state) => state.name)
    .sort();

export interface WorkspaceOption {
  readonly id: WorkspaceId;
  readonly label: string;
}

/** Register mints the WorkspaceId as a UUIDv7, so anything a person picks from needs the name. */
export const registeredWorkspaceOptions = (board: Board): WorkspaceOption[] =>
  registeredStates(board)
    .map((state) => ({ id: state.name, label: state.displayName ?? state.name }))
    .sort((left, right) => left.label.localeCompare(right.label));

export interface FailedWorkspace {
  readonly label: string;
  readonly message: string;
  /** Absent until register mints one, and then there is no settings page to open. */
  readonly id: WorkspaceId | null;
}

/** A Failed workspace has no work to filter, but its settings page carries the error. */
export const failedWorkspaces = (board: Board): FailedWorkspace[] =>
  [...board.workspaces.values()]
    .filter(WorkspaceState.guards.Failed)
    .map(({ name, displayName, source, message }) => ({
      id: name ?? null,
      label: displayName ?? name ?? source,
      message,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

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

export const boardItem = (board: Board, workspace: WorkspaceId, workItem: WorkItemId) =>
  board.items.get(itemKey(workspace, workItem)) ?? null;

export const runsForItem = (board: Board, workspace: WorkspaceId, workItem: WorkItemId): RunSummary[] =>
  [...board.runs.values()].filter((run) => run.workspace === workspace && run.workItem === workItem);

export const runForItem = (board: Board, workspace: WorkspaceId, workItem: WorkItemId) => {
  const forItem = runsForItem(board, workspace, workItem);
  const live = forItem.find((run) => run.status === "running");
  if (live) return live;
  return forItem.sort((a, b) => b.startedAtMillis - a.startedAtMillis)[0] ?? null;
};
