import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HarnessName,
  IssueTrackerType,
  makeBrand,
  SlackChannelId,
  SlackMessageTs,
  SlackTeamId,
  SourceControlType,
  TrimmedNonEmptyString,
  WorkflowId,
  WorkItemId,
  WorkspaceId,
} from "./base-schemas";
import { Lineage, ParkReason, WorkItemKey, WorkItemRef } from "./coordination";
import { RunId } from "./run";
import { RunPlanPolicyProfile } from "./settings";
import { IssueTrackerConfig, SourceControlConfig } from "./workspace";

export const WorkflowNodeId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("WorkflowNodeId"));
export type WorkflowNodeId = typeof WorkflowNodeId.Type;

export const WorkflowCatalogKey = TrimmedNonEmptyString.pipe(Schema.brand("WorkflowCatalogKey"));
export type WorkflowCatalogKey = typeof WorkflowCatalogKey.Type;

export const NeedIdentity = TrimmedNonEmptyString.pipe(Schema.brand("NeedIdentity"));
export type NeedIdentity = typeof NeedIdentity.Type;

export const WorkflowParameterValue = Schema.Struct({
  id: TrimmedNonEmptyString,
  value: Schema.String,
});
export type WorkflowParameterValue = typeof WorkflowParameterValue.Type;

