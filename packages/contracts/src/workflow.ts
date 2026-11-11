import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { PrincipalId } from "./principal";
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
}).annotate({ parseOptions: { onExcessProperty: "error" } });
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
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkflowDocument = typeof WorkflowDocument.Type;

export const WorkflowEdit = Schema.TaggedUnion({
  Rename: { name: TrimmedNonEmptyString },
  SelectWorkspaces: { workspaces: WorkflowWorkspaceSelection },
  AddTrigger: { trigger: WorkflowTrigger },
  RemoveTrigger: { trigger: WorkflowNodeId },
  SetTriggerEntry: { trigger: WorkflowNodeId, entry: WorkflowCatalogKey },
  SetTriggerParameter: {
    trigger: WorkflowNodeId,
    parameter: TrimmedNonEmptyString,
    values: Schema.Array(Schema.String),
  },
  SetTriggerStart: { trigger: WorkflowNodeId, start: WorkflowNodeId },
  AddTriggerFilter: { trigger: WorkflowNodeId, filter: WorkflowTriggerFilter },
  RemoveTriggerFilter: { trigger: WorkflowNodeId, entry: WorkflowCatalogKey },
  AddOperation: { operation: WorkflowOperation },
  RemoveOperation: { operation: WorkflowNodeId },
  RenameOperation: { operation: WorkflowNodeId, name: TrimmedNonEmptyString },
  SetInstruction: { operation: WorkflowNodeId, instruction: Schema.String },
  SetInstructionPackage: {
    operation: WorkflowNodeId,
    package: Schema.NullOr(TrimmedNonEmptyString),
  },
  SetPermissionProfile: { operation: WorkflowNodeId, profile: RunPlanPolicyProfile },
  SetRequires: { operation: WorkflowNodeId, requires: Schema.Array(NeedIdentity) },
  SetModel: { operation: WorkflowNodeId, model: WorkflowModelSelection },
  SetForEach: { operation: WorkflowNodeId, forEach: Schema.NullOr(TrimmedNonEmptyString) },
  AddQuestion: { operation: WorkflowNodeId, question: WorkflowQuestion },
  RemoveQuestion: { operation: WorkflowNodeId, question: WorkflowNodeId },
  SetQuestionText: {
    operation: WorkflowNodeId,
    question: WorkflowNodeId,
    text: TrimmedNonEmptyString,
  },
  AddChoice: {
    operation: WorkflowNodeId,
    question: WorkflowNodeId,
    choice: WorkflowQuestionChoice,
  },
  RemoveChoice: {
    operation: WorkflowNodeId,
    question: WorkflowNodeId,
    choice: WorkflowNodeId,
  },
  RenameChoice: {
    operation: WorkflowNodeId,
    question: WorkflowNodeId,
    choice: WorkflowNodeId,
    name: TrimmedNonEmptyString,
  },
  AddTransition: {
    operation: WorkflowNodeId,
    when: Schema.Array(WorkflowTransitionAnswer),
  },
  RemoveTransition: {
    operation: WorkflowNodeId,
    when: Schema.Array(WorkflowTransitionAnswer),
  },
  SetTransitionActions: {
    operation: WorkflowNodeId,
    when: Schema.Array(WorkflowTransitionAnswer),
    actions: Schema.Array(WorkflowAction),
  },
  SetTransitionHandOff: {
    operation: WorkflowNodeId,
    when: Schema.Array(WorkflowTransitionAnswer),
    handOff: Schema.NullOr(WorkflowNodeId),
  },
  SetHint: {
    operation: WorkflowNodeId,
    field: TrimmedNonEmptyString,
    text: Schema.NullOr(TrimmedNonEmptyString),
  },
});
export type WorkflowEdit = typeof WorkflowEdit.Type;

export const WorkflowEditBatch = Schema.NonEmptyArray(WorkflowEdit).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type WorkflowEditBatch = typeof WorkflowEditBatch.Type;

export const WorkflowDiagnosticCode = Schema.Literals([
  "schema",
  "unknown-target",
  "duplicate-id",
  "duplicate-transition",
  "unknown-reference",
  "self-hand-off",
  "unknown-catalog-entry",
  "unknown-option",
  "unknown-model",
  "no-trigger",
  "uncovered-outcome",
  "conflicting-hand-offs",
  "empty-instruction",
  "missing-option",
  "profile-too-narrow",
  "no-workspace",
  "item-kind-mismatch",
  "filter-not-applicable",
  "connection-not-ready",
  "need-not-ready",
  "harness-unavailable",
  "no-harness",
  "workspace-not-registered",
  "system-unbound",
  "unreachable-operation",
  "option-not-listed",
  "hand-off-and-trigger",
]);
export type WorkflowDiagnosticCode = typeof WorkflowDiagnosticCode.Type;

export const WorkflowDiagnosticClass = Schema.Literals(["malformed", "incomplete", "advisory"]);
export type WorkflowDiagnosticClass = typeof WorkflowDiagnosticClass.Type;

export const WorkflowDiagnosticLocation = Schema.Struct({
  trigger: Schema.NullOr(WorkflowNodeId),
  operation: Schema.NullOr(WorkflowNodeId),
  question: Schema.NullOr(WorkflowNodeId),
  choice: Schema.NullOr(WorkflowNodeId),
  field: Schema.String,
});
export type WorkflowDiagnosticLocation = typeof WorkflowDiagnosticLocation.Type;

export const WorkflowDiagnostic = Schema.Struct({
  code: WorkflowDiagnosticCode,
  class: WorkflowDiagnosticClass,
  location: WorkflowDiagnosticLocation,
  message: TrimmedNonEmptyString,
});
export type WorkflowDiagnostic = typeof WorkflowDiagnostic.Type;

export const WorkflowCatalogParameter = Schema.Struct({
  id: TrimmedNonEmptyString,
  required: Schema.Boolean,
  source: Schema.Literals(["fixed", "live"]),
  values: Schema.Array(Schema.String),
});
export type WorkflowCatalogParameter = typeof WorkflowCatalogParameter.Type;

