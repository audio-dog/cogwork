import {
  type AttemptRecord,
  type Claim,
  IssueTrackerError,
  type LifecycleStage,
  linearTeams,
  type OperationKey,
  type Priority,
  type RunPlanWorkContextProse,
  type TriageRole,
  type WorkflowActionArtifact,
  type WorkflowActionOrigin,
  type WorkItemId,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CoordinationService, CoordinationView } from "./coordination";
import type { FollowUpMarker, FollowUpTrigger, ObservedPr } from "./follow-up";
import type { WorkspaceIssueTrackerBinding } from "./projector";
import type { TriggerSource } from "./trigger-source";

export type { BaseDivergence, FollowUpMarker, ObservedPr, PrReview } from "./follow-up";
export { IssueTrackerError };

export const defaultTrackerCooldown = Duration.minutes(1);

export interface ClaimRequest {
  readonly claimedAtMillis: number;
  readonly stage: LifecycleStage;
}

interface ObservedItemBase {
  readonly claimHeld: boolean;
  readonly claim: Claim | null;
  readonly claimedByUs: boolean;
  readonly attempts: ReadonlyArray<AttemptRecord>;
  readonly handback: { readonly by: string; readonly atMillis: number; readonly note?: string | null } | null;
  readonly engineHandoffAtMillis?: number | null;
  readonly followUpTrigger?: FollowUpTrigger | null;
  readonly coordination?: CoordinationView;
  readonly id: WorkItemId;
  readonly title: string;
  readonly url: string;
  readonly roles: ReadonlyArray<TriageRole>;
  readonly assignees: ReadonlyArray<string>;
  readonly openBlockers: number;
  readonly proposal: string | null;
  readonly priority: Priority;
  readonly states?: ReadonlyArray<string>;
  readonly lastTouchedAtMillis?: number;
}

export interface TrackerItem extends ObservedItemBase {
  readonly followUp: FollowUpMarker | null;
}

export interface ObservedItem extends ObservedItemBase {
  readonly pr: ObservedPr | null;
}

export interface RoleChanges {
  readonly add: ReadonlyArray<TriageRole>;
  readonly remove: ReadonlyArray<TriageRole>;
}

export interface TriagedOutcome {
  readonly role: TriageRole;
  readonly proposal: string;
  readonly atMillis: number;
}

export interface ImplementedOutcome {
  readonly atMillis: number;
}

export interface FollowedUpOutcome {
  readonly marker: FollowUpMarker;
  readonly summary: string;
  readonly atMillis: number;
}

export interface AttemptFailedOutcome extends OperationKey {
  readonly atMillis: number;
  readonly reason?: string;
  readonly marker?: FollowUpMarker;
  readonly terminal?: boolean;
}

export interface HandOffOutcome {
  readonly stage: LifecycleStage;
  readonly note?: string;
}

export interface StalledOutcome {
  readonly marker: FollowUpMarker;
  readonly atMillis: number;
  readonly detail: string;
}

export interface ReclassifyOutcome {
  readonly changes: RoleChanges;
  readonly note?: string;
}

export interface HandBackOutcome {
  readonly record: { readonly by: string; readonly atMillis: number };
  readonly changes: RoleChanges;
  readonly note?: string;
  readonly trigger?: FollowUpTrigger;
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
    writeKey: string,
  ) => Effect.Effect<void, IssueTrackerError>;
  readonly removeLabel: (
    workspace: WorkspaceIssueTrackerBinding,
    itemId: WorkItemId,
    label: string,
    writeKey: string,
  ) => Effect.Effect<void, IssueTrackerError>;
  readonly closeIssue: (
    workspace: WorkspaceIssueTrackerBinding,
    itemId: WorkItemId,
    writeKey: string,
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

const failWhenRemote = Effect.fn("IssueTracker.guard")(function* (workspace: WorkspaceIssueTrackerBinding) {
  if (hasRemoteSource(workspace)) {
    return yield* noAdapter(workspace);
  }
  return yield* Effect.void;
});

const observeEmpty = Effect.fn("IssueTracker.observe")(function* (workspace: WorkspaceIssueTrackerBinding) {
  if (hasRemoteSource(workspace)) {
    return yield* noAdapter(workspace);
  }
  return [] as ReadonlyArray<TrackerItem>;
});

const readEmptyProse = Effect.fn("IssueTracker.readProse")(function* (
  workspace: WorkspaceIssueTrackerBinding,
) {
  if (hasRemoteSource(workspace)) {
    return yield* noAdapter(workspace);
  }
  const prose: RunPlanWorkContextProse = { body: "", comments: [] };
  return prose;
});

export const makeEmpty = Effect.succeed({
  rateLimitScope: (_workspace: WorkspaceIssueTrackerBinding): string | null => null,
  observe: observeEmpty,
  readProse: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId) => readEmptyProse(workspace),
  claim: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId, _claim: ClaimRequest) =>
    failWhenRemote(workspace),
  release: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId) => failWhenRemote(workspace),
  note: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId, _detail: string) =>
    failWhenRemote(workspace),
  triaged: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId, _outcome: TriagedOutcome) =>
    failWhenRemote(workspace),
  implemented: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId, _outcome: ImplementedOutcome) =>
    failWhenRemote(workspace),
  followedUp: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId, _outcome: FollowedUpOutcome) =>
    failWhenRemote(workspace),
  attemptFailed: (
    workspace: WorkspaceIssueTrackerBinding,
    _itemId: WorkItemId,
    _outcome: AttemptFailedOutcome,
  ) => failWhenRemote(workspace),
  handOff: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId, _outcome: HandOffOutcome) =>
    failWhenRemote(workspace),
  handBack: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId, _outcome: HandBackOutcome) =>
    failWhenRemote(workspace),
  stalled: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId, _outcome: StalledOutcome) =>
    failWhenRemote(workspace),
  reclassify: (workspace: WorkspaceIssueTrackerBinding, _itemId: WorkItemId, _outcome: ReclassifyOutcome) =>
    failWhenRemote(workspace),
  ...unsupportedWorkflowActions,
} as const);

export type IssueTrackerService = Effect.Success<typeof makeEmpty> & {
  readonly assignees?: (
    workspace: WorkspaceIssueTrackerBinding,
    itemId: WorkItemId,
  ) => Effect.Effect<ReadonlyArray<string>, IssueTrackerError>;
  readonly triggerSources?: ReadonlyArray<TriggerSource>;
  readonly workflowCoordination?: (
    workspace: WorkspaceIssueTrackerBinding,
    itemId: WorkItemId,
  ) => Effect.Effect<CoordinationService, IssueTrackerError>;
};

export class IssueTracker extends Context.Service<IssueTracker, IssueTrackerService>()(
  "@cogwork/engine/issue-tracker/IssueTracker",
) {}

export const emptyLayer = Layer.effect(IssueTracker, makeEmpty);

export const releaseClaim = (tracker: IssueTrackerService) =>
  Effect.fn("IssueTracker.releaseClaim")(function* (
    workspace: WorkspaceIssueTrackerBinding,
    itemId: WorkItemId,
  ) {
    yield* tracker.release(workspace, itemId).pipe(
      Effect.catchTag("IssueTrackerError", (error) =>
        Effect.logWarning("claim release failed", {
          workspace: workspace.config.name,
          item: itemId,
          message: error.message,
        }),
      ),
    );
  });
