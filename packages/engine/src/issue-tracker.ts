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
import type { TriggerSource } from "./trigger-source";

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
    message: `no work source adapter configured for ${workspace.config.name}`,
  });

const hasRemoteSource = (workspace: WorkspaceIssueTrackerBinding) => {
  const source = workspace.config.issueTracker;
  return source.type === "linear" ? linearTeams(source).length > 0 : true;
};

const observeEmpty = Effect.fn("IssueTracker.observe")(function* (workspace: WorkspaceIssueTrackerBinding) {
  if (hasRemoteSource(workspace)) return yield* noAdapter(workspace);
  return [] as ReadonlyArray<TrackerItem>;
});

const readEmptyProse = Effect.fn("IssueTracker.readProse")(function* (
  workspace: WorkspaceIssueTrackerBinding,
) {
  if (hasRemoteSource(workspace)) return yield* noAdapter(workspace);
  const prose: RunPlanWorkContextProse = { body: "", comments: [] };
  return prose;
});

export const makeEmpty = Effect.succeed({
  observe: observeEmpty,
  readProse: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId) => readEmptyProse(workspace),
  ...unsupportedWorkflowActions,
});

export type IssueTrackerService = Effect.Success<typeof makeEmpty> & {
  readonly assignees?: (
    workspace: WorkspaceIssueTrackerBinding,
    itemId: WorkItemId,
  ) => Effect.Effect<ReadonlyArray<string>, IssueTrackerError>;
  readonly triggerSources?: ReadonlyArray<TriggerSource>;
};

export class IssueTracker extends Context.Service<IssueTracker, IssueTrackerService>()(
  "@cogwork/engine/issue-tracker/IssueTracker",
) {}

export const emptyLayer = Layer.effect(IssueTracker, makeEmpty);