export const WorkflowCatalogEntry = Schema.Struct({
  key: WorkflowCatalogKey,
  name: TrimmedNonEmptyString,
  kind: Schema.Literals(["trigger", "action", "filter"]),
  system: Schema.NullOr(TrimmedNonEmptyString),
  connection: Schema.NullOr(TrimmedNonEmptyString),
  requires: Schema.Array(NeedIdentity),
  parameters: Schema.Array(WorkflowCatalogParameter),
  itemKind: Schema.NullOr(TrimmedNonEmptyString),
  actsOn: Schema.Array(TrimmedNonEmptyString),
  requiresWorkspace: Schema.Boolean,
  permissionProfile: RunPlanPolicyProfile,
  agentInputs: Schema.Array(TrimmedNonEmptyString),
  emits: Schema.Array(WorkflowCatalogKey),
});
export type WorkflowCatalogEntry = typeof WorkflowCatalogEntry.Type;

export const WorkflowCatalogHarness = Schema.Struct({
  name: HarnessName,
  models: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      options: Schema.Array(
        Schema.Struct({
          id: TrimmedNonEmptyString,
          values: Schema.Array(Schema.Union([TrimmedNonEmptyString, Schema.Boolean])),
        }),
      ),
    }),
  ),
});
export type WorkflowCatalogHarness = typeof WorkflowCatalogHarness.Type;

export const WorkflowCatalog = Schema.Struct({
  entries: Schema.Array(WorkflowCatalogEntry),
  instructionPackages: Schema.Array(TrimmedNonEmptyString),
  harnesses: Schema.Array(WorkflowCatalogHarness),
});
export type WorkflowCatalog = typeof WorkflowCatalog.Type;

const unique = <A>(values: ReadonlyArray<A>) => [...new Set(values)];

const objectFields = <A extends Schema.Top>(entries: ReadonlyArray<readonly [string, A]>) =>
  Object.fromEntries(entries);

const answerFields = (operation: WorkflowOperation) =>
  objectFields(
    operation.questions.map(
      (question) => [question.id, Schema.Literals(question.choices.map(({ id }) => id))] as const,
    ),
  );

const operationActionEntries = (operation: WorkflowOperation, catalog: WorkflowCatalog) => {
  const actionKeys = new Set(
    operation.transitions.flatMap(({ actions }) => actions.map(({ entry }) => entry)),
  );
  return catalog.entries.filter(({ key, kind }) => kind === "action" && actionKeys.has(key));
};

const inputFields = (operation: WorkflowOperation, catalog: WorkflowCatalog) => {
  const inputs = unique(operationActionEntries(operation, catalog).flatMap(({ agentInputs }) => agentInputs));
  return objectFields(
    inputs.map((input) => [
      input,
      input === "review_comments" ? Schema.Array(WorkflowReviewComment) : Schema.String,
    ]),
  );
};

export const workflowOperationResultSchema = (
  operation: WorkflowOperation,
  catalog: WorkflowCatalog,
  workspaces: ReadonlyArray<WorkspaceId> = [],
  itemWorkspace?: WorkspaceId,
) => {
  const elementFields = {
    summary: TrimmedNonEmptyString,
    answers: Schema.Struct(answerFields(operation)),
    inputs: Schema.Struct(inputFields(operation, catalog)),
  };
  const parseOptions = { onExcessProperty: "error" } as const;
  const workspaceEntries = operationActionEntries(operation, catalog).filter(
    ({ requiresWorkspace }) => requiresWorkspace,
  );
  const elementNeedsWorkspace = workspaceEntries.length > 0;
  const onceNeedsWorkspace = workspaceEntries.some(
    ({ actsOn }) => itemWorkspace === undefined || actsOn.includes("*"),
  );
  const element = elementNeedsWorkspace
    ? Schema.Struct({ ...elementFields, workspace: Schema.Literals(["none", ...workspaces]) }).annotate({
        parseOptions,
      })
    : Schema.Struct(elementFields).annotate({ parseOptions });
  const once = onceNeedsWorkspace
    ? Schema.Struct({
        summary: TrimmedNonEmptyString,
        stuck: Schema.Boolean,
        answers: elementFields.answers,
        inputs: elementFields.inputs,
        workspace: Schema.Literals(["none", ...workspaces]),
      }).annotate({ parseOptions })
    : Schema.Struct({
        summary: TrimmedNonEmptyString,
        stuck: Schema.Boolean,
        answers: elementFields.answers,
        inputs: elementFields.inputs,
      }).annotate({ parseOptions });
  return operation.forEach === null
    ? once
    : Schema.Struct({
        summary: TrimmedNonEmptyString,
        stuck: Schema.Boolean,
        elements: Schema.Array(element).check(Schema.isMaxLength(50)),
      }).annotate({ parseOptions });
};

export const workflowOperationResultJsonSchema = (
  operation: WorkflowOperation,
  catalog: WorkflowCatalog,
  workspaces: ReadonlyArray<WorkspaceId> = [],
  itemWorkspace?: WorkspaceId,
) =>
  Schema.toStandardJSONSchemaV1(
    Schema.toStandardSchemaV1(workflowOperationResultSchema(operation, catalog, workspaces, itemWorkspace)),
  );

export const matchWorkflowTransitions = (
  operation: WorkflowOperation,
  answers: Readonly<Record<string, string>>,
) =>
  operation.transitions.filter((transition) =>
    transitionMatches(
      transition,
      Object.entries(answers).map(([question, choice]) => ({
        question: Schema.decodeSync(WorkflowNodeId)(question),
        choice: Schema.decodeSync(WorkflowNodeId)(choice),
      })),
    ),
  );

