import {
  IssueTrackerError,
  linearTeams,
  type Priority,
  type RunPlanWorkContextProse,
  type WorkflowActionArtifact,
  type WorkflowActionOrigin,
  type WorkItemId,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { WorkspaceIssueTrackerBinding } from "./projector";

export { IssueTrackerError };

export const defaultTrackerCooldown = Duration.minutes(1);

export interface TrackerItem {
  readonly id: WorkItemId;
  readonly title: string;
  readonly url: string;
  readonly assignees: ReadonlyArray<string>;
  readonly openBlockers: number;
  readonly priority: Priority;
  readonly states?: ReadonlyArray<string>;
  readonly lastTouchedAtMillis?: number;
}

export interface ListedTrackerItem extends TrackerItem {
  readonly open: boolean;
  readonly labels: ReadonlyArray<string>;
  readonly createdAtMillis: number;
}

export interface TrackerComment {
  readonly id: string;
  readonly author: string | null;
  readonly authorAssociation: string;
  readonly authoredByPerson: boolean;
  readonly body: string;
  readonly createdAtMillis: number;
}

export interface TrackerProse {
  readonly body: string;
  readonly comments: ReadonlyArray<TrackerComment>;
}

export interface CreateIssueInput {
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
  readonly origin: WorkflowActionOrigin;
}

export interface IssueTrackerActionService {
  readonly createIssue: (
    workspace: WorkspaceIssueTrackerBinding,
    input: CreateIssueInput,
  ) => Effect.Effect<WorkflowActionArtifact, IssueTrackerError>;
  readonly commentIssue: (
    workspace: WorkspaceIssueTrackerBinding,
    itemId: WorkItemId,
    body: string,
    writeKey: string,
  ) => Effect.Effect<void, IssueTrackerError>;
  readonly addLabels: (
    workspace: WorkspaceIssueTrackerBinding,
    itemId: WorkItemId,
    labels: ReadonlyArray<string>,
  ) => Effect.Effect<void, IssueTrackerError>;
  readonly removeLabel: (
    workspace: WorkspaceIssueTrackerBinding,
    itemId: WorkItemId,
    label: string,
  ) => Effect.Effect<void, IssueTrackerError>;
  readonly closeIssue: (
    workspace: WorkspaceIssueTrackerBinding,
    itemId: WorkItemId,
  ) => Effect.Effect<void, IssueTrackerError>;
}

/** Label and close writes carry no marker, so a repeated step reads the state instead. */
export const convergeTrackerState = Effect.fn("IssueTracker.convergeState")(function* (
  change: string,
  applied: Effect.Effect<boolean, IssueTrackerError>,
  write: Effect.Effect<unknown, IssueTrackerError>,
) {
  if (yield* applied) return;
  yield* write;
  if (yield* applied) return;
  return yield* new IssueTrackerError({
    reason: "unavailable",
    message: `${change} was not confirmed by read-back`,
  });
});

const unavailableAction = () =>
  Effect.fail(
    new IssueTrackerError({
      reason: "unavailable",
      message: "the issue tracker does not support Workflow actions",
    }),
  );

export const unsupportedWorkflowActions: IssueTrackerActionService = {
  createIssue: unavailableAction,
  commentIssue: unavailableAction,
  addLabels: unavailableAction,
  removeLabel: unavailableAction,
  closeIssue: unavailableAction,
};

const noAdapter = (workspace: WorkspaceIssueTrackerBinding) =>
  new IssueTrackerError({
    reason: "unavailable",
    message: `no work source adapter configured for ${workspace.config.id}`,
  });

const hasRemoteSource = (workspace: WorkspaceIssueTrackerBinding) => {
  const source = workspace.config.issueTracker;
  return source.type === "linear" ? linearTeams(source).length > 0 : true;
};

const emptyRead = <A>(value: A) =>
  Effect.fn("IssueTracker.emptyRead")(function* (workspace: WorkspaceIssueTrackerBinding) {
    if (hasRemoteSource(workspace)) return yield* noAdapter(workspace);
    return value;
  });

const emptyProse: RunPlanWorkContextProse = { body: "", comments: [] };
const emptyTriggerProse: TrackerProse = { body: "", comments: [] };

export const makeEmpty = Effect.succeed({
  observe: emptyRead<ReadonlyArray<TrackerItem>>([]),
  itemsChangedSince: (workspace: WorkspaceIssueTrackerBinding, _sinceMillis: number) =>
    emptyRead<ReadonlyArray<ListedTrackerItem>>([])(workspace),
  openItemsWithLabel: (workspace: WorkspaceIssueTrackerBinding, _label: string) =>
    emptyRead<ReadonlyArray<ListedTrackerItem>>([])(workspace),
  readItem: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId) =>
    emptyRead<ListedTrackerItem | null>(null)(workspace),
  readProse: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId) =>
    emptyRead(emptyProse)(workspace),
  readTriggerProse: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId) =>
    emptyRead(emptyTriggerProse)(workspace),
  labelAppliedAt: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId, _label: string) =>
    emptyRead<number | null>(null)(workspace),
  listLabels: emptyRead<ReadonlyArray<string>>([]),
  ...unsupportedWorkflowActions,
});

export type IssueTrackerService = Effect.Success<typeof makeEmpty> & {
  readonly assignees?: (
    workspace: WorkspaceIssueTrackerBinding,
    itemId: WorkItemId,
  ) => Effect.Effect<ReadonlyArray<string>, IssueTrackerError>;
};

export class IssueTracker extends Context.Service<IssueTracker, IssueTrackerService>()(
  "@cogwork/engine/issue-tracker/IssueTracker",
) {}

export const emptyLayer = Layer.effect(IssueTracker, makeEmpty);
