import {
  type WorkflowActionPlan,
  type WorkflowActionPlanArtifact,
  type WorkflowActionPlanStep,
  type WorkflowActionTarget,
  type WorkflowAgentInputValue,
  type WorkflowCatalogEntry,
  type WorkflowParameterValue,
  type WorkflowWorkspaceSource,
  WorkItemRef,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Coordination } from "./coordination";
import { type IssueTrackerActionService, IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace, WorkspaceIssueTrackerBinding } from "./projector";
import type { RunLedger } from "./run-ledger";
import type { SlackWrite, SlackWriteError } from "./slack-write";
import type {
  PullRequestContext,
  SourceControlProvider,
  SourceControlProviderService,
} from "./source-control";
import type { TriggerAdmission, TriggerObservationStore } from "./trigger-observation";
import type { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import type { WorkflowNotifications } from "./workflow-notification";
import type { WorktreeManager, WorktreeManagerService } from "./worktree";

export class WorkflowActionPlanDecodeError extends Schema.TaggedError<WorkflowActionPlanDecodeError>()(
  "WorkflowActionPlanDecodeError",
  { reason: Schema.Literals(["invalid", "declined", "unavailable"]), message: Schema.String },
) {}

export const decodeFailure = (message: string) =>
  Effect.fail(WorkflowActionPlanDecodeError.make({ reason: "invalid", message }));

export interface PullRequestSnapshot {
  readonly workspace: string;
  readonly pullRequest: PullRequestContext;
}

export interface TargetContext {
  readonly entry: WorkflowCatalogEntry;
  readonly admission: TriggerAdmission;
  readonly workspaces: ReadonlyArray<RegisteredWorkspace>;
  readonly inputs: Readonly<Record<string, WorkflowAgentInputValue>>;
  readonly parameters: ReadonlyArray<WorkflowParameterValue>;
  readonly workspace: string | undefined;
  readonly sourceControl: SourceControlProviderService | undefined;
  readonly worktrees?: WorktreeManagerService;
  readonly runBranch?: string;
  readonly pullRequestSnapshots?: ReadonlyArray<PullRequestSnapshot>;
}

export type TargetProducer = (
  context: TargetContext,
) => Effect.Effect<WorkflowActionTarget, WorkflowActionPlanDecodeError>;

export interface ActionContext {
  readonly item: TriggerAdmission["event"]["key"];
  readonly plan: WorkflowActionPlan;
  readonly step: WorkflowActionPlanStep;
  readonly workspace: WorkspaceIssueTrackerBinding | null;
  readonly tracker: IssueTrackerActionService;
  readonly notifications: Effect.Success<typeof WorkflowNotifications>;
  readonly ledger: Effect.Success<typeof RunLedger>;
  readonly sourceControl: Effect.Success<typeof SourceControlProvider> | null;
  readonly sourceWorkspace: RegisteredWorkspace | null;
  readonly worktrees: Effect.Success<typeof WorktreeManager> | null;
  readonly slack: Effect.Success<typeof SlackWrite>;
  readonly actionPlans: Effect.Success<typeof WorkflowActionPlanStore>;
  readonly coordination: Effect.Success<typeof Coordination>;
  readonly observationStore: Effect.Success<typeof TriggerObservationStore>;
}

export type ActionExecutor = (
  context: ActionContext,
) => Effect.Effect<WorkflowActionPlanArtifact | null, IssueTrackerError | SlackWriteError>;

export const actionPhases = ["approval", "write", "notify", "terminal"] as const;
export type ActionPhase = (typeof actionPhases)[number];

export type EngineToolName = "issue-search" | "pull-request";

export interface ActionEntry {
  readonly row: WorkflowCatalogEntry;
  readonly target: TargetProducer;
  readonly execute: ActionExecutor;
  readonly phase: ActionPhase;
  readonly tools: ReadonlyArray<EngineToolName>;
}

export const stringInput = (step: WorkflowActionPlanStep, name: string) => {
  const value = step.inputs[name];
  return typeof value === "string" ? value : "";
};

export const invalidTarget = (step: WorkflowActionPlanStep) =>
  new IssueTrackerError({
    reason: "unavailable",
    retryable: false,
    message: `Action ${step.entry} has an invalid target`,
  });

export const parameterValues = (parameters: ReadonlyArray<WorkflowParameterValue>, id: string) =>
  parameters.filter((parameter) => parameter.id === id).map(({ value }) => value);

export const itemWorkspaceOf = (admission: TriggerAdmission) =>
  WorkItemRef.matchOrElse(
    admission.event.key,
    {
      Issue: ({ workspace }) => workspace,
      PullRequest: ({ workspace }) => workspace,
    },
    () => undefined,
  );

const targetWorkspaceFrom = {
  "item-else-agent": ({ admission, workspace }) => itemWorkspaceOf(admission) ?? workspace,
  agent: ({ workspace }) => workspace,
} satisfies Record<WorkflowWorkspaceSource, (context: TargetContext) => string | undefined>;

export const targetWorkspaceOf = (context: TargetContext) =>
  context.entry.workspaceSource === null
    ? context.workspace
    : targetWorkspaceFrom[context.entry.workspaceSource](context);