export const MachineReadiness = Schema.Struct({
  workspaces: Schema.Array(Schema.Struct({ id: WorkspaceId, binds: Schema.Array(TrimmedNonEmptyString) })),
  connections: Schema.Array(
    Schema.Struct({
      system: TrimmedNonEmptyString,
      ready: Schema.Boolean,
      reason: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  harnesses: Schema.Array(Schema.Struct({ name: HarnessName, available: Schema.Boolean })),
  defaultHarness: Schema.NullOr(HarnessName),
  readyNeeds: Schema.Array(NeedIdentity),
});
export type MachineReadiness = typeof MachineReadiness.Type;

export const WorkflowCatalogResult = Schema.Struct({
  catalog: WorkflowCatalog,
  machine: MachineReadiness,
});
export type WorkflowCatalogResult = typeof WorkflowCatalogResult.Type;

export const WorkflowAvailability = Schema.TaggedUnion({
  Available: {},
  ConnectionNeeded: {},
  Unavailable: { reason: TrimmedNonEmptyString },
});
export type WorkflowAvailability = typeof WorkflowAvailability.Type;

export const WorkflowTemplate = Schema.Struct({
  id: WorkflowNodeId,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  document: WorkflowDocument,
});
export type WorkflowTemplate = typeof WorkflowTemplate.Type;

export const WorkflowOption = Schema.Struct({
  value: Schema.String,
  name: TrimmedNonEmptyString,
  listedIn: Schema.Array(WorkspaceId),
});
export type WorkflowOption = typeof WorkflowOption.Type;

export const WorkflowOptionList = Schema.Array(WorkflowOption);
export type WorkflowOptionList = typeof WorkflowOptionList.Type;

export const WorkflowRecord = Schema.Struct({
  id: WorkflowId,
  principal: PrincipalId,
  workingCopy: WorkflowDocument,
  workingRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  publishedCopy: Schema.NullOr(WorkflowDocument),
  publishedRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  enabled: Schema.Boolean,
  diagnostics: Schema.Array(WorkflowDiagnostic),
  readiness: Schema.Array(WorkflowDiagnostic),
});
export type WorkflowRecord = typeof WorkflowRecord.Type;

export const WorkflowReadFailure = Schema.Struct({
  id: Schema.String,
  message: TrimmedNonEmptyString,
});
export type WorkflowReadFailure = typeof WorkflowReadFailure.Type;

export const WorkflowList = Schema.Struct({
  workflows: Schema.Array(WorkflowRecord),
  unreadable: Schema.Array(WorkflowReadFailure),
});
export type WorkflowList = typeof WorkflowList.Type;

export const WorkflowSwitchResult = Schema.Struct({
  workflow: WorkflowRecord,
  matchingItems: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type WorkflowSwitchResult = typeof WorkflowSwitchResult.Type;

export class WorkflowNotFound extends Schema.TaggedError<WorkflowNotFound>()("WorkflowNotFound", {
  id: WorkflowId,
}) {}

export class WorkflowUnreadable extends Schema.TaggedError<WorkflowUnreadable>()("WorkflowUnreadable", {
  id: WorkflowId,
  message: TrimmedNonEmptyString,
}) {}

export class WorkflowEditRefused extends Schema.TaggedError<WorkflowEditRefused>()("WorkflowEditRefused", {
  diagnostics: Schema.Array(WorkflowDiagnostic),
}) {}

export class WorkflowPublishRefused extends Schema.TaggedError<WorkflowPublishRefused>()(
  "WorkflowPublishRefused",
  {
    reason: Schema.Literals(["stale-revision", "incomplete"]),
    expectedRevision: Schema.Int,
    actualRevision: Schema.Int,
    diagnostics: Schema.Array(WorkflowDiagnostic),
  },
) {}

export class WorkflowSwitchRefused extends Schema.TaggedError<WorkflowSwitchRefused>()(
  "WorkflowSwitchRefused",
  { id: WorkflowId, reason: Schema.Literal("no-published-revision") },
) {}

export const WorkflowFailure = Schema.Union([
  WorkflowNotFound,
  WorkflowUnreadable,
  WorkflowEditRefused,
  WorkflowPublishRefused,
  WorkflowSwitchRefused,
]);
export type WorkflowFailure = typeof WorkflowFailure.Type;

const rootLocation: WorkflowDiagnosticLocation = {
  trigger: null,
  operation: null,
  question: null,
  choice: null,
  field: "document",
} satisfies WorkflowDiagnosticLocation;

const location = (
  field: string,
  values: Partial<Pick<WorkflowDiagnosticLocation, "trigger" | "operation" | "question" | "choice">> = {},
) => ({ ...rootLocation, ...values, field });

const diagnostic = (
  code: WorkflowDiagnosticCode,
  diagnosticClass: WorkflowDiagnosticClass,
  message: string,
  diagnosticLocation: WorkflowDiagnosticLocation = rootLocation,
) => ({ code, class: diagnosticClass, location: diagnosticLocation, message }) satisfies WorkflowDiagnostic;

const unknownTarget = (target: string, field: string) =>
  diagnostic("unknown-target", "malformed", `No ${field} has id ${target}`, location(field));

export type Decoded<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Refused"; readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> };

const ok = <A>(value: A): Decoded<A> => ({ _tag: "Ok", value });

const refused = <A>(diagnostics: ReadonlyArray<WorkflowDiagnostic>): Decoded<A> => ({
  _tag: "Refused",
  diagnostics,
});

const decodeWorkflowDocumentValue = (input: unknown) => {
  const decoded = Schema.decodeUnknownExit(WorkflowDocument, {
    errors: "all",
    onExcessProperty: "error",
  })(input);
  return Exit.isFailure(decoded)
    ? refused<WorkflowDocument>([
        diagnostic("schema", "malformed", Cause.pretty(decoded.cause), location("document")),
      ])
    : ok(decoded.value);
};

const updateById = <A extends { readonly id: string }>(
  values: ReadonlyArray<A>,
  id: string,
  field: string,
  update: (value: A) => A,
): Decoded<ReadonlyArray<A>> =>
  values.some((value) => value.id === id)
    ? ok(values.map((value) => (value.id === id ? update(value) : value)))
    : refused([unknownTarget(id, field)]);

const updateOperation = (
  document: WorkflowDocument,
  operation: WorkflowNodeId,
  update: (value: WorkflowOperation) => WorkflowOperation,
): Decoded<WorkflowDocument> => {
  const operations = updateById(document.operations, operation, "operation", update);
  return operations._tag === "Ok" ? ok({ ...document, operations: operations.value }) : operations;
};

const updateTrigger = (
  document: WorkflowDocument,
  trigger: WorkflowNodeId,
  update: (value: WorkflowTrigger) => WorkflowTrigger,
): Decoded<WorkflowDocument> => {
  const triggers = updateById(document.triggers, trigger, "trigger", update);
  return triggers._tag === "Ok" ? ok({ ...document, triggers: triggers.value }) : triggers;
};

const withQuestion = (
  document: WorkflowDocument,
  operation: WorkflowNodeId,
  question: WorkflowNodeId,
  update: (value: WorkflowQuestion) => WorkflowQuestion,
): Decoded<WorkflowDocument> => {
  const selectedOperation = document.operations.find(({ id }) => id === operation);
  if (!selectedOperation) return refused([unknownTarget(operation, "operation")]);
  const questions = updateById(selectedOperation.questions, question, "question", update);
  if (questions._tag === "Refused") return questions;
  return updateOperation(document, operation, (value) => ({ ...value, questions: questions.value }));
};

const withChoice = (
  document: WorkflowDocument,
  operation: WorkflowNodeId,
  question: WorkflowNodeId,
  choice: WorkflowNodeId,
  update: (value: WorkflowQuestionChoice) => WorkflowQuestionChoice,
): Decoded<WorkflowDocument> => {
  const selectedOperation = document.operations.find(({ id }) => id === operation);
  if (!selectedOperation) return refused([unknownTarget(operation, "operation")]);
  const selectedQuestion = selectedOperation.questions.find(({ id }) => id === question);
  if (!selectedQuestion) return refused([unknownTarget(question, "question")]);
  const choices = updateById(selectedQuestion.choices, choice, "choice", update);
  if (choices._tag === "Refused") return choices;
  return withQuestion(document, operation, question, (value) => ({ ...value, choices: choices.value }));
};

const transitionKey = (transition: Pick<WorkflowTransition, "when">) =>
  JSON.stringify(
    [...transition.when]
      .sort((left, right) => left.question.localeCompare(right.question))
      .map(({ question, choice }) => [question, choice]),
  );

const withTransition = (
  document: WorkflowDocument,
  operation: WorkflowNodeId,
  when: ReadonlyArray<WorkflowTransitionAnswer>,
  update: (value: WorkflowTransition) => WorkflowTransition,
): Decoded<WorkflowDocument> => {
  const selectedOperation = document.operations.find(({ id }) => id === operation);
  if (!selectedOperation) return refused([unknownTarget(operation, "operation")]);
  const key = transitionKey({ when });
  const hasTransition = selectedOperation.transitions.some((value) => transitionKey(value) === key);
  if (!hasTransition) return refused([unknownTarget(key, "transition")]);
  return updateOperation(document, operation, (value) => ({
    ...value,
    transitions: value.transitions.map((transition) =>
      transitionKey(transition) === key ? update(transition) : transition,
    ),
  }));
};

const setTriggerParameter = (
  trigger: WorkflowTrigger,
  parameter: string,
  values: ReadonlyArray<string>,
): WorkflowTrigger => ({
  ...trigger,
  parameters: [
    ...trigger.parameters.filter(({ id }) => id !== parameter),
    ...values.map((value) => ({ id: parameter, value })),
  ],
});

const removeQuestion = (
  document: WorkflowDocument,
  operation: WorkflowNodeId,
  question: WorkflowNodeId,
): Decoded<WorkflowDocument> => {
  const selected = withQuestion(document, operation, question, (value) => value);
  if (selected._tag === "Refused") return selected;
  return updateOperation(document, operation, (value) => ({
    ...value,
    questions: value.questions.filter(({ id }) => id !== question),
    transitions: value.transitions.filter((transition) =>
      transition.when.every((answer) => answer.question !== question),
    ),
  }));
};

const removeTransition = (
  document: WorkflowDocument,
  operation: WorkflowNodeId,
  when: ReadonlyArray<WorkflowTransitionAnswer>,
): Decoded<WorkflowDocument> => {
  const selected = withTransition(document, operation, when, (value) => value);
  if (selected._tag === "Refused") return selected;
  const key = transitionKey({ when });
  return updateOperation(document, operation, (value) => ({
    ...value,
    transitions: value.transitions.filter((transition) => transitionKey(transition) !== key),
  }));
};

const applyWorkflowEdit = (document: WorkflowDocument, edit: WorkflowEdit): Decoded<WorkflowDocument> =>
  WorkflowEdit.match(edit, {
    Rename: ({ name }) => ok({ ...document, name }),
    SelectWorkspaces: ({ workspaces }) => ok({ ...document, workspaces }),
    AddTrigger: ({ trigger }) => ok({ ...document, triggers: [...document.triggers, trigger] }),
    RemoveTrigger: ({ trigger }) => {
      const triggers = document.triggers.filter(({ id }) => id !== trigger);
      return triggers.length === document.triggers.length
        ? refused([unknownTarget(trigger, "trigger")])
        : ok({ ...document, triggers });
    },
    SetTriggerEntry: ({ trigger, entry }) =>
      updateTrigger(document, trigger, (value) => ({ ...value, entry, parameters: [], filters: [] })),
    AddTriggerFilter: ({ trigger, filter }) =>
      updateTrigger(document, trigger, (value) => ({
        ...value,
        filters: [...value.filters.filter(({ entry }) => entry !== filter.entry), filter],
      })),
    RemoveTriggerFilter: ({ trigger, entry }) =>
      updateTrigger(document, trigger, (value) => ({
        ...value,
        filters: value.filters.filter((filter) => filter.entry !== entry),
      })),
    SetTriggerParameter: ({ trigger, parameter, values }) =>
      updateTrigger(document, trigger, (value) => setTriggerParameter(value, parameter, values)),
    SetTriggerStart: ({ trigger, start }) =>
      updateTrigger(document, trigger, (value) => ({ ...value, start })),
    AddOperation: ({ operation }) => ok({ ...document, operations: [...document.operations, operation] }),
    RemoveOperation: ({ operation }) => {
      const operations = document.operations
        .filter(({ id }) => id !== operation)
        .map((value) => ({
          ...value,
          transitions: value.transitions.map((transition) => ({
            ...transition,
            handOff: transition.handOff === operation ? null : transition.handOff,
          })),
        }));
      return operations.length === document.operations.length
        ? refused([unknownTarget(operation, "operation")])
        : ok({ ...document, operations });
    },
    RenameOperation: ({ operation, name }) =>
      updateOperation(document, operation, (value) => ({ ...value, name })),
    SetInstruction: ({ operation, instruction }) =>
      updateOperation(document, operation, (value) => ({ ...value, instruction })),
    SetInstructionPackage: ({ operation, package: instructionPackage }) =>
      updateOperation(document, operation, (value) => ({ ...value, instructionPackage })),
    SetPermissionProfile: ({ operation, profile: permissionProfile }) =>
      updateOperation(document, operation, (value) => ({ ...value, permissionProfile })),
    SetRequires: ({ operation, requires }) =>
      updateOperation(document, operation, (value) => ({ ...value, requires })),
    SetModel: ({ operation, model }) =>
      updateOperation(document, operation, (value) => ({ ...value, model })),
    SetForEach: ({ operation, forEach }) =>
      updateOperation(document, operation, (value) => ({ ...value, forEach })),
    AddQuestion: ({ operation, question }) =>
      updateOperation(document, operation, (value) => ({
        ...value,
        questions: [...value.questions, question],
      })),
    RemoveQuestion: ({ operation, question }) => removeQuestion(document, operation, question),
    SetQuestionText: ({ operation, question, text }) =>
      withQuestion(document, operation, question, (value) => ({ ...value, text })),
    AddChoice: ({ operation, question, choice }) =>
      withQuestion(document, operation, question, (value) => ({
        ...value,
        choices: [...value.choices, choice],
      })),
    RemoveChoice: ({ operation, question, choice }) => {
      const selected = withChoice(document, operation, question, choice, (value) => value);
      if (selected._tag === "Refused") return selected;
      return updateOperation(document, operation, (value) => ({
        ...value,
        questions: value.questions.map((item) =>
          item.id === question ? { ...item, choices: item.choices.filter(({ id }) => id !== choice) } : item,
        ),
        transitions: value.transitions.filter((transition) =>
          transition.when.every((answer) => answer.question !== question || answer.choice !== choice),
        ),
      }));
    },
    RenameChoice: ({ operation, question, choice, name }) =>
      withChoice(document, operation, question, choice, (value) => ({ ...value, name })),
    AddTransition: ({ operation, when }) =>
      updateOperation(document, operation, (value) => ({
        ...value,
        transitions: [...value.transitions, { when, actions: [], handOff: null }],
      })),
    RemoveTransition: ({ operation, when }) => removeTransition(document, operation, when),
    SetTransitionActions: ({ operation, when, actions }) =>
      withTransition(document, operation, when, (value) => ({ ...value, actions })),
    SetTransitionHandOff: ({ operation, when, handOff }) =>
      withTransition(document, operation, when, (value) => ({ ...value, handOff })),
    SetHint: ({ operation, field, text }) =>
      updateOperation(document, operation, (value) => ({
        ...value,
        hints:
          text === null
            ? value.hints.filter((hint) => hint.field !== field)
            : [...value.hints.filter((hint) => hint.field !== field), { field, text }],
      })),
  });

export const applyWorkflowEdits = (
  document: WorkflowDocument,
  edits: WorkflowEditBatch,
): Decoded<WorkflowDocument> => {
  const result = edits.reduce<Decoded<WorkflowDocument>>(
    (result, edit) => (result._tag === "Refused" ? result : applyWorkflowEdit(result.value, edit)),
    ok(document),
  );
  if (result._tag === "Refused") return result;
  const decoded = decodeWorkflowDocumentValue(result.value);
  if (decoded._tag === "Refused") return decoded;
  const diagnostics = [
    ...duplicateIdDiagnostics(decoded.value),
    ...duplicateTransitionDiagnostics(decoded.value),
    ...referenceDiagnostics(decoded.value),
    ...selfHandOffDiagnostics(decoded.value),
  ];
  return diagnostics.length === 0 ? decoded : refused(diagnostics);
};

const duplicateValues = <A extends string>(values: ReadonlyArray<A>) =>
  values
    .filter((value, index) => values.indexOf(value) !== index)
    .filter((value, index, duplicates) => duplicates.indexOf(value) === index);

const answerCombinations = (operation: WorkflowOperation) =>
  operation.questions.reduce<ReadonlyArray<ReadonlyArray<WorkflowTransitionAnswer>>>(
    (combinations, question) =>
      combinations.flatMap((combination) =>
        question.choices.map((choice) => [...combination, { question: question.id, choice: choice.id }]),
      ),
    [[]],
  );

const transitionMatches = (
  transition: WorkflowTransition,
  answers: ReadonlyArray<WorkflowTransitionAnswer>,
) =>
  transition.when.every((condition) =>
    answers.some((answer) => answer.question === condition.question && answer.choice === condition.choice),
  );

export const uncovered = (operation: WorkflowOperation) => {
  const hasQuestionWithoutChoices = operation.questions.some(({ choices }) => choices.length === 0);
  if (hasQuestionWithoutChoices) return [[]];
  return answerCombinations(operation).filter(
    (answers) =>
      !operation.transitions.some(
        (transition) =>
          transitionMatches(transition, answers) &&
          (transition.actions.length > 0 || transition.handOff !== null),
      ),
  );
};

const duplicateIdDiagnostics = (document: WorkflowDocument) => {
  const nodes = [
    ...document.operations.map(({ id }) => ({
      id,
      location: location("operation", { operation: id }),
    })),
    ...document.triggers.map(({ id }) => ({
      id,
      location: location("trigger", { trigger: id }),
    })),
    ...document.operations.flatMap((operation) =>
      operation.questions.map(({ id }) => ({
        id,
        location: location("question", { operation: operation.id, question: id }),
      })),
    ),
  ];
  const duplicateNodes = duplicateValues(nodes.map(({ id }) => id)).map((id) =>
    diagnostic(
      "duplicate-id",
      "malformed",
      `Duplicate node id ${id}`,
      nodes.find((node) => node.id === id)?.location,
    ),
  );
  const duplicateChoices = document.operations.flatMap((operation) =>
    operation.questions.flatMap((question) =>
      duplicateValues(question.choices.map(({ id }) => id)).map((id) =>
        diagnostic(
          "duplicate-id",
          "malformed",
          `Question ${question.id} has duplicate choice id ${id}`,
          location("choice", { operation: operation.id, question: question.id, choice: id }),
        ),
      ),
    ),
  );
  return [...duplicateNodes, ...duplicateChoices];
};

const duplicateTransitionDiagnostics = (document: WorkflowDocument) =>
  document.operations.flatMap((operation) => {
    const keys = operation.transitions.map(transitionKey);
    return duplicateValues(keys).map((key) =>
      diagnostic(
        "duplicate-transition",
        "malformed",
        `Operation ${operation.id} has duplicate Transition ${key}`,
        location("transition", { operation: operation.id }),
      ),
    );
  });

const referenceDiagnostics = (document: WorkflowDocument) => {
  const operationIds = new Set(document.operations.map(({ id }) => id));
  const triggerDiagnostics = document.triggers.flatMap((trigger) =>
    operationIds.has(trigger.start)
      ? []
      : [
          diagnostic(
            "unknown-reference",
            "malformed",
            `Trigger ${trigger.id} starts missing Operation ${trigger.start}`,
            location("start", { trigger: trigger.id }),
          ),
        ],
  );
  const transitionDiagnostics = document.operations.flatMap((operation) => {
    const questions = new Map(operation.questions.map((question) => [question.id, question]));
    return operation.transitions.flatMap((transition) => {
      const handOff =
        transition.handOff !== null && !operationIds.has(transition.handOff)
          ? [
              diagnostic(
                "unknown-reference",
                "malformed",
                `Operation ${operation.id} hands off to missing Operation ${transition.handOff}`,
                location("handOff", { operation: operation.id }),
              ),
            ]
          : [];
      const answers = transition.when.flatMap(({ question, choice }) => {
        const referencedQuestion = questions.get(question);
        if (!referencedQuestion) {
          return [
            diagnostic(
              "unknown-reference",
              "malformed",
              `Transition names missing Question ${question}`,
              location("when", { operation: operation.id, question }),
            ),
          ];
        }
        return referencedQuestion.choices.some(({ id }) => id === choice)
          ? []
          : [
              diagnostic(
                "unknown-reference",
                "malformed",
                `Transition names missing Choice ${choice}`,
                location("when", { operation: operation.id, question, choice }),
              ),
            ];
      });
      return [...handOff, ...answers];
    });
  });
  return [...triggerDiagnostics, ...transitionDiagnostics];
};

const selfHandOffDiagnostics = (document: WorkflowDocument) =>
  document.operations.flatMap((operation) =>
    operation.transitions.flatMap((transition) =>
      transition.handOff === operation.id
        ? [
            diagnostic(
              "self-hand-off",
              "malformed",
              `Operation ${operation.id} hands off to itself`,
              location("handOff", { operation: operation.id }),
            ),
          ]
        : [],
    ),
  );

const entryUsages = (document: WorkflowDocument) => [
  ...document.triggers.map((trigger) => ({
    entry: trigger.entry,
    parameters: trigger.parameters,
    expectedKind: "trigger" as const,
    location: location("entry", { trigger: trigger.id }),
  })),
  ...document.triggers.flatMap((trigger) =>
    trigger.filters.map(({ entry }) => ({
      entry,
      parameters: [],
      expectedKind: "filter" as const,
      location: location("filters", { trigger: trigger.id }),
    })),
  ),
  ...document.operations.flatMap((operation) =>
    operation.transitions.flatMap((transition) =>
      transition.actions.map((action) => ({
        entry: action.entry,
        parameters: action.parameters,
        expectedKind: "action" as const,
        location: location("entry", { operation: operation.id }),
      })),
    ),
  ),
];

const catalogDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  const usageDiagnostics = entryUsages(document).flatMap((usage) => {
    const entry = entries.get(usage.entry);
    if (!entry || entry.kind !== usage.expectedKind) {
      return [
        diagnostic(
          "unknown-catalog-entry",
          "malformed",
          `Unknown ${usage.expectedKind} catalog entry ${usage.entry}`,
          usage.location,
        ),
      ];
    }
    const unknownParameters = usage.parameters
      .filter(({ id }) => !entry.parameters.some((parameter) => parameter.id === id))
      .map(({ id }) => diagnostic("unknown-option", "malformed", `Unknown parameter ${id}`, usage.location));
    const parameterDiagnostics = entry.parameters.flatMap((parameter) => {
      const values = usage.parameters.filter(({ id }) => id === parameter.id).map(({ value }) => value);
      const result = [
        {
          matches: parameter.required && values.length === 0,
          make: () => [
            diagnostic("missing-option", "incomplete", `Missing parameter ${parameter.id}`, usage.location),
          ],
        },
        {
          matches: parameter.source === "fixed",
          make: () =>
            values
              .filter((value) => !parameter.values.includes(value))
              .map((value) =>
                diagnostic(
                  "unknown-option",
                  "malformed",
                  `Parameter ${parameter.id} does not list ${value}`,
                  usage.location,
                ),
              ),
        },
      ].find(({ matches }) => matches);
      return result?.make() ?? [];
    });
    return [...unknownParameters, ...parameterDiagnostics];
  });
  const instructionDiagnostics = document.operations.flatMap((operation) =>
    operation.instructionPackage !== null &&
    !catalog.instructionPackages.includes(operation.instructionPackage)
      ? [
          diagnostic(
            "unknown-catalog-entry",
            "malformed",
            `Unknown instruction package ${operation.instructionPackage}`,
            location("instructionPackage", { operation: operation.id }),
          ),
        ]
      : [],
  );
  return [...usageDiagnostics, ...instructionDiagnostics];
};

const modelDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) =>
  document.operations.flatMap((operation) => {
    const harnessName = operation.model.harness;
    const harness = catalog.harnesses.find((candidate) => candidate.name === harnessName);
    const model = harness?.models.find((candidate) => candidate.id === operation.model.model);
    const invalidHarness = harnessName !== null && !harness;
    const invalidModel = operation.model.model !== null && (!harness || !model);
    const invalidOptions = operation.model.options.some((option) => {
      const catalogOption = model?.options.find((candidate) => candidate.id === option.id);
      return !catalogOption?.values.includes(option.value);
    });
    const invalidImplicitSelection =
      harnessName === null && (operation.model.model !== null || operation.model.options.length > 0);
    const invalidSelection = invalidImplicitSelection || invalidHarness || invalidModel || invalidOptions;
    return invalidSelection
      ? [
          diagnostic(
            "unknown-model",
            "malformed",
            `Unknown model selection for Operation ${operation.id}`,
            location("model", { operation: operation.id }),
          ),
        ]
      : [];
  });

const noTriggerDiagnostics = (document: WorkflowDocument) =>
  document.triggers.length === 0
    ? [diagnostic("no-trigger", "incomplete", "Workflow has no Trigger", location("triggers"))]
    : [];

const uncoveredDiagnostics = (document: WorkflowDocument) =>
  document.operations.flatMap((operation) =>
    uncovered(operation).length > 0
      ? [
          diagnostic(
            "uncovered-outcome",
            "incomplete",
            `Operation ${operation.id} has uncovered answers`,
            location("transitions", { operation: operation.id }),
          ),
        ]
      : [],
  );

const conflictingHandOffDiagnostics = (document: WorkflowDocument) =>
  document.operations.flatMap((operation) =>
    answerCombinations(operation).flatMap((answers) => {
      const handOffs = new Set(
        operation.transitions
          .filter((transition) => transitionMatches(transition, answers))
          .flatMap((transition) => (transition.handOff === null ? [] : [transition.handOff])),
      );
      return handOffs.size > 1
        ? [
            diagnostic(
              "conflicting-hand-offs",
              "incomplete",
              `Operation ${operation.id} has conflicting hand-offs`,
              location("handOff", { operation: operation.id }),
            ),
          ]
        : [];
    }),
  );

const emptyInstructionDiagnostics = (document: WorkflowDocument) =>
  document.operations.flatMap((operation) =>
    operation.instructionPackage === null && operation.instruction.trim().length === 0
      ? [
          diagnostic(
            "empty-instruction",
            "incomplete",
            `Operation ${operation.id} has no instruction`,
            location("instruction", { operation: operation.id }),
          ),
        ]
      : [],
  );

const actionEntries = (operation: WorkflowOperation, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  return operation.transitions.flatMap((transition) =>
    transition.actions.flatMap((action) => {
      const entry = entries.get(action.entry);
      return entry?.kind === "action" ? [entry] : [];
    }),
  );
};

const operationCapabilityDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) =>
  document.operations.flatMap((operation) => {
    const entries = actionEntries(operation, catalog);
    const profile =
      entries.some(({ permissionProfile }) => permissionProfile === "full") &&
      operation.permissionProfile === "read-only"
        ? [
            diagnostic(
              "profile-too-narrow",
              "incomplete",
              `Operation ${operation.id} needs the full permission profile`,
              location("permissionProfile", { operation: operation.id }),
            ),
          ]
        : [];
    const noWorkspace = document.workspaces._tag === "Listed" && document.workspaces.workspaces.length === 0;
    const workspace =
      noWorkspace && entries.some(({ requiresWorkspace }) => requiresWorkspace)
        ? [
            diagnostic(
              "no-workspace",
              "incomplete",
              `Operation ${operation.id} needs a Workspace`,
              location("workspaces", { operation: operation.id }),
            ),
          ]
        : [];
    return [...profile, ...workspace];
  });

const reachableKinds = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  const seeds = document.triggers.flatMap((trigger) => {
    const kind = entries.get(trigger.entry)?.itemKind;
    return kind === null || kind === undefined ? [] : [[trigger.start, kind] as const];
  });
  const next = (known: ReadonlyArray<readonly [WorkflowNodeId, string]>) => {
    const additions = known.flatMap(([operationId, kind]) =>
      document.operations
        .filter(({ id }) => id === operationId)
        .flatMap((operation) =>
          operation.transitions.flatMap(({ handOff }) =>
            handOff === null ? [] : [[handOff, kind] as const],
          ),
        ),
    );
    return [...known, ...additions].filter(
      (entry, index, values) =>
        values.findIndex(([operationId, kind]) => operationId === entry[0] && kind === entry[1]) === index,
    );
  };
  return Array.from({ length: document.operations.length }, () => null).reduce(next, seeds);
};

const itemKindDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const kinds = reachableKinds(document, catalog);
  return document.operations.flatMap((operation) => {
    const operationKinds = kinds.filter(([id]) => id === operation.id).map(([, kind]) => kind);
    const entries = actionEntries(operation, catalog);
    const mismatch = entries.some(
      ({ actsOn }) => !actsOn.includes("*") && operationKinds.some((kind) => !actsOn.includes(kind)),
    );
    return mismatch
      ? [
          diagnostic(
            "item-kind-mismatch",
            "incomplete",
            `Operation ${operation.id} has an action that cannot act on its item kind`,
            location("actions", { operation: operation.id }),
          ),
        ]
      : [];
  });
};