export const WorkflowWorkspaceSelection = Schema.Union([
  Schema.TaggedStruct("Every", {}),
  Schema.TaggedStruct("Listed", { workspaces: Schema.Array(WorkspaceId) }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type WorkflowWorkspaceSelection = typeof WorkflowWorkspaceSelection.Type;

export const WorkflowTriggerFilter = Schema.Struct({
  entry: WorkflowCatalogKey,
});
export type WorkflowTriggerFilter = typeof WorkflowTriggerFilter.Type;

export const WorkflowTrigger = Schema.Struct({
  id: WorkflowNodeId,
  entry: WorkflowCatalogKey,
  parameters: Schema.Array(WorkflowParameterValue),
  filters: Schema.Array(WorkflowTriggerFilter).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  start: WorkflowNodeId,
});
export type WorkflowTrigger = typeof WorkflowTrigger.Type;

export const WorkflowQuestionChoice = Schema.Struct({
  id: WorkflowNodeId,
  name: TrimmedNonEmptyString,
});
export type WorkflowQuestionChoice = typeof WorkflowQuestionChoice.Type;

export const WorkflowQuestion = Schema.Struct({
  id: WorkflowNodeId,
  text: TrimmedNonEmptyString,
  choices: Schema.Array(WorkflowQuestionChoice),
});
export type WorkflowQuestion = typeof WorkflowQuestion.Type;

const boundedAnswerSpace = Schema.makeFilter((questions: ReadonlyArray<WorkflowQuestion>) => {
  const combinations = questions.reduce(
    (count, question) => Math.min(count * question.choices.length, 4097),
    1,
  );
  return combinations <= 4096 ? undefined : "Expected at most 4096 answer combinations";
});

export const WorkflowTransitionAnswer = Schema.Struct({
  question: WorkflowNodeId,
  choice: WorkflowNodeId,
});
export type WorkflowTransitionAnswer = typeof WorkflowTransitionAnswer.Type;

export const WorkflowAction = Schema.Struct({
  entry: WorkflowCatalogKey,
  parameters: Schema.Array(WorkflowParameterValue),
});
export type WorkflowAction = typeof WorkflowAction.Type;

const workflowActionTargetBinding = {
  workspace: WorkspaceId,
  app: IssueTrackerType,
  issueTracker: IssueTrackerConfig,
  repository: Schema.NullOr(TrimmedNonEmptyString),
} as const;

const sourceControlActionTargetBinding = {
  workspace: WorkspaceId,
  app: SourceControlType,
  issueTracker: IssueTrackerConfig,
  sourceControl: Schema.optional(SourceControlConfig),
  repository: Schema.NullOr(TrimmedNonEmptyString),
} as const;

export const WorkflowActionTarget = Schema.TaggedUnion({
  Cogwork: {},
  NoWorkspace: {},
  SlackChannel: { channel: SlackChannelId },
  SlackMessage: {
    team: SlackTeamId,
    channel: SlackChannelId,
    ts: SlackMessageTs,
    threadTs: SlackMessageTs,
  },
  CurrentIssue: { ...workflowActionTargetBinding, issue: WorkItemId },
  ExistingIssue: { ...workflowActionTargetBinding, issue: WorkItemId },
  NewIssue: workflowActionTargetBinding,
  NewPullRequest: { ...sourceControlActionTargetBinding, issue: WorkItemId },
  CurrentPullRequest: { ...sourceControlActionTargetBinding, item: WorkItemRef },
  NamedPullRequest: {
    ...sourceControlActionTargetBinding,
    number: Schema.Int.check(Schema.isGreaterThan(0)),
    url: TrimmedNonEmptyString,
    headBranch: TrimmedNonEmptyString,
    baseBranch: TrimmedNonEmptyString,
    headSha: TrimmedNonEmptyString,
  },
});
export type WorkflowActionTarget = typeof WorkflowActionTarget.Type;

export class WorkflowActionOrigin extends Schema.Class<WorkflowActionOrigin>("WorkflowActionOrigin")({
  item: WorkItemKey,
  workflow: WorkflowId,
  attempt: RunId,
  writeKey: TrimmedNonEmptyString,
  lineage: Lineage,
}) {}

export class WorkflowActionArtifact extends Schema.Class<WorkflowActionArtifact>("WorkflowActionArtifact")({
  kind: Schema.Literals(["IssueCreated", "PullRequestOpened", "PullRequestUpdated"]),
  workspace: WorkspaceId,
  issue: WorkItemId,
  url: TrimmedNonEmptyString,
  origin: WorkflowActionOrigin,
}) {}

export class WorkflowSlackActionArtifact extends Schema.Class<WorkflowSlackActionArtifact>(
  "WorkflowSlackActionArtifact",
)({
  team: SlackTeamId,
  channel: SlackChannelId,
  ts: SlackMessageTs,
  threadTs: Schema.NullOr(SlackMessageTs),
  origin: WorkflowActionOrigin,
}) {}

export const WorkflowActionPlanArtifact = Schema.Union([WorkflowActionArtifact, WorkflowSlackActionArtifact]);
export type WorkflowActionPlanArtifact = typeof WorkflowActionPlanArtifact.Type;

export const WorkflowReviewComment = Schema.Struct({
  path: TrimmedNonEmptyString,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  body: TrimmedNonEmptyString,
});
export type WorkflowReviewComment = typeof WorkflowReviewComment.Type;

export const WorkflowAgentInputValue = Schema.Union([Schema.String, Schema.Array(WorkflowReviewComment)]);
export type WorkflowAgentInputValue = typeof WorkflowAgentInputValue.Type;

export const WorkflowOperationElement = Schema.Struct({
  summary: TrimmedNonEmptyString,
  answers: Schema.Record(Schema.String, Schema.String),
  inputs: Schema.Record(Schema.String, WorkflowAgentInputValue),
  workspace: Schema.optional(Schema.String),
});
export type WorkflowOperationElement = typeof WorkflowOperationElement.Type;

export class WorkflowActionPlanStep extends Schema.Class<WorkflowActionPlanStep>("WorkflowActionPlanStep")({
  position: Schema.Natural,
  entry: WorkflowCatalogKey,
  parameters: Schema.Array(WorkflowParameterValue),
  inputs: Schema.Record(Schema.String, WorkflowAgentInputValue),
  target: WorkflowActionTarget,
  writeKey: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "executing", "completed", "failed"]),
  failures: Schema.Natural,
  artifact: Schema.NullOr(WorkflowActionPlanArtifact),
}) {}

export class WorkflowActionPlan extends Schema.Class<WorkflowActionPlan>("WorkflowActionPlan")({
  item: WorkItemKey,
  workflow: WorkflowId,
  attempt: RunId,
  operation: WorkflowNodeId,
  revision: TrimmedNonEmptyString,
  createdAtMillis: Schema.Natural,
  consumedHandbackAtMillis: Schema.Natural.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  digest: TrimmedNonEmptyString,
  workflowRevision: Schema.Int.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
  summary: TrimmedNonEmptyString,
  answers: Schema.Record(Schema.String, Schema.String),
  inputs: Schema.Record(Schema.String, WorkflowAgentInputValue).pipe(
    Schema.withConstructorDefault(Effect.succeed({})),
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  workspace: Schema.NullOr(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  lineage: Lineage,
  handOff: Schema.NullOr(WorkflowNodeId),
  steps: Schema.Array(WorkflowActionPlanStep),
}) {}

export const WorkflowParkCommand = Schema.Literals([
  "approve",
  "reject",
  "choose-answer",
  "hand-back",
  "open-workflow",
]);
export type WorkflowParkCommand = typeof WorkflowParkCommand.Type;

export const WorkflowPark = Schema.Struct({
  item: WorkItemRef,
  workflow: WorkflowId,
  publishedRevision: Schema.Int,
  operation: WorkflowNodeId,
  lineage: Lineage,
  summary: TrimmedNonEmptyString,
  changedSinceParked: Schema.Boolean,
  commands: Schema.Array(WorkflowParkCommand),
  reason: ParkReason,
  attempt: Schema.NullOr(RunId),
  parkedAtMillis: Schema.Natural,
  plan: Schema.NullOr(WorkflowActionPlan),
});
export type WorkflowPark = typeof WorkflowPark.Type;

export const WorkflowSkippedRecord = Schema.Struct({
  summary: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
  atMillis: Schema.Natural,
});
export type WorkflowSkippedRecord = typeof WorkflowSkippedRecord.Type;

export const WorkflowAttention = Schema.Struct({
  parks: Schema.Array(WorkflowPark),
  skipped: Schema.Array(
    Schema.Struct({
      workflow: WorkflowId,
      steps: Schema.Array(WorkflowSkippedRecord),
      events: Schema.Array(WorkflowSkippedRecord),
    }),
  ),
});
export type WorkflowAttention = typeof WorkflowAttention.Type;

export class WorkflowTouchpointFailure extends Schema.TaggedError<WorkflowTouchpointFailure>()(
  "WorkflowTouchpointFailure",
  {
    reason: Schema.Literals([
      "not-found",
      "stale-attempt",
      "stale-digest",
      "not-awaiting-approval",
      "not-handed-to-you",
      "invalid-edits",
      "unavailable",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}

export const WorkflowTransition = Schema.Struct({
  when: Schema.Array(WorkflowTransitionAnswer),
  actions: Schema.Array(WorkflowAction),
  handOff: Schema.NullOr(WorkflowNodeId),
});
export type WorkflowTransition = typeof WorkflowTransition.Type;

export const WorkflowHint = Schema.Struct({
  field: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
});
export type WorkflowHint = typeof WorkflowHint.Type;

export const WorkflowModelSelection = Schema.Struct({
  harness: Schema.NullOr(HarnessName),
  model: Schema.NullOr(TrimmedNonEmptyString),
  options: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      value: Schema.Union([TrimmedNonEmptyString, Schema.Boolean]),
    }),
  ),
});
export type WorkflowModelSelection = typeof WorkflowModelSelection.Type;

export const WorkflowOperation = Schema.Struct({
  id: WorkflowNodeId,
  name: TrimmedNonEmptyString,
  instructionPackage: Schema.NullOr(TrimmedNonEmptyString),
  instruction: Schema.String,
  permissionProfile: RunPlanPolicyProfile,
  requires: Schema.Array(NeedIdentity),
  model: WorkflowModelSelection,
  forEach: Schema.NullOr(TrimmedNonEmptyString),
  questions: Schema.Array(WorkflowQuestion).check(boundedAnswerSpace),
  transitions: Schema.Array(WorkflowTransition),
  hints: Schema.Array(WorkflowHint),
});
export type WorkflowOperation = typeof WorkflowOperation.Type;

export const WorkflowNotificationId = makeBrand("WorkflowNotificationId");
export type WorkflowNotificationId = typeof WorkflowNotificationId.Type;

export const WorkflowNotification = Schema.Struct({
  id: WorkflowNotificationId,
  item: WorkItemRef,
  workflow: WorkflowId,
  operation: WorkflowNodeId,
  summary: TrimmedNonEmptyString,
  answers: Schema.Record(Schema.String, Schema.String),
  artifacts: Schema.Array(WorkflowActionArtifact),
  atMillis: Schema.Natural,
});
export type WorkflowNotification = typeof WorkflowNotification.Type;

export const WorkflowDocument = Schema.Struct({
  name: TrimmedNonEmptyString,
  workspaces: WorkflowWorkspaceSelection,
  triggers: Schema.Array(WorkflowTrigger),
  operations: Schema.Array(WorkflowOperation),
});
export type WorkflowDocument = typeof WorkflowDocument.Type;
