import {
  type Board,
  itemKey,
  type RunSummary,
  refOfKey,
  type WorkflowId,
  type WorkflowRecord,
  type WorkItemId,
  WorkItemRef,
  type WorkspaceId,
  WorkspaceState,
} from "@cogwork/contracts";

export interface FeedRun {
  readonly run: RunSummary;
  readonly label: string;
  readonly title: string | null;
}

const refLabel = WorkItemRef.match({
  Issue: ({ id }) => id,
  PullRequest: ({ number }) => `PR #${number}`,
  GranolaNote: () => "Granola note",
  SlackMessage: () => "Slack message",
  SlackConversation: () => "Slack thread",
  ScheduleInstant: () => "Schedule",
  FanOutChild: ({ position }) => `Item ${position + 1}`,
});

export const workItemLabel = (workItem: string) => {
  const ref = refOfKey(workItem);
  return ref === null ? workItem : refLabel(ref);
};

export const runTitle = (run: Pick<RunSummary, "subject" | "workItem">) =>
  run.subject?.title ?? workItemLabel(run.workItem);

export type OperationRun = Pick<RunSummary, "workflow" | "operation">;

export const operationNameOf = (workflows: ReadonlyMap<WorkflowId, WorkflowRecord>, run: OperationRun) => {
  const workflow = run.workflow === undefined ? undefined : workflows.get(run.workflow);
  const operations = (workflow?.publishedCopy ?? workflow?.workingCopy)?.operations ?? [];
  return operations.find(({ id }) => id === run.operation)?.name ?? run.operation;
};

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

const feedRunOf = (board: Board, run: RunSummary) => ({
  run,
  label: workItemLabel(run.workItem),
  title: run.subject?.title ?? board.items.get(itemKey(run.workspace, run.workItem))?.item.title ?? null,
});

const runs = (board: Board, filter: WorkspaceId | null) =>
  [...board.runs.values()].filter((run) => inWorkspace(filter, run.workspace));

const registeredStates = (board: Board) =>
  [...board.workspaces.values()].filter(WorkspaceState.guards.Registered);

export const registeredWorkspaces = (board: Board): WorkspaceId[] =>
  registeredStates(board)
    .map((state) => state.id)
    .sort();

export interface WorkspaceOption {
  readonly id: WorkspaceId;
  readonly label: string;
}

/** Register mints the WorkspaceId as a UUIDv7, so anything a person picks from needs the display name. */
export const registeredWorkspaceOptions = (board: Board): WorkspaceOption[] =>
  registeredStates(board)
    .map((state) => ({ id: state.id, label: state.displayName }))
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
    .map(({ id, displayName, source, message }) => ({
      id: id ?? null,
      label: displayName ?? id ?? source,
      message,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

export const runningRuns = (board: Board, filter: WorkspaceId | null): FeedRun[] =>
  runs(board, filter)
    .filter((run) => run.status === "running")
    .sort((a, b) => a.startedAtMillis - b.startedAtMillis)
    .map((run) => feedRunOf(board, run));

export const recentlyDone = (board: Board, filter: WorkspaceId | null, limit = 8): FeedRun[] =>
  runs(board, filter)
    .filter((run) => terminalStatuses.has(run.status))
    .sort((a, b) => (b.endedAtMillis ?? 0) - (a.endedAtMillis ?? 0))
    .slice(0, limit)
    .map((run) => feedRunOf(board, run));

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