export const filterAppliesTo = (filter: WorkflowCatalogEntry, trigger: WorkflowCatalogEntry) =>
  filter.kind === "filter" && filter.system === trigger.system && filter.itemKind === trigger.itemKind;

const filterDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  return document.triggers.flatMap((trigger) => {
    const triggerEntry = entries.get(trigger.entry);
    return trigger.filters.flatMap(({ entry }) => {
      const filterEntry = entries.get(entry);
      const notApplicable =
        triggerEntry?.kind === "trigger" &&
        filterEntry?.kind === "filter" &&
        !filterAppliesTo(filterEntry, triggerEntry);
      return notApplicable
        ? [
            diagnostic(
              "filter-not-applicable",
              "incomplete",
              `Filter ${entry} does not apply to Trigger ${trigger.id}`,
              location("filters", { trigger: trigger.id }),
            ),
          ]
        : [];
    });
  });
};

const optionReadinessDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  return entryUsages(document).flatMap((usage) => {
    const entry = entries.get(usage.entry);
    if (!entry) return [];
    return usage.parameters.flatMap(({ id, value }) => {
      const parameter = entry.parameters.find((candidate) => candidate.id === id);
      // A source lists most live values only on request, so an empty catalog list says nothing.
      const missingLiveValue =
        parameter?.source === "live" && parameter.values.length > 0 && !parameter.values.includes(value);
      return missingLiveValue
        ? [
            diagnostic(
              "option-not-listed",
              "advisory",
              `Parameter ${id} does not list ${value}`,
              usage.location,
            ),
          ]
        : [];
    });
  });
};

const workspaceReadinessDiagnostics = (document: WorkflowDocument, machine: MachineReadiness) => {
  const selected = document.workspaces._tag === "Listed" ? document.workspaces.workspaces : [];
  const workspaceIds = machine.workspaces.map(({ id }) => id);
  const registered = selected.flatMap((workspace) =>
    workspaceIds.includes(workspace)
      ? []
      : [
          diagnostic(
            "workspace-not-registered",
            "advisory",
            `Workspace ${workspace} is not registered`,
            location("workspaces"),
          ),
        ],
  );
  return registered;
};

const bindingReadinessDiagnostics = (
  document: WorkflowDocument,
  catalog: WorkflowCatalog,
  machine: MachineReadiness,
) => {
  const selected = document.workspaces._tag === "Listed" ? document.workspaces.workspaces : [];
  return entryUsages(document).flatMap((usage) => {
    const system = catalog.entries.find(({ key }) => key === usage.entry)?.system;
    if (system === null || system === undefined) return [];
    const bound = machine.workspaces.filter(({ binds }) => binds.includes(system)).map(({ id }) => id);
    const selection =
      document.workspaces._tag === "Every" ? machine.workspaces.map(({ id }) => id) : selected;
    const observed = selection.filter((workspace) => bound.includes(workspace)).length;
    const messages = [
      { when: observed === 0, value: `No selected Workspace binds ${system}` },
      {
        when: observed > 0 && observed < selection.length,
        value: `${usage.entry} observes in ${observed} of ${selection.length} Workspaces`,
      },
    ];
    const message = messages.find(({ when }) => when)?.value;
    return message === undefined ? [] : [diagnostic("system-unbound", "advisory", message, usage.location)];
  });
};

interface AvailabilityInput {
  readonly entry: WorkflowCatalogEntry;
  readonly connection: MachineReadiness["connections"][number] | undefined;
}

const availabilityRules = [
  {
    matches: ({ entry }: AvailabilityInput) => entry.connection === null && entry.system === null,
    make: (_input: AvailabilityInput) => ({ _tag: "Available" }) as const,
  },
  {
    matches: ({ connection }: AvailabilityInput) => connection === undefined,
    make: (_input: AvailabilityInput) => ({ _tag: "ConnectionNeeded" }) as const,
  },
  {
    matches: ({ connection }: AvailabilityInput) => connection?.ready === true,
    make: (_input: AvailabilityInput) => ({ _tag: "Available" }) as const,
  },
  {
    matches: ({ connection }: AvailabilityInput) => connection?.reason === null,
    make: (_input: AvailabilityInput) => ({ _tag: "ConnectionNeeded" }) as const,
  },
] satisfies ReadonlyArray<{
  readonly matches: (input: AvailabilityInput) => boolean;
  readonly make: (input: AvailabilityInput) => WorkflowAvailability;
}>;

export const availabilityOf = (
  entry: WorkflowCatalogEntry,
  machine: MachineReadiness,
): WorkflowAvailability => {
  const input = {
    entry,
    connection: machine.connections.find(({ system }) => system === entry.system),
  };
  return (
    availabilityRules.find(({ matches }) => matches(input))?.make(input) ?? {
      _tag: "Unavailable",
      reason: input.connection?.reason ?? "Connection unavailable",
    }
  );
};

const connectionReadinessDiagnostics = (
  document: WorkflowDocument,
  catalog: WorkflowCatalog,
  machine: MachineReadiness,
) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  return entryUsages(document).flatMap((usage) => {
    const entry = entries.get(usage.entry);
    if (!entry) return [];
    return WorkflowAvailability.match(availabilityOf(entry, machine), {
      Available: () => [],
      ConnectionNeeded: () => [
        diagnostic(
          "connection-not-ready",
          "advisory",
          `Connection for ${entry.system ?? entry.connection ?? entry.key} is needed`,
          usage.location,
        ),
      ],
      Unavailable: ({ reason }) => [diagnostic("connection-not-ready", "advisory", reason, usage.location)],
    });
  });
};

const needReadinessDiagnostics = (document: WorkflowDocument, machine: MachineReadiness) =>
  document.operations.flatMap((operation) =>
    operation.requires.flatMap((need) =>
      machine.readyNeeds.includes(need)
        ? []
        : [
            diagnostic(
              "need-not-ready",
              "advisory",
              `Need ${need} is not ready`,
              location("requires", { operation: operation.id }),
            ),
          ],
    ),
  );

const harnessReadinessDiagnostics = (document: WorkflowDocument, machine: MachineReadiness) =>
  document.operations.flatMap((operation) => {
    const harness = operation.model.harness ?? machine.defaultHarness;
    if (harness === null) {
      return [
        diagnostic(
          "no-harness",
          "advisory",
          `Operation ${operation.id} has no Harness`,
          location("model", { operation: operation.id }),
        ),
      ];
    }
    const available = machine.harnesses.find(({ name }) => name === harness)?.available ?? false;
    return available
      ? []
      : [
          diagnostic(
            "harness-unavailable",
            "advisory",
            `Harness ${harness} is unavailable`,
            location("model", { operation: operation.id }),
          ),
        ];
  });

const unreachableDiagnostics = (document: WorkflowDocument) => {
  const reached = new Set([
    ...document.triggers.map(({ start }) => start),
    ...document.operations.flatMap((operation) =>
      operation.transitions.flatMap(({ handOff }) => (handOff === null ? [] : [handOff])),
    ),
  ]);
  return document.operations.flatMap((operation) =>
    reached.has(operation.id)
      ? []
      : [
          diagnostic(
            "unreachable-operation",
            "advisory",
            `Operation ${operation.id} is unreachable`,
            location("operation", { operation: operation.id }),
          ),
        ],
  );
};

const handOffTriggerDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  return document.operations.flatMap((operation) =>
    operation.transitions.flatMap((transition) => {
      if (transition.handOff === null) return [];
      const emitsHandOffTrigger = transition.actions.some((action) =>
        (entries.get(action.entry)?.emits ?? []).some((entry) =>
          document.triggers.some(
            (trigger) => trigger.entry === entry && trigger.start === transition.handOff,
          ),
        ),
      );
      return emitsHandOffTrigger
        ? [
            diagnostic(
              "hand-off-and-trigger",
              "advisory",
              `Operation ${operation.id} hands off and also triggers ${transition.handOff}`,
              location("transition", { operation: operation.id }),
            ),
          ]
        : [];
    }),
  );
};

const validationRules = [
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => duplicateIdDiagnostics(document),
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => duplicateTransitionDiagnostics(document),
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => referenceDiagnostics(document),
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => selfHandOffDiagnostics(document),
  catalogDiagnostics,
  modelDiagnostics,
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => noTriggerDiagnostics(document),
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => uncoveredDiagnostics(document),
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => conflictingHandOffDiagnostics(document),
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => emptyInstructionDiagnostics(document),
  operationCapabilityDiagnostics,
  itemKindDiagnostics,
  filterDiagnostics,
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => unreachableDiagnostics(document),
  handOffTriggerDiagnostics,
] satisfies ReadonlyArray<
  (document: WorkflowDocument, catalog: WorkflowCatalog) => ReadonlyArray<WorkflowDiagnostic>
>;

export const validateWorkflow = (document: WorkflowDocument, catalog: WorkflowCatalog) =>
  validationRules.flatMap((rule) => rule(document, catalog));

export const adviseReadiness = (
  document: WorkflowDocument,
  catalog: WorkflowCatalog,
  machine: MachineReadiness,
) => [
  ...connectionReadinessDiagnostics(document, catalog, machine),
  ...needReadinessDiagnostics(document, machine),
  ...harnessReadinessDiagnostics(document, machine),
  ...workspaceReadinessDiagnostics(document, machine),
  ...bindingReadinessDiagnostics(document, catalog, machine),
  ...optionReadinessDiagnostics(document, catalog),
];

export const decodeWorkflowDocument = decodeWorkflowDocumentValue;

export const validateWorkflowInput = (input: unknown, catalog: WorkflowCatalog) => {
  const decoded = decodeWorkflowDocument(input);
  return decoded._tag === "Refused" ? decoded.diagnostics : validateWorkflow(decoded.value, catalog);
};
